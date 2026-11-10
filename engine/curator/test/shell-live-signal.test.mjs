// The shell page must keep the daemon's last_seen_at honest even when the browser throttles its timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { chromePage } from '../server.mjs';

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
  const fire = (t, e = {}) => (listeners[t] || []).forEach((f) => f({ type: t, ...e }));
  return { calls, fire, document };
}

test('becoming visible sends a tick straight away, hidden does not', () => {
  const p = boot();
  p.calls.length = 0;
  p.document.visibilityState = 'hidden';
  p.fire('visibilitychange');
  p.document.visibilityState = 'visible';
  p.fire('visibilitychange');
  const ticks = p.calls.filter((c) => c.url.startsWith('/api/updates?s=abc'));
  assert.equal(ticks.length, 1);
});

test('pagehide posts a keepalive gone signal carrying the cap', () => {
  const p = boot();
  p.calls.length = 0;
  p.fire('pagehide');
  assert.equal(p.calls.length, 1);
  const c = p.calls[0];
  assert.match(c.url, /^\/api\/gone\?s=abc&p=[A-Za-z0-9_-]+$/);
  assert.equal(c.method, 'POST');
  assert.equal(c.keepalive, true);
  assert.equal(c.headers['X-Curator-Cap'], 'C1');
});

test('a page with no key sends no signals', () => {
  const p = boot({ hash: '' });
  p.calls.length = 0;
  p.fire('pagehide');
  p.fire('visibilitychange');
  assert.equal(p.calls.length, 0);
});

test('a page restored from the back-forward cache comes back under a fresh page id', () => {
  const p = boot();
  p.fire('pagehide');
  const goneId = /&p=([^&]+)/.exec(p.calls.at(-1).url)[1];
  p.calls.length = 0;
  p.fire('pageshow', { persisted: true });
  const ticks = p.calls.filter((c) => c.url.startsWith('/api/updates?s=abc'));
  assert.equal(ticks.length, 1);
  assert.notEqual(/&p=([^&]+)/.exec(ticks[0].url)[1], goneId);
});

test('a normal first pageshow does not send an extra tick', () => {
  const p = boot();
  p.calls.length = 0;
  p.fire('pageshow', { persisted: false });
  assert.equal(p.calls.filter((c) => c.url.startsWith('/api/updates')).length, 0);
});
