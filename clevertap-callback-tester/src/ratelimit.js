'use strict';

/**
 * Sliding-window rate limiter kept in memory (nothing is persisted).
 * check(key) -> { allowed, remaining, retryAfterSec }
 */
function createRateLimiter({ limit = 30, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map(); // key -> array of timestamps (ms)

  function prune(list, t) {
    const cutoff = t - windowMs;
    let i = 0;
    while (i < list.length && list[i] <= cutoff) i += 1;
    if (i > 0) list.splice(0, i);
  }

  const sweeper = setInterval(() => {
    const t = now();
    for (const [key, list] of hits) {
      prune(list, t);
      if (list.length === 0) hits.delete(key);
    }
  }, windowMs);
  sweeper.unref();

  return {
    check(key) {
      const t = now();
      let list = hits.get(key);
      if (!list) {
        list = [];
        hits.set(key, list);
      }
      prune(list, t);
      if (list.length >= limit) {
        const retryAfterSec = Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
        return { allowed: false, remaining: 0, retryAfterSec };
      }
      list.push(t);
      return { allowed: true, remaining: limit - list.length, retryAfterSec: 0 };
    },
    close() {
      clearInterval(sweeper);
      hits.clear();
    },
  };
}

module.exports = { createRateLimiter };
