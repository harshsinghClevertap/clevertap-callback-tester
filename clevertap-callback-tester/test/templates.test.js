'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  substitute,
  validateTemplates,
  loadTemplatesFile,
  buildRequest,
  listTemplates,
  toCurl,
} = require('../src/templates');

const TEMPLATES_FILE = path.join(__dirname, '..', 'templates.json');
const ctx = { callbackUrl: 'https://example.com/cb', msgId: 'a|b|c|d', timestamp: 1647441774 };

test('substitute: replaces MSG_ID inside a string', () => {
  assert.equal(substitute('id={{MSG_ID}}', ctx), 'id=a|b|c|d');
});

test('substitute: whole-string TIMESTAMP becomes a string', () => {
  assert.equal(substitute('{{TIMESTAMP}}', ctx), '1647441774');
});

test('substitute: TIMESTAMP:number becomes a JSON number', () => {
  assert.equal(substitute('{{TIMESTAMP:number}}', ctx), 1647441774);
});

test('substitute: works through nested arrays and objects', () => {
  const out = substitute({ a: [{ meta: '{{MSG_ID}}', ts: '{{TIMESTAMP:number}}' }] }, ctx);
  assert.deepEqual(out, { a: [{ meta: 'a|b|c|d', ts: 1647441774 }] });
});

test('substitute: tolerates spaces inside the braces', () => {
  assert.equal(substitute('{{ MSG_ID }}', ctx), 'a|b|c|d');
});

test('substitute: a msgId with quotes or backslashes cannot break the JSON', () => {
  const nasty = '","status":"hacked","x":"\\';
  const out = substitute({ statuses: [{ msgId: '{{MSG_ID}}', status: 'delivered' }] }, { ...ctx, msgId: nasty });
  assert.equal(out.statuses[0].msgId, nasty);
  assert.equal(out.statuses[0].status, 'delivered');
  assert.deepEqual(Object.keys(out.statuses[0]), ['msgId', 'status']);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('substitute: replacement text with $ patterns is inserted literally', () => {
  assert.equal(substitute('x{{MSG_ID}}y', { ...ctx, msgId: "$& $1 $'" }), "x$& $1 $'y");
});

test('substitute: unknown placeholder is an error', () => {
  assert.throws(() => substitute('{{NOPE}}', ctx), /Unknown placeholder/);
});

test('substitute: missing value is an error', () => {
  assert.throws(() => substitute('{{MSG_ID}}', { timestamp: 1 }), /No value available/);
});

test('substitute: number type inside a larger string is rejected', () => {
  assert.throws(() => substitute('ts={{TIMESTAMP:number}}', ctx), /whole string/);
});

test('substitute: non-string values pass through unchanged', () => {
  assert.deepEqual(substitute({ n: 1, b: true, z: null }, ctx), { n: 1, b: true, z: null });
});

test('shipped templates.json is valid and covers every required button', () => {
  const doc = loadTemplatesFile(TEMPLATES_FILE);
  assert.deepEqual(Object.keys(doc.channels.sms.statuses), ['delivered', 'clicked']);
  assert.deepEqual(Object.keys(doc.channels.whatsapp.statuses), ['delivered', 'viewed', 'clicked']);
});

test('SMS delivered payload matches the CleverTap format', () => {
  const doc = loadTemplatesFile(TEMPLATES_FILE);
  const req = buildRequest(doc, 'sms', 'delivered', ctx);
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.deepEqual(req.body, [
    { event: 'delivered', data: [{ ts: 1647441774, meta: 'a|b|c|d', description: 'Delivered to handset' }] },
  ]);
});

test('SMS clicked payload carries url, shortUrl and meta', () => {
  const doc = loadTemplatesFile(TEMPLATES_FILE);
  const [evt] = buildRequest(doc, 'sms', 'clicked', ctx).body;
  assert.equal(evt.event, 'clicked');
  assert.equal(evt.data[0].meta, 'a|b|c|d');
  assert.ok(evt.data[0].url && evt.data[0].shortUrl);
  assert.equal(typeof evt.data[0].ts, 'number');
});

test('WhatsApp delivered / viewed payloads use string timestamps and the right status', () => {
  const doc = loadTemplatesFile(TEMPLATES_FILE);
  const delivered = buildRequest(doc, 'whatsapp', 'delivered', ctx).body;
  assert.equal(delivered.payloadVersion, '0.1');
  assert.deepEqual(delivered.statuses[0], { msgId: 'a|b|c|d', status: 'delivered', timestamp: '1647441774' });
  const viewed = buildRequest(doc, 'whatsapp', 'viewed', ctx).body;
  assert.equal(viewed.statuses[0].status, 'read');
  assert.equal(viewed.statuses[0].msgId, 'a|b|c|d');
});

test('WhatsApp clicked payload uses Clicked status with numeric ts', () => {
  const doc = loadTemplatesFile(TEMPLATES_FILE);
  const s = buildRequest(doc, 'whatsapp', 'clicked', ctx).body.statuses[0];
  assert.equal(s.status, 'Clicked');
  assert.equal(s.msgId, 'a|b|c|d');
  assert.equal(s.ts, 1647441774);
});

test('buildRequest rejects unknown channels and statuses, including prototype keys', () => {
  const doc = loadTemplatesFile(TEMPLATES_FILE);
  assert.throws(() => buildRequest(doc, 'email', 'delivered', ctx), (e) => e.code === 'UNKNOWN_TEMPLATE');
  assert.throws(() => buildRequest(doc, 'sms', 'viewed', ctx), (e) => e.code === 'UNKNOWN_TEMPLATE');
  assert.throws(() => buildRequest(doc, '__proto__', 'x', ctx), (e) => e.code === 'UNKNOWN_TEMPLATE');
  assert.throws(() => buildRequest(doc, 'sms', 'constructor', ctx), (e) => e.code === 'UNKNOWN_TEMPLATE');
  assert.throws(() => buildRequest(doc, undefined, undefined, ctx), (e) => e.code === 'UNKNOWN_TEMPLATE');
});

test('validateTemplates rejects broken definitions', () => {
  assert.throws(() => validateTemplates({}), /channels/);
  assert.throws(() => validateTemplates({ channels: {} }), /no channels/);
  const base = (req) => ({ channels: { c: { label: 'C', statuses: { s: { label: 'S', request: req } } } } });
  assert.throws(() => validateTemplates(base({ method: 'GET', body: {} })), /method/);
  assert.throws(() => validateTemplates(base({ method: 'POST', body: 'text' })), /body/);
  assert.throws(() => validateTemplates(base({ method: 'POST', body: { a: 1 } })), /MSG_ID/);
  assert.doesNotThrow(() => validateTemplates(base({ method: 'POST', body: { a: '{{MSG_ID}}' } })));
});

test('listTemplates exposes labels but not request bodies', () => {
  const doc = loadTemplatesFile(TEMPLATES_FILE);
  const list = listTemplates(doc);
  assert.equal(list.channels.sms.label, 'SMS');
  assert.deepEqual(list.channels.whatsapp.statuses.map((s) => s.key), ['delivered', 'viewed', 'clicked']);
  assert.equal(JSON.stringify(list).includes('payloadVersion'), false);
});

test('toCurl quotes single quotes safely', () => {
  const curl = toCurl({
    method: 'POST',
    url: 'https://example.com/a?b=1',
    headers: { 'Content-Type': 'application/json' },
    bodyText: JSON.stringify({ m: "it's" }),
  });
  assert.match(curl, /^curl -X POST 'https:\/\/example\.com\/a\?b=1'/);
  assert.match(curl, /-H 'Content-Type: application\/json'/);
  assert.ok(curl.includes(`--data-raw '{"m":"it'\\''s"}'`));
});
