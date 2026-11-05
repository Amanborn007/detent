// A test process must not start a daemon unless it opts in, and a daemon it starts must die with its owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';

const CURATOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(CURATOR_DIR, 'cli.mjs');
const SERVER = join(CURATOR_DIR, 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-daemon-iso-')));
  const file = join(dir, 'plan.html');
  writeFileSync(file, '<!DOCTYPE html>\n<html><body><h1>review</h1></body></html>\n');
  return { dir, file, state: join(dir, 'state') };
}

function env(extra, { testProcess = true } = {}) {
  const base = { ...process.env };
  for (const k of ['CURATOR_NO_BROWSER', 'CURATOR_ALLOW_BROWSER', 'CURATOR_ALLOW_DAEMON', 'CURATOR_OWNER_PID', 'CURATOR_STATE_DIR', 'BROWSER']) delete base[k];
  if (testProcess) base.NODE_TEST_CONTEXT = 'child-v8'; else delete base.NODE_TEST_CONTEXT;
  return { ...base, ...extra };
}

function cli(args, e) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: e });
  return { code: r.status, out: r.stdout + r.stderr };
}

function recordedPid(state) {
  const f = join(state, 'state.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).pid : null;
}

function reap(state) {
  const pid = recordedPid(state);
  if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

test('open from a test process refuses to start a daemon unless CURATOR_ALLOW_DAEMON=1', () => {
  const s = scratch();
  try {
    const r = cli(['open', s.file], env({ CURATOR_STATE_DIR: s.state, CURATOR_NO_BROWSER: '1' }));
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /CURATOR_ALLOW_DAEMON=1/);
    assert.equal(recordedPid(s.state), null, 'no daemon was started');
  } finally { reap(s.state); }
});

test('the daemon entrypoint itself refuses to start in a test process without CURATOR_ALLOW_DAEMON=1', () => {
  const s = scratch();
  const r = spawnSync(process.execPath, [SERVER, '--daemon'], { encoding: 'utf8', timeout: 5000, env: env({ CURATOR_STATE_DIR: s.state }) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /CURATOR_ALLOW_DAEMON=1/);
});

test('open from a test process without CURATOR_STATE_DIR is refused before it contacts a daemon in the default state dir', async () => {
  const s = scratch();
  const dflt = join(s.dir, '.local', 'curator');
  mkdirSync(dflt, { recursive: true, mode: 0o700 });
  const hits = [];
  const live = createHttpServer((req, res) => { hits.push(req.url); res.end('{}'); });
  await new Promise((r) => live.listen(0, '127.0.0.1', r));
  writeFileSync(join(dflt, 'state.json'), JSON.stringify({ pid: process.pid, port: live.address().port }));
  try {
    const child = spawn(process.execPath, [CLI, 'open', s.file], { env: env({ CURATOR_NO_BROWSER: '1', DETENT_ROOT: s.dir }) });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const code = await new Promise((r) => child.on('close', r));
    assert.notEqual(code, 0, out);
    assert.match(out, /CURATOR_STATE_DIR/);
    assert.deepEqual(hits, [], 'open already talked to the daemon in the default state dir');
  } finally { live.close(); }
});

test('a daemon started with CURATOR_OWNER_PID exits within 5s of its owner dying', async () => {
  const s = scratch();
  const parent = join(s.dir, 'parent.mjs');
  writeFileSync(parent, `import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'open', ${JSON.stringify(s.file)}], { encoding: 'utf8', env: { ...process.env, CURATOR_OWNER_PID: String(process.pid) } });
if (r.status !== 0) { console.error(r.stdout + r.stderr); process.exit(1); }
console.log('ready');
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'pipe'],
    env: env({ CURATOR_STATE_DIR: s.state, CURATOR_NO_BROWSER: '1', CURATOR_ALLOW_DAEMON: '1' }) });
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  try {
    await new Promise((res, rej) => {
      child.stdout.on('data', (c) => /ready/.test(String(c)) && res());
      child.on('exit', () => rej(new Error(`parent exited early: ${err}`)));
      setTimeout(() => rej(new Error(`parent never became ready: ${err}`)), 15000);
    });
    const pid = recordedPid(s.state);
    assert.ok(Number.isInteger(pid) && alive(pid), 'daemon is running');
    child.kill('SIGKILL');
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
    assert.ok(!alive(pid), 'daemon is still alive 5s after its owner died');
  } finally { child.kill('SIGKILL'); reap(s.state); }
});

test('a daemon refuses a CURATOR_OWNER_PID that is not a pid', () => {
  const s = scratch();
  const r = spawnSync(process.execPath, [SERVER, '--daemon'], { encoding: 'utf8', timeout: 5000,
    env: env({ CURATOR_STATE_DIR: s.state, CURATOR_ALLOW_DAEMON: '1', CURATOR_OWNER_PID: 'abc' }) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /CURATOR_OWNER_PID/);
});

test('a CURATOR_OWNER_PID from outside a test process never reaches the daemon', async () => {
  const s = scratch();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  try {
    const r = cli(['open', s.file], env({ CURATOR_STATE_DIR: s.state, CURATOR_NO_BROWSER: '1', CURATOR_OWNER_PID: dead }, { testProcess: false }));
    assert.equal(r.code, 0, r.out);
    const pid = recordedPid(s.state);
    await sleep(3500);
    assert.ok(alive(pid), 'the daemon honoured an owner pid it should never have been given');
  } finally {
    cli(['stop'], env({ CURATOR_STATE_DIR: s.state }, { testProcess: false }));
    reap(s.state);
  }
});

test('BROWSER=none/true/false/empty keeps open from launching a browser; unset still launches one', async () => {
  const s = scratch();
  const bin = join(s.dir, 'bin');
  const log = join(s.dir, 'opened.log');
  mkdirSync(bin);
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $@" >> "${log}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const e = (extra) => env({ CURATOR_STATE_DIR: s.state, CURATOR_ALLOW_BROWSER: '1', CURATOR_ALLOW_DAEMON: '1',
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, ...extra });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  try {
    for (const value of ['none', 'true', 'false', '']) {
      const r = cli(['open', s.file], e({ BROWSER: value }));
      assert.equal(r.code, 0, r.out);
      await sleep(500);
      assert.equal(calls(), '', `BROWSER=${JSON.stringify(value)} still launched a browser`);
    }
    const r = cli(['open', s.file], e({}));
    assert.equal(r.code, 0, r.out);
    for (let i = 0; i < 40 && !calls(); i++) await sleep(100);
    assert.match(calls(), /^(open|xdg-open) /, 'with BROWSER unset the opener should run');
  } finally {
    cli(['stop'], e({ CURATOR_NO_BROWSER: '1' }));
    reap(s.state);
  }
});
