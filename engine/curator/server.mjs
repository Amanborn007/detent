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

export const IDLE_SHUTDOWN_MS = 60 * 60 * 1000; // 60 min with no poll waiter and no request
export const HEARTBEAT_MS = 15 * 1000;
const DELIVERED_CAP = 500;

export function idleMsFromEnv(env = process.env) {
  if (env.CURATOR_IDLE_MS === undefined || env.CURATOR_IDLE_MS === '') return IDLE_SHUTDOWN_MS;
  const ms = Number(env.CURATOR_IDLE_MS);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`CURATOR_IDLE_MS must be a positive number of milliseconds, got ${env.CURATOR_IDLE_MS}`);
  return ms;
}

// A live session keeps the daemon up: after a sleep its drafts need this boot's keys.
export function shouldIdleExit({ hasWaiters, hasLiveSessions, lastActivity, now, idleMs }) {
  return !hasWaiters && !hasLiveSessions && now - lastActivity > idleMs;
}

// An orphan exits, but never while it holds a waiting poll or unsent answers.
export function shouldExitForState({ stateExists, statePid, ownPid, hasWaiters, hasPending }) {
  if (hasWaiters || hasPending) return false;
  return !stateExists || statePid !== ownPid;
}

export function shouldPruneSession({ fileExists, pendingCount }) {
  return !fileExists && pendingCount === 0;
}

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
    this.itemIds = new WeakMap();
    this.busy = 0; // non-poll requests in flight; the daemon never exits mid-request
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
      delivered: existing ? existing.delivered : [],
      lastSeenAt: null,
    };
    this.sessions.set(key, session);
    this.flush();
    return session;
  }

  get(key) {
    return this.sessions.get(key) || null;
  }

  hasPending() {
    for (const s of this.sessions.values()) if (s.pending.length > 0) return true;
    return false;
  }

  // Copy our queued items into whatever state.json now holds, without taking it over.
  mergePendingIntoState() {
    if (!this.stateFile) return;
    const data = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : {};
    data.sessions ||= {};
    for (const [key, s] of this.sessions) {
      if (s.pending.length === 0) continue;
      const target = data.sessions[key] ||= {
        id: s.id, file: s.file, createdAt: s.createdAt, pending: [], ended: s.ended, endedBy: s.endedBy,
        chat: s.chat, delivered: s.delivered,
      };
      for (const item of s.pending) {
        if (!target.pending.some((p) => JSON.stringify(p) === JSON.stringify(item))) target.pending.push(item);
      }
    }
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  hasWaiters() {
    for (const s of this.sessions.values()) if (s.waiters.length > 0) return true;
    return false;
  }

  // Items carry no id on the wire (agents deepEqual them), so ids live beside them.
  idsFor(items) {
    return items.map((item) => {
      let id = this.itemIds.get(item);
      if (!id) {
        id = crypto.randomBytes(8).toString('hex');
        this.itemIds.set(item, id);
      }
      return id;
    });
  }

  // Called once a poll response has been fully written to the agent's socket.
  recordDelivered(key, prompts) {
    const session = this.get(key);
    if (!session || !Array.isArray(prompts) || prompts.length === 0) return;
    const at = new Date().toISOString();
    for (const id of this.idsFor(prompts)) session.delivered.push({ id, at });
    if (session.delivered.length > DELIVERED_CAP) session.delivered.splice(0, session.delivered.length - DELIVERED_CAP);
    this.flush();
  }

  // In memory only: a tab's cap is bound to this boot, so a restored value would outlive its tab.
  markSeen(key, now = Date.now()) {
    const session = this.get(key);
    if (session) session.lastSeenAt = now;
  }

  markGone(key) {
    const session = this.get(key);
    if (session) session.lastSeenAt = null;
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
    this.idsFor(items);
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
      last_seen_at: s.lastSeenAt === null ? null : new Date(s.lastSeenAt).toISOString(),
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
        delivered: s.delivered,
      };
    }
    const data = { ...this.meta, updatedAt: new Date().toISOString(), sessions };
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  // Pruning happens here and nowhere else: a missing file at open() time is routine.
  loadState({ fileExists = fs.existsSync } = {}) {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    for (const [key, s] of Object.entries(data.sessions || {})) {
      if (shouldPruneSession({ fileExists: fileExists(s.file), pendingCount: (s.pending || []).length })) continue;
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
        delivered: s.delivered || [],
        lastSeenAt: null,
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

// Pure answer-flow logic. It is injected into the shell page as source, so it
// must stay self-contained (no closures, no imports).
export function answerProgress(questions, answered) {
  const seen = new Set(answered);
  const names = [...seen];
  if (!Array.isArray(questions)) {
    return { known: false, total: null, answered: names.length, unanswered: [], requiredMissing: [] };
  }
  const open = questions.filter((q) => !seen.has(q.question));
  return {
    known: true,
    total: questions.length,
    answered: questions.length - open.length,
    unanswered: open.map((q) => q.question),
    requiredMissing: open.filter((q) => q.required).map((q) => q.question),
  };
}

export function itemDelivery(id, delivered) {
  return delivered.some((d) => d.id === id) ? 'delivered' : 'sent';
}

export function handoffLabel(state, polling) {
  if (state === 'delivered') return 'handed to agent';
  return polling ? 'sent, agent is picking it up' : 'queued — agent not listening right now';
}

// Superseded by handoffLabel in the page; kept because shell-flow.test.mjs imports it.
export function deliveryLabel(state, polling) {
  if (state === 'delivered') return 'delivered to agent';
  return polling ? 'sent, agent is picking it up' : 'queued — agent not listening right now';
}

export function chromePage(session) {
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
  [hidden] { display: none !important; }
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
  #progress { font-size: 12px; margin: 0 14px 4px; opacity: .85; }
  #jumps { margin: 0 14px 4px; display: flex; flex-direction: column; gap: 2px; }
  #jumps button { text-align: left; border: 0; background: none; color: #2563c9; font-size: 12px; cursor: pointer; padding: 1px 0;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #queue { flex: 1; overflow-y: auto; padding: 0 10px; min-height: 80px; }
  #queue:empty::after { content: "Nothing queued. Alt-click an element, select text, or answer a decision in the plan. Click anything queued to edit it before sending.";
                        display: block; font-size: 12px; opacity: .55; padding: 8px 6px; }
  #sentList { max-height: 24vh; overflow-y: auto; padding: 0 10px; }
  .item { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-size: 12.5px;
          display: flex; gap: 8px; align-items: flex-start; background: rgba(128,128,128,.05); }
  .item.sent { opacity: .8; }
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
  .item .state { font-size: 11px; display: block; margin-top: 3px; font-weight: 600; color: #8a5a00; }
  .item .state.delivered { color: #176633; }
  .item button { flex: none; border: 0; background: none; cursor: pointer; color: inherit; opacity: .5; font-size: 14px; padding: 0 2px; }
  .item button:hover { opacity: 1; }
  #modal { flex: none; padding: 10px 14px; border-top: 1px solid rgba(128,128,128,.3); background: rgba(37,99,201,.08);
           display: flex; flex-direction: column; gap: 8px; }
  #modalMsg { font-size: 12.5px; overflow-wrap: anywhere; }
  #modalText { width: 100%; resize: vertical; min-height: 90px; border-radius: 8px; border: 1px solid rgba(128,128,128,.4);
               padding: 8px; font: inherit; font-size: 13px; background: transparent; color: inherit; }
  #err { flex: none; display: flex; gap: 8px; padding: 8px 14px; background: #f5c4c4; color: #4a1010; font-size: 12.5px; }
  #err span { flex: 1; overflow-wrap: anywhere; }
  #err button { border: 0; background: none; cursor: pointer; color: inherit; }
  #composer { flex: none; padding: 10px 14px; border-top: 1px solid rgba(128,128,128,.3); display: flex; flex-direction: column; gap: 8px; }
  #comment { width: 100%; resize: vertical; min-height: 54px; border-radius: 8px; border: 1px solid rgba(128,128,128,.4);
             padding: 8px; font: inherit; font-size: 13px; background: transparent; color: inherit; }
  .row { display: flex; gap: 8px; }
  button.primary { flex: 1; background: #2563c9; color: #fff; border: 0; border-radius: 8px; padding: 9px; font-size: 13px;
                   font-weight: 600; cursor: pointer; }
  button.primary:disabled { opacity: .45; cursor: default; }
  button.plain { background: none; border: 1px solid rgba(128,128,128,.5); color: inherit; border-radius: 8px; padding: 9px 12px;
                 font-size: 13px; cursor: pointer; }
  button.danger { background: none; border: 1px solid rgba(200,60,60,.6); color: #c83c3c; border-radius: 8px; padding: 9px 12px;
                  font-size: 13px; cursor: pointer; }
  #drafts { flex: none; padding: 10px 14px; border-top: 1px solid rgba(128,128,128,.3); display: none; flex-direction: column; gap: 6px; font-size: 12.5px; }
  body.nokey #drafts, body.offline #drafts { display: flex; }
  #draftText { width: 100%; min-height: 110px; font: 12px ui-monospace, monospace; border-radius: 8px; padding: 8px;
               border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; }
  #chat { flex: none; max-height: 30vh; overflow-y: auto; padding: 4px 14px 10px; border-top: 1px solid rgba(128,128,128,.3); }
  .msg { font-size: 12.5px; margin: 6px 0; overflow-wrap: anywhere; }
  .msg .who { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; margin-right: 6px; }
  .msg.agent .who { color: #2563c9; opacity: 1; }
  #banner { display: none; padding: 8px 14px; background: #b0b6bd; color: #17191c; font-size: 13px; font-weight: 600; flex: none; }
  body.ended #banner { display: block; }
  #nokey { display: none; padding: 8px 14px; background: #f2cf8a; color: #17191c; font-size: 13px; font-weight: 600; flex: none; }
  body.nokey #nokey { display: block; }
  #offline { display: none; padding: 8px 14px; background: #f5c4c4; color: #4a1010; font-size: 13px; font-weight: 600; flex: none; }
  body.offline #offline { display: block; }
</style>
</head>
<body>
<header id="hdr"><span class="dot"></span><h1>${title}</h1><span class="hint">alt-click to annotate · select text to comment</span></header>
<div id="banner">Session ended. Nothing further will be sent to the agent.</div>
<div id="nokey">This page can't reach the agent: its access key is missing, or it came from an earlier curator server that has since restarted. Your unsent items are kept below. Run <code>curator open &lt;file&gt;</code> again, use the link it prints, and paste anything you still want sent.</div>
<div id="offline">Curator server not reachable — your unsent items are kept</div>
<main>
  <iframe id="plan" sandbox="allow-scripts allow-forms" title="plan artifact"></iframe>
  <aside>
    <h2>Queued for agent</h2>
    <div id="progress"></div>
    <div id="jumps"></div>
    <div id="queue"></div>
    <div id="sentWrap" hidden>
      <h2>Sent to agent</h2>
      <div id="sentList"></div>
    </div>
    <div id="modal" hidden>
      <div id="modalMsg"></div>
      <textarea id="modalText" hidden></textarea>
      <div class="row">
        <button class="primary" id="modalOk">OK</button>
        <button class="plain" id="modalCancel">Cancel</button>
      </div>
    </div>
    <div id="err" role="alert" hidden><span id="errText"></span><button id="errClose" title="Dismiss">✕</button></div>
    <div id="drafts">
      <div>Unsent items from this page, as text you can copy:</div>
      <textarea id="draftText" readonly></textarea>
      <div class="row"><button class="plain" id="draftCopy">Copy</button></div>
    </div>
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
  var KEYS_KEY = 'curator:keys:' + SID;
  var DRAFT_KEY = 'curator:draft:' + SID;
  var NL = String.fromCharCode(10);
  ${answerProgress}
  ${itemDelivery}
  ${handoffLabel}
  var frame = document.getElementById('plan');
  var queueEl = document.getElementById('queue');
  var chatEl = document.getElementById('chat');
  var commentEl = document.getElementById('comment');
  var sendBtn = document.getElementById('send');
  var endBtn = document.getElementById('end');
  var progressEl = document.getElementById('progress');
  var jumpsEl = document.getElementById('jumps');
  var sentWrapEl = document.getElementById('sentWrap');
  var sentListEl = document.getElementById('sentList');
  var modalEl = document.getElementById('modal');
  var modalMsgEl = document.getElementById('modalMsg');
  var modalTextEl = document.getElementById('modalText');
  var modalOkEl = document.getElementById('modalOk');
  var errEl = document.getElementById('err');
  var errTextEl = document.getElementById('errText');
  var draftTextEl = document.getElementById('draftText');
  var queue = [];
  var sent = [];
  var questions = null;
  var delivered = [];
  var polling = false;
  var lastMtime = null;
  var chatVersion = 0;
  var chatCount = 0;
  var ended = false;
  var storageWarned = false;
  var sendConfirming = false;

  function showError(msg) {
    errTextEl.textContent = msg;
    errEl.hidden = false;
  }
  document.getElementById('errClose').addEventListener('click', function () { errEl.hidden = true; });

  function storageFailed() {
    if (storageWarned) return;
    storageWarned = true;
    showError('Browser storage is unavailable, so keys and drafts will not survive a reload.');
  }

  // C authorises this page's own calls; R lets the iframe load the artifact and nothing else.
  // The fragment is stripped from the address bar, so a reload reads the keys back from here.
  var keys = new URLSearchParams(location.hash.slice(1));
  var CAP = keys.get('c') || '';
  var RKEY = keys.get('r') || '';
  if (CAP && RKEY) {
    try { sessionStorage.setItem(KEYS_KEY, JSON.stringify({ c: CAP, r: RKEY })); } catch (e) { storageFailed(); }
  } else {
    var savedKeys = null;
    try { savedKeys = sessionStorage.getItem(KEYS_KEY); } catch (e) { storageFailed(); }
    if (savedKeys) {
      var parsedKeys = JSON.parse(savedKeys);
      CAP = parsedKeys.c || '';
      RKEY = parsedKeys.r || '';
    }
  }
  var noKey = !CAP || !RKEY;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  var modalQueue = [];
  var modalCb = null;
  var modalCancelCb = null;
  function openModal(opts) {
    if (modalCb) { modalQueue.push(opts); return; }
    modalCb = opts.onOk;
    modalCancelCb = opts.onCancel || null;
    modalMsgEl.textContent = opts.message;
    var withText = typeof opts.text === 'string';
    modalTextEl.hidden = !withText;
    modalTextEl.value = withText ? opts.text : '';
    modalOkEl.textContent = opts.ok || 'OK';
    modalEl.hidden = false;
    (withText ? modalTextEl : modalOkEl).focus();
  }
  function closeModal(cancelled) {
    var onCancel = modalCancelCb;
    modalCb = null;
    modalCancelCb = null;
    modalEl.hidden = true;
    if (cancelled === true && onCancel) onCancel();
    var next = modalQueue.shift();
    if (next) openModal(next);
  }
  function cancelModal() { closeModal(true); }
  function acceptModal() {
    var cb = modalCb;
    var value = modalTextEl.value;
    closeModal(false);
    if (cb) cb(value);
  }
  modalOkEl.addEventListener('click', acceptModal);
  document.getElementById('modalCancel').addEventListener('click', cancelModal);
  modalEl.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); cancelModal(); }
    else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !modalTextEl.hidden) { ev.preventDefault(); acceptModal(); }
  });

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

  function draftText() {
    var lines = queue.map(function (item) {
      var sn = snippet(item);
      return '[' + item.type + '] ' + label(item) + (sn ? NL + '    ' + sn : '');
    });
    var c = commentEl.value.trim();
    if (c) lines.push('[comment] ' + c);
    return lines.join(NL);
  }
  function saveDrafts() {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ queue: queue, comment: commentEl.value, sent: sent })); } catch (e) { storageFailed(); }
  }
  function restoreDrafts() {
    var raw = null;
    try { raw = sessionStorage.getItem(DRAFT_KEY); } catch (e) { storageFailed(); }
    if (!raw) return;
    var d = JSON.parse(raw);
    if (Array.isArray(d.queue)) queue = d.queue;
    if (Array.isArray(d.sent)) sent = d.sent;
    if (typeof d.comment === 'string') commentEl.value = d.comment;
  }
  commentEl.addEventListener('input', saveDrafts);

  function answeredQuestions() {
    return queue.concat(sent.map(function (s) { return s.item; }))
      .filter(function (i) { return i.type === 'decision'; })
      .map(function (i) { return i.question; });
  }

  function renderProgress() {
    var p = answerProgress(questions, answeredQuestions());
    jumpsEl.textContent = '';
    if (p.known) {
      progressEl.textContent = p.answered + ' of ' + p.total + ' decisions answered';
      p.unanswered.forEach(function (q) {
        var b = document.createElement('button');
        b.textContent = 'Jump to: ' + q;
        b.title = q;
        b.addEventListener('click', function () { toFrame({ action: 'scroll-to-question', question: q }); });
        jumpsEl.appendChild(b);
      });
    } else if (p.answered > 0) {
      progressEl.textContent = p.answered + ' decisions answered (this artifact does not report how many it has)';
    } else {
      progressEl.textContent = '';
    }
  }

  function renderSent() {
    sentListEl.textContent = '';
    sentWrapEl.hidden = sent.length === 0;
    sent.forEach(function (entry) {
      var state = entry.id ? itemDelivery(entry.id, delivered) : 'sent';
      var div = document.createElement('div');
      div.className = 'item sent';
      var kind = document.createElement('span');
      kind.className = 'kind kind-' + entry.item.type;
      kind.textContent = entry.item.type;
      var body = document.createElement('span');
      body.className = 'body';
      body.textContent = label(entry.item);
      var st = document.createElement('span');
      st.className = 'state ' + state;
      st.textContent = handoffLabel(state, polling);
      body.appendChild(st);
      div.appendChild(kind); div.appendChild(body);
      sentListEl.appendChild(div);
    });
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
    sendBtn.disabled = ended || noKey || sendConfirming;
    endBtn.disabled = ended || noKey;
    draftTextEl.value = draftText();
    renderProgress();
    renderSent();
    saveDrafts();
  }

  // Edit a queued item in place. A decision edits its note, since the answer
  // itself is changed by clicking a different option in the artifact.
  function editItem(i) {
    var item = queue[i];
    if (!item || ended) return;
    if (item.type === 'decision') {
      openModal({
        message: 'Why / note for: ' + item.question, text: item.note || '', ok: 'Save',
        onOk: function (note) {
          var question = item.question;
          var i = queue.findIndex(function (q) { return q.type === 'decision' && q.question === question; });
          if (i === -1) { showError('That decision was removed while you were editing it, so the note was not saved.'); return; }
          item = queue[i];
          note = note.trim();
          if (note === '') delete item.note; else item.note = note;
          if (item.answer === null && item.note === undefined) {
            queue.splice(i, 1);
            toFrame({ action: 'decision-cleared', question: item.question });
          } else {
            toFrame({ action: 'note-set', question: item.question, note: item.note || '' });
          }
          render();
        },
      });
      return;
    }
    var field = item.type === 'prompt' ? 'text' : 'comment';
    openModal({
      message: 'Edit this ' + item.type + ':', text: item[field] || '', ok: 'Save',
      onOk: function (next) {
        var i = queue.indexOf(item);
        if (i === -1) { showError('That item was removed while you were editing it, so the edit was not saved.'); return; }
        next = next.trim();
        if (next === '') queue.splice(i, 1); else item[field] = next;
        render();
      },
    });
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

  function repostMarks() {
    queue.forEach(function (item) {
      if (item.type !== 'decision') return;
      toFrame({ action: 'decision-accepted', question: item.question, answer: item.answer });
      if (item.note) toFrame({ action: 'note-set', question: item.question, note: item.note });
    });
    sent.forEach(function (entry) {
      if (entry.item.type === 'decision') toFrame({ action: 'decision-sent', question: entry.item.question });
    });
  }
  frame.addEventListener('load', repostMarks);

  // Hidden tabs get their timers throttled; say so explicitly. Registered before 'message' because
  // the shell-behavior stub keeps only the last window listener.
  window.addEventListener('visibilitychange', function () { if (!noKey) tick(); });
  window.addEventListener('pagehide', function () {
    if (noKey) return;
    fetch('/api/gone?s=' + SID, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Curator-Cap': CAP }, body: '{}' });
  });

  window.addEventListener('message', function (ev) {
    if (ev.source !== frame.contentWindow) return;
    var d = ev.data;
    if (!d || d.curator !== true) return;
    if (d.action === 'annotate-request') {
      openModal({
        message: 'Comment on: ' + (d.elementText || d.selector || 'element'), text: '', ok: 'Queue',
        onOk: function (c) {
          if (c.trim() === '') return;
          enqueue({ type: 'annotation', selector: d.selector, elementText: d.elementText, comment: c.trim() });
        },
      });
    } else if (d.action === 'selection-request') {
      openModal({
        message: 'Comment on: “' + (d.selectedText || '').slice(0, 120) + '”', text: '', ok: 'Queue',
        onOk: function (c) {
          if (c.trim() === '') return;
          enqueue({ type: 'selection', selector: d.selector, selectedText: d.selectedText, comment: c.trim() });
        },
      });
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
    } else if (d.action === 'questions') {
      if (!Array.isArray(d.questions)) return;
      questions = d.questions.map(function (q) {
        return typeof q === 'string' ? { question: q, required: false } : { question: q.question, required: !!q.required };
      });
      renderProgress();
    } else if (d.action === 'prompt') {
      openModal({
        message: 'The artifact page wants to queue this prompt for the agent: ' + String(d.text).slice(0, 300), ok: 'Queue it',
        onOk: function () { enqueue({ type: 'prompt', text: d.text }); },
      });
    }
  });

  function setOffline(off) {
    document.body.classList.toggle('offline', off);
    if (off) draftTextEl.value = draftText();
  }

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

  function sendFailed(resp) {
    showError('Send failed: ' + resp.error + (resp.next_step ? ' ' + resp.next_step : '') + ' Your items are still queued.');
    render();
  }

  function doSend(items, comment) {
    sendBtn.disabled = true;
    api('POST', '/api/send?s=' + SID, { items: items }).then(function (resp) {
      if (resp.error) { sendFailed(resp); return; }
      var ids = resp.ids || [];
      items.forEach(function (item, n) {
        if (item.type === 'decision') {
          // The server keeps one answer per question, so an undelivered earlier answer is gone.
          sent = sent.filter(function (e) {
            return !(e.item.type === 'decision' && e.item.question === item.question && itemDelivery(e.id, delivered) !== 'delivered');
          });
          toFrame({ action: 'decision-sent', question: item.question });
        }
        sent.push({ item: item, id: ids[n] });
      });
      queue = queue.filter(function (q) { return items.indexOf(q) === -1; });
      if (comment && commentEl.value.trim() === comment) commentEl.value = '';
      errEl.hidden = true;
      render();
    }).catch(function () {
      showError('Send failed: the curator server is not reachable. Your items are still queued.');
      render();
    });
  }

  sendBtn.addEventListener('click', function () {
    if (ended) return;
    var built = buildItems();
    if (built.items.length === 0) { showError('Nothing to send. Queue an annotation, decision or comment first.'); return; }
    var p = answerProgress(questions, answeredQuestions());
    if (p.requiredMissing.length > 0) {
      var names = p.requiredMissing.slice(0, 3).map(function (q) { return '“' + q.slice(0, 60) + '”'; }).join(', ');
      sendConfirming = true;
      render();
      openModal({
        message: p.requiredMissing.length + ' required decision(s) have no answer yet: ' + names + (p.requiredMissing.length > 3 ? ' and more' : '') + '. The agent will get nothing for them.',
        ok: 'Send anyway',
        onOk: function () {
          sendConfirming = false;
          var live = buildItems();
          if (live.items.length === 0) { render(); showError('Nothing left to send.'); return; }
          doSend(live.items, live.comment);
        },
        onCancel: function () { sendConfirming = false; render(); },
      });
      return;
    }
    doSend(built.items, built.comment);
  });

  function buildItems() {
    var items = queue.slice();
    var c = commentEl.value.trim();
    if (c) items.push({ type: 'comment', text: c });
    return { items: items, comment: c };
  }

  endBtn.addEventListener('click', function () {
    if (ended) return;
    openModal({
      message: 'End the session? The agent will stop polling this plan.', ok: 'End session',
      onOk: function () {
        api('POST', '/api/end?s=' + SID, { by: 'user' }).then(function (resp) {
          if (resp.error) { showError('End failed: ' + resp.error + (resp.next_step ? ' ' + resp.next_step : '')); return; }
          markEnded();
        }).catch(function () { showError('End failed: the curator server is not reachable.'); });
      },
    });
  });

  document.getElementById('draftCopy').addEventListener('click', function () {
    navigator.clipboard.writeText(draftTextEl.value).catch(function () {
      draftTextEl.select();
      showError('Could not copy automatically. The text is selected, press Cmd/Ctrl+C.');
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
    setOffline(false);
    render();
  }

  function reloadArtifact() {
    saveDrafts();
    frame.src = '/artifact/' + SID + '?k=' + encodeURIComponent(RKEY) + '&t=' + Date.now();
  }

  function tick() {
    api('GET', '/api/updates?s=' + SID + '&since=' + chatVersion).then(function (resp) {
      setOffline(false);
      if (resp.error) { if (!noKey) showError('Curator server said: ' + resp.error); return; }
      chatVersion = resp.version;
      (resp.chat || []).slice(chatCount).forEach(function (m) { addMsg(m.from, m.text); });
      chatCount = (resp.chat || []).length;
      delivered = resp.delivered || [];
      polling = !!resp.polling;
      renderSent();
      if (typeof resp.mtime === 'number') {
        if (lastMtime !== null && resp.mtime !== lastMtime) reloadArtifact();
        lastMtime = resp.mtime;
      }
      if (resp.ended && !ended) markEnded();
    }).catch(function () { setOffline(true); });
  }

  restoreDrafts();
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
    if (p !== '/api/poll') {
      store.busy += 1;
      res.on('close', () => { store.busy -= 1; });
    }
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
        store.markSeen(session.key);
        let mtime = null;
        try { mtime = fs.statSync(session.file).mtimeMs; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        return sendJson(res, 200, {
          version: session.version,
          chat: session.chat,
          ended: session.ended,
          ended_by: session.endedBy,
          delivered: session.delivered,
          polling: session.waiters.length > 0,
          mtime,
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
        res.on('finish', () => store.recordDelivered(key, payload.prompts));
        return res.end(JSON.stringify(payload));
      }

      if (req.method === 'POST') {
        const hasBearer = req.headers.authorization !== undefined;
        const hasCap = req.headers['x-curator-cap'] !== undefined;
        if (!['/api/open', '/api/send', '/api/end', '/api/reply', '/api/gone'].includes(p)) {
          return sendJson(res, 404, { error: `no route: ${req.method} ${p}`, next_step: 'See engine/curator/README.md for the API.' });
        }
        // /api/end serves both callers; the credential presented says which one this is.
        const browserRoute = p === '/api/send' || p === '/api/gone' || (p === '/api/end' && !hasBearer);
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

        if (p === '/api/gone') {
          store.markGone(session.key);
          return sendJson(res, 200, { ok: true });
        }

        if (p === '/api/send') {
          if (body.key !== undefined) throw new HttpError(400, 'send takes the session in ?s=, not a "key"', 'POST /api/send?s=<session> with {"items": [...]}');
          if (!Array.isArray(body.items) || body.items.length === 0) {
            return sendJson(res, 400, { error: 'items must be a non-empty array', next_step: 'Queue at least one item before sending.' });
          }
          if (body.items.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
            return sendJson(res, 400, { error: 'every item must be a JSON object', next_step: 'Send items shaped like {"type": "comment", "text": "..."}.' });
          }
          const delivered = store.send(session.key, body.items);
          store.addUserChat(session.key, `sent ${body.items.length} item(s) to the agent`);
          return sendJson(res, 200, { ok: true, delivered, ids: store.idsFor(body.items) });
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
  if (process.env.NODE_TEST_CONTEXT && process.env.CURATOR_ALLOW_DAEMON !== '1') {
    process.stderr.write('curator: refusing to start a daemon from a test process; set CURATOR_ALLOW_DAEMON=1\n');
    process.exit(1);
  }
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
  if (process.env.CURATOR_OWNER_PID !== undefined) {
    const owner = Number(process.env.CURATOR_OWNER_PID);
    if (!Number.isInteger(owner) || owner <= 0) {
      process.stderr.write(`curator: CURATOR_OWNER_PID must be a pid, got "${process.env.CURATOR_OWNER_PID}"\n`);
      process.exit(1);
    }
    setInterval(() => {
      try {
        process.kill(owner, 0);
      } catch (e) {
        if (e.code === 'ESRCH') stop();
      }
    }, 2000);
  }
  // Idle self-shutdown, and exit when another daemon has taken over state.json.
  const idleMs = idleMsFromEnv();
  setInterval(() => {
    if (store.busy > 0) return;
    let statePid = null;
    const stateExists = fs.existsSync(stateFile);
    if (stateExists) statePid = JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid ?? null;
    // Not stop(): that would rewrite state.json and clobber the daemon that owns it.
    const hasWaiters = store.hasWaiters();
    if (shouldExitForState({ stateExists, statePid, ownPid: process.pid, hasWaiters, hasPending: store.hasPending() })) {
      store.mergePendingIntoState();
      process.exit(0);
    }
    if (shouldIdleExit({ hasWaiters, hasLiveSessions: store.hasLiveSessions(), lastActivity: store.lastActivity, now: Date.now(), idleMs })) stop();
  }, Math.min(60 * 1000, idleMs));
}
