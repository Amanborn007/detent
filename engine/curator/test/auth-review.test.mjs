// Follow-ups from the security review of the curator authentication.
//
//   keys are bound to one server boot:  C = HMAC(S, "curator-session:" + boot + ":" + id), R likewise with
//   "curator-artifact:". `boot` is the random id GET /healthz reports.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync, chmodSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';

import { SessionStore, createServer } from '../server.mjs';

const CURATOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(CURATOR_DIR, 'cli.mjs');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'curator-review-')));
let counter = 0;
const fresh = (name) => {
  const dir = join(base, `${name}-${counter++}`);
  mkdirSync(dir);
  return dir;
};
const hmac = (secret, label) => crypto.createHmac('sha256', secret).update(label).digest('hex');
const toKill = new Set();
after(() => {
  for (const pid of toKill) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

function makeArtifact(dir, name = 'plan.html') {
  const file = join(dir, name);
  writeFileSync(file, '<!DOCTYPE html>\n<html><body><h1>review</h1></body></html>\n');
  return realpathSync(file);
}

function raw(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const cliEnv = (stateDir, extra = {}) => ({ ...process.env, CURATOR_STATE_DIR: stateDir, CURATOR_NO_BROWSER: '1', ...extra });
const lastJson = (s) => JSON.parse(s.trim().split('\n').pop());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

async function listen(store, secret) {
  const server = createServer(store, { secret });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const hz = await raw(port, { path: '/healthz?nonce=0123456789abcdef0123456789abcdef' });
  return { server, port, boot: JSON.parse(hz.text).boot };
}

// --- H1: keys die with the server that issued them -----------------------------------------

test('a key issued by one server boot is refused by the next boot that shares its secret and state', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const store = new SessionStore();
  const file = makeArtifact(fresh('h1'));
  const s = store.open(file);
  const a = await listen(store, secret);
  const b = await listen(store, secret);
  try {
    assert.match(a.boot, /^[0-9a-f]{32}$/, 'healthz reports a boot id');
    assert.notEqual(a.boot, b.boot);
    const C = (boot) => hmac(secret, `curator-session:${boot}:${s.id}`);
    const R = (boot) => hmac(secret, `curator-artifact:${boot}:${s.id}`);
    const headers = (port, boot) => ({ 'X-Curator-Cap': C(boot), Origin: `http://127.0.0.1:${port}` });

    const own = await raw(a.port, { method: 'POST', path: `/api/send?s=${s.id}`, headers: headers(a.port, a.boot), body: { items: [{ type: 'comment', text: 'x' }] } });
    assert.equal(own.code, 200, 'the boot-bound key works on its own server');
    const replay = await raw(b.port, { method: 'POST', path: `/api/send?s=${s.id}`, headers: headers(b.port, a.boot), body: { items: [{ type: 'comment', text: 'y' }] } });
    assert.equal(replay.code, 401, 'server A\'s C on server B');
    assert.equal((await raw(b.port, { path: `/api/updates?s=${s.id}`, headers: { 'X-Curator-Cap': C(a.boot) } })).code, 401);
    assert.equal((await raw(b.port, { path: `/artifact/${s.id}?k=${R(a.boot)}` })).code, 401, 'server A\'s R on server B');
    assert.equal((await raw(b.port, { path: `/artifact/${s.id}?k=${R(b.boot)}` })).code, 200);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('the page clears its fragment, and tells the user to reopen when its server is gone', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const store = new SessionStore();
  const s = store.open(makeArtifact(fresh('page')));
  const { server, port } = await listen(store, secret);
  try {
    const page = (await raw(port, { path: `/s/${s.id}` })).text;
    assert.match(page, /history\.replaceState\(/, 'the keys leave the address bar once read');
    assert.match(page, /earlier curator server/i, 'a 401 tells the user to reopen');
  } finally {
    server.close();
  }
});

// --- H2: the keys never appear in an argv --------------------------------------------------

test('the browser is launched on a local file, never on a url carrying the keys', async (t) => {
  const dir = fresh('launch');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'argv.log');
  const seen = join(dir, 'seen.html');
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\ncat "$1" >> "${seen}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const stateDir = join(dir, 'state');
  const file = makeArtifact(dir);
  const env = { ...process.env, CURATOR_STATE_DIR: stateDir, PATH: `${bin}:${process.env.PATH}` };
  delete env.CURATOR_NO_BROWSER;
  const r = await runCli(['open', file], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  toKill.add(JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')).pid);
  for (let i = 0; i < 40 && !(existsSync(seen) && readFileSync(seen, 'utf8').includes('</script>')); i++) await sleep(100);
  if (!existsSync(log)) return t.skip(`no browser launcher on ${process.platform}`);
  const argv = readFileSync(log, 'utf8');
  assert.doesNotMatch(argv, /[#&?]?[cr]=[0-9a-f]{16}/, `keys in argv: ${argv}`);
  assert.doesNotMatch(argv, /127\.0\.0\.1/, 'the url itself is not in argv either');
  assert.match(readFileSync(seen, 'utf8'), /location\.replace\(.*#c=[0-9a-f]{64}&r=[0-9a-f]{64}/, 'the launcher page carries the url');
});

// --- M1: a pre-authentication server left in ~/.curator -------------------------------------

function stubDaemon(root) {
  const dir = join(root, 'engine', 'curator');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'server.mjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script, '--daemon'], { stdio: 'ignore' });
  toKill.add(child.pid);
  return child;
}

test('curator open stops a curator daemon recorded in the legacy ~/.curator', async () => {
  const dir = fresh('legacy');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.curator'), { recursive: true });
  const old = stubDaemon(join(dir, 'other-clone'));
  await sleep(200);
  writeFileSync(join(home, '.curator', 'state.json'), JSON.stringify({ pid: old.pid, port: 9, sessions: {} }));
  const exited = new Promise((r) => old.on('exit', r));
  const stateDir = join(dir, 'state');
  const r = await runCli(['open', makeArtifact(dir)], cliEnv(stateDir, { HOME: home }));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  toKill.add(JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')).pid);
  await Promise.race([exited, sleep(4000).then(() => { throw new Error('the legacy daemon was not stopped'); })]);
});

test('curator open warns loudly, and kills nothing, when the legacy pid is not a curator daemon', async () => {
  const dir = fresh('legacywarn');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.curator'), { recursive: true });
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  toKill.add(bystander.pid);
  await sleep(200);
  writeFileSync(join(home, '.curator', 'state.json'), JSON.stringify({ pid: bystander.pid, port: 9, sessions: {} }));
  const stateDir = join(dir, 'state');
  const r = await runCli(['open', makeArtifact(dir)], cliEnv(stateDir, { HOME: home }));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  toKill.add(JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')).pid);
  const out = lastJson(r.stdout);
  assert.ok(out.warnings.some((w) => w.includes(String(bystander.pid))), JSON.stringify(out.warnings));
  assert.ok(alive(bystander.pid));
});

// --- L1: a credential that is not 64 hex characters is a 401 --------------------------------

test('a multibyte credential of the right length is a 401, not a 500', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const store = new SessionStore();
  const s = store.open(makeArtifact(fresh('l1')));
  const { server, port } = await listen(store, secret);
  try {
    const wide = 'é'.repeat(64);
    assert.equal((await raw(port, { path: '/api/status', headers: { Authorization: `Bearer ${wide}` } })).code, 401);
    assert.equal((await raw(port, { path: `/api/updates?s=${s.id}`, headers: { 'X-Curator-Cap': wide } })).code, 401);
    assert.equal((await raw(port, { path: `/artifact/${s.id}?k=${encodeURIComponent(wide)}` })).code, 401);
  } finally {
    server.close();
  }
});

// --- L2: only this clone's own daemon is ever signalled -------------------------------------

test('open does not signal a process whose command line merely contains server.mjs --daemon', async () => {
  const dir = fresh('l2');
  const decoyDir = join(dir, 'other');
  mkdirSync(decoyDir);
  const decoy = join(decoyDir, 'server.mjs');
  writeFileSync(decoy, `import http from 'node:http';
const s = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ ok: true, pid: process.pid })); });
s.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: s.address().port }) + '\\n'));
`);
  const child = spawn(process.execPath, [decoy, '--daemon']);
  toKill.add(child.pid);
  const port = await new Promise((r) => child.stdout.once('data', (c) => r(JSON.parse(String(c)).port)));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(join(stateDir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ pid: child.pid, port, sessions: {} }), { mode: 0o600 });
  const r = await runCli(['open', makeArtifact(dir)], cliEnv(stateDir));
  assert.equal(r.code, 1, r.stdout);
  await sleep(300);
  assert.ok(alive(child.pid), 'the decoy must still be running');
});

// --- L3: ancestors of the state dir ---------------------------------------------------------

test('a group-writable parent of the state dir, below HOME, is refused', async () => {
  const dir = fresh('l3');
  const home = join(dir, 'home');
  const parent = join(home, 'a');
  mkdirSync(parent, { recursive: true });
  chmodSync(home, 0o700);
  chmodSync(parent, 0o770);
  const stateDir = join(parent, 'state');
  const r = await runCli(['status'], cliEnv(stateDir, { HOME: home }));
  assert.equal(r.code, 1, r.stdout);
  assert.ok(lastJson(r.stdout).error.includes(parent), r.stdout);
  assert.ok(!existsSync(join(stateDir, 'secret')));
});

// --- L4: the parent page only listens to its own frame --------------------------------------

test('the chrome page accepts messages only from its iframe and asks before queueing an artifact prompt', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const store = new SessionStore();
  const s = store.open(makeArtifact(fresh('l4')));
  const { server, port } = await listen(store, secret);
  try {
    const page = (await raw(port, { path: `/s/${s.id}` })).text;
    assert.match(page, /ev\.source\s*!==\s*frame\.contentWindow/);
    assert.match(page, /window\.confirm\([^)]*(page|artifact)[^)]*\)[\s\S]{0,200}enqueue\(\{ type: 'prompt'/);
  } finally {
    server.close();
  }
});
