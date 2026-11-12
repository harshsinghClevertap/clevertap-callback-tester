'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/ratelimit');

test('allows up to the limit, then blocks with a retry hint', () => {
  let t = 1_000_000;
  const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, true);
  const third = rl.check('a');
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const fourth = rl.check('a');
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterSec >= 1 && fourth.retryAfterSec <= 60);
  rl.close();
});

test('limits are tracked per key', () => {
  const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 5 });
  assert.equal(rl.check('ip-1').allowed, true);
  assert.equal(rl.check('ip-1').allowed, false);
  assert.equal(rl.check('ip-2').allowed, true);
  rl.close();
});

test('requests are allowed again once they age out of the window', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  t = 30_000;
  assert.equal(rl.check('a').allowed, true);
  t = 59_000;
  assert.equal(rl.check('a').allowed, false);
  t = 60_001; // first hit has expired, second has not
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, false);
  rl.close();
});
