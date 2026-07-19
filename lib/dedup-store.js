import crypto from 'crypto';

export function buildDedupKey({ type, chatId, pageId, message, automation_name, idempotencyKey }) {
  if (idempotencyKey) return `explicit:${idempotencyKey}`;
  const payload = `${type}|${chatId}|${pageId}|${message ?? ''}|${automation_name ?? ''}`;
  return 'auto:' + crypto.createHash('sha1').update(payload).digest('hex');
}

export class DedupStore {
  constructor({ windowMs, now = () => Date.now(), map = new Map() } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('DedupStore requires a positive windowMs');
    }
    this.windowMs = windowMs;
    this.now = now;
    this.map = map;
  }

  get size() {
    return this.map.size;
  }

  entries() {
    return this.map.entries();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (this.isStaleCompleted(entry)) {
      this.map.delete(key);
      return null;
    }
    return entry;
  }

  setInFlight(key, promise) {
    this.map.set(key, { promise });
  }

  markSent(key, result) {
    const existing = this.map.get(key);
    const promise = existing?.promise ?? Promise.resolve(result);
    this.map.set(key, { promise, result, completedAt: this.now() });
  }

  clear(key) {
    this.map.delete(key);
  }

  isStaleCompleted(entry, now = this.now()) {
    return !!entry.completedAt && now - entry.completedAt > this.windowMs;
  }

  cleanup(now = this.now()) {
    let removed = 0;
    for (const [key, entry] of this.map.entries()) {
      if (this.isStaleCompleted(entry, now)) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

export function summarizeDedupEntries(store, { limit = 100, now = Date.now() } = {}) {
  const safeLimit = Math.max(0, Math.min(Number(limit) || 0, 1000));
  const entries = [];
  let count = 0;
  let cachedCount = 0;
  let inFlightCount = 0;
  let staleCompletedCount = 0;

  for (const [key, entry] of store.entries()) {
    count++;
    const state = entry.completedAt ? 'cached' : 'in-flight';
    if (state === 'cached') cachedCount++;
    else inFlightCount++;
    if (entry.completedAt && store.isStaleCompleted(entry, now)) staleCompletedCount++;

    if (entries.length < safeLimit) {
      entries.push({
        keyDigest: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
        state,
        ageMs: entry.completedAt ? now - entry.completedAt : undefined,
        sent: entry.result?.sent ?? undefined
      });
    }
  }

  const omitted = Math.max(0, count - entries.length);
  return {
    ok: true,
    windowMs: store.windowMs,
    count,
    cachedCount,
    inFlightCount,
    staleCompletedCount,
    returned: entries.length,
    omitted,
    hasMore: omitted > 0,
    entries
  };
}
