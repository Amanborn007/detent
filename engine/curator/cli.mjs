#!/usr/bin/env node
// curator CLI — agent-ergonomic: every outcome is a single JSON line on
// stdout with a next_step field. Exit 0 on success, 1 on error.
// Commands: open | poll | reply | end | status | log
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStateDir, checkStateDir, readSecret, secretPath, healthProof, safeEqual, browserUrl, AuthSetupError } from './auth.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(MODULE_DIR, 'server.mjs');
const CHECK_PATH = path.join(MODULE_DIR, 'scripts', 'artifact-check.py');

const STATE_DIR = resolveStateDir();
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const POLL_FAILURES_FILE = path.join(STATE_DIR, 'poll-failures.json');

const USAGE =
  'Usage: curator open <file.html> | curator check <file.html> | curator poll <file> | curator drain [<file>...] | curator reply <file> -m "<msg>" | curator log <file> -m "<entry>" | curator answer <file> --question <id> --answer <value> [--note <text>] | curator end <file> | curator status';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(error, next_step) {
  out({ error, next_step: next_step || USAGE });
  process.exit(1);
}

// --- tiny argv parser with unknown-flag rejection --------------------------
function parseArgs(argv, allowedFlags) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      const name = allowedFlags[a];
      if (!name) fail(`unknown flag: ${a}`, USAGE);
      const val = argv[i + 1];
      if (val === undefined) fail(`flag ${a} requires a value`, USAGE);
      flags[name] = val;
      i++;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

// --- state / server helpers -------------------------------------------------
function readState() {
  checkStateDir(STATE_DIR);
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

// `secret` is passed only for a server that has already proved it holds it (see resolveServer).
function httpJson({ method, port, path: reqPath, body, timeoutMs, secret }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c)); // long-poll heartbeats are single spaces; JSON.parse tolerates them
        res.on('end', () => {
          try {
            resolve({ code: res.statusCode, json: JSON.parse(data.trim() || '{}') });
          } catch (e) {
            reject(new Error(`bad response from curator server (${res.statusCode}): ${e.message}`));
          }
        });
      }
    );
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        // Carry a code so callers classify by err.code, never by message text.
        const e = new Error('curator server did not respond');
        e.code = 'ETIMEDOUT';
        req.destroy(e);
      });
    }
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// In Claude Code's sandbox, kill(alivePid, 0) throws EPERM while a dead pid
// still throws ESRCH — verified; POSIX EPERM also means "exists". So ESRCH is
// the only "dead" signal.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

// The secret is only ever sent to a server classified 'running' (valid healthz proof).
async function resolveServer() {
  const state = readState();
  if (!state || !state.port || !state.pid) return { status: 'down', state };
  const nonce = crypto.randomBytes(16).toString('hex');
  let json;
  try {
    ({ json } = await httpJson({ method: 'GET', port: state.port, path: `/healthz?nonce=${nonce}`, timeoutMs: 1500 }));
  } catch (cause) {
    // ECONNREFUSED means nothing is listening; if state.pid is alive anyway,
    // that pid was reused by the OS for an unrelated process — still 'down'.
    if (cause.code === 'ECONNREFUSED') return { status: 'down', state };
    if (pidAlive(state.pid)) return { status: 'unreachable', state, cause };
    return { status: 'down', state };
  }
  if (!json.ok || json.pid !== state.pid) return { status: 'down', state };
  if (typeof json.proof !== 'string' || typeof json.boot !== 'string') return { status: 'untrusted', why: 'legacy', state };
  const secret = readSecret(STATE_DIR);
  if (!secret) {
    throw new AuthSetupError(`curator server (pid ${state.pid}, port ${state.port}) is running but its secret ${secretPath(STATE_DIR)} is missing`,
      `Stop the server, then run: curator open <file.html>. Its pid is ${state.pid} (kill ${state.pid}). curator never creates a new secret under a running server.`);
  }
  if (!safeEqual(json.proof, healthProof(secret, nonce))) return { status: 'untrusted', why: 'bad-proof', state };
  return { status: 'running', port: state.port, state, secret, boot: json.boot };
}

function failUntrusted({ state, why }, nextCmd) {
  const what = why === 'legacy' ? 'sends no proof of the secret (a server from before authentication)' : 'did not prove it holds this state directory\'s secret';
  fail(`the curator server on port ${state.port} (pid ${state.pid}) ${what}, so nothing was sent to it`,
    `Run: ${nextCmd}. curator open replaces a legacy server and refuses to stop a process that is not a curator daemon.`);
}

function commandOf(pid) {
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.error || ps.status !== 0 ? null : ps.stdout.trim();
}

async function terminate(pid) {
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 100 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  if (pidAlive(pid)) fail(`the old curator server (pid ${pid}) did not stop after SIGTERM`, `Run: kill -9 ${pid}, then run: curator open <file.html>`);
}

// Only this clone's own daemon, matched on its exact command line, is signalled for the recorded server.
async function stopUntrustedServer({ state }) {
  const { pid, port } = state;
  const cmd = commandOf(pid);
  if (cmd === null || !cmd.endsWith(` ${SERVER_PATH} --daemon`)) {
    fail(`port ${port} is held by pid ${pid}, which is not a curator daemon started from this clone, so it was not stopped`,
      `Stop whatever listens on port ${port} yourself or choose another CURATOR_STATE_DIR, then run: curator open <file.html>`);
  }
  await terminate(pid);
}

// Before authentication the state lived in ~/.curator, and a server left there answers anyone.
async function retireLegacyServer() {
  const legacyDir = path.join(os.homedir(), '.curator');
  if (path.resolve(legacyDir) === path.resolve(STATE_DIR)) return [];
  let pid;
  try {
    pid = JSON.parse(fs.readFileSync(path.join(legacyDir, 'state.json'), 'utf8')).pid;
  } catch {
    return [];
  }
  if (!Number.isInteger(pid) || !pidAlive(pid)) return [];
  const cmd = commandOf(pid);
  if (cmd !== null && /(^|\s)\/\S*\/curator\/server\.mjs --daemon$/.test(cmd)) {
    await terminate(pid);
    return [];
  }
  const warning = `pid ${pid} from the old ${path.join(legacyDir, 'state.json')} is still running as "${cmd}". If it is an old curator server it answers every request without a credential: stop it with: kill ${pid}`;
  process.stderr.write(`curator: WARNING ${warning}\n`);
  return [warning];
}

// The keys must never reach an argv, where any process can read them. The browser opens a local file that redirects.
function launchBrowser(url) {
  if (process.env.CURATOR_NO_BROWSER) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!opener) return;
  const launcher = path.join(STATE_DIR, `open-${crypto.randomBytes(8).toString('hex')}.html`);
  fs.writeFileSync(launcher, `<!DOCTYPE html>\n<meta charset="utf-8"><title>curator</title>\n<script>location.replace(${JSON.stringify(url)});</script>\n`, { mode: 0o600 });
  const child = spawn(opener, [launcher], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => process.stderr.write(`curator: could not run ${opener}: ${e.message}\n`));
  child.unref();
  const sweep = 'setTimeout(() => { try { require("fs").unlinkSync(process.argv[1]); } catch {} }, 15000)';
  spawn(process.execPath, ['-e', sweep, launcher], { detached: true, stdio: 'ignore' }).unref();
}

// --- consecutive-failure counter (poll-failures.json) ------------------------
// Shape: { [canonicalFileKey]: { count, updatedAt, lastDeliveredFingerprint? } }
function readPollFailures() {
  try {
    return JSON.parse(fs.readFileSync(POLL_FAILURES_FILE, 'utf8'));
  } catch {
    return {}; // missing/corrupt counter must never block a poll
  }
}

function writePollFailures(failures) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${POLL_FAILURES_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(failures, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, POLL_FAILURES_FILE);
}

function bumpPollFailure(key, { fingerprint } = {}) {
  const failures = readPollFailures();
  const entry = failures[key] || { count: 0 };
  entry.count += 1;
  entry.updatedAt = new Date().toISOString();
  if (fingerprint) entry.lastDeliveredFingerprint = fingerprint;
  failures[key] = entry;
  let counterError;
  try {
    writePollFailures(failures);
  } catch (err) {
    counterError = String((err && err.message) || err); // surfaced on the JSON, never thrown
  }
  return { count: entry.count, counterError };
}

function resetPollFailures(key) {
  try {
    const failures = readPollFailures();
    if (!(key in failures)) return;
    delete failures[key];
    writePollFailures(failures);
  } catch {
    // a successful poll must not die on a counter write
  }
}

function pendingFingerprint(session) {
  return crypto.createHash('sha256').update(session.id + JSON.stringify(session.pending)).digest('hex');
}

// Shared "alive but unreachable" error: one JSON line, exit 1.
function failUnreachable({ state, cause, command, consecutive, counterError }) {
  const reason = (cause && (cause.code || cause.message)) || 'unknown';
  const payload = {
    error: `curator server (pid ${state.pid}, port ${state.port}) is running but unreachable from this shell (${reason})`,
    server: 'unreachable',
    server_pid: state.pid,
  };
  if (consecutive !== undefined) payload.consecutive_failures = consecutive;
  if (counterError) payload.counter_error = counterError;
  if (consecutive !== undefined && consecutive >= 3) {
    payload.next_step = `Stop retrying — escalate to the human: the poll cannot reach the curator server from this shell (${consecutive} consecutive failures). The server is alive; ask the human to run "${command}" from an unsandboxed shell.`;
  } else {
    payload.next_step = `The server is alive but this shell cannot reach 127.0.0.1 — you are likely in a sandboxed shell that blocks loopback connections. Re-run this exact command unsandboxed: ${command}`;
    if (counterError) {
      payload.next_step += ' If it still cannot connect, or this shell cannot track failures, stop retrying and escalate to the human.';
    }
  }
  out(payload);
  process.exit(1);
}

function spawnServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH, '--daemon'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CURATOR_STATE_DIR: STATE_DIR },
    });
    let buf = '';
    let errBuf = '';
    let settled = false; // first outcome wins: a resolve that already happened beats a late exit/timer
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => settle(reject, new Error(`curator server did not start: ${errBuf.slice(0, 400)}`)), 10000);
    child.stderr.on('data', (c) => (errBuf += c));
    child.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        const info = JSON.parse(buf.slice(0, nl));
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle(resolve, info.port);
      } catch (e) {
        settle(reject, new Error(`curator server printed garbage: ${e.message}`));
      }
    });
    // Fast-fail: a daemon that dies before printing its port should not make
    // the CLI sit out the full 10s timer (which stays as the outer bound).
    child.on('exit', (code, signal) => {
      let msg = `curator server exited before it was ready (${code ?? signal}): ${errBuf.slice(0, 400)}`;
      if (/listen EPERM|EACCES/.test(errBuf)) {
        msg += ' — this shell probably cannot listen on 127.0.0.1 (sandboxed shell); re-run unsandboxed.';
      }
      settle(reject, new Error(msg));
    });
    child.on('error', (e) => settle(reject, e));
  });
}

function canonicalFile(file, { mustExist }) {
  if (!file) fail('missing <file> argument', USAGE);
  const abs = path.resolve(file);
  if (fs.existsSync(abs)) return fs.realpathSync(abs);
  if (mustExist) fail(`file not found: ${abs}`, 'Write the artifact first, then run: curator open <file.html>');
  return abs;
}

const POLL_HINT = (file) =>
  `Now run: curator poll ${file}. It blocks silently until the user sends feedback or ends the session - that is normal, do not kill it. If it dies, re-run it once; if the error says the server is unreachable from a sandboxed shell, re-run it unsandboxed; after 3 consecutive failures stop and escalate to the human. Feedback is never lost.`;

// The pre-open rules were advisory for a full session and got ignored for a full session, so the
// gate runs here rather than only in the skill: an artifact that fails the check does not get served.
// CURATOR_NO_CHECK=1 is the deliberate way past it — reopening a legacy artifact written before the
// rules existed is the case it is there for — and taking it is reported on the success line, never
// silently.
function runArtifactCheck(file) {
  const result = spawnSync('python3', [CHECK_PATH, file], { encoding: 'utf8' });
  const lines = `${result.stdout || ''}${result.stderr || ''}`.split('\n').filter((l) => l.trim());
  return {
    error: result.error,
    ok: result.status === 0,
    problems: lines.filter((l) => !l.startsWith('warning:') && !l.startsWith('OK,')),
    warnings: lines.filter((l) => l.startsWith('warning:')),
  };
}

function enforceArtifactCheck(file) {
  // Exactly '1'. Any-nonempty would let an ambient CURATOR_NO_CHECK=0 or =false turn the mandatory
  // gate off, which is the opposite of what setting it to a false value means.
  if (process.env.CURATOR_NO_CHECK === '1') return { check: 'skipped (CURATOR_NO_CHECK)' };

  const { error, ok, problems, warnings } = runArtifactCheck(file);
  if (error) {
    // No silent pass: a check that could not run is an unchecked artifact, and the caller decides.
    fail(`cannot run the artifact check: ${error.message}`,
      `The check needs python3 on PATH (${CHECK_PATH}). Install it, or open deliberately unchecked with CURATOR_NO_CHECK=1 curator open ${file}.`);
  }
  if (!ok) {
    fail(`the artifact fails the pre-open check, so it was not opened:\n${problems.join('\n')}`,
      `Fix what the check names above, then run: curator open ${file}. The rules are in engine/curator/blocks.md. To open it unchecked anyway — a legacy artifact, say — use CURATOR_NO_CHECK=1 curator open ${file}.`);
  }
  // Warnings do not gate, but they are worth carrying to the caller rather than dropping.
  return warnings.length ? { check: 'passed', check_warnings: warnings } : { check: 'passed' };
}

// The same gate `open` enforces, on its own. Lets you read the problems before the gate reports them,
// and makes the rules runnable without knowing where the script lives.
async function cmdCheck(args) {
  const { positionals } = parseArgs(args, {});
  const file = canonicalFile(positionals[0], { mustExist: true });
  const { error, ok, problems, warnings } = runArtifactCheck(file);
  if (error) {
    fail(`cannot run the artifact check: ${error.message}`,
      `The check needs python3 on PATH (${CHECK_PATH}).`);
  }
  if (!ok) {
    out({ check: 'failed', key: file, problems, warnings,
      next_step: `Fix what is named above, then run: curator check ${file}. The rules are in engine/curator/blocks.md.` });
    process.exit(1);
  }
  out({ check: 'passed', key: file, warnings, next_step: `Now run: curator open ${file}` });
}

// --- commands ---------------------------------------------------------------
async function cmdOpen(args) {
  const { positionals } = parseArgs(args, {});
  const file = canonicalFile(positionals[0], { mustExist: true });
  if (!fs.statSync(file).isFile()) fail(`not a file: ${file}`, 'Point curator open at a self-contained .html artifact.');
  const checked = enforceArtifactCheck(file);
  const warnings = await retireLegacyServer();
  let resolved = await resolveServer();
  if (resolved.status === 'unreachable') {
    // NEVER spawn here: the server is alive, we just can't see it — spawning
    // a duplicate was the observed sandbox failure mode.
    failUnreachable({ state: resolved.state, cause: resolved.cause, command: `curator open ${file}` });
  }
  if (resolved.status === 'untrusted') {
    await stopUntrustedServer(resolved);
    resolved = { status: 'down' };
  }
  if (resolved.status !== 'running') {
    await spawnServer();
    resolved = await resolveServer();
    if (resolved.status !== 'running') {
      fail('the curator server that was just started did not prove it holds this state directory\'s secret', 'Check CURATOR_STATE_DIR and run: curator open <file.html>');
    }
  }
  const { port, secret } = resolved;
  const { code, json } = await httpJson({ method: 'POST', port, path: '/api/open', body: { file }, timeoutMs: 5000, secret });
  if (code !== 200) fail(json.error || `server error ${code}`, json.next_step);
  const url = browserUrl(port, json.sessionId, secret, resolved.boot);
  launchBrowser(url);
  out({ url, key: file, session: json.sessionId, ...checked, ...(warnings.length ? { warnings } : {}), next_step: POLL_HINT(file) });
}

// `drainTimeoutMs` bounds the running-server long-poll. Left undefined for the
// bare `poll` command (blocks silently until feedback/end, as designed). Set by
// `drain`, which only ever polls sessions that ALREADY have pending>0 — the
// server resolves those immediately, so the timeout never fires in practice and
// only guards the impossible-in-single-agent-use concurrent-drain race, keeping
// `drain` strictly non-blocking (watchdog-proof) regardless of server version.
//
// `isDrain` (set only by `cmdDrain`) makes every hard-failure path THROW
// instead of calling fail()/failUnreachable() (which process.exit() the whole
// CLI). cmdDrain polls multiple sessions in a loop with a per-key try/catch —
// process.exit() cannot be caught by that catch, so without this flag one
// stuck session (e.g. unreachable + already-delivered) would silently abort
// delivery for every other pending session in the same sweep. Plain `poll`
// never sets it, so its exit-on-failure behavior is unchanged.
async function pollOnce(file, { drainTimeoutMs, isDrain = false } = {}) {
  const bail = (error, next_step) => {
    if (isDrain) throw new Error(error);
    fail(error, next_step);
  };
  const bailUnreachable = (args) => {
    if (isDrain) {
      const reason = (args.cause && (args.cause.code || args.cause.message)) || 'unknown';
      throw new Error(`curator server (pid ${args.state.pid}, port ${args.state.port}) is unreachable from this shell (${reason})`);
    }
    failUnreachable(args);
  };
  // `drain` sweeps many sessions into one stdout stream; a bare {status:...}
  // line is unattributable once there's more than one result (the `ended`
  // payload from the server carries no file reference at all, and
  // `feedback`'s is only a substring inside next_step). Stamp `key` on every
  // delivered line in drain mode so each result maps back to its file; plain
  // `poll` already knows which single file it asked for, so leave it as-is.
  // Every delivery path below funnels through here, so this is the one place
  // that stamps decision answers onto the artifact as they are delivered.
  const emit = (payload) => {
    let stamp_error;
    if (Array.isArray(payload.prompts) && payload.prompts.length > 0) {
      try {
        stamp_error = stampDecisions(file, payload.prompts);
      } catch (e) {
        stamp_error = String((e && e.message) || e);
      }
    }
    const merged = stamp_error ? { ...payload, stamp_error } : payload;
    out(isDrain ? { key: file, ...merged } : merged);
  };
  const resolved = await resolveServer();
  if (resolved.status === 'untrusted') {
    bail(`the curator server on port ${resolved.state.port} did not prove it holds this state directory's secret, so nothing was sent to it`,
      `Run: curator open ${file}`);
    return;
  }
  if (resolved.status === 'running') {
    const { code, json } = await httpJson({ method: 'GET', port: resolved.port, path: `/api/poll?key=${encodeURIComponent(file)}`, timeoutMs: drainTimeoutMs, secret: resolved.secret });
    if (code !== 200) bail(json.error || `server error ${code}`, json.next_step || `Run: curator open ${file}`);
    resetPollFailures(file); // a reachable server clears the consecutive-failure streak
    emit(json);
    return;
  }
  if (resolved.status === 'unreachable') {
    const { state, cause } = resolved;
    const session = state && state.sessions && state.sessions[file];
    if (session && session.ended) {
      emit({
        status: 'ended',
        prompts: [],
        next_step: 'The user ended the session. Stop polling. Do not reopen it uninvited; deliver any remaining updates in chat.',
      });
      return;
    }
    if (session && Array.isArray(session.pending) && session.pending.length > 0) {
      // Read-only fallback delivery, once per distinct payload: the live
      // server OWNS state.json — clearing pending here caused a verified
      // split-brain/duplicate-delivery incident, so we never writeState.
      // Instead the delivered payload's fingerprint is remembered in the
      // counter file so an identical re-poll doesn't deliver again.
      const fingerprint = pendingFingerprint(session);
      const prior = readPollFailures()[file];
      if (!prior || prior.lastDeliveredFingerprint !== fingerprint) {
        bumpPollFailure(file, { fingerprint });
        emit({
          status: 'feedback',
          prompts: session.pending,
          server: 'unreachable',
          next_step: `The curator server is alive but unreachable from this shell (likely a sandboxed shell blocking 127.0.0.1). This feedback was recovered read-only from the state file; it remains queued on the server and may be re-delivered by the next successful poll — apply it, then run the next poll unsandboxed: curator poll ${file}`,
        });
        return;
      }
    }
    const { count, counterError } = bumpPollFailure(file);
    bailUnreachable({ state, cause, command: `curator poll ${file}`, consecutive: count, counterError });
    return;
  }
  // Server is down: durable pending feedback still lives in the state file.
  const state = resolved.state;
  const session = state && state.sessions && state.sessions[file];
  if (session && Array.isArray(session.pending) && session.pending.length > 0) {
    const prompts = session.pending;
    session.pending = [];
    writeState(state);
    emit({
      status: session.ended ? 'ended' : 'feedback',
      prompts,
      next_step: session.ended
        ? 'The user ended the session. Stop polling. Do not reopen it uninvited; deliver any remaining updates in chat.'
        : `Apply the feedback, then run: curator reply ${file} -m "<what you changed>" and poll again. (Note: the curator server had stopped; curator open ${file} will restart it.)`,
    });
    return;
  }
  if (session && session.ended) {
    emit({
      status: 'ended',
      prompts: [],
      next_step: 'The user ended the session. Stop polling. Do not reopen it uninvited; deliver any remaining updates in chat.',
    });
    return;
  }
  bail(`no curator server running and no queued feedback for ${file}`, `Run: curator open ${file}`);
}

async function cmdPoll(args) {
  const { positionals } = parseArgs(args, {});
  const file = canonicalFile(positionals[0], { mustExist: false });
  await pollOnce(file);
}

// `drain` is the reliable feedback-catcher: one non-blocking sweep of ALL
// sessions. The problem it fixes: feedback is durable server-side but only a
// `poll` delivers it, so feedback sits forever in any session the agent never
// armed, and armed long-poll background jobs get killed by the harness watchdog
// before they drain. `drain` avoids the blocking long-poll entirely — it lists
// every session (via /api/status when the server is up, else the durable state
// file) and polls ONLY the ones with pending>0. Such a poll returns instantly
// (the server resolves a non-empty queue immediately), so nothing blocks and no
// background job needs to survive. Run it at the top of every turn.
async function cmdDrain(args) {
  const { positionals } = parseArgs(args, {});
  // Scoping to named files leaves every other session's queue untouched.
  const only = positionals.length ? new Set(positionals.map((f) => canonicalFile(f, { mustExist: false }))) : null;
  const resolved = await resolveServer();
  if (resolved.status === 'untrusted') failUntrusted(resolved, 'curator open <file.html>');

  // Discover sessions + pending counts without ever registering a waiter.
  let sessions;
  if (resolved.status === 'running') {
    const { code, json } = await httpJson({ method: 'GET', port: resolved.port, path: '/api/status', timeoutMs: 5000, secret: resolved.secret });
    if (code !== 200) fail(json.error || `server error ${code}`, 'Run: curator status');
    sessions = (json.sessions || []).map((s) => ({ key: s.key, pending: s.pending_feedback_items || 0 }));
  } else {
    // 'down' and 'unreachable' both carry the last durable state file. Read it
    // read-only; per-session delivery below reuses pollOnce, which applies the
    // exact same safe recovery (read-only fallback for 'unreachable', drain +
    // writeState for 'down') the bare `poll` command already uses.
    const state = resolved.state;
    sessions = Object.entries((state && state.sessions) || {}).map(([key, s]) => ({ key, pending: (s.pending || []).length }));
  }

  if (only) sessions = sessions.filter((s) => only.has(s.key));
  const pendingKeys = sessions.filter((s) => s.pending > 0).map((s) => s.key);
  if (pendingKeys.length === 0) {
    out({
      status: 'idle',
      sessions: sessions.length,
      drained: 0,
      next_step:
        sessions.length === 0
          ? 'No curator sessions exist. Nothing to drain.'
          : `No pending curator feedback across ${sessions.length} session(s). Run \`curator drain\` again at the top of your next turn.`,
    });
    return;
  }

  let drained = 0;
  for (const key of pendingKeys) {
    try {
      await pollOnce(key, { drainTimeoutMs: 15000, isDrain: true }); // pending>0 => returns immediately; timeout only guards a concurrent-drain race
      drained += 1;
    } catch (err) {
      out({
        key,
        status: 'drain-error',
        error: String((err && err.message) || err),
        next_step: `Feedback remains queued; re-run \`curator drain\` or \`curator poll ${key}\`.`,
      });
    }
  }
  out({
    status: 'drained',
    drained,
    next_step:
      'Apply every prompt above. For each: update the artifact body in place AND `curator log <file> -m ...`, then `curator reply <file> -m "<what changed>"`. Re-run `curator drain` at the top of your next turn to catch new feedback.',
  });
}

async function cmdReply(args) {
  const { positionals, flags } = parseArgs(args, { '-m': 'message', '--message': 'message' });
  const file = canonicalFile(positionals[0], { mustExist: false });
  if (!flags.message) fail('reply requires -m "<message>"', `Run: curator reply ${file} -m "<what you changed>"`);
  const resolved = await resolveServer();
  if (resolved.status === 'unreachable') {
    failUnreachable({ state: resolved.state, cause: resolved.cause, command: `curator reply ${file} -m "${flags.message}"` });
  }
  if (resolved.status === 'untrusted') failUntrusted(resolved, `curator open ${file}`);
  if (resolved.status !== 'running') {
    fail(`no curator server running for ${file}`, `Run: curator open ${file} to restart it, then reply again.`);
  }
  const { code, json } = await httpJson({
    method: 'POST',
    port: resolved.port,
    path: '/api/reply',
    body: { key: file, message: flags.message },
    timeoutMs: 5000,
    secret: resolved.secret,
  });
  if (code !== 200) fail(json.error || `server error ${code}`, json.next_step || `Run: curator open ${file}`);
  await pollOnce(file);
}

// Escape untrusted text before interpolating it into the artifact HTML.
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// A true synchronous sleep (no busy-wait) for mutateArtifact's lock-retry poll.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Guards concurrent read-modify-write of one artifact file (cmdLog vs. the
// decision-stamping poll path), which otherwise silently lose one writer.
// Exclusive-create lock at `${file}.lock`; 25ms poll up to 3s; 5s stale takeover.
function mutateArtifact(file, fn) {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + 3000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 5000) {
          fs.unlinkSync(lockPath); // stale: previous holder crashed without releasing it
          continue;
        }
      } catch {
        continue; // lock vanished between the EEXIST and this stat; retry the open
      }
      if (Date.now() >= deadline) throw new Error(`could not acquire lock ${lockPath} within 3s`);
      sleepSync(25);
    }
  }
  try {
    const html = fs.readFileSync(file, 'utf8');
    const next = fn(html);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    return next;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lockPath); } catch {} // best-effort; a takeover race here is harmless
  }
}

// `log` writes an audit line straight into the artifact file on disk, so the
// browser shows it on the next reload — no server, live poll, or feedback
// round required. This is what keeps the artifact in sync with decisions and
// work as they land: a `reply` is a transient chat ping, but the artifact is
// the durable source of truth the user reloads, so it must never go stale
// behind the conversation. Entries are newest-first under a "Decision & Change
// Log" section, which is created on first use.
async function cmdLog(args) {
  const { positionals, flags } = parseArgs(args, { '-m': 'message', '--message': 'message' });
  const file = canonicalFile(positionals[0], { mustExist: true });
  if (!flags.message) fail('log requires -m "<entry>"', `Run: curator log ${file} -m "<decision -> action -> outcome>"`);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const li = `<li data-curator-log-entry><strong>${escapeHtml(stamp)}</strong> — ${escapeHtml(flags.message)}</li>`;
  const OL_OPEN = '<ol data-curator-changelog-entries>';
  // Replacement args are passed as FUNCTIONS: a string replacement would let the
  // untrusted message re-inject `$&`/`$$`/`$1` patterns (e.g. a "$$ cost" note
  // corrupting into the matched text), so a function keeps the entry literal.
  mutateArtifact(file, (html) => {
    if (html.includes(OL_OPEN)) {
      return html.replace(OL_OPEN, () => `${OL_OPEN}\n      ${li}`); // newest first
    }
    const section =
      '<section data-curator-changelog>\n' +
      '  <h2>Decision &amp; Change Log</h2>\n' +
      '  <p><em>What was decided and what changed since this plan opened — most recent at the top, kept in sync as work lands.</em></p>\n' +
      `  ${OL_OPEN}\n      ${li}\n  </ol>\n` +
      '</section>\n';
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${section}</body>`) : html + section;
  });
  out({
    status: 'logged',
    key: file,
    entry: flags.message,
    next_step:
      "Logged into the artifact's change log (the user sees it on reload). Also keep the artifact BODY in sync with the decision/work applied, then continue the poll/reply loop.",
  });
}

// Finds the '<' that opens the tag containing byte offset `attrIdx`, by
// walking backward until either a '<' (found) or an unmatched '>' (not
// inside a tag — malformed input).
function findEnclosingOpenTag(html, attrIdx) {
  for (let i = attrIdx; i >= 0; i--) {
    if (html[i] === '<') return i;
    if (html[i] === '>') return -1;
  }
  return -1;
}

// Inserts an attribute just before a tag's closing '>', honoring a
// self-closing '/>' so the slash stays last.
function insertAttrBeforeClose(tagStr, attrs) {
  return /\/>$/.test(tagStr) ? tagStr.slice(0, -2) + attrs + '/>' : tagStr.slice(0, -1) + attrs + '>';
}

// Textually scopes the `data-plan-question="id"` block by depth-counted
// same-tag matching, so nested markup between the open and close tags does
// not fool the boundary. Refuses (throws) on zero or more than one match.
function scopeQuestionBlock(html, id, file) {
  const marker = `data-plan-question="${id}"`;
  const positions = [];
  for (let idx = html.indexOf(marker); idx !== -1; idx = html.indexOf(marker, idx + marker.length)) {
    positions.push(idx);
  }
  if (positions.length === 0) throw new Error(`no question found with id "${id}" in ${file}`);
  if (positions.length > 1) throw new Error(`question "${id}" appears more than once in ${file} — not unique`);

  const openTagStart = findEnclosingOpenTag(html, positions[0]);
  if (openTagStart === -1) throw new Error(`could not locate the opening tag for question "${id}"`);
  const openTagEnd = html.indexOf('>', positions[0]);
  if (openTagEnd === -1) throw new Error(`malformed tag for question "${id}"`);
  const tagMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(openTagStart));
  if (!tagMatch) throw new Error(`could not determine the tag name for question "${id}"`);

  const tagRe = new RegExp(`<(/?)${tagMatch[1]}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = openTagEnd + 1;
  let depth = 1;
  let end = -1;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[1] === '/') {
      depth--;
      if (depth === 0) { end = m.index + m[0].length; break; }
    } else {
      depth++;
    }
  }
  if (end === -1) throw new Error(`unterminated block for question "${id}"`);
  return { start: openTagStart, end };
}

// Strips any prior answer marks from a question block so re-answering
// replaces rather than stacks. Function replacer keeps the file's
// $-injection-safe convention even though no untrusted text is involved here.
function stripPriorMarks(block) {
  return block.replace(
    /\s+data-curator-answered-option(?:="[^"]*")?|\s+data-curator-answered-at="[^"]*"|\s+data-curator-answered-note="[^"]*"|\s+data-curator-answered="[^"]*"/g,
    () => ''
  );
}

// Marks the block's own leading (question) open tag with the answer.
function markAnswered(block, { escapedAnswer, iso, escapedNote }) {
  return block.replace(/^<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*>/, (tag) => {
    let attrs = ` data-curator-answered="${escapedAnswer}" data-curator-answered-at="${iso}"`;
    if (escapedNote !== undefined) attrs += ` data-curator-answered-note="${escapedNote}"`;
    return insertAttrBeforeClose(tag, attrs);
  });
}

// Marks the `data-plan-option` tag matching the (already-escaped) answer.
// Escaping BEFORE matching lets a pre-escaped option value in the file match.
function markOption(block, escapedAnswer, id, rawAnswer) {
  const marker = `data-plan-option="${escapedAnswer}"`;
  const idx = block.indexOf(marker);
  if (idx === -1) throw new Error(`no option "${rawAnswer}" found for question "${id}"`);
  const tagStart = findEnclosingOpenTag(block, idx);
  const tagEnd = tagStart === -1 ? -1 : block.indexOf('>', idx);
  if (tagStart === -1 || tagEnd === -1) throw new Error(`malformed option tag for question "${id}"`);
  const marked = insertAttrBeforeClose(block.slice(tagStart, tagEnd + 1), ' data-curator-answered-option');
  return block.slice(0, tagStart) + marked + block.slice(tagEnd + 1);
}

// Applies one answer directly to the artifact on disk. Shared by `cmdAnswer`
// and `stampDecisions`. Throws on refusal (no match / not unique / no such
// option); never touches `data-curator-chosen`, the SDK's transient mark.
function applyAnswer(file, { question, answer, note }) {
  const escapedAnswer = escapeHtml(answer);
  const escapedNote = note !== undefined ? escapeHtml(note) : undefined;
  const iso = new Date().toISOString();
  mutateArtifact(file, (html) => {
    const { start, end } = scopeQuestionBlock(html, question, file);
    let block = html.slice(start, end);
    block = stripPriorMarks(block);
    block = markAnswered(block, { escapedAnswer, iso, escapedNote });
    block = markOption(block, escapedAnswer, question, answer);
    return html.slice(0, start) + block + html.slice(end);
  });
}

// Stamps every `{type:'decision', ...}` item in `prompts` onto `file`. Caught
// per item, never thrown — an unstamped mark beats a lost delivery.
function stampDecisions(file, prompts) {
  const failures = [];
  for (const item of prompts || []) {
    if (!item || item.type !== 'decision') continue;
    try {
      applyAnswer(file, { question: item.question, answer: item.answer, note: item.note });
    } catch (e) {
      failures.push(`${item.question}: ${(e && e.message) || e}`);
    }
  }
  return failures.length ? failures.join('; ') : undefined;
}

async function cmdAnswer(args) {
  const { positionals, flags } = parseArgs(args, {
    '--question': 'question',
    '--answer': 'answer',
    '--note': 'note',
  });
  const file = canonicalFile(positionals[0], { mustExist: true });
  if (!flags.question || !flags.answer) {
    fail('answer requires --question <id> and --answer <value>',
      `Run: curator answer ${file} --question <id> --answer <value> [--note <text>]`);
  }
  applyAnswer(file, { question: flags.question, answer: flags.answer, note: flags.note });
  out({
    status: 'answered',
    file,
    question: flags.question,
    answer: flags.answer,
    next_step: `Recorded on ${file} (reload the artifact to see it). Continue the poll/reply loop if the session is open.`,
  });
}

async function cmdEnd(args) {
  const { positionals } = parseArgs(args, {});
  const file = canonicalFile(positionals[0], { mustExist: false });
  const resolved = await resolveServer();
  if (resolved.status === 'unreachable') {
    failUnreachable({ state: resolved.state, cause: resolved.cause, command: `curator end ${file}` });
  }
  if (resolved.status === 'untrusted') failUntrusted(resolved, `curator open ${file}`);
  if (resolved.status !== 'running') fail(`no curator server running for ${file}`, 'Nothing to end. Run curator status to see sessions.');
  const { code, json } = await httpJson({
    method: 'POST',
    port: resolved.port,
    path: '/api/end',
    body: { key: file, by: 'agent' },
    timeoutMs: 5000,
    secret: resolved.secret,
  });
  if (code !== 200) fail(json.error || `server error ${code}`, json.next_step || 'Run curator status to see sessions.');
  out({ status: 'ended', ended_by: 'agent', key: file, next_step: 'Session closed. Deliver any remaining updates in chat.' });
}

async function cmdStatus(args) {
  parseArgs(args, {});
  const resolved = await resolveServer();
  if (resolved.status === 'unreachable') {
    failUnreachable({ state: resolved.state, cause: resolved.cause, command: 'curator status' });
  }
  if (resolved.status === 'untrusted') failUntrusted(resolved, 'curator open <file.html>');
  if (resolved.status === 'running') {
    const port = resolved.port;
    const { json } = await httpJson({ method: 'GET', port, path: '/api/status', timeoutMs: 5000, secret: resolved.secret });
    const sessions = json.sessions || [];
    if (sessions.length === 0) {
      out({ sessions: 0, server: 'running', port, next_step: 'Run: curator open <file.html> to start a session.' });
      return;
    }
    for (const s of sessions) out({ ...s, server: 'running', url: browserUrl(port, s.session, resolved.secret, resolved.boot) });
    return;
  }
  const state = resolved.state;
  const sessions = Object.entries((state && state.sessions) || {});
  if (sessions.length === 0) {
    out({ sessions: 0, server: 'stopped', next_step: 'Run: curator open <file.html> to start a session.' });
    return;
  }
  for (const [key, s] of sessions) {
    out({
      key,
      session: s.id,
      ended: !!s.ended,
      pending_feedback_items: (s.pending || []).length,
      server: 'stopped',
      next_step: `Run: curator open ${key} to restart the server for this session.`,
    });
  }
}

// --- dispatch ----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const commands = { open: cmdOpen, check: cmdCheck, poll: cmdPoll, drain: cmdDrain, reply: cmdReply, end: cmdEnd, status: cmdStatus, log: cmdLog, answer: cmdAnswer };

if (!cmd || !commands[cmd]) {
  fail(cmd ? `unknown command: ${cmd}` : 'missing command', USAGE);
}

commands[cmd](rest).catch((err) => {
  fail(String((err && err.message) || err), (err && err.next_step) || USAGE);
});
