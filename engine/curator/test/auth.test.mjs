// Authentication of the local curator server, over real processes and real HTTP.
//
// Helpers are deliberately not imported from the server: the HMACs are computed
// here with node:crypto and the secret is read straight off disk, so these tests
// pin the wire contract rather than the implementation.
//
//   secret S       $STATE_DIR/secret, 64 hex chars. Agent credential: Authorization: Bearer S.
//   R(id)          HMAC-SHA256(S, "curator-artifact:" + id), the `k` query on /artifact/<id>.
//   C(id)          HMAC-SHA256(S, "curator-session:" + id), the X-Curator-Cap header on browser routes.
//   healthz proof  HMAC-SHA256(S, "curator-healthz:" + nonce) for GET /healthz?nonce=<nonce>.
//   browser routes identify the session with ?s=<id>; agent routes identify the file with `key`.
//
// Cases that already pass on main (a foreign Host name) are kept as regression guards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync, chmodSync, symlinkSync, statSync, existsSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const CURATOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(CURATOR_DIR, 'cli.mjs');
const SERVER = join(CURATOR_DIR, 'server.mjs');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'curator-auth-')));
let counter = 0;
const fresh = (name) => {
  const dir = join(base, `${name}-${counter++}`);
  mkdirSync(dir);
  return dir;
};

const hmac = (secret, label) => crypto.createHmac('sha256', secret).update(label).digest('hex');
const R = (secret, id) => hmac(secret, `curator-artifact:${id}`);
const C = (secret, id) => hmac(secret, `curator-session:${id}`);

const toKill = new Set();
after(() => {
  for (const pid of toKill) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

function readSecret(stateDir) {
  const file = join(stateDir, 'secret');
  assert.ok(existsSync(file), `no secret file at ${file}: the server never created a credential`);
  return readFileSync(file, 'utf8').trim();
}

function makeArtifact(dir, name = 'plan.html') {
  const file = join(dir, name);
  writeFileSync(file, '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>auth</title></head>\n<body><h1>SECRET-PLAN-TEXT</h1>\n<div data-plan-question="q1"><button data-plan-option="A">A</button></div></body></html>\n');
  return realpathSync(file);
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
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').pop());

function raw(port, { method = 'GET', path = '/', headers = {}, body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => {
      resolve({ code: 'timeout', headers: {}, text: '' });
      req.destroy();
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve({ code: 'reset', headers: {}, text: '' }) : reject(e)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const json = (r) => JSON.parse(r.text);
const JSON_CT = { 'Content-Type': 'application/json' };

function rawSocket(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let data = '';
    s.on('data', (c) => (data += c));
    s.on('close', () => resolve(data));
    s.on('error', reject);
    setTimeout(() => s.destroy(), 3000);
  });
}

// Starts `node server.mjs --daemon` directly, so the state-dir and secret checks are exercised without the CLI.
function startDaemon(stateDir, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, '--daemon'], { env: { ...process.env, CURATOR_STATE_DIR: stateDir, ...env } });
    toKill.add(child.pid);
    let out = '';
    let err = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done({ child, exited: false, stderr: err, timedOut: true }), 6000);
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('\n')) done({ child, exited: false, ...JSON.parse(out.split('\n')[0]), stderr: err });
    });
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => done({ child, exited: true, code, stderr: err }));
  });
}

// One real server and one open session shared by the HTTP-level tests.
const stateDir = join(fresh('main'), 'state');
const workDir = fresh('work');
const artifact = makeArtifact(workDir);
let port;
let sessionId;
let secret = '0'.repeat(64); // placeholder until the server has written the real one, so requests stay well-formed
let otherArtifact;
let otherSession;

async function openViaCli(file, dir = stateDir) {
  const r = await runCli(['open', file], cliEnv(dir));
  assert.equal(r.code, 0, `open failed: ${r.stdout}${r.stderr}`);
  return lastJson(r.stdout);
}

async function pendingCount(p, file) {
  const r = await raw(p, { path: '/api/status', headers: { Host: `127.0.0.1:${p}`, Authorization: `Bearer ${secret}` } });
  assert.equal(r.code, 200, `authenticated status failed: ${r.code} ${r.text}`);
  const row = json(r).sessions.find((s) => s.key === file);
  return row ? row.pending_feedback_items : 0;
}

const hostOf = () => `127.0.0.1:${port}`;
const cap = (id = sessionId) => C(secret, id);
const sendHeaders = (extra = {}) => ({ ...JSON_CT, Host: hostOf(), Origin: `http://${hostOf()}`, 'X-Curator-Cap': cap(), ...extra });
const ITEM = { type: 'decision', question: 'q1', answer: 'A' };

test('setup: open starts a server that created its secret', async () => {
  const opened = await openViaCli(artifact);
  port = Number(new URL(opened.url).port);
  sessionId = opened.session;
  toKill.add(JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')).pid);
  otherArtifact = makeArtifact(workDir, 'other.html');
  otherSession = (await openViaCli(otherArtifact)).session;
  const file = join(stateDir, 'secret');
  if (existsSync(file)) secret = readFileSync(file, 'utf8').trim();
  assert.match(readSecret(stateDir), /^[0-9a-f]{64}$/);
});

test('open prints a url whose fragment carries both keys, derived from the secret', async () => {
  const opened = await openViaCli(artifact);
  assert.equal(opened.url, `http://127.0.0.1:${port}/s/${sessionId}#c=${C(secret, sessionId)}&r=${R(secret, sessionId)}`);
});

test('unauthenticated reads are refused and leak nothing', async () => {
  for (const path of ['/api/status', `/api/poll?key=${encodeURIComponent(artifact)}`, `/artifact/${sessionId}`, `/artifact/${sessionId}?k=${'0'.repeat(64)}`, `/api/updates?s=${sessionId}`]) {
    const r = await raw(port, { path, headers: { Host: hostOf() }, timeoutMs: 1500 });
    assert.equal(r.code, 401, `${path} must be 401 without a credential, got ${r.code}`);
    assert.doesNotMatch(r.text, /SECRET-PLAN-TEXT/);
    assert.ok(!r.text.includes(sessionId), `${path} response must not echo a session id`);
    assert.ok(json(r).next_step, `${path} keeps the {error, next_step} contract`);
  }
});

test('unauthenticated answers are refused and the queue stays empty', async () => {
  const before = await pendingCount(port, artifact);
  for (const [path, body] of [
    [`/api/send?s=${sessionId}`, { sessionId, items: [ITEM] }],
    ['/api/send', { sessionId, items: [ITEM] }],
    ['/api/send', { key: artifact, items: [ITEM] }],
    [`/api/end?s=${sessionId}`, { sessionId, by: 'user' }],
    ['/api/reply', { key: artifact, message: 'hi' }],
    ['/api/open', { file: artifact }],
  ]) {
    const r = await raw(port, { method: 'POST', path, headers: { ...JSON_CT, Host: hostOf() }, body });
    assert.equal(r.code, 401, `POST ${path} without a credential must be 401, got ${r.code}`);
  }
  assert.equal(await pendingCount(port, artifact), before);
});

test('a request with no Host header is refused', async () => {
  const reply = await rawSocket(port, 'GET /healthz?nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HTTP/1.0\r\n\r\n');
  assert.match(reply, /^HTTP\/1\.[01] 403/, `expected 403, got: ${reply.slice(0, 80)}`);
});

test('a Host on another port is refused', async () => {
  const r = await raw(port, { path: '/healthz?nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', headers: { Host: `127.0.0.1:${port + 1}` } });
  assert.equal(r.code, 403);
  assert.match(json(r).error, /Host/);
});

test('regression guard (passes on main): a foreign Host name is refused', async () => {
  const r = await raw(port, { path: '/healthz?nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', headers: { Host: 'evil.example' } });
  assert.equal(r.code, 403);
});

test('healthz proves knowledge of the secret and needs a nonce', async () => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const r = await raw(port, { path: `/healthz?nonce=${nonce}`, headers: { Host: hostOf() } });
  assert.equal(r.code, 200);
  assert.equal(json(r).proof, hmac(secret, `curator-healthz:${nonce}`));
  const bare = await raw(port, { path: '/healthz', headers: { Host: hostOf() } });
  assert.equal(bare.code, 400, 'no nonce, no proof');
});

test('cross-origin POSTs are refused even with a valid key, and queue nothing', async () => {
  const before = await pendingCount(port, artifact);
  for (const origin of ['http://evil.example', `http://127.0.0.1:${port + 1}`, 'null', `http://localhost:${port}`]) {
    const r = await raw(port, { method: 'POST', path: `/api/send?s=${sessionId}`, headers: sendHeaders({ Origin: origin }), body: { sessionId, items: [ITEM] } });
    assert.equal(r.code, 403, `Origin ${origin} must be refused, got ${r.code}`);
  }
  assert.equal(await pendingCount(port, artifact), before);
});

test('OPTIONS is 405 with no CORS headers', async () => {
  const r = await raw(port, { method: 'OPTIONS', path: '/api/send', headers: { Host: hostOf(), Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.ok(r.code === 405 || r.code === 403, `got ${r.code}`);
  const own = await raw(port, { method: 'OPTIONS', path: '/api/send', headers: { Host: hostOf() } });
  assert.equal(own.code, 405);
  assert.deepEqual(Object.keys(own.headers).filter((h) => h.startsWith('access-control-')), []);
});

test('a no-cors replay (text/plain, key in the body) is refused with 403, or 401 when it hides its Origin', async () => {
  const before = await pendingCount(port, artifact);
  const body = JSON.stringify({ key: artifact, sessionId, items: [ITEM] });
  const withOrigin = await raw(port, { method: 'POST', path: '/api/send', headers: { 'Content-Type': 'text/plain', Host: hostOf(), Origin: 'http://evil.example' }, body });
  assert.equal(withOrigin.code, 403);
  const without = await raw(port, { method: 'POST', path: '/api/send', headers: { 'Content-Type': 'text/plain', Host: hostOf() }, body });
  assert.equal(without.code, 401);
  assert.equal(await pendingCount(port, artifact), before);
});

test('a credential of the wrong length is a 401, not an error', async () => {
  const cases = [
    { path: '/api/status', headers: { Authorization: 'Bearer abc' } },
    { path: '/api/status', headers: { Authorization: `Bearer ${secret}00` } },
    { path: `/api/updates?s=${sessionId}`, headers: { 'X-Curator-Cap': 'short' } },
    { path: `/artifact/${sessionId}?k=short` },
  ];
  for (const c of cases) {
    const r = await raw(port, { path: c.path, headers: { Host: hostOf(), ...(c.headers || {}) } });
    assert.equal(r.code, 401, `${c.path} ${JSON.stringify(c.headers)} -> ${r.code}`);
  }
});

test('an unauthenticated request with an invalid JSON body is a 401, not a 500', async () => {
  const r = await raw(port, { method: 'POST', path: `/api/send?s=${sessionId}`, headers: { ...JSON_CT, Host: hostOf() }, body: '{not json' });
  assert.equal(r.code, 401);
});

test('an authenticated POST that is not application/json is a 415', async () => {
  const r = await raw(port, { method: 'POST', path: `/api/send?s=${sessionId}`, headers: sendHeaders({ 'Content-Type': 'text/plain' }), body: JSON.stringify({ sessionId, items: [ITEM] }) });
  assert.equal(r.code, 415);
});

test('a valid key with a foreign Origin is refused on a GET too', async () => {
  const r = await raw(port, { path: `/api/updates?s=${sessionId}`, headers: { Host: hostOf(), Origin: 'http://evil.example', 'X-Curator-Cap': cap() } });
  assert.equal(r.code, 403);
});

test('the artifact key R is refused on /api/send, /api/end and /api/updates, and C is refused on /artifact', async () => {
  const rKey = R(secret, sessionId);
  const before = await pendingCount(port, artifact);
  const send = await raw(port, { method: 'POST', path: `/api/send?s=${sessionId}`, headers: sendHeaders({ 'X-Curator-Cap': rKey }), body: { sessionId, items: [ITEM] } });
  assert.equal(send.code, 401);
  const end = await raw(port, { method: 'POST', path: `/api/end?s=${sessionId}`, headers: sendHeaders({ 'X-Curator-Cap': rKey }), body: { sessionId, by: 'user' } });
  assert.equal(end.code, 401);
  const upd = await raw(port, { path: `/api/updates?s=${sessionId}`, headers: { Host: hostOf(), 'X-Curator-Cap': rKey } });
  assert.equal(upd.code, 401);
  const art = await raw(port, { path: `/artifact/${sessionId}?k=${C(secret, sessionId)}`, headers: { Host: hostOf() } });
  assert.equal(art.code, 401);
  assert.equal(await pendingCount(port, artifact), before);
});

test('a key for session A is refused on session B', async () => {
  const send = await raw(port, { method: 'POST', path: `/api/send?s=${otherSession}`, headers: sendHeaders({ 'X-Curator-Cap': C(secret, sessionId) }), body: { sessionId: otherSession, items: [ITEM] } });
  assert.equal(send.code, 401);
  const art = await raw(port, { path: `/artifact/${otherSession}?k=${R(secret, sessionId)}`, headers: { Host: hostOf() } });
  assert.equal(art.code, 401);
});

test('browser routes take a session and a key only, agent routes a file and a bearer only', async () => {
  const withKey = await raw(port, { method: 'POST', path: `/api/send?s=${sessionId}`, headers: sendHeaders(), body: { key: artifact, items: [ITEM] } });
  assert.equal(withKey.code, 400, 'send-by-key is gone');
  const bothCreds = await raw(port, { method: 'POST', path: `/api/end?s=${sessionId}`, headers: sendHeaders({ Authorization: `Bearer ${secret}` }), body: { by: 'user' } });
  assert.equal(bothCreds.code, 401, 'one credential per route');
  const replyById = await raw(port, { method: 'POST', path: '/api/reply', headers: { ...JSON_CT, Host: hostOf(), Authorization: `Bearer ${secret}` }, body: { sessionId, message: 'x' } });
  assert.equal(replyById.code, 400, 'reply-by-sessionId is gone');
  const bearerOnBrowserRoute = await raw(port, { path: `/api/updates?s=${sessionId}`, headers: { Host: hostOf(), Authorization: `Bearer ${secret}` } });
  assert.equal(bearerOnBrowserRoute.code, 401);
});

test('/api/open takes only .html files', async () => {
  const r = await raw(port, { method: 'POST', path: '/api/open', headers: { ...JSON_CT, Host: hostOf(), Authorization: `Bearer ${secret}` }, body: { file: join(workDir, 'notes.txt') } });
  assert.equal(r.code, 400);
});

test('the chrome page holds no key, sets only the iframe src from script, and carries the headers', async () => {
  const r = await raw(port, { path: `/s/${sessionId}`, headers: { Host: hostOf() } });
  assert.equal(r.code, 200);
  assert.match(r.text, /<iframe[^>]+sandbox="allow-scripts allow-forms"/);
  assert.doesNotMatch(r.text, /<iframe[^>]+\ssrc=/, 'the static iframe has no src');
  for (const k of [secret, C(secret, sessionId), R(secret, sessionId)]) assert.ok(!r.text.includes(k), 'no key in the page');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['content-security-policy'], "frame-ancestors 'self'");
});

test('a valid key works: the artifact loads, a send queues, a bearer lists it', async () => {
  const art = await raw(port, { path: `/artifact/${sessionId}?k=${R(secret, sessionId)}`, headers: { Host: hostOf() } });
  assert.equal(art.code, 200);
  assert.match(art.text, /SECRET-PLAN-TEXT/);
  assert.equal(art.text.split('/sdk.js?s=').length - 1, 1);
  assert.doesNotMatch(art.text, /sdk\.js\?s=[^"]*[?&]k=/, 'the injected script tag carries no key');
  assert.equal(art.headers['referrer-policy'], 'no-referrer');
  assert.equal(art.headers['content-security-policy'], "frame-ancestors 'self'");

  const upd = await raw(port, { path: `/api/updates?s=${sessionId}`, headers: { Host: hostOf(), 'X-Curator-Cap': cap() } });
  assert.equal(upd.code, 200);

  const before = await pendingCount(port, artifact);
  const send = await raw(port, { method: 'POST', path: `/api/send?s=${sessionId}`, headers: sendHeaders(), body: { sessionId, items: [ITEM] } });
  assert.equal(send.code, 200, send.text);
  assert.equal(await pendingCount(port, artifact), before + 1);
});

test('the CLI polls and drains with the secret', async () => {
  const poll = await runCli(['poll', artifact], cliEnv(stateDir));
  assert.equal(poll.code, 0, poll.stdout + poll.stderr);
  const got = lastJson(poll.stdout);
  assert.equal(got.status, 'feedback');
  assert.deepEqual(got.prompts, [ITEM]);

  const send = await raw(port, { method: 'POST', path: `/api/send?s=${sessionId}`, headers: sendHeaders(), body: { sessionId, items: [{ type: 'comment', text: 'again' }] } });
  assert.equal(send.code, 200);
  const drain = await runCli(['drain', artifact], cliEnv(stateDir));
  assert.equal(drain.code, 0, drain.stdout + drain.stderr);
  assert.ok(drain.stdout.includes('"again"'));
});

test('the CLI refuses to run, and does not regenerate, when the secret is missing under a live server', async () => {
  const dir = join(fresh('nosecret'), 'state');
  const file = makeArtifact(dirname(dir));
  await openViaCli(file, dir);
  toKill.add(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).pid);
  const s = join(dir, 'secret');
  assert.ok(existsSync(s), 'server wrote a secret');
  writeFileSync(join(dir, 'secret.bak'), readFileSync(s), { mode: 0o600 });
  unlinkSync(s);
  for (const args of [['poll', file], ['status'], ['open', file]]) {
    const r = await runCli(args, cliEnv(dir));
    assert.equal(r.code, 1, `${args[0]} must fail loudly: ${r.stdout}`);
    assert.match(lastJson(r.stdout).next_step, /stop the server, then .*curator open/i);
  }
  assert.ok(!existsSync(s), 'a live server\'s secret is never regenerated');
});

// --- impostors and legacy servers ------------------------------------------------

function startStub(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

async function impostorFixture({ proof }) {
  const dir = join(fresh('impostor'), 'state');
  mkdirSync(dir, { mode: 0o700 });
  const file = makeArtifact(dirname(dir));
  writeFileSync(join(dir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/healthz')) res.end(JSON.stringify({ ok: true, pid: process.pid, ...(proof === undefined ? {} : { proof }) }));
    else res.end(JSON.stringify({ status: 'feedback', prompts: [{ type: 'decision', question: 'q1', answer: 'forged' }], sessions: [] }));
  });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ pid: process.pid, port: stub.port, sessions: { [file]: { id: 'aaaa1111bbbb2222cccc3333', file, pending: [], ended: false, chat: [] } } }), { mode: 0o600 });
  return { dir, file, stub };
}

for (const [label, proof] of [['a bad proof', '0'.repeat(64)], ['no proof (a legacy server)', undefined]]) {
  test(`an impostor with ${label} gets no secret and its answers are refused`, async (t) => {
    const { dir, file, stub } = await impostorFixture({ proof });
    t.after(() => stub.server.close());
    for (const args of [['poll', file], ['drain', file], ['reply', file, '-m', 'hello'], ['end', file], ['status']]) {
      const r = await runCli(args, cliEnv(dir));
      assert.equal(r.code, 1, `${args[0]} must refuse: ${r.stdout}`);
      const out = lastJson(r.stdout);
      assert.ok(!r.stdout.includes('forged'), 'a forged answer is never printed');
      assert.match(out.next_step, /curator open/);
    }
    const nonHealth = stub.seen.filter((s) => !s.url.startsWith('/healthz'));
    assert.deepEqual(nonHealth, [], 'nothing but the healthz probe may reach an unproven server');
    assert.ok(stub.seen.every((s) => s.headers.authorization === undefined), 'the secret is never sent to an unproven server');
  });
}

test('open refuses to stop a process that is not a curator daemon', async (t) => {
  const { dir, file, stub } = await impostorFixture({ proof: undefined });
  t.after(() => stub.server.close());
  const r = await runCli(['open', file], cliEnv(dir));
  assert.equal(r.code, 1, r.stdout);
  assert.match(lastJson(r.stdout).error, /not a curator daemon/);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  assert.ok(stub.seen.every((s) => s.headers.authorization === undefined));
});

test('open replaces a legacy daemon that answers healthz without a proof', async () => {
  const dir = join(fresh('legacy'), 'state');
  const root = dirname(dir);
  const file = makeArtifact(root);
  const fakeDir = join(root, 'fake');
  mkdirSync(fakeDir);
  writeFileSync(join(fakeDir, 'server.mjs'), `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const stateDir = process.env.CURATOR_STATE_DIR;
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url.startsWith('/healthz') ? { ok: true, pid: process.pid } : { ok: true, sessionId: 'aa', key: 'x' }));
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ pid: process.pid, port: server.address().port, sessions: {} }), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, port: server.address().port }) + '\\n');
});
process.on('SIGTERM', () => process.exit(0));
`);
  const legacy = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(fakeDir, 'server.mjs'), '--daemon'], { env: { ...process.env, CURATOR_STATE_DIR: dir } });
    toKill.add(child.pid);
    child.stdout.once('data', (c) => resolve({ child, ...JSON.parse(String(c).split('\n')[0]) }));
  });
  const exited = new Promise((resolve) => legacy.child.on('exit', resolve));
  const opened = await openViaCli(file, dir);
  assert.match(opened.url, /#c=[0-9a-f]{64}&r=[0-9a-f]{64}$/);
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('the legacy daemon was not stopped')), 5000))]);
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.notEqual(state.pid, legacy.pid);
  toKill.add(state.pid);
});

// --- state directory and secret hygiene -----------------------------------------

test('the state dir is 0700 and the secret and state files are 0600', () => {
  const mode = (p) => statSync(p).mode & 0o777;
  assert.equal(mode(stateDir), 0o700);
  assert.equal(mode(join(stateDir, 'secret')), 0o600);
  assert.equal(mode(join(stateDir, 'state.json')), 0o600);
});

test('a world-readable pre-existing state dir owned by the user is tightened to 0700', async () => {
  const dir = join(fresh('loose'), 'state');
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  const d = await startDaemon(dir);
  assert.equal(d.exited, false, `daemon should start: ${d.stderr}`);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('a group-writable state dir is refused by the daemon and the CLI', async () => {
  const dir = join(fresh('gw'), 'state');
  mkdirSync(dir);
  chmodSync(dir, 0o770);
  const d = await startDaemon(dir);
  assert.equal(d.exited, true, 'the daemon must not start on a group-writable dir');
  assert.notEqual(d.code, 0);
  assert.ok(d.stderr.includes(dir), `error names the dir: ${d.stderr}`);
  const file = makeArtifact(dirname(dir));
  for (const args of [['open', file], ['status'], ['poll', file]]) {
    const r = await runCli(args, cliEnv(dir));
    assert.equal(r.code, 1, `${args[0]}: ${r.stdout}`);
    assert.ok(lastJson(r.stdout).error.includes(dir));
  }
  assert.ok(!existsSync(join(dir, 'secret')), 'no secret is created in a refused dir');
});

test('a symlinked state dir is refused by the daemon and the CLI', async () => {
  const root = fresh('sym');
  const real = join(root, 'real');
  mkdirSync(real, { mode: 0o700 });
  const link = join(root, 'link');
  symlinkSync(real, link);
  const d = await startDaemon(link);
  assert.equal(d.exited, true, 'the daemon must not start on a symlinked dir');
  assert.ok(d.stderr.includes(link));
  const r = await runCli(['status'], cliEnv(link));
  assert.equal(r.code, 1, r.stdout);
  assert.ok(lastJson(r.stdout).error.includes(link));
  assert.ok(!existsSync(join(real, 'secret')));
});

test('a secret readable by others, or a symlinked secret, stops the daemon and is never replaced', async () => {
  const loose = join(fresh('loosesecret'), 'state');
  mkdirSync(loose, { mode: 0o700 });
  writeFileSync(join(loose, 'secret'), 'a'.repeat(64));
  chmodSync(join(loose, 'secret'), 0o644);
  const a = await startDaemon(loose);
  assert.equal(a.exited, true);
  assert.notEqual(a.code, 0);
  assert.ok(a.stderr.includes(join(loose, 'secret')), a.stderr);
  assert.equal(readFileSync(join(loose, 'secret'), 'utf8'), 'a'.repeat(64));

  const linked = join(fresh('linksecret'), 'state');
  mkdirSync(linked, { mode: 0o700 });
  const target = join(dirname(linked), 'elsewhere');
  writeFileSync(target, 'b'.repeat(64), { mode: 0o600 });
  symlinkSync(target, join(linked, 'secret'));
  const b = await startDaemon(linked);
  assert.equal(b.exited, true);
  assert.ok(b.stderr.includes(join(linked, 'secret')), b.stderr);
});

test('a state dir inside a git work tree gets a .gitignore that ignores everything', async () => {
  const root = fresh('worktree');
  mkdirSync(join(root, '.git'));
  const dir = join(root, 'sub', 'state');
  const d = await startDaemon(dir);
  assert.equal(d.exited, false, d.stderr);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').trim(), '*');
});

test('the secret survives a restart, a stopped server clears its pid, and old keys keep working', async () => {
  const dir = join(fresh('restart'), 'state');
  const file = makeArtifact(dirname(dir));
  const first = await openViaCli(file, dir);
  const s1 = readSecret(dir);
  const pid1 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).pid;
  process.kill(pid1, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  const stopped = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(stopped.pid, undefined, 'SIGTERM clears the pid and port from the state file');
  assert.ok(stopped.sessions[file], 'the session is kept');

  const second = await openViaCli(file, dir);
  toKill.add(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).pid);
  assert.equal(readSecret(dir), s1, 'same secret after a restart');
  assert.equal(second.session, first.session);
  const port2 = Number(new URL(second.url).port);
  const upd = await raw(port2, { path: `/api/updates?s=${first.session}`, headers: { Host: `127.0.0.1:${port2}`, 'X-Curator-Cap': C(s1, first.session) } });
  assert.equal(upd.code, 200, 'the key from the first url still works');
});
