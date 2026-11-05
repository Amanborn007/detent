// Runs the shell's inline script against a stub DOM, so the send, edit and
// reload paths are exercised rather than only grepped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { chromePage } from '../server.mjs';

const code = /<script>\n([\s\S]*)<\/script>/.exec(chromePage({ id: 'abc', file: '/tmp/p.html' }))[1];
const tick = () => new Promise((r) => setImmediate(r));

function boot({ hash = '#c=C1&r=R1', storage = {} } = {}) {
  const els = {};
  const sends = [];
  const posted = [];
  const mk = () => ({
    children: [], style: {}, listeners: {}, hidden: false, value: '', disabled: false, _t: '',
    classList: { add() {}, toggle() {} },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, focus() {}, select() {},
    set textContent(v) { this._t = v; this.children = []; },
    get textContent() { return this._t; },
  });
  const ctx = {
    console, URLSearchParams, setInterval: () => 1, clearInterval() {},
    location: { hash, pathname: '/s/abc', search: '' }, history: { replaceState() {} },
    sessionStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = v; } },
    document: { getElementById: (id) => (els[id] ||= mk()), createElement: mk, createTextNode: (t) => ({ t }), body: { classList: { add() {}, toggle() {} } } },
    fetch: (url, opts) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      let reply = { version: 1, chat: [], delivered: [], polling: false, mtime: 1 };
      if (url.includes('/api/send')) { sends.push(body); reply = { ok: true, ids: body.items.map((_, i) => `id${sends.length}-${i}`) }; }
      return Promise.resolve({ status: 200, json: () => Promise.resolve(reply) });
    },
    window: { addEventListener(t, f) { ctx.onMessage = f; } }, navigator: {},
  };
  const frameWin = { postMessage(m) { posted.push(m); } };
  els.plan = mk();
  els.plan.contentWindow = frameWin;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const from = (data) => ctx.onMessage({ source: frameWin, data: { curator: true, ...data } });
  const click = (id) => (els[id].listeners.click || []).forEach((f) => f());
  const queueRow = (i) => els.queue.children[i];
  return { els, sends, posted, from, click, queueRow, storage };
}

test('a reload restores sent answers so required questions are not nagged again', async () => {
  const a = boot();
  a.from({ action: 'decision', question: 'q1', answer: 'A' });
  a.click('send');
  await tick(); await tick();
  assert.equal(a.sends.length, 1);
  const b = boot({ hash: '', storage: a.storage });
  b.els.plan.listeners.load.forEach((f) => f());
  assert.match(b.els.progress.textContent, /1 decisions answered/);
  assert.ok(b.posted.some((m) => m.action === 'decision-sent' && m.question === 'q1'), 'the mark is re-posted as sent');
  b.from({ action: 'questions', questions: [{ question: 'q1', required: true }] });
  b.click('send');
  assert.doesNotMatch(b.els.modalMsg.textContent, /required decision/, 'no required-missing warning for an answered question');
});

test('Send anyway disables Send while the confirm is open and sends the live queue', async () => {
  const s = boot();
  s.from({ action: 'questions', questions: [{ question: 'must', required: true }] });
  s.from({ action: 'annotate-request', selector: '#a', elementText: 'A' });
  s.els.modalText.value = 'first';
  s.click('modalOk');
  s.from({ action: 'annotate-request', selector: '#b', elementText: 'B' });
  s.els.modalText.value = 'second';
  s.click('modalOk');
  assert.equal(s.els.queue.children.length, 2);
  s.click('send');
  assert.match(s.els.modalMsg.textContent, /required decision/);
  assert.equal(s.els.send.disabled, true, 'a second Send click cannot start another confirm');
  s.click('modalCancel');
  assert.equal(s.els.send.disabled, false, 'cancelling re-enables Send');
  s.click('send');
  s.queueRow(0).children[2].listeners.click[0]();
  s.click('modalOk');
  await tick(); await tick();
  assert.equal(s.sends.length, 1);
  assert.deepEqual(s.sends[0].items.map((i) => i.comment), ['second'], 'the item deleted during the confirm is not sent');
});

test('editing a decision note survives the item being re-answered meanwhile', () => {
  const s = boot();
  s.from({ action: 'decision', question: 'q', answer: 'A' });
  s.queueRow(0).children[1].listeners.click[0]();
  s.from({ action: 'decision', question: 'q', answer: 'B' });
  s.els.modalText.value = 'because';
  s.click('modalOk');
  const saved = JSON.parse(s.storage['curator:draft:abc']);
  assert.equal(saved.queue[0].answer, 'B');
  assert.equal(saved.queue[0].note, 'because');
});

test('an edit whose item is gone says so instead of vanishing', () => {
  const s = boot();
  s.from({ action: 'annotate-request', selector: '#a', elementText: 'A' });
  s.els.modalText.value = 'first';
  s.click('modalOk');
  s.queueRow(0).children[1].listeners.click[0]();
  s.queueRow(0).children[2].listeners.click[0]();
  s.els.modalText.value = 'edited';
  s.click('modalOk');
  assert.match(s.els.errText.textContent, /removed/);
  assert.equal(s.els.err.hidden, false);
});
