'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./src/errors');
const { createTemplateStore, listTemplates } = require('./src/templates');
const { createRateLimiter } = require('./src/ratelimit');
const { renderRequest, sendCallback, DEFAULTS } = require('./src/service');
const { validateMsgId } = require('./src/validate');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const envBool = (v, fallback = false) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v));
const envInt = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function configFromEnv(env = process.env) {
  return {
    port: envInt(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    templatesPath: env.TEMPLATES_PATH || path.join(__dirname, 'templates.json'),
    rateLimitPerMinute: envInt(env.RATE_LIMIT_PER_MIN, 30),
    trustProxy: envBool(env.TRUST_PROXY),
    timeoutMs: envInt(env.REQUEST_TIMEOUT_MS, DEFAULTS.timeoutMs),
    maxRequestBodyBytes: DEFAULTS.maxRequestBodyBytes,
    maxResponseBytes: envInt(env.MAX_RESPONSE_BYTES, DEFAULTS.maxResponseBytes),
    // Developer escape hatches. Leave both off in any shared deployment.
    allowHttp: envBool(env.ALLOW_HTTP),
    allowPrivate: envBool(env.ALLOW_PRIVATE_HOSTS),
  };
}

const API_BODY_LIMIT = 4 * 1024;

function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      reject(new AppError('BAD_REQUEST', 'Content-Type must be application/json', 415));
      return;
    }
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new AppError('TOO_LARGE', `Request body exceeds ${limit} bytes`, 413, { close: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new AppError('BAD_REQUEST', 'Request body must be a JSON object', 400));
      }
    });
    req.on('error', () => {
      if (!failed) reject(new AppError('BAD_REQUEST', 'Could not read request body', 400));
    });
  });
}

function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Browsers send Origin on cross-site POSTs; refuse anything not coming from this app. */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    host = null;
  }
  if (host !== req.headers.host) throw new AppError('FORBIDDEN_ORIGIN', 'Cross-origin requests are not allowed', 403);
}

function optionalString(value, name, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError('BAD_REQUEST', `"${name}" must be a string of at most ${max} characters`, 400);
  }
  return value;
}

function createServer(overrides = {}) {
  const config = { ...configFromEnv(), ...overrides };
  const store = createTemplateStore(config.templatesPath);
  const sendLimiter = createRateLimiter({ limit: config.rateLimitPerMinute, windowMs: 60_000 });
  const previewLimiter = createRateLimiter({ limit: config.rateLimitPerMinute * 4, windowMs: 60_000 });

  function limit(limiter, req, res) {
    const verdict = limiter.check(clientKey(req, config.trustProxy));
    if (!verdict.allowed) {
      throw new AppError('RATE_LIMITED', `Too many requests. Try again in ${verdict.retryAfterSec}s.`, 429, {
        headers: { 'Retry-After': String(verdict.retryAfterSec) },
      });
    }
    return verdict;
  }

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/templates') {
      if (req.method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', 'Use GET', 405, { headers: { Allow: 'GET' } });
      sendJson(res, 200, listTemplates(store.get()));
      return;
    }

    if (pathname === '/api/preview' || pathname === '/api/send') {
      if (req.method !== 'POST') throw new AppError('METHOD_NOT_ALLOWED', 'Use POST', 405, { headers: { Allow: 'POST' } });
      checkOrigin(req);
      limit(pathname === '/api/send' ? sendLimiter : previewLimiter, req, res);
      const input = await readJson(req, API_BODY_LIMIT);

      if (pathname === '/api/preview') {
        const callbackUrl = optionalString(input.callbackUrl, 'callbackUrl', 2048).trim() || 'https://YOUR_CALLBACK_URL';
        const typed = optionalString(input.msgId, 'msgId', 512).trim();
        const msgId = typed ? validateMsgId(typed) : 'MSG_ID_HERE';
        const request = renderRequest(store.get(), {
          channel: input.channel,
          status: input.status,
          callbackUrl,
          msgId,
        });
        const { bodyText, ...rest } = request;
        sendJson(res, 200, { request: rest });
        return;
      }

      const result = await sendCallback(
        { channel: input.channel, status: input.status, callbackUrl: input.callbackUrl, msgId: input.msgId },
        {
          templates: store.get(),
          options: { allowHttp: config.allowHttp, allowPrivate: config.allowPrivate },
          timeoutMs: config.timeoutMs,
          maxRequestBodyBytes: config.maxRequestBodyBytes,
          maxResponseBytes: config.maxResponseBytes,
        },
      );
      sendJson(res, 200, { result });
      return;
    }

    throw new AppError('NOT_FOUND', 'Unknown API endpoint', 404);
  }

  function serveStatic(req, res, pathname) {
    const entry = STATIC_FILES[pathname];
    if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
      throw new AppError('NOT_FOUND', 'Not found', 404);
    }
    const [file, type] = entry;
    const data = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  function handleError(res, err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof AppError) {
      const error = { code: err.code, message: err.message };
      if (err.request) error.request = err.request;
      const headers = { ...(err.headers || {}) };
      if (err.close) headers.Connection = 'close';
      sendJson(res, err.status, { error }, headers);
      return;
    }
    // Log the stack only; never log user-supplied URLs, msgIds or responses.
    console.error('Unexpected error:', err && err.stack ? err.stack.split('\n')[0] : err);
    sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected server error' } });
  }

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    try {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        throw new AppError('BAD_REQUEST', 'Bad request URL', 400);
      }
      if (pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('ok');
        return;
      }
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
      }
      serveStatic(req, res, pathname);
    } catch (err) {
      handleError(res, err);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('close', () => {
    sendLimiter.close();
    previewLimiter.close();
  });
  server.config = config;
  return server;
}

if (require.main === module) {
  const server = createServer();
  const { port, host, allowHttp, allowPrivate } = server.config;
  server.listen(port, host, () => {
    console.log(`CleverTap Callback Tester listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (allowHttp || allowPrivate) {
      console.warn('WARNING: ALLOW_HTTP / ALLOW_PRIVATE_HOSTS is on. SSRF protection is weakened; use for local development only.');
    }
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, configFromEnv };
