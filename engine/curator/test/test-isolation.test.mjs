// A test process must never open a browser or start a daemon in a state dir it did not pick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cli.mjs');

function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-isolation-')));
  const file = join(dir, 'plan.html');
  writeFileSync(file, '<!DOCTYPE html>\n<html><body><h1>review</h1></body></html>\n');
  return { dir, file, state: join(dir, 'state') };
}

function cli(args, env) {
  const base = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
  for (const k of ['CURATOR_NO_BROWSER', 'CURATOR_ALLOW_BROWSER', 'CURATOR_STATE_DIR']) delete base[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...base, ...env } });
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

test('open from a test process refuses to launch a browser, before any daemon starts', () => {
  const s = scratch();
  const r = cli(['open', s.file], { CURATOR_STATE_DIR: s.state });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /curator: refusing to open a browser from a test process; set CURATOR_NO_BROWSER=1 or CURATOR_ALLOW_BROWSER=1/);
  assert.ok(!existsSync(join(s.state, 'state.json')), 'no daemon was started');
});

test('open from a test process refuses to start a daemon without an explicit CURATOR_STATE_DIR', () => {
  const s = scratch();
  const r = cli(['open', s.file], { CURATOR_NO_BROWSER: '1', DETENT_ROOT: s.dir });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /CURATOR_STATE_DIR/);
  assert.ok(!existsSync(join(s.dir, '.local', 'curator', 'state.json')), 'no daemon was started');
});

test('curator stop terminates the daemon recorded in its state dir, and is a no-op when none runs', () => {
  const s = scratch();
  const env = { CURATOR_STATE_DIR: s.state, CURATOR_NO_BROWSER: '1' };
  const idle = cli(['stop'], env);
  assert.equal(idle.code, 0, idle.out);
  const open = cli(['open', s.file], env);
  assert.equal(open.code, 0, open.out);
  const pid = JSON.parse(readFileSync(join(s.state, 'state.json'), 'utf8')).pid;
  assert.ok(Number.isInteger(pid));
  try {
    const stop = cli(['stop'], env);
    assert.equal(stop.code, 0, stop.out);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the daemon is gone');
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
