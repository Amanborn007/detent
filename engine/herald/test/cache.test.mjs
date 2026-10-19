import { test } from 'node:test';
import assert from 'node:assert';
import { emptyReadCache, markSeen, hasSeen } from '../herald.mjs';

test('markSeen splits fresh vs already-seen and marks the fresh ones', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const r1 = markSeen(emptyReadCache(), 'mail', ['a', 'b', 'c'], now);
  assert.deepEqual(r1.fresh, ['a', 'b', 'c']);
  assert.deepEqual(r1.already, []);

  // Second pass: a,b already seen; d is new.
  const r2 = markSeen(r1.cache, 'mail', ['a', 'b', 'd'], now);
  assert.deepEqual(r2.fresh, ['d']);
  assert.deepEqual(r2.already, ['a', 'b']);
});

test('memoization is per-source: same id under a different source is fresh', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const r1 = markSeen(emptyReadCache(), 'mail', ['x'], now);
  const r2 = markSeen(r1.cache, 'chat', ['x'], now);
  assert.deepEqual(r2.fresh, ['x']);
});

test('hasSeen reflects what markSeen recorded', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const { cache } = markSeen(emptyReadCache(), 'tickets', ['ABC-1'], now);
  assert.equal(hasSeen(cache, 'tickets', 'ABC-1'), true);
  assert.equal(hasSeen(cache, 'tickets', 'ABC-2'), false);
});

test('markSeen tolerates a null/empty cache and empty ids', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const r = markSeen(null, 'mail', [], now);
  assert.deepEqual(r.fresh, []);
  assert.equal(r.cache.schema, 'brief-read-cache-v0');
});
