import assert from 'node:assert/strict';
import test from 'node:test';

import { DedupStore, buildDedupKey, summarizeDedupEntries } from '../lib/dedup-store.js';

test('DedupStore evicts stale completed entries during cleanup without removing fresh or in-flight entries', () => {
  let now = 10_000;
  const store = new DedupStore({ windowMs: 1_000, now: () => now });

  store.setInFlight('in-flight', Promise.resolve({ ok: true }));
  store.markSent('fresh', { sent: true });

  now = 8_000;
  store.markSent('stale', { sent: true });

  now = 10_000;
  const removed = store.cleanup();

  assert.equal(removed, 1);
  assert.equal(store.get('stale'), null);
  assert.ok(store.get('fresh'));
  assert.ok(store.get('in-flight'));
  assert.equal(store.size, 2);
});

test('DedupStore get lazily evicts stale completed entries but keeps duplicate safety within window', () => {
  let now = 1_000;
  const store = new DedupStore({ windowMs: 600, now: () => now });

  store.markSent('sent', { sent: true, ok: true });
  now = 1_500;
  assert.deepEqual(store.get('sent')?.result, { sent: true, ok: true });

  now = 1_601;
  assert.equal(store.get('sent'), null);
  assert.equal(store.size, 0);
});

test('summarizeDedupEntries caps returned entries and reports omitted/stale counts without exposing raw keys', () => {
  const now = 50_000;
  const store = new DedupStore({ windowMs: 1_000, now: () => now });

  store.markSent('fresh-a', { sent: true });
  store.markSent('fresh-b', { sent: true });
  store.setInFlight('in-flight', Promise.resolve({ ok: true }));

  store.map.set('stale-a', {
    promise: Promise.resolve({ sent: true }),
    result: { sent: true },
    completedAt: now - 5_000
  });

  const summary = summarizeDedupEntries(store, { limit: 2, now });

  assert.equal(summary.count, 4);
  assert.equal(summary.returned, 2);
  assert.equal(summary.omitted, 2);
  assert.equal(summary.staleCompletedCount, 1);
  assert.equal(summary.hasMore, true);
  assert.equal(summary.entries.length, 2);
  assert.deepEqual(Object.keys(summary.entries[0]).sort(), ['ageMs', 'keyDigest', 'sent', 'state']);
  assert.equal(summary.entries[0].key, undefined);
});

test('buildDedupKey preserves explicit idempotency and hashes automatic payloads', () => {
  assert.equal(buildDedupKey({ idempotencyKey: 'abc-123' }), 'explicit:abc-123');

  const first = buildDedupKey({ type: 'text', chatId: 'c1', pageId: 'p1', message: 'hi' });
  const second = buildDedupKey({ type: 'text', chatId: 'c1', pageId: 'p1', message: 'hi' });
  const changed = buildDedupKey({ type: 'text', chatId: 'c1', pageId: 'p1', message: 'bye' });

  assert.match(first, /^auto:[a-f0-9]{40}$/);
  assert.equal(first, second);
  assert.notEqual(first, changed);
});
