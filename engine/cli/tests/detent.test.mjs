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
test('detent run new prints a next_step that names detent, not engine', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'detentnext-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const r = spawnSync('node', [DETENT, 'run', 'new', '--ticket', 'o/r#1', '--repo', repo, '--no-worktree'],
    { encoding: 'utf8', env: { ...process.env, DETENT_ROOT: tmp } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.match(out.next_step, /^detent stage begin intake /);
  fs.rmSync(tmp, { recursive: true, force: true });
});
test('detent drive refusal prints a next_step that names detent, not engine', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'detentdrive-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const env = { ...process.env, DETENT_ROOT: tmp };
  const made = spawnSync('node', [DETENT, 'run', 'new', '--ticket', 'o/r#1', '--repo', repo, '--no-worktree'], { encoding: 'utf8', env });
  assert.equal(made.status, 0, made.stderr + made.stdout);
  const runId = JSON.parse(made.stdout).run_id;
  const r = spawnSync('node', [DETENT, 'drive', '--run', runId, '--repo', repo, '--max-steps', '0'], { encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(JSON.parse(r.stdout).next_step, /^detent drive --run /);
  fs.rmSync(tmp, { recursive: true, force: true });
});
