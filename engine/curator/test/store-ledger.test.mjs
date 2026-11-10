// Store-level behaviour for the answer flow: the delivered ledger, the tab
// heartbeat, state pruning and the daemon's exit decisions. Pure functions
// are tested directly so no daemon has to be spawned.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

import {
  SessionStore, createServer, shouldIdleExit, shouldExitForState, shouldPruneSession, idleMsFromEnv, IDLE_SHUTDOWN_MS,
} from '../server.mjs';
import { sessionKey } from '../auth.mjs';

const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'curator-ledger-')));
let n = 0;
const artifact = () => {
  const f = join(base, `plan-${n++}.html`);
  fs.writeFileSync(f, '<!DOCTYPE html><html><body>x</body></html>');
  return f;
};
const stateFileName = () => join(base, `state-${n++}.json`);
const servers = [];
after(() => { for (const s of servers) s.close(); });

async function boot(store) {
  const secret = crypto.randomBytes(32).toString('hex');
  const server = createServer(store, { secret });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = server.address().port;
  const capHeader = (id) => ({ 'X-Curator-Cap': sessionKey(secret, server.bootId, id) });
  const bearer = { Authorization: `Bearer ${secret}` };
  const call = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { Host: `127.0.0.1:${port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve({ code: res.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  return { server, port, capHeader, bearer, call };
}

test('a poll response that finishes records its items in the delivered ledger', async () => {
  const store = new SessionStore();
  const file = artifact();
  const s = store.open(file);
  const { capHeader, bearer, call } = await boot(store);
  const sent = await call('POST', `/api/send?s=${s.id}`, { headers: capHeader(s.id), body: { items: [{ type: 'comment', text: 'a' }, { type: 'comment', text: 'b' }] } });
  assert.equal(sent.code, 200);
  assert.equal(sent.json.ids.length, 2, 'send tells the shell which ids it accepted');
  let upd = await call('GET', `/api/updates?s=${s.id}`, { headers: capHeader(s.id) });
  assert.deepEqual(upd.json.delivered, [], 'nothing is delivered before an agent polls');
  const polled = await call('GET', `/api/poll?key=${encodeURIComponent(file)}`, { headers: bearer });
  assert.equal(polled.json.prompts.length, 2);
  await new Promise((r) => setTimeout(r, 50));
  upd = await call('GET', `/api/updates?s=${s.id}`, { headers: capHeader(s.id) });
  assert.deepEqual(upd.json.delivered.map((d) => d.id).sort(), [...sent.json.ids].sort());
  assert.ok(upd.json.delivered.every((d) => typeof d.at === 'string'));
});

test('updates report whether a poll is waiting right now', async () => {
  const store = new SessionStore();
  const file = artifact();
  const s = store.open(file);
  const { port, capHeader, bearer, call } = await boot(store);
  let upd = await call('GET', `/api/updates?s=${s.id}`, { headers: capHeader(s.id) });
  assert.equal(upd.json.polling, false);
  const req = http.request({ host: '127.0.0.1', port, path: `/api/poll?key=${encodeURIComponent(file)}`, headers: { Host: `127.0.0.1:${port}`, ...bearer } });
  req.on('error', () => {});
  req.end();
  await new Promise((r) => setTimeout(r, 100));
  upd = await call('GET', `/api/updates?s=${s.id}`, { headers: capHeader(s.id) });
  assert.equal(upd.json.polling, true);
  req.destroy();
});

test('a poll whose socket died is requeued and never reaches the ledger', async () => {
  const store = new SessionStore();
  const file = artifact();
  const s = store.open(file);
  store.send(file, [{ type: 'comment', text: 'x' }]);
  const payload = await store.poll(file);
  store.requeue(file, payload);
  assert.equal(s.pending.length, 1);
  assert.deepEqual(s.delivered, []);
});

test('recordDelivered keeps the ids assigned at send and survives a state reload', () => {
  const stateFile = stateFileName();
  const store = new SessionStore({ stateFile });
  const file = artifact();
  const s = store.open(file);
  const items = [{ type: 'decision', question: 'q', answer: 'A' }];
  store.send(file, items);
  const [id] = store.idsFor(items);
  const drained = store.drainPending(s);
  store.recordDelivered(file, drained);
  assert.equal(s.delivered[0].id, id);
  const again = new SessionStore({ stateFile });
  again.loadState();
  assert.equal(again.get(file).delivered[0].id, id);
});

test('the status list carries last_seen_at from the open tab, and updates ticks set it', async () => {
  const store = new SessionStore();
  const s = store.open(artifact());
  const { capHeader, bearer, call } = await boot(store);
  let st = await call('GET', '/api/status', { headers: bearer });
  assert.equal(st.json.sessions[0].last_seen_at, null, 'never seen before a tab ticks');
  const before = Date.now();
  await call('GET', `/api/updates?s=${s.id}`, { headers: capHeader(s.id) });
  st = await call('GET', '/api/status', { headers: bearer });
  const seen = Date.parse(st.json.sessions[0].last_seen_at);
  assert.ok(seen >= before - 1 && seen <= Date.now() + 1, 'last_seen_at is the tick time');
});

test('a rejected tick does not count as the tab being seen', async () => {
  const store = new SessionStore();
  const s = store.open(artifact());
  const { call } = await boot(store);
  const r = await call('GET', `/api/updates?s=${s.id}`, { headers: { 'X-Curator-Cap': 'f'.repeat(64) } });
  assert.equal(r.code, 401);
  assert.equal(s.lastSeenAt, null);
});

test('lastSeenAt does not survive a daemon restart', () => {
  const stateFile = stateFileName();
  const store = new SessionStore({ stateFile });
  const file = artifact();
  store.open(file);
  store.markSeen(file, 1234567890000);
  const again = new SessionStore({ stateFile });
  again.loadState();
  assert.equal(again.get(file).lastSeenAt, null);
});

test('updates include the artifact file mtime so the shell can reload on republish', async () => {
  const store = new SessionStore();
  const file = artifact();
  const s = store.open(file);
  const { capHeader, call } = await boot(store);
  fs.utimesSync(file, 1000, 1000);
  const a = await call('GET', `/api/updates?s=${s.id}`, { headers: capHeader(s.id) });
  fs.utimesSync(file, 2000, 2000);
  const b = await call('GET', `/api/updates?s=${s.id}`, { headers: capHeader(s.id) });
  assert.equal(typeof a.json.mtime, 'number');
  assert.notEqual(a.json.mtime, b.json.mtime);
});

test('the prune rule drops a session only when its file is gone and its queue is empty', () => {
  assert.equal(shouldPruneSession({ fileExists: false, pendingCount: 0 }), true);
  assert.equal(shouldPruneSession({ fileExists: false, pendingCount: 1 }), false, 'queued feedback is never pruned');
  assert.equal(shouldPruneSession({ fileExists: true, pendingCount: 0 }), false);
});

test('loadState applies the prune rule and open() never prunes', () => {
  const stateFile = stateFileName();
  const store = new SessionStore({ stateFile });
  const gone = artifact();
  const goneQueued = artifact();
  const live = artifact();
  for (const f of [gone, goneQueued, live]) store.open(f);
  store.send(goneQueued, [{ type: 'comment', text: 'keep me' }]);
  fs.rmSync(gone);
  fs.rmSync(goneQueued);

  const reloaded = new SessionStore({ stateFile });
  reloaded.loadState();
  assert.equal(reloaded.get(gone), null, 'missing file with an empty queue is pruned');
  assert.ok(reloaded.get(goneQueued), 'missing file but queued feedback survives');
  assert.ok(reloaded.get(live));

  const missing = artifact();
  fs.rmSync(missing);
  store.open(missing);
  assert.ok(store.get(gone), 'open() leaves a session with a missing file alone');
});

test('idle exit needs no waiter and no request for the full idle window, live sessions or not', () => {
  const idleMs = 1000;
  assert.equal(shouldIdleExit({ hasWaiters: false, lastActivity: 0, now: 1001, idleMs }), true);
  assert.equal(shouldIdleExit({ hasWaiters: false, lastActivity: 0, now: 999, idleMs }), false);
  assert.equal(shouldIdleExit({ hasWaiters: true, lastActivity: 0, now: 10 * idleMs, idleMs }), false, 'an attached poll keeps it alive');
});

test('CURATOR_IDLE_MS overrides the idle window and defaults to 60 minutes', () => {
  assert.equal(idleMsFromEnv({}), IDLE_SHUTDOWN_MS);
  assert.equal(IDLE_SHUTDOWN_MS, 60 * 60 * 1000);
  assert.equal(idleMsFromEnv({ CURATOR_IDLE_MS: '5000' }), 5000);
  assert.throws(() => idleMsFromEnv({ CURATOR_IDLE_MS: 'soon' }), /CURATOR_IDLE_MS/);
});

test('the daemon exits when state.json is gone or names another pid, and only then', () => {
  assert.equal(shouldExitForState({ stateExists: false, statePid: null, ownPid: 7 }), true);
  assert.equal(shouldExitForState({ stateExists: true, statePid: 8, ownPid: 7 }), true);
  assert.equal(shouldExitForState({ stateExists: true, statePid: 7, ownPid: 7 }), false);
});

test('hasWaiters reflects an attached poll', () => {
  const store = new SessionStore();
  const file = artifact();
  store.open(file);
  assert.equal(store.hasWaiters(), false);
  const { cancel } = store.pollCancelable(file);
  assert.equal(store.hasWaiters(), true);
  cancel();
  assert.equal(store.hasWaiters(), false);
});
