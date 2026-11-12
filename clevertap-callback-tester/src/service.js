'use strict';

const { performance } = require('node:perf_hooks');
const { AppError } = require('./errors');
const { buildRequest, toCurl } = require('./templates');
const { validateCallbackUrl, validateMsgId, resolveHost } = require('./validate');
const { httpSend } = require('./http-send');
const { deriveProfileUrl } = require('./profile');

const DEFAULTS = {
  timeoutMs: 10_000,
  maxRequestBodyBytes: 16 * 1024,
  maxResponseBytes: 64 * 1024,
};

/** Renders the request that would be sent, without touching the network. */
function renderRequest(templates, { channel, status, callbackUrl, msgId, now = Date.now }) {
  const built = buildRequest(templates, channel, status, {
    callbackUrl,
    msgId,
    timestamp: Math.floor(now() / 1000),
  });
  const bodyText = JSON.stringify(built.body);
  return {
    method: built.method,
    url: callbackUrl,
    headers: built.headers,
    body: built.body,
    bodyText,
    curl: toCurl({ method: built.method, url: callbackUrl, headers: built.headers, bodyText }),
  };
}

/**
 * Validates the input, builds the callback payload, and POSTs it to the callback URL.
 * Nothing is stored. Throws AppError (with `.request` attached once the request is built).
 */
async function sendCallback(input, deps) {
  const {
    templates,
    options = {},
    resolver,
    now = Date.now,
    timeoutMs = DEFAULTS.timeoutMs,
    maxRequestBodyBytes = DEFAULTS.maxRequestBodyBytes,
    maxResponseBytes = DEFAULTS.maxResponseBytes,
  } = deps;

  const url = validateCallbackUrl(input.callbackUrl, options);
  const msgId = validateMsgId(input.msgId);

  const request = renderRequest(templates, {
    channel: input.channel,
    status: input.status,
    callbackUrl: url.href,
    msgId,
    now,
  });
  if (Buffer.byteLength(request.bodyText) > maxRequestBodyBytes) {
    throw new AppError('TOO_LARGE', `Request payload exceeds ${maxRequestBodyBytes} bytes`, 413);
  }
  const requestInfo = {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
    curl: request.curl,
  };

  try {
    const started = performance.now();
    const pinned = await resolveHost(url.hostname, {
      resolver,
      allowPrivate: options.allowPrivate,
      timeoutMs: Math.min(5000, timeoutMs),
    });
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) throw new AppError('TIMEOUT', `No response within ${Math.round(timeoutMs / 1000)}s`, 504);

    const res = await httpSend({
      url,
      method: request.method,
      headers: request.headers,
      bodyText: request.bodyText,
      pinned,
      timeoutMs: remaining,
      maxResponseBytes,
    });
    const durationMs = Math.round(performance.now() - started);

    const ok = res.status >= 200 && res.status < 300;
    let note = null;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location ? ` to ${res.headers.location}` : '';
      note = `The server answered with a redirect${location}. Redirects are not followed.`;
    }
    // Delivered/viewed/clicked: point to the profile where the event is recorded.
    const profileUrl = ok ? deriveProfileUrl(url.href, msgId, input.channel) : null;
    return {
      outcome: ok ? 'success' : 'http_error',
      durationMs,
      note,
      profileUrl,
      request: requestInfo,
      response: {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        body: res.body,
        truncated: res.truncated,
        bytes: res.bytes,
      },
    };
  } catch (e) {
    if (e instanceof AppError) e.request = requestInfo;
    throw e;
  }
}

module.exports = { DEFAULTS, renderRequest, sendCallback };
