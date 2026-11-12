'use strict';

// End-to-end tests against a throwaway local HTTP server.
// Local targets need the developer-only allowHttp + allowPrivate switches; the default
// (production) behaviour of refusing them is covered in the SSRF tests below.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { loadTemplatesFile } = require('../src/templates');
const { sendCallback } = require('../src/service');
const { createServer } = require('../server');

const templates = loadTemplatesFile(path.join(__dirname, '..', 'templates.json'));
const DEV = { allowHttp: true, allowPrivate: true };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

async function withTarget(handler, fn) {
  const received = [];
  const target = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      handler(req, res, received);
    });
  });
  const port = await listen(target);
  try {
    await fn({ base: `http://127.0.0.1:${port}`, received });
  } finally {
    await close(target);
  }
}

const base = (extra = {}) => ({ templates, options: DEV, ...extra });

test('sends the SMS delivered payload and reports the response', async () => {
  await withTarget((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"success","processed":1}'); }, async ({ base: url, received }) => {
    const out = await sendCallback({ channel: 'sms', status: 'delivered', callbackUrl: `${url}/cb?x=1`, msgId: '9999.1200.wzrk_default.-1.' }, base());
    assert.equal(out.outcome, 'success');
    assert.equal(out.response.status, 200);
    assert.equal(JSON.parse(out.response.body).processed, 1);
    assert.equal(typeof out.durationMs, 'number');
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/cb?x=1');
    assert.equal(received[0].headers['content-type'], 'application/json');
    const body = JSON.parse(received[0].body);
    assert.equal(body[0].event, 'delivered');
    assert.equal(body[0].data[0].meta, '9999.1200.wzrk_default.-1.');
    assert.match(String(body[0].data[0].ts), /^\d{10}$/);
    assert.match(out.request.curl, /^curl -X POST 'http:\/\/127\.0\.0\.1:\d+\/cb\?x=1'/);
  });
});

test('sends WhatsApp viewed with a fresh string timestamp', async () => {
  await withTarget((_req, res) => { res.end('ok'); }, async ({ base: url, received }) => {
    const before = Math.floor(Date.now() / 1000);
    await sendCallback({ channel: 'whatsapp', status: 'viewed', callbackUrl: url, msgId: 'i|1|2|j' }, base());
    const s = JSON.parse(received[0].body).statuses[0];
    assert.equal(s.msgId, 'i|1|2|j');
    assert.equal(s.status, 'read');
    assert.equal(typeof s.timestamp, 'string');
    assert.ok(Number(s.timestamp) >= before && Number(s.timestamp) <= before + 5);
  });
});

test('non-2xx responses are returned as http_error, not thrown', async () => {
  await withTarget((_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"status":"fail"}'); }, async ({ base: url }) => {
    const out = await sendCallback({ channel: 'sms', status: 'clicked', callbackUrl: url, msgId: 'm1' }, base());
    assert.equal(out.outcome, 'http_error');
    assert.equal(out.response.status, 400);
    assert.equal(out.response.body, '{"status":"fail"}');
  });
});

test('redirects are not followed', async () => {
  await withTarget((req, res, received) => {
    if (req.url === '/final') { res.end('should never be requested'); return; }
    res.writeHead(302, { Location: '/final' });
    res.end();
  }, async ({ base: url, received }) => {
    const out = await sendCallback({ channel: 'sms', status: 'delivered', callbackUrl: `${url}/start`, msgId: 'm1' }, base());
    assert.equal(out.response.status, 302);
    assert.equal(out.outcome, 'http_error');
    assert.match(out.note, /not followed/);
    assert.equal(received.length, 1);
    assert.equal(received.some((r) => r.url === '/final'), false);
  });
});

test('large responses are truncated at the cap', async () => {
  await withTarget((_req, res) => { res.end('x'.repeat(200_000)); }, async ({ base: url }) => {
    const out = await sendCallback({ channel: 'sms', status: 'delivered', callbackUrl: url, msgId: 'm1' }, base({ maxResponseBytes: 1000 }));
    assert.equal(out.response.truncated, true);
    assert.equal(out.response.body.length, 1000);
  });
});

test('a server that never answers hits the timeout', async () => {
  await withTarget(() => { /* never respond */ }, async ({ base: url }) => {
    const started = Date.now();
    await assert.rejects(
      sendCallback({ channel: 'sms', status: 'delivered', callbackUrl: url, msgId: 'm1' }, base({ timeoutMs: 300 })),
      (e) => e.code === 'TIMEOUT' && e.status === 504 && /curl -X POST/.test(e.request.curl),
    );
    assert.ok(Date.now() - started < 3000);
  });
});

test('connection refused is reported as CONNECTION_ERROR', async () => {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe); // port is now closed
  await assert.rejects(
    sendCallback({ channel: 'sms', status: 'delivered', callbackUrl: `http://127.0.0.1:${port}/`, msgId: 'm1' }, base()),
    (e) => e.code === 'CONNECTION_ERROR',
  );
});

test('DNS failure is reported as DNS_FAILURE', async () => {
  const resolver = async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; };
  await assert.rejects(
    sendCallback({ channel: 'sms', status: 'delivered', callbackUrl: 'https://no-such-host.example/cb', msgId: 'm1' }, { templates, resolver }),
    (e) => e.code === 'DNS_FAILURE',
  );
});

test('empty msgId and bad URL are rejected before any network activity', async () => {
  await assert.rejects(sendCallback({ channel: 'sms', status: 'delivered', callbackUrl: 'https://example.com', msgId: '  ' }, { templates }), (e) => e.code === 'INVALID_MSG_ID');
  await assert.rejects(sendCallback({ channel: 'sms', status: 'delivered', callbackUrl: 'nope', msgId: 'm1' }, { templates }), (e) => e.code === 'INVALID_URL');
});

test('SSRF: production defaults refuse local and private destinations', async () => {
  const input = (callbackUrl) => ({ channel: 'sms', status: 'delivered', callbackUrl, msgId: 'm1' });
  await assert.rejects(sendCallback(input('http://127.0.0.1/'), { templates }), (e) => e.code === 'INVALID_URL'); // http refused
  await assert.rejects(sendCallback(input('https://127.0.0.1/'), { templates }), (e) => e.code === 'BLOCKED_ADDRESS');
  await assert.rejects(sendCallback(input('https://localhost/'), { templates }), (e) => e.code === 'BLOCKED_ADDRESS');
  await assert.rejects(sendCallback(input('https://169.254.169.254/latest/meta-data/'), { templates }), (e) => e.code === 'BLOCKED_ADDRESS');
  await assert.rejects(sendCallback(input('https://[::1]/'), { templates }), (e) => e.code === 'BLOCKED_ADDRESS');
  await assert.rejects(sendCallback(input('https://[::ffff:7f00:1]/'), { templates }), (e) => e.code === 'BLOCKED_ADDRESS');
  const rebinding = async () => [{ address: '10.0.0.7', family: 4 }];
  await assert.rejects(sendCallback(input('https://innocent.example/'), { templates, resolver: rebinding }), (e) => e.code === 'BLOCKED_ADDRESS');
});

test('the connection is pinned to the resolved address, not re-resolved', async () => {
  await withTarget((_req, res) => res.end('pinned'), async ({ base: url }) => {
    const port = new URL(url).port;
    const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    // The hostname does not exist in real DNS; only the injected resolver can make this work.
    const out = await sendCallback(
      { channel: 'sms', status: 'delivered', callbackUrl: `http://made-up-host.invalid:${port}/`, msgId: 'm1' },
      base({ resolver }),
    );
    assert.equal(out.response.body, 'pinned');
  });
});

// ---------- HTTP API ----------

async function withApp(overrides, fn) {
  const server = createServer({ allowHttp: true, allowPrivate: true, ...overrides });
  const port = await listen(server);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await close(server);
  }
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('API: serves the page, templates list and health check', async () => {
  await withApp({}, async (app) => {
    const page = await fetch(`${app}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /CleverTap Callback Tester/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const list = await (await fetch(`${app}/api/templates`)).json();
    assert.deepEqual(list.channels.sms.statuses.map((s) => s.key), ['delivered', 'clicked']);
    assert.equal((await fetch(`${app}/healthz`)).status, 200);
    assert.equal((await fetch(`${app}/../package.json`)).status, 404);
    assert.equal((await fetch(`${app}/templates.json`)).status, 404);
  });
});

test('API: /api/send end to end', async () => {
  await withTarget((_req, res) => { res.writeHead(200); res.end('received'); }, async ({ base: url, received }) => {
    await withApp({}, async (app) => {
      const res = await post(`${app}/api/send`, { channel: 'whatsapp', status: 'delivered', callbackUrl: url, msgId: 'i|1|2|j' });
      assert.equal(res.status, 200);
      const { result } = await res.json();
      assert.equal(result.response.status, 200);
      assert.equal(result.response.body, 'received');
      assert.equal(JSON.parse(received[0].body).statuses[0].msgId, 'i|1|2|j');
    });
  });
});

test('API: validation errors come back as structured JSON', async () => {
  await withApp({}, async (app) => {
    let res = await post(`${app}/api/send`, { channel: 'sms', status: 'delivered', callbackUrl: 'nope', msgId: 'm' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_URL');
    res = await post(`${app}/api/send`, { channel: 'sms', status: 'delivered', callbackUrl: 'https://example.com', msgId: '' });
    assert.equal((await res.json()).error.code, 'INVALID_MSG_ID');
    res = await post(`${app}/api/send`, { channel: 'sms', status: 'viewed', callbackUrl: 'https://example.com', msgId: 'm' });
    assert.equal((await res.json()).error.code, 'UNKNOWN_TEMPLATE');
  });
});

test('API: preview builds the payload without sending anything', async () => {
  await withApp({}, async (app) => {
    const res = await post(`${app}/api/preview`, { channel: 'sms', status: 'clicked', callbackUrl: '', msgId: 'abc' });
    assert.equal(res.status, 200);
    const { request } = await res.json();
    assert.equal(request.method, 'POST');
    assert.equal(request.body[0].data[0].meta, 'abc');
    assert.match(request.curl, /YOUR_CALLBACK_URL/);
    const blank = await (await post(`${app}/api/preview`, { channel: 'sms', status: 'clicked', msgId: '' })).json();
    assert.equal(blank.request.body[0].data[0].meta, 'MSG_ID_HERE');
  });
});

test('API: bad bodies, wrong methods and oversized bodies', async () => {
  await withApp({}, async (app) => {
    assert.equal((await post(`${app}/api/send`, 'not json')).status, 400);
    assert.equal((await post(`${app}/api/send`, '[1,2]')).status, 400);
    assert.equal((await fetch(`${app}/api/send`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
    assert.equal((await fetch(`${app}/api/send`)).status, 405);
    const big = await post(`${app}/api/send`, { channel: 'sms', status: 'delivered', callbackUrl: 'https://example.com', msgId: 'x'.repeat(20_000) });
    assert.equal(big.status, 413);
    assert.equal((await fetch(`${app}/api/nope`)).status, 404);
  });
});

test('API: cross-origin POSTs are refused', async () => {
  await withApp({}, async (app) => {
    const res = await post(`${app}/api/send`, { channel: 'sms', status: 'delivered', callbackUrl: 'https://example.com', msgId: 'm' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'FORBIDDEN_ORIGIN');
  });
});

test('API: rate limit returns 429 with Retry-After', async () => {
  await withApp({ rateLimitPerMinute: 3 }, async (app) => {
    const body = { channel: 'sms', status: 'delivered', callbackUrl: 'nope', msgId: 'm' };
    for (let i = 0; i < 3; i += 1) assert.equal((await post(`${app}/api/send`, body)).status, 400);
    const limited = await post(`${app}/api/send`, body);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
  });
});

test('API: production defaults block private destinations over the API', async () => {
  await withApp({ allowHttp: false, allowPrivate: false }, async (app) => {
    const res = await post(`${app}/api/send`, { channel: 'sms', status: 'delivered', callbackUrl: 'https://169.254.169.254/', msgId: 'm' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BLOCKED_ADDRESS');
  });
});
