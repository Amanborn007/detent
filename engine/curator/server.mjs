#!/usr/bin/env node
// curator server: serves plan artifacts with an injected annotation SDK and
// bridges browser feedback to a long-polling CLI. Binds 127.0.0.1 only.
// Concept credit: lavish-axi by kunchenguid (MIT) — concepts only; see NOTICE.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  resolveStateDir, checkStateDir, loadOrCreateSecret, ensureGitignore, healthProof, artifactKey, sessionKey, safeEqual,
} from './auth.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const FEEDBACK_NEXT_STEP =
  'Apply the feedback, then run: curator reply <file> -m "<what you changed>" and poll again.';
export const ENDED_NEXT_STEP =
  'The user ended the session. Stop polling. Do not reopen it uninvited; deliver any remaining updates in chat.';

export const IDLE_SHUTDOWN_MS = 60 * 60 * 1000; // 60 min with no sessions/activity
export const HEARTBEAT_MS = 15 * 1000;

// ---------------------------------------------------------------------------
// SessionStore: the core queue/poll semantics. Pure logic, unit-testable.
// Session key = canonical absolute path of the artifact file.
// ---------------------------------------------------------------------------
export class SessionStore {
  constructor({ stateFile = null } = {}) {
    this.stateFile = stateFile;
    this.sessions = new Map(); // key -> session
    this.meta = {}; // pid/port, merged into the state file by the server
    this.lastActivity = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  open(filePath) {
    this.touch();
    const key = filePath;
    const existing = this.sessions.get(key);
    if (existing && !existing.ended) return existing;
    const session = {
      id: crypto.randomBytes(12).toString('hex'),
      key,
      file: filePath,
      createdAt: new Date().toISOString(),
      pending: existing ? existing.pending : [], // never lose queued feedback across reopen
      ended: false,
      endedBy: null,
      chat: existing ? existing.chat : [],
      version: 0,
      waiters: [],
    };
    this.sessions.set(key, session);
    this.flush();
    return session;
  }

  get(key) {
    return this.sessions.get(key) || null;
  }

  getById(id) {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return null;
  }

  // Merge items into a pending list. Decision answers are keyed by question:
  // re-answering replaces the earlier answer (exactly one answer per question).
  static mergeItems(pending, items) {
    for (const item of items) {
      if (item && item.type === 'decision' && item.question !== undefined) {
        const i = pending.findIndex((p) => p.type === 'decision' && p.question === item.question);
        if (i !== -1) {
          pending[i] = item;
          continue;
        }
      }
      pending.push(item);
    }
    return pending;
  }

  feedbackPayload(session, prompts) {
    return {
      status: 'feedback',
      prompts,
      next_step: FEEDBACK_NEXT_STEP.replaceAll('<file>', session.key),
    };
  }

  endedPayload(session, prompts) {
    return { status: 'ended', prompts, next_step: ENDED_NEXT_STEP };
  }

  drainPending(session) {
    const prompts = session.pending;
    session.pending = [];
    return prompts;
  }

  resolveWaiters(session, payload) {
    const waiters = session.waiters.splice(0);
    for (const w of waiters) w.resolve(payload);
    return waiters.length;
  }

  // User clicked "Send to Agent". Returns true if a waiting poll consumed it,
  // false if it was durably queued for the next poll.
  send(key, items) {
    this.touch();
    const session = this.mustGet(key);
    if (session.ended) throw new Error(`session for ${key} already ended`);
    SessionStore.mergeItems(session.pending, items);
    session.version += 1;
    if (session.waiters.length > 0) {
      const payload = this.feedbackPayload(session, this.drainPending(session));
      this.resolveWaiters(session, payload);
      this.flush();
      return true;
    }
    this.flush();
    return false;
  }

  // Agent long-poll. Resolves immediately if feedback is already pending or the
  // session has ended; otherwise waits for the next user action.
  poll(key) {
    return this.pollCancelable(key).promise;
  }

  pollCancelable(key) {
    this.touch();
    const session = this.mustGet(key);
    if (session.ended) {
      const payload = this.endedPayload(session, this.drainPending(session));
      this.flush();
      return { promise: Promise.resolve(payload), cancel: () => {} };
    }
    if (session.pending.length > 0) {
      const payload = this.feedbackPayload(session, this.drainPending(session));
      this.flush();
      return { promise: Promise.resolve(payload), cancel: () => {} };
    }
    const waiter = {};
    waiter.promise = new Promise((resolve) => {
      waiter.resolve = resolve;
    });
    session.waiters.push(waiter);
    return {
      promise: waiter.promise,
      cancel: () => {
        const i = session.waiters.indexOf(waiter);
        if (i !== -1) session.waiters.splice(i, 1);
      },
    };
  }

  // The poller died before the payload reached it: put the prompts back so the
  // next poll retrieves them. Feedback is never lost.
  requeue(key, payload) {
    const session = this.get(key);
    if (!session || !payload || !Array.isArray(payload.prompts)) return;
    session.pending = payload.prompts.concat(session.pending);
    this.flush();
  }

  end(key, { by = 'user' } = {}) {
    this.touch();
    const session = this.mustGet(key);
    session.ended = true;
    session.endedBy = by;
    session.version += 1;
    // Only drain pending feedback if a waiter is actually there to receive it;
    // otherwise leave it queued so the next poll's ended response includes it.
    const prompts = session.waiters.length > 0 ? this.drainPending(session) : [];
    const payload = this.endedPayload(session, prompts);
    this.resolveWaiters(session, payload);
    this.flush();
    return payload;
  }

  addReply(key, message) {
    this.touch();
    const session = this.mustGet(key);
    session.chat.push({ from: 'agent', text: message, at: new Date().toISOString() });
    session.version += 1;
    this.flush();
  }

  addUserChat(key, text) {
    const session = this.mustGet(key);
    session.chat.push({ from: 'user', text, at: new Date().toISOString() });
    session.version += 1;
    this.flush();
  }

  mustGet(key) {
    const session = this.sessions.get(key);
    if (!session) throw new Error(`no session for ${key}`);
    return session;
  }

  statusList() {
    return [...this.sessions.values()].map((s) => ({
      key: s.key,
      session: s.id,
      created_at: s.createdAt,
      ended: s.ended,
      ended_by: s.endedBy,
      pending_feedback_items: s.pending.length,
    }));
  }

  hasLiveSessions() {
    for (const s of this.sessions.values()) if (!s.ended) return true;
    return false;
  }

  // --- durable state ---
  flush() {
    if (!this.stateFile) return;
    const sessions = {};
    for (const [key, s] of this.sessions) {
      sessions[key] = {
        id: s.id,
        file: s.file,
        createdAt: s.createdAt,
        pending: s.pending,
        ended: s.ended,
        endedBy: s.endedBy,
        chat: s.chat,
      };
    }
    const data = { ...this.meta, updatedAt: new Date().toISOString(), sessions };
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    for (const [key, s] of Object.entries(data.sessions || {})) {
      this.sessions.set(key, {
        id: s.id,
        key,
        file: s.file,
        createdAt: s.createdAt,
        pending: s.pending || [],
        ended: !!s.ended,
        endedBy: s.endedBy || null,
        chat: s.chat || [],
        version: 0,
        waiters: [],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function sendJson(res, code, obj) {
  res.writeHead(code, JSON_HEADERS);
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Serve the artifact verbatim except for exactly one injected script tag.
// The tag goes right AFTER the doctype (anything other than comments/whitespace
// before <!DOCTYPE> puts the browser in quirks mode), or is prepended when
// there is no doctype. Leading HTML comments (e.g. a license/generator header)
// are legal before the doctype and must be preserved ahead of the injected tag,
// or standards mode is silently lost. The file on disk is never modified.
export function injectedArtifact(bytes, sessionId) {
  const tag = `<script src="/sdk.js?s=${sessionId}"></script>`;
  // Scan a bounded prefix: skip any leading whitespace + HTML comments, then the
  // doctype. Matched length (comments + doctype) is where the tag is injected.
  const prefix = bytes.subarray(0, 65536).toString('utf8');
  const doctype = /^(?:\s*<!--[\s\S]*?-->)*\s*<!doctype[^>]*>/i.exec(prefix);
  if (doctype) {
    const at = Buffer.byteLength(doctype[0], 'utf8');
    return Buffer.concat([bytes.subarray(0, at), Buffer.from(`\n${tag}`, 'utf8'), bytes.subarray(at)]);
  }
  return Buffer.concat([Buffer.from(`${tag}\n`, 'utf8'), bytes]);
}

// Security: refuse to read anything that resolves outside the registered
// artifact's directory (e.g. the file was swapped for a symlink elsewhere).
export function safeReadArtifact(registeredFile) {
  const registeredDir = path.dirname(registeredFile);
  const real = fs.realpathSync(registeredFile);
  if (real !== registeredFile && !real.startsWith(registeredDir + path.sep)) {
    throw new Error(`artifact resolves outside its registered directory: ${real}`);
  }
  return fs.readFileSync(real);
}

function chromePage(session) {
  const title = escapeHtml(path.basename(session.file));
  const sid = session.id;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>curator — ${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; min-width: 0; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         display: flex; flex-direction: column; height: 100vh; background: #f4f5f7; color: #1a1d21; }
  @media (prefers-color-scheme: dark) { body { background: #17191c; color: #e6e8ea; } }
  header { padding: 10px 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid rgba(128,128,128,.3);
           background: rgba(128,128,128,.06); flex: none; }
  header .dot { width: 9px; height: 9px; border-radius: 50%; background: #2fa34f; flex: none; }
  header.ended .dot { background: #b0b6bd; }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header .hint { font-size: 12px; opacity: .65; margin-left: auto; white-space: nowrap; }
  main { flex: 1; display: flex; min-height: 0; }
  iframe { flex: 1; border: 0; background: #fff; }
  aside { width: 340px; flex: none; display: flex; flex-direction: column; border-left: 1px solid rgba(128,128,128,.3); }
  aside h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .6; margin: 12px 14px 6px; }
  #queue { flex: 1; overflow-y: auto; padding: 0 10px; min-height: 80px; }
  #queue:empty::after { content: "Nothing queued. Alt-click an element, select text, or answer a decision in the plan. Click anything queued to edit it before sending.";
                        display: block; font-size: 12px; opacity: .55; padding: 8px 6px; }
  .item { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-size: 12.5px;
          display: flex; gap: 8px; align-items: flex-start; background: rgba(128,128,128,.05); }
  .item .kind { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: 1px 6px;
                border-radius: 99px; flex: none; margin-top: 1px; }
  .kind-annotation { background: #dbe9ff; color: #1c4f9c; } .kind-selection { background: #ffeccc; color: #8a5a00; }
  .kind-decision { background: #dcf5e3; color: #176633; } .kind-prompt, .kind-comment { background: #eee0fa; color: #5b2d8c; }
  @media (prefers-color-scheme: dark) {
    .kind-annotation { background: #1c3a63; color: #a9c8f5; } .kind-selection { background: #5a4310; color: #f2cf8a; }
    .kind-decision { background: #16452a; color: #9fe0b5; } .kind-prompt, .kind-comment { background: #3d2359; color: #d4b6f5; }
  }
  .item .body { flex: 1; overflow-wrap: anywhere; border-radius: 4px; }
  .item .body:hover { background: rgba(128,128,128,.16); box-shadow: 0 0 0 3px rgba(128,128,128,.16); }
  .item .body:focus-visible { outline: 2px solid #2563c9; outline-offset: 2px; }
  .item .snippet { opacity: .65; font-size: 11.5px; display: block; margin-top: 2px; }
  .item button { flex: none; border: 0; background: none; cursor: pointer; color: inherit; opacity: .5; font-size: 14px; padding: 0 2px; }
  .item button:hover { opacity: 1; }
  #composer { flex: none; padding: 10px 14px; border-top: 1px solid rgba(128,128,128,.3); display: flex; flex-direction: column; gap: 8px; }
  #comment { width: 100%; resize: vertical; min-height: 54px; border-radius: 8px; border: 1px solid rgba(128,128,128,.4);
             padding: 8px; font: inherit; font-size: 13px; background: transparent; color: inherit; }
  .row { display: flex; gap: 8px; }
  button.primary { flex: 1; background: #2563c9; color: #fff; border: 0; border-radius: 8px; padding: 9px; font-size: 13px;
                   font-weight: 600; cursor: pointer; }
  button.primary:disabled { opacity: .45; cursor: default; }
  button.danger { background: none; border: 1px solid rgba(200,60,60,.6); color: #c83c3c; border-radius: 8px; padding: 9px 12px;
                  font-size: 13px; cursor: pointer; }
  #chat { flex: none; max-height: 30vh; overflow-y: auto; padding: 4px 14px 10px; border-top: 1px solid rgba(128,128,128,.3); }
  .msg { font-size: 12.5px; margin: 6px 0; overflow-wrap: anywhere; }
  .msg .who { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; margin-right: 6px; }
  .msg.agent .who { color: #2563c9; opacity: 1; }
  #banner { display: none; padding: 8px 14px; background: #b0b6bd; color: #17191c; font-size: 13px; font-weight: 600; flex: none; }
  body.ended #banner { display: block; }
  #nokey { display: none; padding: 8px 14px; background: #f2cf8a; color: #17191c; font-size: 13px; font-weight: 600; flex: none; }
  body.nokey #nokey { display: block; }
</style>
</head>
<body>
<header id="hdr"><span class="dot"></span><h1>${title}</h1><span class="hint">alt-click to annotate · select text to comment</span></header>
<div id="banner">Session ended. Nothing further will be sent to the agent.</div>
<div id="nokey">This link has no access key, or its keys came from an earlier curator server, so nothing on this page can reach the agent. Run <code>curator open &lt;file&gt;</code> again and use the link it prints.</div>
<main>
  <iframe id="plan" sandbox="allow-scripts allow-forms" title="plan artifact"></iframe>
  <aside>
    <h2>Queued for agent</h2>
    <div id="queue"></div>
    <div id="composer">
      <textarea id="comment" placeholder="Free-text comment for the agent (optional)"></textarea>
      <div class="row">
        <button class="primary" id="send">Send to Agent</button>
        <button class="danger" id="end">End session</button>
      </div>
    </div>
    <h2>Agent replies</h2>
    <div id="chat"></div>
  </aside>
</main>
<script>
(function () {
  'use strict';
  var SID = ${JSON.stringify(sid)};
  // C authorises this page's own calls; R lets the iframe load the artifact and nothing else.
  var keys = new URLSearchParams(location.hash.slice(1));
  var CAP = keys.get('c') || '';
  var RKEY = keys.get('r') || '';
  var noKey = !CAP || !RKEY;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  var frame = document.getElementById('plan');
  var queueEl = document.getElementById('queue');
  var chatEl = document.getElementById('chat');
  var commentEl = document.getElementById('comment');
  var sendBtn = document.getElementById('send');
  var endBtn = document.getElementById('end');
  var queue = [];
  var chatVersion = 0;
  var chatCount = 0;
  var ended = false;

  function toFrame(msg) {
    if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ curator: true }, msg), '*');
  }

  function label(item) {
    if (item.type === 'decision') {
      return item.question + ' → ' + (item.answer === null || item.answer === undefined ? 'answered in your own words' : item.answer);
    }
    if (item.type === 'selection') return item.comment;
    if (item.type === 'annotation') return item.comment;
    return item.text || '';
  }
  function snippet(item) {
    if (item.type === 'selection') return '“' + (item.selectedText || '').slice(0, 140) + '”';
    if (item.type === 'annotation') return (item.selector || '') + (item.elementText ? ' — ' + item.elementText.slice(0, 90) : '');
    if (item.type === 'decision' && item.note) return 'note: ' + item.note.slice(0, 140);
    return '';
  }

  function render() {
    queueEl.textContent = '';
    queue.forEach(function (item, i) {
      var div = document.createElement('div');
      div.className = 'item';
      var kind = document.createElement('span');
      kind.className = 'kind kind-' + item.type;
      kind.textContent = item.type;
      var body = document.createElement('span');
      body.className = 'body';
      body.textContent = label(item);
      var sn = snippet(item);
      if (sn) {
        var s = document.createElement('span');
        s.className = 'snippet';
        s.textContent = sn;
        body.appendChild(s);
      }
      // Queued feedback is a draft until Send, so it has to stay editable.
      body.setAttribute('role', 'button');
      body.setAttribute('tabindex', '0');
      body.title = 'Click to edit';
      body.style.cursor = 'text';
      body.addEventListener('click', function () { editItem(i); });
      body.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); editItem(i); }
      });
      var rm = document.createElement('button');
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.addEventListener('click', function () {
        queue.splice(i, 1);
        if (item.type === 'decision') toFrame({ action: 'decision-cleared', question: item.question });
        render();
      });
      div.appendChild(kind); div.appendChild(body); div.appendChild(rm);
      queueEl.appendChild(div);
    });
    sendBtn.disabled = ended || noKey;
    endBtn.disabled = ended || noKey;
  }

  // Edit a queued item in place. A decision edits its note, since the answer
  // itself is changed by clicking a different option in the artifact.
  function editItem(i) {
    var item = queue[i];
    if (!item || ended) return;
    if (item.type === 'decision') {
      var note = window.prompt('Why / note for: ' + item.question, item.note || '');
      if (note === null) return;
      note = note.trim();
      if (note === '') delete item.note; else item.note = note;
      if (item.answer === null && item.note === undefined) {
        queue.splice(i, 1);
        toFrame({ action: 'decision-cleared', question: item.question });
      } else {
        toFrame({ action: 'note-set', question: item.question, note: item.note || '' });
      }
      render();
      return;
    }
    var field = item.type === 'prompt' ? 'text' : 'comment';
    var next = window.prompt('Edit this ' + item.type + ':', item[field] || '');
    if (next === null) return;
    next = next.trim();
    if (next === '') queue.splice(i, 1); else item[field] = next;
    render();
  }

  function dequeueDecision(question) {
    var i = queue.findIndex(function (q) { return q.type === 'decision' && q.question === question; });
    if (i !== -1) { queue.splice(i, 1); render(); }
  }

  function enqueue(item) {
    if (ended) return;
    if (item.type === 'decision') {
      var i = queue.findIndex(function (q) { return q.type === 'decision' && q.question === item.question; });
      if (i !== -1) queue[i] = item; else queue.push(item);
    } else {
      queue.push(item);
    }
    render();
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== frame.contentWindow) return;
    var d = ev.data;
    if (!d || d.curator !== true) return;
    if (d.action === 'annotate-request') {
      var c = window.prompt('Comment on: ' + (d.elementText || d.selector || 'element'));
      if (c === null || c.trim() === '') return;
      enqueue({ type: 'annotation', selector: d.selector, elementText: d.elementText, comment: c.trim() });
    } else if (d.action === 'selection-request') {
      var c2 = window.prompt('Comment on: “' + (d.selectedText || '').slice(0, 120) + '”');
      if (c2 === null || c2.trim() === '') return;
      enqueue({ type: 'selection', selector: d.selector, selectedText: d.selectedText, comment: c2.trim() });
    } else if (d.action === 'decision') {
      var dec = { type: 'decision', question: d.question, answer: d.answer };
      // Only attach note when the user actually wrote one, so a note-less
      // decision stays byte-identical to the legacy {type,question,answer}.
      if (typeof d.note === 'string' && d.note.trim() !== '') dec.note = d.note.trim();
      // No option and no note is a retraction; a note on its own is a real answer
      // in the reader's own words, for when none of the options is the answer.
      if (d.answer === null && dec.note === undefined) {
        dequeueDecision(d.question);
        toFrame({ action: 'decision-cleared', question: d.question });
        return;
      }
      enqueue(dec);
      toFrame({ action: 'decision-accepted', question: d.question, answer: d.answer });
    } else if (d.action === 'prompt') {
      if (!window.confirm('The artifact page wants to queue this prompt for the agent: ' + String(d.text).slice(0, 300))) return;
      enqueue({ type: 'prompt', text: d.text });
    }
  });

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Curator-Cap': CAP },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      if (r.status === 401) stale();
      return r.json();
    });
  }

  function addMsg(from, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + from;
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = from === 'agent' ? 'agent' : 'you';
    div.appendChild(who);
    div.appendChild(document.createTextNode(text));
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  sendBtn.addEventListener('click', function () {
    if (ended) return;
    var items = queue.slice();
    var c = commentEl.value.trim();
    if (c) items.push({ type: 'comment', text: c });
    if (items.length === 0) { window.alert('Nothing to send — queue an annotation, decision, or comment first.'); return; }
    sendBtn.disabled = true;
    api('POST', '/api/send?s=' + SID, { items: items }).then(function (resp) {
      if (resp.error) { window.alert('Send failed: ' + resp.error + (resp.next_step ? '\\n' + resp.next_step : '')); sendBtn.disabled = false; return; }
      queue.forEach(function (item) {
        if (item.type === 'decision') toFrame({ action: 'decision-cleared', question: item.question });
      });
      queue = [];
      commentEl.value = '';
      sendBtn.disabled = false;
      render();
    }).catch(function (e) { window.alert('Send failed: ' + e); sendBtn.disabled = false; });
  });

  endBtn.addEventListener('click', function () {
    if (ended) return;
    if (!window.confirm('End the session? The agent will stop polling this plan.')) return;
    api('POST', '/api/end?s=' + SID, { by: 'user' }).then(function (resp) {
      if (resp.error) { window.alert('End failed: ' + resp.error + (resp.next_step ? '\\n' + resp.next_step : '')); return; }
      markEnded();
    });
  });

  function markEnded() {
    ended = true;
    document.body.classList.add('ended');
    document.getElementById('hdr').classList.add('ended');
    render();
  }

  var timer = null;
  function stale() {
    if (timer) { clearInterval(timer); timer = null; }
    noKey = true;
    document.body.classList.add('nokey');
    render();
  }

  function tick() {
    api('GET', '/api/updates?s=' + SID + '&since=' + chatVersion).then(function (resp) {
      if (resp.error) return;
      chatVersion = resp.version;
      (resp.chat || []).slice(chatCount).forEach(function (m) { addMsg(m.from, m.text); });
      chatCount = (resp.chat || []).length;
      if (resp.ended && !ended) markEnded();
    }).catch(function () { /* server restarting; retry on next tick */ });
  }
  if (noKey) {
    document.body.classList.add('nokey');
  } else {
    frame.src = '/artifact/' + SID + '?k=' + encodeURIComponent(RKEY);
    timer = setInterval(tick, 1500);
    tick();
  }
  render();
})();
</script>
</body>
</html>`;
}

const PAGE_HEADERS = { 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "frame-ancestors 'self'" };

const NO_CREDENTIAL = {
  error: 'missing or invalid credential',
  next_step: 'Use engine/curator/cli.mjs from your detent clone (an older curator CLI sends no credential), or run: curator open <file.html>',
};

class HttpError extends Error {
  constructor(code, error, next_step) {
    super(error);
    this.code = code;
    this.next_step = next_step;
  }
}

const isJsonType = (ct) => /^application\/json\s*(;|$)/i.test(String(ct || ''));

export function createServer(store, { secret } = {}) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error('createServer requires the server secret: refusing to serve without authentication');
  }
  let boundPort = 0;
  const bootId = crypto.randomBytes(16).toString('hex');

  const bearerOk = (req) => {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    return Boolean(m) && safeEqual(m[1], secret);
  };
  const capOf = (req) => String(req.headers['x-curator-cap'] || '');
  const sessionFor = (url) => store.getById(url.searchParams.get('s') || '');
  // An unknown session still compares against a throwaway key so the 401 does not reveal whether it exists.
  const capOk = (session, given) => safeEqual(given, sessionKey(secret, bootId, session ? session.id : '-')) && Boolean(session);
  const unauthorized = () => new HttpError(401, NO_CREDENTIAL.error, NO_CREDENTIAL.next_step);

  const server = http.createServer(async (req, res) => {
    store.touch();
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      // 1. Host: present, loopback, and this server's own port. Defeats DNS rebinding and other-port pages.
      const host = String(req.headers.host || '').toLowerCase();
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(host)) {
        throw new HttpError(403, `forbidden Host header: ${req.headers.host || '(none)'}`, 'Access curator via http://127.0.0.1:<port> only.');
      }
      // 2. Origin, when a browser sends one, must be this very server (rejects "null" from the sandboxed iframe).
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
        throw new HttpError(403, `forbidden Origin header: ${req.headers.origin}`, 'Use the curator page opened by the curator CLI.');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET, POST' });
        return res.end(JSON.stringify({ error: 'OPTIONS is not supported', next_step: 'See engine/curator/README.md for the API.' }));
      }

      if (req.method === 'GET' && p === '/healthz') {
        const nonce = url.searchParams.get('nonce') || '';
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new HttpError(400, 'missing or malformed nonce', 'GET /healthz?nonce=<16 to 128 url-safe characters>');
        return sendJson(res, 200, { ok: true, pid: process.pid, boot: bootId, proof: healthProof(secret, nonce) });
      }

      if (req.method === 'GET' && p === '/sdk.js') {
        const body = fs.readFileSync(path.join(MODULE_DIR, 'sdk.js'));
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(body);
      }

      if (req.method === 'GET' && p.startsWith('/s/')) {
        const session = store.getById(p.slice(3));
        if (!session) return sendJson(res, 404, { error: 'unknown session', next_step: 'Run: curator open <file.html>' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...PAGE_HEADERS });
        return res.end(chromePage(session));
      }

      if (req.method === 'GET' && p.startsWith('/artifact/')) {
        const session = store.getById(p.slice('/artifact/'.length));
        const given = url.searchParams.get('k') || '';
        if (!session || !safeEqual(given, artifactKey(secret, bootId, session.id))) throw unauthorized();
        // A registered artifact that has since been moved/deleted is a routine,
        // expected condition (the agent regenerated the plan) — report it as a
        // clean 404, not a 500 with a raw ENOENT that leaks the fs path.
        if (!fs.existsSync(session.file)) {
          return sendJson(res, 404, {
            error: 'artifact file no longer exists',
            next_step: `The artifact was moved or deleted. Re-create it, then run: curator open ${session.file}`,
          });
        }
        const bytes = safeReadArtifact(session.file);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...PAGE_HEADERS });
        return res.end(injectedArtifact(bytes, session.id));
      }

      // Browser routes take one session (?s=) and its key (X-Curator-Cap). Agent routes take one file (key) and the bearer.
      if (req.method === 'GET' && p === '/api/updates') {
        const session = sessionFor(url);
        if (!capOk(session, capOf(req))) throw unauthorized();
        return sendJson(res, 200, {
          version: session.version,
          chat: session.chat,
          ended: session.ended,
          ended_by: session.endedBy,
        });
      }

      if (req.method === 'GET' && p === '/api/status') {
        if (!bearerOk(req)) throw unauthorized();
        return sendJson(res, 200, { pid: process.pid, sessions: store.statusList() });
      }

      if (req.method === 'GET' && p === '/api/poll') {
        if (!bearerOk(req)) throw unauthorized();
        const key = url.searchParams.get('key');
        const session = key && store.get(key);
        if (!session) {
          return sendJson(res, 404, { error: `no session for ${key}`, next_step: `Run: curator open ${key || '<file.html>'}` });
        }
        req.socket.setTimeout(0);
        res.writeHead(200, JSON_HEADERS);
        const heartbeat = setInterval(() => res.write(' '), HEARTBEAT_MS);
        const { promise, cancel } = store.pollCancelable(key);
        let closed = false;
        res.on('close', () => {
          closed = true;
          clearInterval(heartbeat);
          cancel();
        });
        const payload = await promise;
        clearInterval(heartbeat);
        if (closed || res.destroyed || !res.writable) {
          store.requeue(key, payload); // ended payloads can carry prompts too — never lose them
          return;
        }
        return res.end(JSON.stringify(payload));
      }

      if (req.method === 'POST') {
        const hasBearer = req.headers.authorization !== undefined;
        const hasCap = req.headers['x-curator-cap'] !== undefined;
        if (!['/api/open', '/api/send', '/api/end', '/api/reply'].includes(p)) {
          return sendJson(res, 404, { error: `no route: ${req.method} ${p}`, next_step: 'See engine/curator/README.md for the API.' });
        }
        // /api/end serves both callers; the credential presented says which one this is.
        const browserRoute = p === '/api/send' || (p === '/api/end' && !hasBearer);
        let session = null;
        if (browserRoute) {
          if (hasBearer) throw unauthorized();
          session = sessionFor(url);
          if (!capOk(session, capOf(req))) throw unauthorized();
        } else if (hasCap || !bearerOk(req)) {
          throw unauthorized();
        }
        if (!isJsonType(req.headers['content-type'])) {
          throw new HttpError(415, 'Content-Type must be application/json', 'Send the body as application/json.');
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (e) {
          if (e.tooLarge) throw new HttpError(413, 'request body too large', 'Send a smaller body.');
          throw new HttpError(400, 'body is not valid JSON', 'Send a JSON object.');
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object', 'Send a JSON object.');

        if (p === '/api/open') {
          if (!body.file) throw new HttpError(400, 'missing "file"', 'POST {"file": "/abs/path.html"}');
          if (typeof body.file !== 'string' || path.extname(body.file).toLowerCase() !== '.html') {
            throw new HttpError(400, 'only .html artifacts can be opened', 'Point curator open at a self-contained .html artifact.');
          }
          const opened = store.open(body.file);
          return sendJson(res, 200, { ok: true, sessionId: opened.id, key: opened.key });
        }

        if (p === '/api/send') {
          if (body.key !== undefined) throw new HttpError(400, 'send takes the session in ?s=, not a "key"', 'POST /api/send?s=<session> with {"items": [...]}');
          if (!Array.isArray(body.items) || body.items.length === 0) {
            return sendJson(res, 400, { error: 'items must be a non-empty array', next_step: 'Queue at least one item before sending.' });
          }
          const delivered = store.send(session.key, body.items);
          store.addUserChat(session.key, `sent ${body.items.length} item(s) to the agent`);
          return sendJson(res, 200, { ok: true, delivered });
        }

        if (p === '/api/end') {
          if (session) {
            if (body.key !== undefined) throw new HttpError(400, 'a browser end takes the session in ?s=, not a "key"', 'POST /api/end?s=<session>');
            store.end(session.key, { by: 'user' });
            return sendJson(res, 200, { ok: true, status: 'ended', ended_by: 'user' });
          }
          if (body.sessionId !== undefined) throw new HttpError(400, 'an agent end takes a "key", not a sessionId', 'POST {"key": "/abs/path.html", "by": "agent"}');
          const target = typeof body.key === 'string' ? store.get(body.key) : null;
          if (!target) return sendJson(res, 404, { error: 'unknown session', next_step: 'Nothing to end; run curator status.' });
          store.end(target.key, { by: 'agent' });
          return sendJson(res, 200, { ok: true, status: 'ended', ended_by: 'agent' });
        }

        if (body.sessionId !== undefined) throw new HttpError(400, 'reply takes a "key", not a sessionId', 'POST {"key": "/abs/path.html", "message": "..."}');
        const target = typeof body.key === 'string' ? store.get(body.key) : null;
        if (!target) return sendJson(res, 404, { error: 'unknown session', next_step: 'Run: curator open <file.html>' });
        if (typeof body.message !== 'string' || body.message.trim() === '') {
          return sendJson(res, 400, { error: 'missing "message"', next_step: 'Pass -m "<what you changed>".' });
        }
        store.addReply(target.key, body.message);
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: `no route: ${req.method} ${p}`, next_step: 'See engine/curator/README.md for the API.' });
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) return sendJson(res, err.code, { error: err.message, next_step: err.next_step });
        return res.destroy();
      }
      if (!res.headersSent) return sendJson(res, 500, { error: String(err && err.message || err), next_step: 'Check the artifact path and re-run curator open.' });
      res.destroy();
    }
  });
  server.on('listening', () => {
    boundPort = server.address().port;
  });
  server.bootId = bootId;
  return server;
}

// ---------------------------------------------------------------------------
// Daemon entrypoint: node server.mjs --daemon
// ---------------------------------------------------------------------------
function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun() && process.argv.includes('--daemon')) {
  const stateDir = resolveStateDir();
  const stateFile = path.join(stateDir, 'state.json');
  let secret;
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    checkStateDir(stateDir);
    secret = loadOrCreateSecret(stateDir);
    ensureGitignore(stateDir);
  } catch (err) {
    process.stderr.write(`curator: ${err.message}\n${err.next_step ? `${err.next_step}\n` : ''}`);
    process.exit(1);
  }
  const store = new SessionStore({ stateFile });
  try {
    store.loadState(); // recover durable pending feedback from a previous run
  } catch (err) {
    process.stderr.write(`curator: could not load state file, starting fresh: ${err}\n`);
  }
  const server = createServer(store, { secret });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    store.meta = { pid: process.pid, port, bootId: server.bootId, startedAt: new Date().toISOString() };
    store.flush();
    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, port }) + '\n');
  });
  const stop = () => {
    store.meta = {};
    store.flush();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // Idle self-shutdown: no live sessions and no activity for 60 minutes.
  setInterval(() => {
    if (!store.hasLiveSessions() && Date.now() - store.lastActivity > IDLE_SHUTDOWN_MS) stop();
  }, 60 * 1000);
}
