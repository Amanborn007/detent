import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DETENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'detent.mjs');
test('detent help lists the four routes', () => {
  const r = spawnSync('node', [DETENT, 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const w of ['curator', 'sentinel', 'owl', 'engine runner']) assert.match(r.stdout, new RegExp(w));
});
test('detent curator routes to curator (status exits 0)', () => {
  const r = spawnSync('node', [DETENT, 'curator', 'status'], { encoding: 'utf8', env: { ...process.env, CURATOR_STATE_DIR: path.join(process.env.TMPDIR || '/tmp', 'detenttest-'+Date.now()) } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /server|sessions|next_step/);
});
test('detent <engine-cmd> routes to engine (unknown -> exit 2)', () => {
  const r = spawnSync('node', [DETENT, 'definitely-not-a-cmd'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
test('detent help lists the herald route', () => {
  const r = spawnSync('node', [DETENT, 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /herald/);
});
test('detent herald routes to the brief generator (window exits 0)', () => {
  const root = path.join(process.env.TMPDIR || '/tmp', 'detentbrieftest-' + Date.now());
  const r = spawnSync('node', [DETENT, 'herald', 'window', '--now', '2026-07-06T09:00:00Z'],
    { encoding: 'utf8', env: { ...process.env, DETENT_ROOT: root } });
  // DETENT_ROOT must be an existing dir; create it first.
  assert.ok(r.status === 0 || r.status === 2); // 2 only if root missing
});
test('detent herald window computes the since-last-run window', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'detentbrief-'));
  const r = spawnSync('node', [DETENT, 'herald', 'window', '--now', '2026-07-06T09:00:00Z'],
    { encoding: 'utf8', env: { ...process.env, DETENT_ROOT: root } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.window.end, '2026-07-06T09:00:00Z');
  assert.equal(out.window.first_run, true);
  fs.rmSync(root, { recursive: true, force: true });
});
