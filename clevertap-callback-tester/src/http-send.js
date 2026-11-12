'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { AppError } = require('./errors');

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);

function mapNetworkError(e) {
  if (e instanceof AppError) return e;
  const code = e && e.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new AppError('DNS_FAILURE', `DNS lookup failed (${code})`, 502);
  }
  if (TLS_ERROR_CODES.has(code) || (typeof code === 'string' && code.startsWith('ERR_TLS'))) {
    return new AppError('TLS_ERROR', `TLS/SSL error: ${e.message}`, 502);
  }
  if (code === 'ECONNREFUSED') return new AppError('CONNECTION_ERROR', 'Connection refused by the callback server', 502);
  if (code === 'ECONNRESET') return new AppError('CONNECTION_ERROR', 'Connection was reset by the callback server', 502);
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new AppError('CONNECTION_ERROR', 'Callback server is unreachable', 502);
  }
  if (code === 'ETIMEDOUT') return new AppError('TIMEOUT', 'Connection to the callback server timed out', 504);
  return new AppError('CONNECTION_ERROR', `Request failed: ${(e && e.message) || 'unknown error'}`, 502);
}

/**
 * Sends one request to an already-validated destination.
 *
 *  - The socket connects to `pinned.address` (the IP that passed the SSRF check),
 *    while the Host header and TLS server name still use the original hostname.
 *  - Redirects are never followed; the 3xx response is returned as-is.
 *  - The response body is capped at maxResponseBytes.
 *  - A single deadline (timeoutMs) covers connect, send and the whole response.
 */
function httpSend({ url, method, headers, bodyText, pinned, timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const payload = Buffer.from(bodyText, 'utf8');

    let settled = false;
    let timer;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const options = {
      protocol: url.protocol,
      hostname: host,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      agent: false,
      headers: { ...headers, 'Content-Length': payload.length },
      lookup(_hostname, lookupOptions, cb) {
        if (lookupOptions && lookupOptions.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      },
    };
    if (isHttps && !net.isIP(host)) options.servername = host;

    const req = lib.request(options, (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;

      const finish = () =>
        done(resolve, {
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          truncated,
          bytes: size,
        });

      res.on('data', (chunk) => {
        if (truncated) return;
        const room = maxResponseBytes - size;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          size += Math.max(room, 0);
          truncated = true;
          finish();
          res.destroy();
        } else {
          chunks.push(chunk);
          size += chunk.length;
        }
      });
      res.on('end', finish);
      res.on('error', (e) => (truncated ? finish() : done(reject, mapNetworkError(e))));
      res.on('aborted', () => done(reject, new AppError('CONNECTION_ERROR', 'Connection closed before the response finished', 502)));
    });

    timer = setTimeout(() => {
      done(reject, new AppError('TIMEOUT', `No response within ${Math.round(timeoutMs / 1000)}s`, 504));
      req.destroy();
    }, timeoutMs);

    req.on('error', (e) => done(reject, mapNetworkError(e)));
    req.end(payload);
  });
}

module.exports = { httpSend, mapNetworkError };
