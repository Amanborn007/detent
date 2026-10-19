#!/usr/bin/env node
/**
 * session-cost-statusline — this session's spend and delegation share, live.
 *
 * WHY
 *   A sub-agent turn costs a fraction of a main-thread turn: same models, but its
 *   context is discarded instead of re-read on every later turn. The monthly
 *   ledger reports the delegation share long after the sessions that set it, so
 *   it cannot change them. This puts it where it is still actionable.
 *
 * COST OF RUNNING
 *   The statusline re-renders constantly, and a transcript reaches tens of MB.
 *   Reading it whole each time would itself be a cost. So state is cached under
 *   $TMPDIR keyed by session id, and only bytes appended since the last render
 *   are parsed.
 *
 * ACCURACY
 *   Streaming writes several records per message and only the last carries the
 *   final output count, so records are folded per message id. Those records are
 *   contiguous, which is what makes an incremental pass correct rather than an
 *   approximation. Scope is this session only, so it will not match
 *   `detent spend` — that dedupes across every transcript, where a resumed session
 *   copies records forward.
 *
 * Never fails a render: any error prints a bare model name and exits 0.
 */
"use strict";

import { readFileSync, statSync, openSync, readSync, closeSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";

// USD per 1e6 tokens. Kept in step with engine/bench/bench.mjs DEFAULT_RATES;
// a statusline may not import the engine, which would make every render a
// module load.
const RATES = {
  fable:  { in: 10, out: 50, cw: 20, cr: 1.0 },
  opus:   { in: 5,  out: 25, cw: 10, cr: 0.5 },
  sonnet: { in: 2,  out: 10, cw: 4,  cr: 0.2 },
  haiku:  { in: 1,  out: 5,  cw: 2,  cr: 0.1 },
};

function rateFor(model) {
  const m = String(model || "").toLowerCase();
  for (const k of ["sonnet", "fable", "haiku", "opus"]) if (m.includes(k)) return RATES[k];
  return null;
}

function costOf(u, r) {
  return ((u.input_tokens || 0) * r.in + (u.output_tokens || 0) * r.out
    + (u.cache_creation_input_tokens || 0) * r.cw
    + (u.cache_read_input_tokens || 0) * r.cr) / 1e6;
}

/** Parse from `offset` to EOF, folding contiguous same-id records. */
function scan(path, offset, acc) {
  const size = statSync(path).size;
  if (size <= offset) return { offset: size, acc };
  const len = size - offset;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, len, offset); } finally { closeSync(fd); }

  const text = buf.toString("utf8");
  // A trailing partial line is left for the next render rather than dropped.
  const lastNl = text.lastIndexOf("\n");
  const usable = lastNl === -1 ? "" : text.slice(0, lastNl);
  const consumed = offset + Buffer.byteLength(usable, "utf8") + (lastNl === -1 ? 0 : 1);

  for (const line of usable.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant") continue;
    const m = d.message || {};
    const u = m.usage;
    if (!u) continue;
    const r = rateFor(m.model);
    if (!r) continue;
    const c = costOf(u, r);
    // Same id as the record before it: the later one is more complete.
    if (m.id && m.id === acc.lastId) {
      acc.cost += c - acc.lastCost;
      acc.lastCost = c;
    } else {
      acc.cost += c;
      acc.turns += 1;
      acc.lastId = m.id || null;
      acc.lastCost = c;
    }
  }
  return { offset: consumed, acc };
}

function blank() { return { cost: 0, turns: 0, lastId: null, lastCost: 0 }; }

function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* keep going */ }
  const path = payload.transcript_path;
  const model = payload.model?.display_name || payload.model?.id || "";
  if (!path || !existsSync(path)) { process.stdout.write(model); return; }

  const cachePath = join(tmpdir(), `detent-statusline-${basename(path)}.json`);
  let state = { main: blank(), sub: blank(), files: {} };
  try {
    if (existsSync(cachePath)) state = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch { /* a corrupt cache just means a full re-scan */ }
  state.main ||= blank(); state.sub ||= blank(); state.files ||= {};

  const r = scan(path, state.files[path] || 0, state.main);
  state.files[path] = r.offset; state.main = r.acc;

  // Sub-agent transcripts live in <transcript-without-.jsonl>/subagents/.
  const subDir = join(dirname(path), basename(path).replace(/\.jsonl$/, ""), "subagents");
  if (existsSync(subDir)) {
    let entries = [];
    try { entries = readdirSync(subDir, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const p = join(subDir, e.name);
      // Each sub-agent file folds ids independently of the others.
      const carry = { ...state.sub, lastId: state.files[`id:${p}`] || null, lastCost: state.files[`c:${p}`] || 0 };
      const sr = scan(p, state.files[p] || 0, carry);
      state.files[p] = sr.offset;
      state.files[`id:${p}`] = sr.acc.lastId;
      state.files[`c:${p}`] = sr.acc.lastCost;
      state.sub = { cost: sr.acc.cost, turns: sr.acc.turns, lastId: state.sub.lastId, lastCost: state.sub.lastCost };
    }
  }

  try { writeFileSync(cachePath, JSON.stringify(state)); } catch { /* render anyway */ }

  const total = state.main.cost + state.sub.cost;
  const share = total > 0 ? state.sub.cost / total : 0;
  // Below ~20% delegation share the offload rule is probably not being followed.
  const flag = total > 5 && share < 0.20 ? " offload?" : "";
  const perTurn = state.main.turns ? state.main.cost / state.main.turns : 0;

  process.stdout.write(
    `${model} | $${total.toFixed(2)} | main $${perTurn.toFixed(2)}/turn | sub ${(share * 100).toFixed(0)}%${flag}`,
  );
}

try {
  main();
} catch {
  process.stdout.write("");
}
