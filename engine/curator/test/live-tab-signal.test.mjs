// last_seen_at must mean "a tab of THIS boot ticked recently", so cmdOpen can trust it to skip a duplicate launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

import { SessionStore, createServer } from '../server.mjs';
import { sessionKey } from '../auth.mjs';

const SECRET = crypto.randomBytes(32).toString('hex');

function call(port, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'curator-live-')));
  const file = join(dir, 'plan.html');
  writeFileSync(file, '<!DOCTYPE html><html><body>x</body></html>');
  const store = new SessionStore();
  const server = createServer(store, { secret: SECRET });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const session = store.open(file);
  const cap = sessionKey(SECRET, server.bootId, session.id);
  const tick = () => call(port, 'GET', `/api/updates?s=${session.id}`, { 'X-Curator-Cap': cap });
  const gone = (headers) => call(port, 'POST', `/api/gone?s=${session.id}`, { 'Content-Type': 'application/json', ...headers }, '{}');
  const seen = async () => (await call(port, 'GET', '/api/status', { Authorization: `Bearer ${SECRET}` })).json.sessions[0].last_seen_at;
  try {
    await fn({ tick, gone, seen, cap });
  } finally {
    server.close();
  }
}

test('a tick sets last_seen_at, and a gone signal clears it', async () => {
  await withServer(async ({ tick, gone, seen, cap }) => {
    assert.equal(await seen(), null);
    await tick();
    assert.match(await seen(), /^\d{4}-\d\d-\d\dT/);
    const r = await gone({ 'X-Curator-Cap': cap });
    assert.equal(r.code, 200);
    assert.equal(await seen(), null);
    await tick();
    assert.notEqual(await seen(), null, 'a new page ticking right after a reload makes the session live again');
  });
});

test('a gone signal with a wrong or missing cap, or only the bearer, is a 401 and clears nothing', async () => {
  await withServer(async ({ tick, gone, seen }) => {
    await tick();
    const before = await seen();
    assert.equal((await gone({ 'X-Curator-Cap': 'f'.repeat(64) })).code, 401);
    assert.equal((await gone({})).code, 401);
    assert.equal((await gone({ Authorization: `Bearer ${SECRET}` })).code, 401);
    assert.equal(await seen(), before);
  });
});

test('last_seen_at is not restored after a daemon restart and is not written to state.json', () => {
  const stateFile = join(realpathSync(mkdtempSync(join(tmpdir(), 'curator-live-state-'))), 'state.json');
  const file = join(realpathSync(mkdtempSync(join(tmpdir(), 'curator-live-art-'))), 'plan.html');
  writeFileSync(file, '<!DOCTYPE html><html><body>x</body></html>');
  const a = new SessionStore({ stateFile });
  const s = a.open(file);
  a.markSeen(s.key, Date.now(), { flush: true });
  assert.ok(!('lastSeenAt' in Object.values(JSON.parse(readFileSync(stateFile, 'utf8')).sessions)[0]));
  const b = new SessionStore({ stateFile });
  b.loadState();
  assert.equal(b.get(s.key).lastSeenAt, null);
  assert.equal(b.statusList()[0].last_seen_at, null);
});
