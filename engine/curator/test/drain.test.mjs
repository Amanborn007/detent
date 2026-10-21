// `drain` contract: one non-blocking sweep that delivers pending feedback from
// EVERY session, without arming a blocking long-poll that the harness watchdog
// could kill. This is the reliable feedback-catcher the agent runs each turn.
//
// The failure mode it fixes: feedback is durable server-side but only a `poll`
// drains it, so a session the agent never armed (or one whose background poll
// was killed) keeps its feedback queued forever. `drain` polls ONLY sessions
// with pending>0 — those polls resolve immediately — so it can never block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

const CURATOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(CURATOR_DIR, 'cli.mjs');
const MINIMAL_HTML = '<!DOCTYPE html>\n<html><body><h1>plan</h1></body></html>\n';

function envFor(stateDir) {
  return { ...process.env, CURATOR_STATE_DIR: stateDir, CURATOR_NO_BROWSER: '1' };
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
function lines(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function makeArtifact(workDir, name) {
  const file = join(workDir, name);
  writeFileSync(file, MINIMAL_HTML);
  return realpathSync(file);
}
function writeStateFile(stateDir, obj) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(obj, null, 2));
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

// --- 1. running server: drain delivers pending from MULTIPLE sessions at once
test('drain: running server delivers pending feedback from every session without blocking', async (t) => {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-drain-')));
  const stateDir = join(workDir, 'state');
  const env = envFor(stateDir);
  const a = makeArtifact(workDir, 'a.html');
  const b = makeArtifact(workDir, 'b.html');
  const c = makeArtifact(workDir, 'c.html'); // no feedback -> must NOT be polled/blocked

  const openedA = JSON.parse((await runCli(['open', a], env)).stdout);
  const port = Number(new URL(openedA.url).port);
  const sidA = openedA.session;
  const sidB = JSON.parse((await runCli(['open', b], env)).stdout).session;
  JSON.parse((await runCli(['open', c], env)).stdout);

  t.after(() => {
    try {
      const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      if (state.pid) process.kill(state.pid);
    } catch {
      /* already gone */
    }
  });

  // Queue feedback on A and B while nobody is polling -> durable, undelivered.
  await fetchRaw(port, '/api/send', { method: 'POST', body: { sessionId: sidA, items: [{ type: 'comment', text: 'fix A' }] } });
  await fetchRaw(port, '/api/send', { method: 'POST', body: { sessionId: sidB, items: [{ type: 'comment', text: 'fix B' }] } });

  // drain must return promptly (no long-poll on the empty session C).
  const start = Date.now();
  const { code, stdout } = await runCli(['drain'], env);
  const elapsed = Date.now() - start;
  assert.equal(code, 0, `drain failed: ${stdout}`);
  assert.ok(elapsed < 5000, `drain must not block on the empty session, took ${elapsed}ms`);

  const out = lines(stdout);
  const feedback = out.filter((l) => l.status === 'feedback');
  assert.equal(feedback.length, 2, `expected two drained sessions, got: ${stdout}`);
  const texts = feedback.flatMap((f) => f.prompts.map((p) => p.text)).sort();
  assert.deepEqual(texts, ['fix A', 'fix B']);
  // Sweeping multiple sessions is only useful if each delivered line says
  // WHICH file it belongs to — a bare {status:'feedback',...} is unattributable
  // once there is more than one result in the same drain sweep.
  const byKey = Object.fromEntries(feedback.map((f) => [f.key, f.prompts.map((p) => p.text)]));
  assert.deepEqual(byKey[a], ['fix A'], `expected feedback for ${a} to carry key, got: ${stdout}`);
  assert.deepEqual(byKey[b], ['fix B'], `expected feedback for ${b} to carry key, got: ${stdout}`);
  const summary = out.find((l) => l.status === 'drained');
  assert.ok(summary && summary.drained === 2, `expected a drained:2 summary, got: ${stdout}`);

  // Drained feedback must not be redelivered by a second drain.
  const again = lines((await runCli(['drain'], env)).stdout);
  assert.ok(again.some((l) => l.status === 'idle'), `second drain should be idle, got: ${JSON.stringify(again)}`);
});

test('drain: named files scope the sweep and leave other sessions queued', async (t) => {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-drain-scope-')));
  const stateDir = join(workDir, 'state');
  const env = envFor(stateDir);
  const a = makeArtifact(workDir, 'a.html');
  const b = makeArtifact(workDir, 'b.html');

  const openedA = JSON.parse((await runCli(['open', a], env)).stdout);
  const port = Number(new URL(openedA.url).port);
  const sidB = JSON.parse((await runCli(['open', b], env)).stdout).session;
  t.after(() => {
    const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    if (state.pid) process.kill(state.pid);
  });

  await fetchRaw(port, '/api/send', { method: 'POST', body: { sessionId: openedA.session, items: [{ type: 'comment', text: 'fix A' }] } });
  await fetchRaw(port, '/api/send', { method: 'POST', body: { sessionId: sidB, items: [{ type: 'comment', text: 'fix B' }] } });

  const scoped = lines((await runCli(['drain', a], env)).stdout).filter((l) => l.status === 'feedback');
  assert.deepEqual(scoped.map((f) => f.key), [a], `scoped drain must only deliver ${a}`);

  const rest = lines((await runCli(['drain'], env)).stdout).filter((l) => l.status === 'feedback');
  assert.deepEqual(rest.flatMap((f) => f.prompts.map((p) => p.text)), ['fix B'], 'b must still be queued after a scoped drain');
});

// --- 2. no server, durable pending in the state file: drain still delivers ---
test('drain: with the server stopped, delivers durable pending from the state file', async () => {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-drain-down-')));
  const stateDir = join(workDir, 'state');
  const a = makeArtifact(workDir, 'a.html');
  // No pid/port -> resolveServer() returns 'down'; pending lives in state.json.
  writeStateFile(stateDir, {
    sessions: { [a]: makeSession(a, { pending: [{ type: 'comment', text: 'queued while down' }] }) },
  });

  const { code, stdout } = await runCli(['drain'], envFor(stateDir));
  assert.equal(code, 0, `drain failed: ${stdout}`);
  const out = lines(stdout);
  const fb = out.find((l) => l.status === 'feedback' || l.status === 'ended');
  assert.ok(fb, `expected delivered feedback, got: ${stdout}`);
  assert.deepEqual(fb.prompts, [{ type: 'comment', text: 'queued while down' }]);
});

// --- 3. idle: sessions exist but nothing pending -> non-blocking idle report -
test('drain: reports idle when no session has pending feedback', async () => {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-drain-idle-')));
  const stateDir = join(workDir, 'state');
  const a = makeArtifact(workDir, 'a.html');
  writeStateFile(stateDir, { sessions: { [a]: makeSession(a, { pending: [] }) } });

  const { code, stdout } = await runCli(['drain'], envFor(stateDir));
  assert.equal(code, 0, `drain failed: ${stdout}`);
  const out = lines(stdout);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'idle');
  assert.equal(out[0].drained, 0);
});

// --- 4. unreachable + already-delivered fingerprint must not abort the whole
// sweep. Regression for: pollOnce's failUnreachable()/fail() call process.exit()
// directly, which cmdDrain's per-key try/catch cannot catch (process.exit does
// not throw). Reproduced with a real alive pid (so resolveServer classifies
// 'unreachable', not 'down') and a raw TCP listener that answers with garbage,
// so the /healthz round-trip errors out for a reason other than ECONNREFUSED.
test('drain: an unreachable already-delivered session must not starve other pending sessions', async (t) => {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-drain-unreachable-')));
  const stateDir = join(workDir, 'state');
  const a = makeArtifact(workDir, 'a.html'); // already delivered once while unreachable -> re-poll would hard-exit today
  const b = makeArtifact(workDir, 'b.html'); // genuinely new pending, must still be delivered this sweep

  // A process that is definitely alive, so pidAlive(pid) is true.
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => dummy.kill());
  await new Promise((resolve) => setTimeout(resolve, 50)); // let it actually start

  // A raw TCP listener that answers every connection with garbage, so the
  // /healthz request errors out for a reason other than ECONNREFUSED.
  const badServer = net.createServer((socket) => socket.end('not-http\r\n\r\n'));
  await new Promise((resolve) => badServer.listen(0, '127.0.0.1', resolve));
  t.after(() => badServer.close());
  const port = badServer.address().port;

  const sessionA = makeSession(a, { id: 'aaaa1111bbbb2222cccc3333', pending: [{ type: 'comment', text: 'already delivered' }] });
  const sessionB = makeSession(b, { id: 'dddd4444eeee5555ffff6666', pending: [{ type: 'comment', text: 'fix B' }] });
  writeStateFile(stateDir, { pid: dummy.pid, port, sessions: { [a]: sessionA, [b]: sessionB } });

  // Simulate "already delivered": record the exact fingerprint pollOnce would
  // compute for A's current pending payload, in poll-failures.json.
  const fingerprint = crypto.createHash('sha256').update(sessionA.id + JSON.stringify(sessionA.pending)).digest('hex');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'poll-failures.json'),
    JSON.stringify({ [a]: { count: 1, updatedAt: new Date().toISOString(), lastDeliveredFingerprint: fingerprint } })
  );

  const { code, stdout } = await runCli(['drain'], envFor(stateDir));
  const out = lines(stdout);
  // B's genuinely-new feedback must be delivered regardless of A's state.
  const feedback = out.find((l) => l.status === 'feedback');
  assert.ok(feedback, `expected B's feedback to be delivered even though A is stuck unreachable, got: ${stdout} (exit ${code})`);
  assert.deepEqual(feedback.prompts, [{ type: 'comment', text: 'fix B' }]);
  // A's failure must be reported per-key, not crash the whole sweep.
  const drainError = out.find((l) => l.status === 'drain-error' && l.key === a);
  assert.ok(drainError, `expected a per-key drain-error for A, got: ${stdout} (exit ${code})`);
  assert.equal(code, 0, `drain must exit 0 even when one session is stuck unreachable, got ${code}: ${stdout}`);
});
