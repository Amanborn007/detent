// Executes sdk.js against a minimal DOM shim: loading marks the page as connected, and
// clicking an option posts a decision to the parent window, which is a separate object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sdk.js'), 'utf8');

// Supports the selector shapes sdk.js uses: tag, [attr], [attr="v"], compound, and comma lists.
function matches(el, sel) {
  return sel.split(',').some((part) => {
    const s = part.trim();
    const tag = /^[a-z][a-z0-9]*/i.exec(s);
    if (tag && el.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    for (const m of s.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (!el.hasAttribute(m[1])) return false;
      if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
    }
    return true;
  });
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.textContent = '';
  }
  get parentElement() { return this.parentNode; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  querySelectorAll(sel) {
    const out = [];
    const visit = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); visit(c); } };
    visit(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { for (let n = this; n; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
}

function load() {
  const html = new Element('html');
  html.dataset = {};
  const head = html.appendChild(new Element('head'));
  const body = html.appendChild(new Element('body'));
  const q = body.appendChild(new Element('div'));
  q.setAttribute('data-plan-question', 'rollout');
  q.appendChild(new Element('h3'));
  for (const key of ['phased', 'cutover']) {
    const o = q.appendChild(new Element('div'));
    o.setAttribute('data-plan-option', key);
    o.appendChild(new Element('strong')).textContent = key;
  }

  const docListeners = {};
  const document = {
    readyState: 'complete',
    documentElement: html,
    head,
    body,
    addEventListener(t, f) { (docListeners[t] ||= []).push(f); },
    createElement: (tag) => new Element(tag),
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
  };
  const received = [];
  const parent = { postMessage(msg, origin) { received.push({ msg: JSON.parse(JSON.stringify(msg)), origin }); } };
  const window = { parent, addEventListener() {}, setTimeout, innerWidth: 800 };
  const ctx = { window, document, Element, console };
  vm.createContext(ctx);
  vm.runInContext(SDK, ctx);
  const click = (target) => {
    for (const f of docListeners.click || []) f({ target, altKey: false, preventDefault() {}, stopPropagation() {} });
  };
  return { html, head, q, received, parent, window, click };
}

test('loading sdk.js marks the document as connected', () => {
  const { html } = load();
  assert.equal(html.dataset.curator, 'connected');
});

test('clicking an option posts a decision to the parent window', () => {
  const { q, received, parent, window, click } = load();
  assert.notEqual(parent, window, 'the parent is a separate object from the window');
  click(q.querySelector('[data-plan-option="cutover"]'));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].msg, { curator: true, action: 'decision', question: 'rollout', answer: 'cutover' });
});

test('the injected style hides the offline banner once connected', () => {
  const { head } = load();
  const css = head.children.filter((c) => c.tagName === 'STYLE').map((s) => s.textContent).join('\n');
  assert.match(css, /html\[data-curator=connected\]\s*\.curator-offline\s*\{\s*display:\s*none/);
});
