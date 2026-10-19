import { test } from 'node:test';
import assert from 'node:assert';
import { computeWindow, DEFAULT_LOOKBACK_HOURS } from '../herald.mjs';

test('first run (no state) defaults to the lookback window', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const w = computeWindow(null, now);
  assert.equal(w.first_run, true);
  assert.equal(w.hours, DEFAULT_LOOKBACK_HOURS);
  assert.equal(w.end, '2026-07-06T09:00:00Z');
  assert.equal(w.start, '2026-07-05T09:00:00Z');
});

test('first run when state exists but has no last_window_end', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const w = computeWindow({ last_run_ts: null }, now);
  assert.equal(w.first_run, true);
  assert.equal(w.hours, DEFAULT_LOOKBACK_HOURS);
});

test('normal run: window is last_window_end -> now', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const w = computeWindow({ last_window_end: '2026-07-05T09:00:00Z' }, now);
  assert.equal(w.first_run, false);
  assert.equal(w.start, '2026-07-05T09:00:00Z');
  assert.equal(w.end, '2026-07-06T09:00:00Z');
  assert.equal(w.hours, 24);
});

test('multi-day gap (weekend/leave) widens the window automatically, no special-casing', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  // last brief ran 3 days earlier (Fri before a long weekend).
  const w = computeWindow({ last_window_end: '2026-07-03T09:00:00Z' }, now);
  assert.equal(w.first_run, false);
  assert.equal(w.start, '2026-07-03T09:00:00Z');
  assert.equal(w.hours, 72);
});

test('clock skew / future state never yields a negative window', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const w = computeWindow({ last_window_end: '2026-07-10T09:00:00Z' }, now);
  assert.equal(w.first_run, true); // fell back to default lookback
  assert.equal(w.hours, DEFAULT_LOOKBACK_HOURS);
  assert.ok(Date.parse(w.start) <= Date.parse(w.end));
});

test('invalid now throws loudly (no silent default)', () => {
  assert.throws(() => computeWindow(null, 'not-a-date'), /invalid 'now'/);
});

test('--days N forces the past N days, ignoring the persisted anchor', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  // Even with a recent anchor, an explicit 3-day override wins.
  const w = computeWindow({ last_window_end: '2026-07-06T05:00:00Z' }, now, DEFAULT_LOOKBACK_HOURS,
    { forceLookbackHours: 72 });
  assert.equal(w.forced, true);
  assert.equal(w.first_run, false);
  assert.equal(w.start, '2026-07-03T09:00:00Z');
  assert.equal(w.end, '2026-07-06T09:00:00Z');
  assert.equal(w.hours, 72);
});

test('forceLookbackHours of 0 or negative is ignored (falls back to normal window)', () => {
  const now = new Date('2026-07-06T09:00:00Z');
  const w = computeWindow({ last_window_end: '2026-07-05T09:00:00Z' }, now, DEFAULT_LOOKBACK_HOURS,
    { forceLookbackHours: 0 });
  assert.equal(w.forced, undefined);
  assert.equal(w.hours, 24);
});
