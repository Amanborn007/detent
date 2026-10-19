// TDD (red phase): defines the contract for CLI resilience to an "unreachable"
// server — the case where state.json says a server is alive (pid matches,
// healthz would answer) but THIS shell cannot reach it (e.g. a sandboxed shell
// that blocks loopback HTTP). This must be distinguished from a genuinely
// "down" server (pid dead, or nothing listening at all) because the fix for
// each is completely different: unreachable => re-run unsandboxed; down =>
// curator open.
//
// None of this exists in cli.mjs yet (serverPort() today treats every probe
// failure — including ETIMEDOUT — as "down"). These tests are expected to
// fail against the current CLI; that failure is the point.
//
// Fixture rationale:
//   - UNREACHABLE: a raw net.createServer(() => {}) accepts the TCP connection
//     but never writes an HTTP response. That's exactly what "alive but this
//     shell can't complete an HTTP round-trip" looks like: the connect()
//     succeeds (so it's not ECONNREFUSED), but the healthz probe then hangs
//     until its own 1.5s timeout fires. state.pid is set to process.pid (this
//     test process), which is always alive, so process.kill(pid, 0) succeeds.
//   - DOWN via dead pid: spawn a node process, wait for it to exit, then use
//     its now-recycled-never (short-lived, so vanishingly unlikely to be
//     reused during the test) pid. process.kill(pid, 0) throws ESRCH.
//   - DOWN via ECONNREFUSED (pid-reuse guard): bind a server, note the port,
//     close it fully, then point state at {pid: process.pid, port}. The pid
//     is alive (it's us) but nothing is listening on that port anymore, so a
//     connect attempt gets ECONNREFUSED. This simulates OS pid reuse: state
//     still has some old pid that now belongs to an unrelated process, and
//     must be treated as "down", not "unreachable".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

const CURATOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(CURATOR_DIR, 'cli.mjs');

const MINIMAL_HTML = '<!DOCTYPE html>\n<html><body><h1>plan</h1></body></html>\n';

// --- generic fixture helpers -------------------------------------------------

function freshWorkDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), `curator-resil-${prefix}-`)));
}

function makeArtifact(workDir, name = 'plan.html') {
  const file = join(workDir, name);
  writeFileSync(file, MINIMAL_HTML);
  // realpath: the CLI canonicalizes with fs.realpathSync (macOS /var ->
  // /private/var), so the crafted state.json key must match that same form.
  return realpathSync(file);
}

function makeSession(file, overrides = {}) {
  return {
    id: 'aaaa1111bbbb2222cccc3333',
    file,
    createdAt: new Date().toISOString(),
    pending: [],
    ended: false,
    endedBy: null,
    chat: [],
    ...overrides,
  };
}

function writeStateFile(stateDir, { pid, port, sessions = {} }) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ pid, port, sessions }, null, 2));
}

function readStateFile(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
}

function readFailuresFile(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'poll-failures.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeFailuresFile(stateDir, obj) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'poll-failures.json'), JSON.stringify(obj, null, 2));
}

function envFor(stateDir, extra = {}) {
  return { ...process.env, CURATOR_STATE_DIR: stateDir, CURATOR_NO_BROWSER: '1', ...extra };
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

function fetchRaw(port, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: payload ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJsonLine(stdout) {
  return JSON.parse(stdout.trim().split('\n')[0]);
}

// Never responds to the HTTP request it accepts, so the CLI's healthz probe
// hangs until its own 1.5s timeout — the signature of "alive but this shell
// can't complete the round-trip" (as opposed to ECONNREFUSED below).
// Accepted sockets are tracked so closeServer can destroy them: a socket that
// is never read stays paused, never observes the peer's EOF, and therefore
// never auto-closes — server.close() would otherwise wait on it forever and
// deadlock the whole test file.
function startUnreachableServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server._testSockets = sockets;
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  for (const socket of server._testSockets || []) socket.destroy();
  return new Promise((resolve) => server.close(resolve));
}

// Bind then fully close, so the port is guaranteed to refuse new connections
// (nothing listening) — simulates OS pid reuse against a stale state.json.
function freeClosedPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function spawnDeadPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('exit', () => resolve(child.pid));
  });
}

// Checks the shared "unreachable" error shape (error/server/server_pid),
// independent of next_step wording (which differs by call count/command).
function assertUnreachableCore(json, pid) {
  assert.match(json.error, /is running but unreachable from this shell/);
  assert.ok(json.error.includes(String(pid)), `error should mention pid ${pid}: ${json.error}`);
  assert.equal(json.server, 'unreachable');
  assert.equal(json.server_pid, pid);
}

// Checks the full "re-run unsandboxed" next_step, including the exact command.
function assertRerunNextStep(json, command) {
  assert.match(json.next_step, /sandboxed shell/i);
  assert.match(json.next_step, /re-run this exact command unsandboxed/i);
  assert.ok(json.next_step.includes(command), `next_step should contain "${command}": ${json.next_step}`);
}

// --- 1. poll unreachable, no pending -> error, counter = 1 ------------------
test('poll: unreachable with nothing deliverable errors with unreachable shape and bumps the failure counter to 1', async (t) => {
  const workDir = freshWorkDir('t1');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const server = await startUnreachableServer();
  t.after(() => closeServer(server)); // cleanup must survive assertion throws, or the leaked listener wedges the whole runner
  const { port } = server.address();
  writeStateFile(stateDir, { pid: process.pid, port, sessions: { [artifact]: makeSession(artifact, { pending: [] }) } });

  const { code, stdout } = await runCli(['poll', artifact], envFor(stateDir));

  assert.equal(code, 1, `expected failure, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assertUnreachableCore(json, process.pid);
  assertRerunNextStep(json, `curator poll ${artifact}`);
  assert.equal(json.consecutive_failures, 1);

  const failures = readFailuresFile(stateDir);
  assert.ok(failures, 'poll-failures.json should exist after an unreachable poll');
  assert.equal(failures[artifact].count, 1);
});

// --- 2 & 3. fallback delivery then dedupe on repeat -------------------------
// These share one unreachable server + state dir because test 3 depends on
// test 2 having already delivered the same pending payload once. The server
// therefore cannot be closed via t.after in test 2; the global after() hook
// guarantees cleanup even when test 3 is skipped (e.g. --test-name-pattern)
// or fails before its own close.
let t23_workDir, t23_stateDir, t23_artifact, t23_server, t23_port;

after(async () => {
  if (t23_server) await closeServer(t23_server);
});

test('poll: unreachable with undelivered pending items falls back to a read-only delivery without touching state.json', async () => {
  t23_workDir = freshWorkDir('t23');
  t23_stateDir = join(t23_workDir, 'state');
  t23_artifact = makeArtifact(t23_workDir);
  t23_server = await startUnreachableServer();
  t23_port = t23_server.address().port;
  const pending = [
    { type: 'comment', text: 'first item' },
    { type: 'comment', text: 'second item' },
  ];
  writeStateFile(t23_stateDir, {
    pid: process.pid,
    port: t23_port,
    sessions: { [t23_artifact]: makeSession(t23_artifact, { pending }) },
  });

  const { code, stdout } = await runCli(['poll', t23_artifact], envFor(t23_stateDir));

  assert.equal(code, 0, `expected fallback delivery to succeed, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assert.equal(json.status, 'feedback');
  assert.deepEqual(json.prompts, pending);
  assert.equal(json.server, 'unreachable');
  assert.match(json.next_step, /unreachable/i);
  assert.match(json.next_step, /state file/i);
  assert.match(json.next_step, /re-?delivered|delivered again/i);

  // The live server (if the shell were unsandboxed) owns state.json; the CLI
  // must not have mutated it out from under a server that might still be running.
  const state = readStateFile(t23_stateDir);
  assert.deepEqual(state.sessions[t23_artifact].pending, pending, 'pending must be left untouched on disk');

  const failures = readFailuresFile(t23_stateDir);
  assert.equal(failures[t23_artifact].count, 1, 'a fallback delivery still counts as an unreachable poll');
});

test('poll: an immediately repeated poll with the same undelivered pending does not deliver again (dedupe)', async () => {
  // state.json is untouched from the previous test — same pending, same fingerprint.
  // (t23_server is closed by the global after() hook.)
  const { code, stdout } = await runCli(['poll', t23_artifact], envFor(t23_stateDir));

  assert.equal(code, 1, `expected dedupe to fall through to the unreachable error, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assertUnreachableCore(json, process.pid);
  assert.equal(json.consecutive_failures, 2, 'counter keeps climbing even though nothing new was delivered');

  const failures = readFailuresFile(t23_stateDir);
  assert.equal(failures[t23_artifact].count, 2);
});

// --- 4. escalation after 3 consecutive unreachable polls --------------------
test('poll: escalates to "stop retrying" wording on the 3rd consecutive unreachable failure', async (t) => {
  const workDir = freshWorkDir('t4');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const server = await startUnreachableServer();
  t.after(() => closeServer(server));
  const { port } = server.address();
  writeStateFile(stateDir, { pid: process.pid, port, sessions: { [artifact]: makeSession(artifact, { pending: [] }) } });

  const first = parseJsonLine((await runCli(['poll', artifact], envFor(stateDir))).stdout);
  assertUnreachableCore(first, process.pid);
  assertRerunNextStep(first, `curator poll ${artifact}`);
  assert.equal(first.consecutive_failures, 1);

  const second = parseJsonLine((await runCli(['poll', artifact], envFor(stateDir))).stdout);
  assertUnreachableCore(second, process.pid);
  assertRerunNextStep(second, `curator poll ${artifact}`);
  assert.equal(second.consecutive_failures, 2);

  const third = parseJsonLine((await runCli(['poll', artifact], envFor(stateDir))).stdout);
  assertUnreachableCore(third, process.pid);
  assert.equal(third.consecutive_failures, 3);
  assert.match(third.next_step, /stop retrying/i);
  assert.match(third.next_step, /escalate to the human/i);
  assert.match(third.next_step, /cannot reach the .*server from this shell/i);
});

// --- 5. dead pid, no pending: legacy "down" error is unchanged --------------
test('poll: dead pid with no queued feedback keeps the legacy down error', async () => {
  const workDir = freshWorkDir('t5');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const pid = await spawnDeadPid();
  const port = await freeClosedPort();
  writeStateFile(stateDir, { pid, port, sessions: { [artifact]: makeSession(artifact, { pending: [] }) } });

  const { code, stdout } = await runCli(['poll', artifact], envFor(stateDir));

  assert.equal(code, 1, `expected legacy down error, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assert.match(json.error, /no curator server running and no queued feedback/);
  assert.match(json.next_step, /curator open/);
  assert.ok(!/unreachable/i.test(json.error), 'a dead pid must classify as down, not unreachable');
});

// --- 6. ECONNREFUSED with an alive (but reused) pid: still "down" -----------
test('poll: ECONNREFUSED against an alive pid (port not actually listening) classifies as down, not unreachable', async () => {
  const workDir = freshWorkDir('t6');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const port = await freeClosedPort(); // nothing listening here anymore
  writeStateFile(stateDir, { pid: process.pid, port, sessions: { [artifact]: makeSession(artifact, { pending: [] }) } });

  const { code, stdout } = await runCli(['poll', artifact], envFor(stateDir));

  assert.equal(code, 1, `expected legacy down error, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assert.match(json.error, /no curator server running and no queued feedback/);
  assert.match(json.next_step, /curator open/);
  assert.ok(!/unreachable/i.test(json.error), 'ECONNREFUSED (pid reuse) must classify as down, not unreachable');
});

// --- 7. poll unreachable but session already ended --------------------------
test('poll: unreachable but the session is already ended delivers the ended status instead of erroring', async (t) => {
  const workDir = freshWorkDir('t7');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const server = await startUnreachableServer();
  t.after(() => closeServer(server));
  const { port } = server.address();
  writeStateFile(stateDir, {
    pid: process.pid,
    port,
    sessions: { [artifact]: makeSession(artifact, { pending: [], ended: true, endedBy: 'user' }) },
  });

  const { code, stdout } = await runCli(['poll', artifact], envFor(stateDir));

  assert.equal(code, 0, `expected an ended status, not an error, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assert.equal(json.status, 'ended');
  assert.match(json.next_step, /stop polling/i);
});

// --- 8. status unreachable ---------------------------------------------------
test('status: unreachable errors with the unreachable shape and mentions "curator status"', async (t) => {
  const workDir = freshWorkDir('t8');
  const stateDir = join(workDir, 'state');
  const server = await startUnreachableServer();
  t.after(() => closeServer(server));
  const { port } = server.address();
  writeStateFile(stateDir, { pid: process.pid, port, sessions: {} });

  const { code, stdout } = await runCli(['status'], envFor(stateDir));

  assert.equal(code, 1, `expected failure, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assertUnreachableCore(json, process.pid);
  assertRerunNextStep(json, 'curator status');
});

// --- 9. reply unreachable ----------------------------------------------------
test('reply: unreachable errors with the unreachable shape', async (t) => {
  const workDir = freshWorkDir('t9');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const server = await startUnreachableServer();
  t.after(() => closeServer(server));
  const { port } = server.address();
  writeStateFile(stateDir, { pid: process.pid, port, sessions: { [artifact]: makeSession(artifact) } });

  const message = 'switched to a phased rollout';
  const { code, stdout } = await runCli(['reply', artifact, '-m', message], envFor(stateDir));

  assert.equal(code, 1, `expected failure, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assertUnreachableCore(json, process.pid);
  assertRerunNextStep(json, `curator reply ${artifact} -m "${message}"`);
});

// --- 10. open unreachable: fails fast, spawns nothing ------------------------
test('open: unreachable fails fast without spawning a second server', async (t) => {
  const workDir = freshWorkDir('t10');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const server = await startUnreachableServer();
  const { port } = server.address();
  writeStateFile(stateDir, { pid: process.pid, port, sessions: { [artifact]: makeSession(artifact) } });
  const before = readStateFile(stateDir);
  t.after(() => {
    // If a buggy CLI DID spawn a real daemon, state.json now carries its pid;
    // kill it so a failing run cannot leak a live server past the suite.
    try {
      const state = readStateFile(stateDir);
      if (state.pid && state.pid !== process.pid) process.kill(state.pid);
    } catch {
      // nothing spawned — the expected case
    }
    return closeServer(server);
  });

  const start = Date.now();
  const { code, stdout } = await runCli(['open', artifact], envFor(stateDir));
  const elapsed = Date.now() - start;

  assert.equal(code, 1, `expected failure, got: ${stdout}`);
  assert.ok(elapsed < 5000, `open should fail fast on an unreachable server, took ${elapsed}ms`);
  const json = parseJsonLine(stdout);
  assertUnreachableCore(json, process.pid);
  assertRerunNextStep(json, `curator open ${artifact}`);

  const after = readStateFile(stateDir);
  assert.deepEqual(after, before, 'state.json (pid/port) must be untouched: no second server was spawned');
});

// --- 11. end unreachable ------------------------------------------------------
test('end: unreachable errors with the unreachable shape', async (t) => {
  const workDir = freshWorkDir('t11');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const server = await startUnreachableServer();
  t.after(() => closeServer(server));
  const { port } = server.address();
  writeStateFile(stateDir, { pid: process.pid, port, sessions: { [artifact]: makeSession(artifact) } });

  const { code, stdout } = await runCli(['end', artifact], envFor(stateDir));

  assert.equal(code, 1, `expected failure, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assertUnreachableCore(json, process.pid);
  assertRerunNextStep(json, `curator end ${artifact}`);
});

// --- 12. open with a down server whose spawned daemon crashes immediately ---
test('open: a spawned daemon that crashes on its first flush fails fast with the crash in the error', async (t) => {
  const workDir = freshWorkDir('t12');
  const artifact = makeArtifact(workDir);
  // CURATOR_STATE_DIR's PARENT is a regular file, not a directory. The
  // daemon's first flush() does fs.mkdirSync(dirname(stateFile), {recursive}),
  // which throws ENOTDIR because a path component already exists as a file.
  // That's an uncaught exception in the listen() callback -> the daemon
  // crashes before ever printing its {port} line to stdout. The CLI must
  // notice the child exited and fail immediately, not wait out the old
  // multi-second spawn timeout.
  const blocker = join(workDir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const stateDir = join(blocker, 'state');

  const start = Date.now();
  const { code, stdout } = await runCli(['open', artifact], envFor(stateDir));
  const elapsed = Date.now() - start;

  assert.equal(code, 1, `expected failure, got: ${stdout}`);
  assert.ok(elapsed < 8000, `open should fail fast when the spawned daemon crashes, took ${elapsed}ms`);
  const json = parseJsonLine(stdout);
  assert.ok(json.error && json.error.length > 0, 'the crashing child\'s stderr should surface in the error');
});

// --- 13. a successful poll against a reachable server resets the counter ---
test('poll: a successful poll against a reachable server resets a pre-existing failure counter', async (t) => {
  const workDir = freshWorkDir('t13');
  const stateDir = join(workDir, 'state');
  const artifact = makeArtifact(workDir);
  const env = envFor(stateDir);

  const opened = parseJsonLine((await runCli(['open', artifact], env)).stdout);
  const port = Number(new URL(opened.url).port);
  const sessionId = opened.session;

  t.after(() => {
    try {
      const state = readStateFile(stateDir);
      if (state.pid) process.kill(state.pid);
    } catch {
      // server already gone
    }
  });

  // Queue feedback while nobody is polling, so it lands durably in state.json.
  const send = await fetchRaw(port, '/api/send', {
    method: 'POST',
    body: { sessionId, items: [{ type: 'comment', text: 'looks good' }] },
  });
  assert.equal(send.code, 200);
  assert.equal(JSON.parse(send.body).delivered, false, 'queued, not delivered, since no one is polling yet');

  // Pre-seed a stale failure counter from an earlier unreachable stretch.
  writeFailuresFile(stateDir, { [artifact]: { count: 2 } });

  const { code, stdout } = await runCli(['poll', artifact], env);
  assert.equal(code, 0, `expected a normal successful poll, got: ${stdout}`);
  const json = parseJsonLine(stdout);
  assert.equal(json.status, 'feedback');
  assert.deepEqual(json.prompts, [{ type: 'comment', text: 'looks good' }]);

  const failures = readFailuresFile(stateDir);
  const entry = failures && failures[artifact];
  assert.ok(!entry || entry.count === 0, 'a successful poll against a reachable server must reset the counter');
});
