#!/usr/bin/env node
// reads — the connector-read courier's durable transport.
// An agent that CANNOT reach an interactive-only connector (Figma/Drive/Gmail/
// Slack/Jira — absent in background/headless contexts) enqueues a read request;
// a session that CAN reach it (the main interactive session) fulfills it and the
// data is fed back. Two transports: (1) in-session SendMessage (subagent -> main),
// documented in BROKER.md; (2) THIS durable file queue for deferred/cross-restart.
// No stored credentials — the capable live session does the actual read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// State lives in the detent repo ONLY — DETENT_ROOT if set, else the clone this
// CLI lives in (engine/courier/courier.mjs -> ../..). Never a ~/.detent home dir.
const REPO_ROOT = process.env.DETENT_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.DETENT_COURIER_DIR || path.join(REPO_ROOT, '.local', 'reads');
const USAGE = 'Usage: reads request --source <s> --query <q> [--for <who>] | reads list | reads get <id> | reads fulfill <id> --result-file <f> | reads await <id> | reads fail <id> --error <m>';

function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function fail(msg, next) { out({ error: msg, ...(next ? { next_step: next } : {}) }); process.exit(1); }
function reqPath(id) { return path.join(DIR, `req-${id}.json`); }
function readReq(id) { try { return JSON.parse(fs.readFileSync(reqPath(id), 'utf8')); } catch { return null; } }
function writeReq(r) { fs.mkdirSync(DIR, { recursive: true }); const t = reqPath(r.id) + '.tmp'; fs.writeFileSync(t, JSON.stringify(r, null, 2)); fs.renameSync(t, reqPath(r.id)); }

function parse(args) {
  const f = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) f[a.slice(2)] = args[++i];
    else pos.push(a);
  }
  return { f, pos };
}

const [cmd, ...rest] = process.argv.slice(2);
const { f, pos } = parse(rest);

if (cmd === 'request') {
  if (!f.source || !f.query) fail('request needs --source and --query', USAGE);
  const id = crypto.randomBytes(6).toString('hex');
  const r = { id, source: f.source, query: f.query, for: f.for || null, status: 'pending', requested_at: new Date().toISOString(), result: null };
  writeReq(r);
  out({ id, status: 'pending', next_step: `The interactive session that can reach ${f.source} runs: reads fulfill ${id} --result-file <path>. This agent then runs: reads await ${id}` });
} else if (cmd === 'list') {
  let ids = [];
  try { ids = fs.readdirSync(DIR).filter((n) => n.startsWith('req-')).map((n) => n.slice(4, -5)); } catch {}
  const openReqs = ids.map(readReq).filter((r) => r && (r.status === 'pending' || r.status === 'failed'));
  if (openReqs.length === 0) { out({ pending: 0, next_step: 'No read requests waiting.' }); }
  else for (const r of openReqs) out({ id: r.id, status: r.status, source: r.source, query: r.query, for: r.for, requested_at: r.requested_at, ...(r.error ? { error: r.error } : {}) });
} else if (cmd === 'get') {
  const r = readReq(pos[0]); if (!r) fail(`no read request ${pos[0]}`, 'reads list to see pending.');
  out(r);
} else if (cmd === 'fulfill') {
  const r = readReq(pos[0]); if (!r) fail(`no read request ${pos[0]}`, 'reads list to see pending.');
  if (!f['result-file'] && f.result === undefined) fail('fulfill needs --result-file <path> (or --result <inline>)', USAGE);
  const result = f['result-file'] ? fs.readFileSync(f['result-file'], 'utf8') : f.result;
  r.result = result; r.status = 'fulfilled'; r.fulfilled_at = new Date().toISOString();
  writeReq(r);
  out({ id: r.id, status: 'fulfilled', next_step: `The requesting agent's 'reads await ${r.id}' will now return this result.` });
} else if (cmd === 'await') {
  const id = pos[0]; if (!id) fail('await needs <id>', USAGE);
  const started = Date.now();
  // durable blocking poll with heartbeat; safe to re-run — result persists in the file
  const tick = () => {
    const r = readReq(id);
    if (!r) { fail(`no read request ${id}`, 'reads list to see pending.'); return; }
    if (r.status === 'fulfilled') { out({ id, status: 'fulfilled', source: r.source, query: r.query, result: r.result }); process.exit(0); }
    if (r.status === 'failed') { out({ id, status: 'failed', source: r.source, query: r.query, error: r.error || 'read failed', next_step: `The courier could not fulfill ${id}. Retry it or surface it as a blocked source.` }); process.exit(0); }
    if (Date.now() - started > 1000 * 60 * 30) { out({ id, status: 'pending', next_step: `Still waiting on the capable session to fulfill ${id}. Re-run reads await ${id}; the result is never lost.` }); process.exit(0); }
    process.stderr.write(' '); // heartbeat keeps the pipe alive
    setTimeout(tick, 2000);
  };
  tick();
} else if (cmd === 'fail') {
  const r = readReq(pos[0]); if (!r) fail(`no read request ${pos[0]}`, 'reads list to see pending.');
  r.status = 'failed'; r.error = f.error || 'read failed'; r.failed_at = new Date().toISOString();
  writeReq(r);
  out({ id: r.id, status: 'failed', error: r.error, next_step: `The requester's 'reads await ${r.id}' returns failed; the courier skill retries or surfaces it.` });
} else {
  fail(`unknown command: ${cmd || '(none)'}`, USAGE);
}
