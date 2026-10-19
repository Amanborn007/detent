// e2e smoke test: real server, real CLI processes, real HTTP — simulating the
// browser by POSTing the same endpoints sdk.js/the chrome page use.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const CURATOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(CURATOR_DIR, 'cli.mjs');

// realpath: the CLI canonicalizes paths (macOS /var -> /private/var), so the
// test must compare against the same canonical form.
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-e2e-')));
const stateDir = join(workDir, 'state');
const artifact = join(workDir, 'plan.html');

const ARTIFACT_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>e2e plan</title></head>
<body>
<h1 id="title">Rollout plan</h1>
<p id="risk">Risky: big-bang migration.</p>
<div data-plan-question="q-rollout">
  <button data-plan-option="Phased">Phased</button>
  <button data-plan-option="Big-bang">Big-bang</button>
</div>
</body></html>
`;
writeFileSync(artifact, ARTIFACT_HTML);

const env = { ...process.env, CURATOR_STATE_DIR: stateDir, CURATOR_NO_BROWSER: '1' };

function runCli(args) {
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

function startCli(args) {
  const child = spawn(process.execPath, [CLI, ...args], { env });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout })));
  return { child, done };
}

function fetchRaw(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let port;
let sessionId;

after(() => {
  try {
    const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    if (state.pid) process.kill(state.pid);
  } catch {
    // server already gone
  }
});

test('open: starts a server, prints url + next_step, serves chrome page and injected artifact', async () => {
  const { code, stdout } = await runCli(['open', artifact]);
  assert.equal(code, 0, `open failed: ${stdout}`);
  const opened = JSON.parse(stdout);
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]+$/);
  assert.match(opened.next_step, /curator poll/);
  assert.match(opened.next_step, /do not kill it/);
  port = Number(new URL(opened.url).port);
  sessionId = opened.session;

  const chrome = await fetchRaw(port, `/s/${sessionId}`);
  assert.equal(chrome.code, 200);
  assert.match(chrome.body.toString(), /<iframe[^>]+sandbox="allow-scripts allow-forms"/);
  assert.match(chrome.body.toString(), /Send to Agent/);
  assert.match(chrome.body.toString(), /End session/);

  const served = await fetchRaw(port, `/artifact/${sessionId}`);
  assert.equal(served.code, 200);
  const tag = `<script src="/sdk.js?s=${sessionId}"></script>`;
  const text = served.body.toString();
  assert.ok(
    text.startsWith(`<!DOCTYPE html>\n${tag}\n`),
    'doctype stays first (standards mode preserved); sdk tag injected right after it'
  );
  assert.equal(text.replace(`\n${tag}`, ''), ARTIFACT_HTML, 'artifact bytes otherwise identical');
  assert.equal(text.split('/sdk.js?s=').length - 1, 1, 'script tag appears exactly once');
  assert.equal(readFileSync(artifact, 'utf8'), ARTIFACT_HTML, 'file on disk never modified');

  const sdk = await fetchRaw(port, '/sdk.js');
  assert.equal(sdk.code, 200);
  assert.match(sdk.body.toString(), /queuePrompt/);
});

test('poll resolves with queued annotations + decision answer and a next_step', async () => {
  const poll = startCli(['poll', artifact]);
  await sleep(400); // let the long-poll register

  const items = [
    { type: 'annotation', selector: '#risk', elementText: 'Risky: big-bang migration.', comment: 'address this risk' },
    { type: 'annotation', selector: '#title', elementText: 'Rollout plan', comment: 'rename to Q3 rollout' },
    { type: 'decision', question: 'q-rollout', answer: 'Phased' },
  ];
  const send = await fetchRaw(port, '/api/send', { method: 'POST', body: { sessionId, items } });
  assert.equal(send.code, 200);
  assert.equal(JSON.parse(send.body).delivered, true, 'a live poll consumed the send');

  const { code, stdout } = await poll.done;
  assert.equal(code, 0, `poll failed: ${stdout}`);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'feedback');
  assert.equal(result.prompts.length, 3);
  assert.deepEqual(result.prompts[2], { type: 'decision', question: 'q-rollout', answer: 'Phased' });
  assert.match(result.next_step, /curator reply .* and poll again/);
});

test('feedback sent while nobody polls is durable and served to the next poll', async () => {
  const items = [{ type: 'comment', text: 'also consider a feature flag' }];
  const send = await fetchRaw(port, '/api/send', { method: 'POST', body: { sessionId, items } });
  assert.equal(JSON.parse(send.body).delivered, false, 'queued, not delivered');

  const { code, stdout } = await runCli(['poll', artifact]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'feedback');
  assert.deepEqual(result.prompts, items);
});

test('reply lands in the chat log and blocks until end; ended response is correct', async () => {
  const reply = startCli(['reply', artifact, '-m', 'Switched the plan to a phased rollout.']);
  await sleep(500);

  const updates = await fetchRaw(port, `/api/updates?s=${sessionId}`);
  const chat = JSON.parse(updates.body).chat;
  assert.ok(
    chat.some((m) => m.from === 'agent' && m.text.includes('phased rollout')),
    'agent reply visible to the browser chat log'
  );

  const end = await fetchRaw(port, '/api/end', { method: 'POST', body: { sessionId, by: 'user' } });
  assert.equal(end.code, 200);

  const { code, stdout } = await reply.done;
  assert.equal(code, 0, `reply failed: ${stdout}`);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'ended');
  assert.match(result.next_step, /Stop polling/);

  const again = await runCli(['poll', artifact]);
  assert.equal(JSON.parse(again.stdout).status, 'ended');
});

test('non-local Host header is refused (dns-rebinding guard)', async () => {
  const evil = await fetchRaw(port, '/api/status', { headers: { Host: 'evil.example.com' } });
  assert.equal(evil.code, 403);
  assert.match(JSON.parse(evil.body).error, /Host/);

  const local = await fetchRaw(port, '/api/status', { headers: { Host: `localhost:${port}` } });
  assert.equal(local.code, 200);
});

test('status lists the session as a JSON line; unknown flags are rejected by name', async () => {
  const status = await runCli(['status']);
  assert.equal(status.code, 0);
  const lines = status.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.key === artifact && l.ended === true));

  const bad = await runCli(['poll', artifact, '--frobnicate', 'x']);
  assert.equal(bad.code, 1);
  const err = JSON.parse(bad.stdout);
  assert.equal(err.error, 'unknown flag: --frobnicate');
  assert.ok(err.next_step);
});
