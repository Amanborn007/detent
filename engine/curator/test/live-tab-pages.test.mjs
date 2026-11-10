// last_seen_at is the newest tick over live pages (tabs); one page closing must not clear another's signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

import { SessionStore, createServer, chromePage } from '../server.mjs';
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
  const tick = (p) => call(port, 'GET', `/api/updates?s=${session.id}${p === undefined ? '' : '&p=' + p}`, { 'X-Curator-Cap': cap });
  const gone = (p, headers = { 'X-Curator-Cap': cap }) => call(port, 'POST', `/api/gone?s=${session.id}${p === undefined ? '' : '&p=' + p}`, { 'Content-Type': 'application/json', ...headers }, '{}');
  const seen = async () => (await call(port, 'GET', '/api/status', { Authorization: `Bearer ${SECRET}` })).json.sessions[0].last_seen_at;
  try {
    await fn({ tick, gone, seen, cap, store, session });
  } finally {
    server.close();
  }
}

test('two pages: one gone leaves last_seen_at set, both gone clears it', async () => {
  await withServer(async ({ tick, gone, seen }) => {
    await tick('pageA');
    await tick('pageB');
    assert.equal((await gone('pageA')).code, 200);
    assert.notEqual(await seen(), null);
    await gone('pageB');
    assert.equal(await seen(), null);
  });
});

test('a tick from a page that already sent gone is ignored, other pages are unaffected', async () => {
  await withServer(async ({ tick, gone, seen }) => {
    await tick('pageA');
    await gone('pageA');
    await tick('pageA');
    assert.equal(await seen(), null);
    await tick('pageB');
    assert.notEqual(await seen(), null);
  });
});

test('a tick without a page id still counts, and a gone without one clears it', async () => {
  await withServer(async ({ tick, gone, seen }) => {
    await tick();
    assert.notEqual(await seen(), null);
    await gone();
    assert.equal(await seen(), null);
    await tick();
    assert.notEqual(await seen(), null);
  });
});

test('a malformed page id does not crash and is not counted', async () => {
  await withServer(async ({ tick, gone, seen }) => {
    for (const bad of ['a%20b', 'x'.repeat(65), '%3Cscript%3E', '..%2F..']) {
      assert.equal((await tick(bad)).code, 200);
      assert.equal(await seen(), null, bad);
      assert.equal((await gone(bad)).code, 200);
    }
  });
});

test('stale pages are dropped so the page map stays bounded', () => {
  const file = join(realpathSync(mkdtempSync(join(tmpdir(), 'curator-live-art-'))), 'plan.html');
  writeFileSync(file, '<!DOCTYPE html><html><body>x</body></html>');
  const store = new SessionStore();
  const s = store.open(file);
  const t0 = 1_000_000_000_000;
  for (let i = 0; i < 100; i++) store.markSeen(s.key, t0 + i, 'p' + i);
  store.markSeen(s.key, t0 + 60 * 60 * 1000, 'fresh');
  assert.equal(store.get(s.key).lastSeenAt, t0 + 60 * 60 * 1000);
  assert.equal(store.get(s.key).pages.size, 1);
});

const code = /<script>\n([\s\S]*)<\/script>/.exec(chromePage({ id: 'abc', file: '/tmp/p.html' }))[1];

function boot({ hash = '#c=C1&r=R1' } = {}) {
  const calls = [];
  const listeners = {};
  const mk = () => ({
    children: [], style: {}, listeners: {}, hidden: false, value: '', disabled: false, _t: '',
    classList: { add() {}, toggle() {} },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, focus() {}, select() {},
    set textContent(v) { this._t = v; this.children = []; },
    get textContent() { return this._t; },
  });
  const els = {};
  const document = { visibilityState: 'visible', getElementById: (id) => (els[id] ||= mk()), createElement: mk, createTextNode: (t) => ({ t }), body: { classList: { add() {}, toggle() {} } } };
  const ctx = {
    console, URLSearchParams, setInterval: () => 1, clearInterval() {},
    location: { hash, pathname: '/s/abc', search: '' }, history: { replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    document,
    fetch: (url, opts = {}) => {
      calls.push({ url, ...opts });
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ version: 1, chat: [], delivered: [], polling: false, mtime: 1 }) });
    },
    window: { addEventListener(t, f) { (listeners[t] ||= []).push(f); } }, navigator: {},
  };
  els.plan = mk();
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const fire = (t) => (listeners[t] || []).forEach((f) => f({ type: t }));
  return { calls, fire, document };
}


test('the shell skips the visibilitychange tick when hidden, and tags ticks and gone with one page id', () => {
  const p = boot();
  p.calls.length = 0;
  p.document.visibilityState = 'hidden';
  p.fire('visibilitychange');
  assert.equal(p.calls.filter((c) => c.url.startsWith('/api/updates')).length, 0);
  p.document.visibilityState = 'visible';
  p.fire('visibilitychange');
  const ticks = p.calls.filter((c) => c.url.startsWith('/api/updates'));
  assert.equal(ticks.length, 1);
  const id = /[?&]p=([A-Za-z0-9_-]{1,64})(&|$)/.exec(ticks[0].url);
  assert.ok(id, 'tick carries p=');
  p.fire('pagehide');
  const g = p.calls.find((c) => c.url.startsWith('/api/gone'));
  assert.equal(g.url, '/api/gone?s=abc&p=' + id[1]);
});
