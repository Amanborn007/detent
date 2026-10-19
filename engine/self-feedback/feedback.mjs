#!/usr/bin/env node
/**
 * feedback — the agent self-feedback journal (`detent feedback`).
 *
 * WHAT IT IS
 *   An append-only, agent-written, human-read journal of coverage gaps a
 *   stage/skill/hook could not resolve on its own: a scout query with no hit
 *   across any provider, a bot/review comment respond couldn't act on, a
 *   preflight source classified `blocked`. It is ADVISORY ONLY — an entry
 *   never blocks a stage, never opens a gate, never networks. See
 *   CONTRACT.md for the full contract and the three emission triggers.
 *
 *   NOT curator's human->agent "feedback" (poll notes/comments). This is the
 *   reverse direction: the AGENT logging what it could not cover, for a human
 *   to read later. `hooks/curator-pending-feedback-check.sh` owns the other
 *   sense of the word.
 *
 * STORE
 *   ${DETENT_ROOT}/.local/self-feedback/journal.jsonl — one JSON object per
 *   line, append-only via a single `appendFileSync` call (an O_APPEND
 *   single-line write is effectively atomic; never read-modify-write).
 *   Already gitignored under the existing `/.local/` root ignore — no
 *   .gitignore edit needed.
 *
 * Every command prints exactly one JSON line to stdout with a `next_step`.
 * Exit codes: 0 = ok · 1 = write/read failure · 2 = refusal (bad input).
 * Errors are raised loudly, never swallowed; `recorded` is never fabricated.
 *
 * Node >= 18. Zero dependencies.
 */
"use strict";

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import process from "node:process";

// ---------------------------------------------------------------------------
// Output helpers — one JSON line, always a next_step.
// ---------------------------------------------------------------------------

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}
function refuse(reason, next_step, extra = {}) {
  out({ ok: false, reason, next_step, ...extra }, 2);
}
function fail(reason, next_step, extra = {}) {
  out({ ok: false, recorded: false, reason, next_step, ...extra }, 1);
}

function nowIso(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Roots. DETENT_ROOT resolves like engine.mjs/herald.mjs: env var, else the
// clone this file lives in (engine/self-feedback/feedback.mjs -> ../../..).
// ---------------------------------------------------------------------------

export function detentRoot() {
  const envRoot = process.env.DETENT_ROOT;
  if (envRoot) {
    const r = resolve(envRoot);
    if (!existsSync(r) || !statSync(r).isDirectory()) {
      refuse(`DETENT_ROOT is not a directory: ${r}`,
        "point DETENT_ROOT at your detent clone (or unset it to use the clone this CLI lives in)");
    }
    return r;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** ${root}/.local/self-feedback/ — gitignored per-user state, same home as brief-state.json. */
export function storeDir(root) {
  return join(root, ".local", "self-feedback");
}
export function journalPath(root) {
  return join(storeDir(root), "journal.jsonl");
}

const VALID_KINDS = ["coverage-gap", "workaround", "blocked-source", "other"];
const VALID_SOURCES = ["skill", "stage", "hook", "user"];

function isDisabled() {
  return String(process.env.DETENT_SELF_FEEDBACK || "").trim().toLowerCase() === "off";
}

// ===========================================================================
// PURE(ish) CORE — exported for tests (herald imports readJournal too, so the
// journal parser lives in exactly one place — no duplication).
// ===========================================================================

/**
 * Append one entry to the journal at `path`. Single `appendFileSync` call —
 * no read-modify-write, so a concurrent append never clobbers another line.
 * Returns the full entry object written.
 */
export function appendEntry(root, fields) {
  const id = `sf-${Date.now()}-${randomBytes(2).toString("hex")}`;
  const entry = {
    schema: "self-feedback-v0",
    id,
    ts: nowIso(),
    area: fields.area,
    kind: fields.kind || "other",
    note: fields.note,
    ...(fields.stage ? { stage: fields.stage } : {}),
    ...(fields.run_id ? { run_id: fields.run_id } : {}),
    ...(fields.source ? { source: fields.source } : {}),
  };
  const p = journalPath(root);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
  return { entry, path: p };
}

/**
 * Parse the journal at an exact file `path`. Malformed lines are skipped,
 * never thrown on — `skipped_lines` reports how many so a caller never
 * silently loses data. Returns { entries, skipped_lines } (oldest-first,
 * unfiltered) — the single parser both `readJournal` (below, root-based, for
 * the CLI/tests) and herald's `buildFeedbackSection` (path-based, mirroring
 * `buildSdlcSection(window, sdlcHome)`) call, so there is exactly one place
 * that understands the journal's line format.
 */
export function readJournalFile(path) {
  if (!existsSync(path)) return { entries: [], skipped_lines: 0, path };
  const raw = readFileSync(path, "utf8");
  const entries = [];
  let skipped_lines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); }
    catch { skipped_lines++; continue; }
    if (!e || typeof e !== "object" || !e.ts) { skipped_lines++; continue; }
    entries.push(e);
  }
  return { entries, skipped_lines, path };
}

/**
 * Read + filter the journal for DETENT_ROOT `root`. `filter.since` (ISO) and
 * `filter.area` narrow the result; entries stay oldest-first (callers that
 * want newest-first, e.g. `list`, reverse the array themselves).
 */
export function readJournal(root, filter = {}) {
  const { entries, skipped_lines, path } = readJournalFile(journalPath(root));
  let filtered = entries;
  if (filter.since) {
    const sinceMs = Date.parse(filter.since);
    if (Number.isFinite(sinceMs)) filtered = filtered.filter((e) => Date.parse(e.ts) >= sinceMs);
  }
  if (filter.area) filtered = filtered.filter((e) => e.area === filter.area);
  return { entries: filtered, skipped_lines, path };
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function cmdAdd(flags) {
  if (isDisabled()) {
    out({ ok: true, recorded: false, reason: "disabled via DETENT_SELF_FEEDBACK=off",
      next_step: "unset DETENT_SELF_FEEDBACK (or set it to anything other than 'off') to resume journaling" });
  }
  const area = flags.area && flags.area !== true ? String(flags.area) : null;
  const note = flags.note && flags.note !== true ? String(flags.note) : null;
  if (!area) refuse("add requires --area <a>", "detent feedback add --area <a> --note <n> [--kind ...] [--stage <s>] [--run <run-id>] [--source <skill|stage|hook|user>]");
  if (!note) refuse("add requires --note <n>", "detent feedback add --area <a> --note <n> [--kind ...] [--stage <s>] [--run <run-id>] [--source <skill|stage|hook|user>]");
  const kind = flags.kind && flags.kind !== true ? String(flags.kind) : "other";
  if (!VALID_KINDS.includes(kind)) refuse(`unknown --kind "${kind}"`, `one of: ${VALID_KINDS.join(", ")}`);
  const source = flags.source && flags.source !== true ? String(flags.source) : undefined;
  if (source !== undefined && !VALID_SOURCES.includes(source)) refuse(`unknown --source "${source}"`, `one of: ${VALID_SOURCES.join(", ")}`);
  const root = detentRoot();
  let written;
  try {
    written = appendEntry(root, {
      area, note, kind, source,
      stage: flags.stage && flags.stage !== true ? String(flags.stage) : undefined,
      run_id: flags.run && flags.run !== true ? String(flags.run) : undefined,
    });
  } catch (e) {
    fail(`could not append to journal: ${e.message}`, `check that ${journalPath(root)}'s parent directory is writable`);
    return;
  }
  // Only reachable if the append above actually returned — never fabricate
  // recorded:true ahead of the write succeeding.
  out({
    ok: true, recorded: true, id: written.entry.id, path: written.path,
    next_step: `logged for later review — detent feedback list --area ${area} to see it alongside prior entries`,
  });
}

function cmdList(flags) {
  const root = detentRoot();
  const limit = flags.limit && flags.limit !== true ? Number(flags.limit) : 50;
  if (!Number.isFinite(limit) || limit <= 0) refuse(`--limit must be a positive number, got: ${flags.limit}`, "detent feedback list [--since <ISO>] [--area <a>] [--limit N=50]");
  const since = flags.since && flags.since !== true ? String(flags.since) : undefined;
  const area = flags.area && flags.area !== true ? String(flags.area) : undefined;
  const { entries, skipped_lines, path } = readJournal(root, { since, area });
  const newestFirst = entries.slice().reverse().slice(0, limit);
  out({
    ok: true, entries: newestFirst, count: newestFirst.length, total_matched: entries.length,
    skipped_lines, path,
    next_step: skipped_lines
      ? `${skipped_lines} malformed line(s) were skipped — inspect ${path} if that is unexpected`
      : (newestFirst.length ? "review the entries above" : "no entries match this filter"),
  });
}

const USAGE = "feedback <add|list|help> — the agent self-feedback journal (see CONTRACT.md)";

function cmdHelp() {
  out({
    ok: true,
    usage: {
      add: "feedback add --area <a> --note <n> [--kind coverage-gap|workaround|blocked-source|other] [--stage <s>] [--run <run-id>] [--source skill|stage|hook|user] — append one advisory entry",
      list: "feedback list [--since <ISO>] [--area <a>] [--limit N=50] — read entries newest-first; malformed lines are skipped and counted, never silently dropped",
      help: "feedback help — this usage",
    },
    note: "detent feedback routes here. Advisory only — an entry never blocks a stage, never opens a gate, never networks. See engine/self-feedback/CONTRACT.md.",
    next_step: USAGE,
  });
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [a] = positional;
  if (a === "help" || flags.help === true || a === undefined) return cmdHelp();
  if (a === "add") return cmdAdd(flags);
  if (a === "list") return cmdList(flags);
  refuse(`unknown command: ${positional.join(" ") || "(none)"}`, USAGE);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath) {
  try {
    main();
  } catch (e) {
    out({ ok: false, recorded: false, reason: `feedback internal error: ${e.message}`, next_step: "this is a bug in feedback.mjs — read the stack", stack: e.stack }, 1);
  }
}
