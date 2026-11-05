// Fixes from the referee review of the shell-flow PR: daemon exit safety,
// idle exit with live sessions, send validation and pure answer logic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

import {
  SessionStore, createServer, shouldIdleExit, shouldExitForState, answerProgress, handoffLabel, chromePage,
} from '../server.mjs';
import { sessionKey } from '../auth.mjs';

const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'curator-fixes-')));
let n = 0;
const artifact = () => {
  const f = join(base, `plan-${n++}.html`);
  fs.writeFileSync(f, '<!DOCTYPE html><html><body>x</body></html>');
  return f;
};
const servers = [];
after(() => { for (const s of servers) s.close(); });

test('the ownership exit never fires with a waiting poll or unsent answers', () => {
  const gone = { stateExists: false, statePid: null, ownPid: 7 };
  assert.equal(shouldExitForState({ ...gone, hasWaiters: true }), false);
  assert.equal(shouldExitForState({ ...gone, hasPending: true }), false);
  assert.equal(shouldExitForState({ ...gone, hasWaiters: false, hasPending: false }), true);
  assert.equal(shouldExitForState({ stateExists: true, statePid: 8, ownPid: 7, hasPending: true }), false);
});

test('hasPending reports any session with queued items', () => {
  const store = new SessionStore();
  const file = artifact();
  store.open(file);
  assert.equal(store.hasPending(), false);
  store.send(file, [{ type: 'comment', text: 'x' }]);
  assert.equal(store.hasPending(), true);
});

test('before an ownership exit, pending items are merged into the state file another daemon owns', () => {
  const stateFile = join(base, `state-${n++}.json`);
  const a = new SessionStore({ stateFile });
  const file = artifact();
  a.open(file);
  const item = { type: 'comment', text: 'keep me' };
  a.send(file, [item]);
  const b = new SessionStore({ stateFile });
  b.meta = { pid: 2 };
  b.flush();
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions[file], undefined);
  a.mergePendingIntoState();
  const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(data.sessions[file].pending, [item]);
  assert.equal(data.pid, 2, 'the other daemon keeps its ownership fields');
  a.mergePendingIntoState();
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions[file].pending.length, 1, 'merging twice does not duplicate');
});

test('idle exit is blocked while any session is still live', () => {
  const idle = { hasWaiters: false, lastActivity: 0, now: 5000, idleMs: 1000 };
  assert.equal(shouldIdleExit({ ...idle, hasLiveSessions: true }), false);
  assert.equal(shouldIdleExit({ ...idle, hasLiveSessions: false }), true);
});

test('the unsent-drafts box also shows while the server is unreachable', () => {
  const page = chromePage({ id: 'abc123', file: '/tmp/plan.html' });
  assert.match(page, /body\.offline #drafts/);
});

test('a question named like an Object property is not counted as answered', () => {
  const p = answerProgress([{ question: 'constructor' }, { question: 'toString' }], []);
  assert.equal(p.answered, 0);
  assert.deepEqual(p.unanswered, ['constructor', 'toString']);
  assert.equal(answerProgress(null, ['constructor']).answered, 1);
  assert.equal(answerProgress([{ question: 'constructor' }], ['constructor']).answered, 1);
});

test('the sent state reads handed to agent, not delivered', () => {
  assert.equal(handoffLabel('delivered', false), 'handed to agent');
  assert.equal(handoffLabel('sent', false), 'queued — agent not listening right now');
  const page = chromePage({ id: 'abc123', file: '/tmp/plan.html' });
  assert.doesNotMatch(page, /delivered to agent/);
});

test('/api/send rejects null and primitive items before touching the queue', async () => {
  const store = new SessionStore();
  const file = artifact();
  const s = store.open(file);
  const secret = crypto.randomBytes(32).toString('hex');
  const server = createServer(store, { secret });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = server.address().port;
  const post = (items) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ items });
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/api/send?s=${s.id}`,
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Curator-Cap': sessionKey(secret, server.bootId, s.id) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  for (const bad of [[null], ['text'], [7], [[]], [{ type: 'comment', text: 'ok' }, null]]) {
    const r = await post(bad);
    assert.equal(r.code, 400, JSON.stringify(bad));
    assert.ok(r.json.next_step);
  }
  assert.equal(s.pending.length, 0, 'nothing was queued by a rejected send');
  assert.equal((await post([{ type: 'comment', text: 'ok' }])).code, 200);
});
