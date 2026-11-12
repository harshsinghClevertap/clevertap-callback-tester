'use strict';

const net = require('node:net');
const dns = require('node:dns').promises;
const { AppError } = require('./errors');

const MAX_URL_LENGTH = 2048;
const MAX_MSG_ID_LENGTH = 512;

// ---------------------------------------------------------------------------
// Blocked address ranges (SSRF protection)
// ---------------------------------------------------------------------------
const blockList = new net.BlockList();
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];
const BLOCKED_V6 = [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [addr, prefix] of BLOCKED_V4) blockList.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of BLOCKED_V6) blockList.addSubnet(addr, prefix, 'ipv6');

/** Parses any valid IPv6 text form into eight 16-bit groups, or null. */
function parseIPv6(input) {
  let ip = String(input).split('%')[0];
  let tail = [];
  const lastColon = ip.lastIndexOf(':');
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    if (!net.isIPv4(maybeV4)) return null;
    const o = maybeV4.split('.').map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups;
  if (parts.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  if (tail.length) {
    nums[6] = tail[0];
    nums[7] = tail[1];
  }
  return nums;
}

/** True when the address must never be contacted (or is not a valid IP at all). */
function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blockList.check(ip, 'ipv4');
  if (family === 6) {
    const g = parseIPv6(ip);
    if (!g) return true;
    // IPv4-mapped (::ffff:a.b.c.d, also written ::ffff:7f00:1): judge the embedded IPv4 address.
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return isBlockedIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    return blockList.check(ip, 'ipv6');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateMsgId(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('INVALID_MSG_ID', 'msgId is required', 400);
  }
  const msgId = raw.trim();
  if (msgId.length > MAX_MSG_ID_LENGTH) {
    throw new AppError('INVALID_MSG_ID', `msgId must be at most ${MAX_MSG_ID_LENGTH} characters`, 400);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(msgId)) {
    throw new AppError('INVALID_MSG_ID', 'msgId must not contain control characters', 400);
  }
  return msgId;
}

/**
 * Syntactic checks on the callback URL. Returns a parsed URL.
 * Hostname resolution (and the private-address check) happens separately in resolveHost().
 */
function validateCallbackUrl(raw, { allowHttp = false, allowPrivate = false } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('INVALID_URL', 'Callback URL is required', 400);
  }
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH) {
    throw new AppError('INVALID_URL', `Callback URL must be at most ${MAX_URL_LENGTH} characters`, 400);
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new AppError('INVALID_URL', 'Callback URL is not a valid URL (include https://)', 400);
  }
  const okProtocol = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (!okProtocol) {
    throw new AppError('INVALID_URL', allowHttp ? 'Callback URL must use http:// or https://' : 'Callback URL must use https://', 400);
  }
  if (url.username || url.password) {
    throw new AppError('INVALID_URL', 'Callback URL must not contain a username or password', 400);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new AppError('INVALID_URL', 'Callback URL has no host', 400);
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw new AppError('BLOCKED_ADDRESS', 'localhost is not allowed as a callback host', 400);
  }
  return url;
}

function withTimeout(promise, ms, makeError) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolves the host and refuses private/reserved destinations.
 * Returns the address to connect to; the caller must pin the connection to it,
 * which stops DNS rebinding between this check and the actual request.
 */
async function resolveHost(hostname, { resolver, allowPrivate = false, timeoutMs = 5000 } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    const lookup = resolver || ((h) => dns.lookup(h, { all: true, verbatim: true }));
    try {
      addresses = await withTimeout(
        Promise.resolve().then(() => lookup(host)),
        timeoutMs,
        () => new AppError('DNS_FAILURE', `DNS lookup for "${host}" timed out`, 502),
      );
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('DNS_FAILURE', `DNS lookup failed for "${host}" (${e.code || e.message})`, 502);
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new AppError('DNS_FAILURE', `DNS lookup for "${host}" returned no addresses`, 502);
  }
  addresses = addresses.map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a));
  if (!allowPrivate) {
    for (const a of addresses) {
      if (isBlockedIp(a.address)) {
        throw new AppError(
          'BLOCKED_ADDRESS',
          `"${host}" resolves to a private or reserved address (${a.address}), which is not allowed`,
          400,
        );
      }
    }
  }
  // Prefer IPv4: many hosts have no IPv6 egress.
  addresses.sort((a, b) => a.family - b.family);
  return addresses[0];
}

module.exports = {
  MAX_URL_LENGTH,
  MAX_MSG_ID_LENGTH,
  isBlockedIp,
  validateMsgId,
  validateCallbackUrl,
  resolveHost,
};
