'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedIp, validateCallbackUrl, validateMsgId, resolveHost } = require('../src/validate');

const code = (c) => (e) => e.code === c;

// ---------- validateCallbackUrl ----------

test('accepts a normal https URL with path and query', () => {
  const url = validateCallbackUrl('https://webhook.site/abc-123?x=1');
  assert.equal(url.hostname, 'webhook.site');
});

test('trims surrounding whitespace', () => {
  assert.equal(validateCallbackUrl('  https://example.com/cb  ').href, 'https://example.com/cb');
});

test('rejects empty, non-string and oversized values', () => {
  assert.throws(() => validateCallbackUrl(''), code('INVALID_URL'));
  assert.throws(() => validateCallbackUrl('   '), code('INVALID_URL'));
  assert.throws(() => validateCallbackUrl(undefined), code('INVALID_URL'));
  assert.throws(() => validateCallbackUrl(42), code('INVALID_URL'));
  assert.throws(() => validateCallbackUrl(`https://example.com/${'a'.repeat(2100)}`), code('INVALID_URL'));
});

test('rejects text that is not a URL', () => {
  assert.throws(() => validateCallbackUrl('not a url'), code('INVALID_URL'));
  assert.throws(() => validateCallbackUrl('example.com/cb'), code('INVALID_URL'));
});

test('rejects http by default and other schemes always', () => {
  assert.throws(() => validateCallbackUrl('http://example.com/cb'), /https/);
  for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://example.com', 'data:text/plain,hi']) {
    assert.throws(() => validateCallbackUrl(bad, { allowHttp: true }), code('INVALID_URL'), bad);
  }
});

test('allowHttp opts in to http for local development', () => {
  assert.equal(validateCallbackUrl('http://example.com/cb', { allowHttp: true }).protocol, 'http:');
});

test('rejects credentials embedded in the URL', () => {
  assert.throws(() => validateCallbackUrl('https://user:pass@example.com/'), /username or password/);
  assert.throws(() => validateCallbackUrl('https://user@example.com/'), /username or password/);
});

test('rejects localhost names unless allowPrivate is set', () => {
  assert.throws(() => validateCallbackUrl('https://localhost/cb'), code('BLOCKED_ADDRESS'));
  assert.throws(() => validateCallbackUrl('https://LOCALHOST:8443/cb'), code('BLOCKED_ADDRESS'));
  assert.throws(() => validateCallbackUrl('https://api.localhost/cb'), code('BLOCKED_ADDRESS'));
  assert.doesNotThrow(() => validateCallbackUrl('https://localhost/cb', { allowPrivate: true }));
});

// ---------- validateMsgId ----------

test('validateMsgId trims and accepts CleverTap style ids', () => {
  assert.equal(validateMsgId('  25596363|1639561857|20220227|25596363 '), '25596363|1639561857|20220227|25596363');
  assert.equal(validateMsgId('9999999999.1200000000.1654002362.20220531.0.wzrk_default.-1.'), '9999999999.1200000000.1654002362.20220531.0.wzrk_default.-1.');
});

test('validateMsgId rejects empty, non-string, huge and control characters', () => {
  assert.throws(() => validateMsgId(''), code('INVALID_MSG_ID'));
  assert.throws(() => validateMsgId('   '), code('INVALID_MSG_ID'));
  assert.throws(() => validateMsgId(null), code('INVALID_MSG_ID'));
  assert.throws(() => validateMsgId(123), code('INVALID_MSG_ID'));
  assert.throws(() => validateMsgId('x'.repeat(513)), code('INVALID_MSG_ID'));
  assert.throws(() => validateMsgId('a\nb'), code('INVALID_MSG_ID'));
  assert.throws(() => validateMsgId('a\u0000b'), code('INVALID_MSG_ID'));
});

// ---------- isBlockedIp ----------

test('blocks private, loopback, link-local and reserved IPv4', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '100.64.0.1', '127.0.0.1', '127.1.2.3',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1',
    '192.0.2.5', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, ip);
});

test('allows ordinary public IPv4 (including just outside private ranges)', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '11.0.0.1', '100.63.255.255', '100.128.0.1', '193.0.0.1']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('blocks private and special IPv6', () => {
  for (const ip of ['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('allows public IPv6', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isBlockedIp(ip), false, ip);
});

test('IPv4-mapped IPv6 is judged by the embedded IPv4 address (both spellings)', () => {
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIp('::ffff:7f00:1'), true);
  assert.equal(isBlockedIp('::ffff:10.1.2.3'), true);
  assert.equal(isBlockedIp('::ffff:a9fe:a9fe'), true); // 169.254.169.254
  assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
  assert.equal(isBlockedIp('::ffff:808:808'), false);
});

test('anything that is not an IP is treated as blocked', () => {
  assert.equal(isBlockedIp('example.com'), true);
  assert.equal(isBlockedIp(''), true);
  assert.equal(isBlockedIp('999.1.1.1'), true);
});

test('URL parser normalises tricky IP spellings, which are then blocked', () => {
  for (const raw of ['https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://127.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/']) {
    const url = validateCallbackUrl(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    assert.equal(isBlockedIp(host), true, `${raw} -> ${host}`);
  }
});

// ---------- resolveHost (resolver injected, no network) ----------

test('resolveHost returns a public address and pins the first one', async () => {
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const a = await resolveHost('example.com', { resolver });
  assert.deepEqual(a, { address: '93.184.216.34', family: 4 });
});

test('resolveHost rejects a name that resolves to a private address', async () => {
  const resolver = async () => [{ address: '10.0.0.5', family: 4 }];
  await assert.rejects(resolveHost('internal.example.com', { resolver }), code('BLOCKED_ADDRESS'));
});

test('resolveHost rejects when ANY returned address is private (mixed answers)', async () => {
  const resolver = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ];
  await assert.rejects(resolveHost('sneaky.example.com', { resolver }), code('BLOCKED_ADDRESS'));
});

test('resolveHost rejects IPv6 loopback answers', async () => {
  const resolver = async () => [{ address: '::1', family: 6 }];
  await assert.rejects(resolveHost('v6.example.com', { resolver }), code('BLOCKED_ADDRESS'));
});

test('resolveHost rejects literal private IPs without any DNS lookup', async () => {
  const resolver = async () => { throw new Error('should not be called'); };
  await assert.rejects(resolveHost('192.168.0.10', { resolver }), code('BLOCKED_ADDRESS'));
  await assert.rejects(resolveHost('[::1]', { resolver }), code('BLOCKED_ADDRESS'));
});

test('resolveHost accepts a literal public IP without any DNS lookup', async () => {
  const resolver = async () => { throw new Error('should not be called'); };
  const a = await resolveHost('8.8.8.8', { resolver });
  assert.equal(a.address, '8.8.8.8');
});

test('resolveHost prefers IPv4 when both families are returned', async () => {
  const resolver = async () => [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ];
  assert.equal((await resolveHost('dual.example.com', { resolver })).address, '1.1.1.1');
});

test('resolveHost maps DNS errors to DNS_FAILURE', async () => {
  const resolver = async () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; };
  await assert.rejects(resolveHost('missing.example.com', { resolver }), (e) => e.code === 'DNS_FAILURE' && /ENOTFOUND/.test(e.message));
});

test('resolveHost maps empty answers and slow lookups to DNS_FAILURE', async () => {
  await assert.rejects(resolveHost('empty.example.com', { resolver: async () => [] }), code('DNS_FAILURE'));
  const slow = () => new Promise(() => {});
  await assert.rejects(resolveHost('slow.example.com', { resolver: slow, timeoutMs: 50 }), (e) => e.code === 'DNS_FAILURE' && /timed out/.test(e.message));
});

test('allowPrivate lets local development targets through', async () => {
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  assert.equal((await resolveHost('dev.local', { resolver, allowPrivate: true })).address, '127.0.0.1');
});
