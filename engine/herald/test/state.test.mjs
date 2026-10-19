import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRun, computeWindow } from '../herald.mjs';
import { mkWorkspace, rmWorkspace } from './helpers.mjs';

const BRIEF = join(dirname(fileURLToPath(import.meta.url)), '..', 'herald.mjs');

test('recordRun advances window, stamps the run, carries context forward', () => {
  const window = computeWindow({ last_window_end: '2026-07-05T09:00:00Z' }, new Date('2026-07-06T09:00:00Z'));
  const prev = { last_run_ts: '2026-07-05T09:00:05Z' };
  const next = recordRun(prev, window, [{ note: 'deferred PR #4' }], new Date('2026-07-06T09:00:10Z'));
  assert.equal(next.last_window_end, '2026-07-06T09:00:00Z');
  assert.equal(next.last_run_ts, '2026-07-06T09:00:10Z');
  assert.equal(next.previous_run_ts, '2026-07-05T09:00:05Z');
  assert.deepEqual(next.carry_context, [{ note: 'deferred PR #4' }]);
});

test('recordRun caps carry_context to 20 items', () => {
  const window = computeWindow(null, new Date('2026-07-06T09:00:00Z'));
  const many = Array.from({ length: 40 }, (_, i) => ({ note: `x${i}` }));
  const next = recordRun(null, window, many);
  assert.equal(next.carry_context.length, 20);
});

test('render CLI writes the artifact AND records the new run timestamp in state', () => {
  const root = mkWorkspace();
  try {
    const env = { ...process.env, DETENT_ROOT: root };
    // 1. assemble (no PRs — fetch will fail without gh, but that surfaces as a
    //    section error, not a crash; assemble still succeeds).
    const asm = spawnSync('node', [BRIEF, 'assemble', '--now', '2026-07-06T09:00:00Z'], { encoding: 'utf8', env });
    assert.equal(asm.status, 0, asm.stderr);
    const asmOut = JSON.parse(asm.stdout);
    assert.ok(existsSync(asmOut.brief_data));

    // 2. render -> writes HTML + records state.
    const rnd = spawnSync('node', [BRIEF, 'render', asmOut.brief_data, '--now', '2026-07-06T09:00:00Z'], { encoding: 'utf8', env });
    assert.equal(rnd.status, 0, rnd.stderr);
    const rndOut = JSON.parse(rnd.stdout);
    assert.ok(existsSync(rndOut.artifact), 'artifact written');
    assert.match(rndOut.artifact, /morning-brief-2026-07-06\.html$/);

    // State recorded.
    const statePath = join(root, '.local', 'brief-state.json');
    assert.ok(existsSync(statePath), 'brief-state.json written');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.last_window_end, '2026-07-06T09:00:00Z');
    assert.ok(state.last_run_ts);

    // 3. A second window now starts from the recorded end (continuity).
    const win = computeWindow(state, new Date('2026-07-07T09:00:00Z'));
    assert.equal(win.start, '2026-07-06T09:00:00Z');
    assert.equal(win.first_run, false);
  } finally { rmWorkspace(root); }
});

test('a forced --days run renders but does NOT advance state (ad-hoc sweep)', () => {
  const root = mkWorkspace();
  try {
    const env = { ...process.env, DETENT_ROOT: root };
    // Seed a recent daily cadence: last window ended 1 day ago.
    const seedState = JSON.parse(spawnSync('node', [BRIEF, 'assemble', '--now', '2026-07-05T09:00:00Z'], { encoding: 'utf8', env }).stdout);
    spawnSync('node', [BRIEF, 'render', seedState.brief_data, '--now', '2026-07-05T09:00:00Z'], { encoding: 'utf8', env });
    const before = JSON.parse(readFileSync(join(root, '.local', 'brief-state.json'), 'utf8'));

    // A forced 7-day sweep at a later time.
    const asm = JSON.parse(spawnSync('node', [BRIEF, 'assemble', '--days', '7', '--now', '2026-07-06T09:00:00Z'], { encoding: 'utf8', env }).stdout);
    assert.equal(asm.window.forced, true);
    const rnd = spawnSync('node', [BRIEF, 'render', asm.brief_data, '--now', '2026-07-06T09:00:00Z'], { encoding: 'utf8', env });
    assert.equal(rnd.status, 0, rnd.stderr);
    assert.equal(JSON.parse(rnd.stdout).recorded, null, 'forced run does not record');

    // State is exactly what the daily cadence left — the sweep did not advance it.
    const after = JSON.parse(readFileSync(join(root, '.local', 'brief-state.json'), 'utf8'));
    assert.equal(after.last_window_end, before.last_window_end);
  } finally { rmWorkspace(root); }
});

test('render --no-record leaves state untouched', () => {
  const root = mkWorkspace();
  try {
    const env = { ...process.env, DETENT_ROOT: root };
    const asm = JSON.parse(spawnSync('node', [BRIEF, 'assemble', '--now', '2026-07-06T09:00:00Z'], { encoding: 'utf8', env }).stdout);
    const rnd = spawnSync('node', [BRIEF, 'render', asm.brief_data, '--no-record'], { encoding: 'utf8', env });
    assert.equal(rnd.status, 0, rnd.stderr);
    assert.equal(existsSync(join(root, '.local', 'brief-state.json')), false, 'no state written');
    // But .plans artifact exists.
    assert.ok(readdirSync(join(root, '.plans')).some((f) => f.startsWith('morning-brief-')));
  } finally { rmWorkspace(root); }
});
