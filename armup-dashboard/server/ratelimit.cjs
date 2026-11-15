/*
 * ratelimit.cjs -- remember recent failures (wrong passwords, wrong invite
 * codes) and say "too many tries" once a key has had too many.
 *
 * In memory, so it resets when the server restarts. That is fine for one
 * server instance; more than one instance would need a shared store.
 */
function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key -> [timestamps of recent failures]

  const recent = (key) => {
    const cutoff = now() - windowMs;
    const list = (hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };

  return {
    // Seconds to wait before trying again, or 0 when allowed.
    blockedFor(key) {
      const list = recent(key);
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000));
    },
    fail(key) {
      const list = recent(key);
      list.push(now());
      hits.set(key, list);
      // keep the map from growing without bound
      if (hits.size > 10000) hits.delete(hits.keys().next().value);
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createLimiter };
