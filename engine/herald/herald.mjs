#!/usr/bin/env node
/**
 * brief — the deterministic core of the morning brief (detent herald).
 *
 * WHAT IT IS
 *   A zero-dependency Node generator that assembles the parts of a morning
 *   brief a machine CAN compute on its own: the since-last-run window, overnight
 *   owl results, open PRs needing action (via `gh`), and active engine
 *   (.sdlc) runs. It emits a single brief-data JSON document, tags every item by
 *   URGENCY, and marks the connector-gated sections (mail / chat / tickets) as
 *   "pending" — because only the invoking agent, in an interactive session, can
 *   reach those connectors. It never calls an MCP connector itself.
 *
 * HOW IT IS USED (consolidated, single-action design)
 *   `detent herald` runs in the INTERACTIVE session. The herald skill drives
 *   it in one shot:
 *     1. `brief assemble`  -> brief-data JSON with the machine-computable
 *        sections filled and the connector sections marked pending.
 *     2. the agent fills the pending connector sections (Gmail / Slack / Jira
 *        MCP reads) and writes them back into the same brief-data file.
 *     3. `brief render <brief-data.json>` -> one self-contained, actionable
 *        curator/curator HTML artifact, and records the new run timestamp.
 *   There is no headless data-prep phase. A first-session-of-day trigger
 *   (SessionStart hook) offers to run this; it does not assemble data headlessly.
 *
 * STATE
 *   ${DETENT_ROOT}/.local/brief-state.json = { last_run_ts, last_window_end,
 *   carry_context[] }. The window is always last_window_end -> now, so a
 *   weekend / leave / skipped day just widens the next window automatically —
 *   there is no hardcoded "yesterday". The new run timestamp is recorded only on
 *   a successful render (the brief actually reached the human).
 *
 * Every command prints exactly one JSON line to stdout with a `next_step`.
 * Exit codes: 0 = ok · 1 = provider/environment failure · 2 = refusal
 * (bad input, missing prerequisite). Errors are raised loudly, never swallowed.
 *
 * Node >= 18. Zero dependencies.
 */
"use strict";

import {
  readFileSync, writeFileSync, renameSync, existsSync, mkdirSync,
  readdirSync, statSync,
} from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { readJournalFile } from "../self-feedback/feedback.mjs";

// ---------------------------------------------------------------------------
// Output helpers — one JSON line, always a next_step (mirrors engine.mjs).
// ---------------------------------------------------------------------------

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}
function refuse(reason, next_step, extra = {}) {
  out({ ok: false, reason, next_step, ...extra }, 2);
}
function fail(reason, next_step, extra = {}) {
  out({ ok: false, reason, next_step, ...extra }, 1);
}

function nowIso(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Roots. DETENT_ROOT resolves like engine.mjs: env var, else the clone this
// file lives in (engine/herald/herald.mjs -> ../../..). State and artifacts are
// centralized there (tasks span repos), matching .sdlc/ and .plans/.
// ---------------------------------------------------------------------------

function detentRoot() {
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

/** Local, gitignored per-user state dir (.local/), same place as team-profiles/inbox. */
function stateDir(root) {
  return join(root, ".local");
}
function defaultStatePath(root) {
  return join(stateDir(root), "brief-state.json");
}
function plansDir(root) {
  return join(root, ".plans");
}
function defaultReadCachePath(root) {
  return join(stateDir(root), "brief-read-cache.json");
}

// ---------------------------------------------------------------------------
// Atomic JSON writes (temp + rename).
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}
function writeJsonAtomic(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, p);
}

// ===========================================================================
// PURE CORE (exported for tests) — no filesystem, no network.
// ===========================================================================

export const DEFAULT_LOOKBACK_HOURS = 24;

/**
 * Compute the brief window from persisted state.
 *   - First ever run (no state / no last_window_end): window is the last
 *     DEFAULT_LOOKBACK_HOURS. There is nothing earlier to anchor to.
 *   - Otherwise: window is last_window_end -> now. A multi-day gap (weekend,
 *     leave, skipped days) therefore widens the window with zero special-casing.
 * Returns { start, end, hours, first_run }, ISO strings.
 */
export function computeWindow(state, now = new Date(), lookbackHours = DEFAULT_LOOKBACK_HOURS, opts = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`computeWindow: invalid 'now': ${now}`);
  // Explicit override (`--days N` / `herald -N`): cover exactly the last N
  // days regardless of the persisted anchor. Ignores state so a user can ask for
  // a wider historical sweep on demand; flagged `forced` so callers/renderer know.
  const forceHours = Number(opts.forceLookbackHours);
  if (Number.isFinite(forceHours) && forceHours > 0) {
    const startMs = nowMs - forceHours * 3600 * 1000;
    const hours = Math.round(((nowMs - startMs) / 3600000) * 100) / 100;
    return {
      start: nowIso(new Date(startMs)),
      end: nowIso(new Date(nowMs)),
      hours,
      first_run: false,
      forced: true,
    };
  }
  const anchor = state && state.last_window_end ? Date.parse(state.last_window_end) : NaN;
  let startMs;
  let firstRun;
  if (Number.isFinite(anchor)) {
    startMs = anchor;
    firstRun = false;
  } else {
    startMs = nowMs - lookbackHours * 3600 * 1000;
    firstRun = true;
  }
  if (startMs > nowMs) {
    // Clock skew or a state written "in the future": never produce a negative
    // window — fall back to the default lookback and say so via first_run.
    startMs = nowMs - lookbackHours * 3600 * 1000;
    firstRun = true;
  }
  const hours = Math.round(((nowMs - startMs) / 3600000) * 100) / 100;
  return {
    start: nowIso(new Date(startMs)),
    end: nowIso(new Date(nowMs)),
    hours,
    first_run: firstRun,
  };
}

export const URGENCIES = ["urgent", "needs-action", "fyi"];

/**
 * Deterministic urgency from an item's signals. One idea per rule.
 *   urgent      — something is actively wrong or blocking you right now.
 *   needs-action — waiting on a decision or an action only you can take.
 *   fyi         — informational; no action required.
 * `signals` is a plain object the section builders fill in.
 */
export function tagUrgency(signals = {}) {
  // urgent
  if (signals.blocked) return "urgent";                 // engine run blocked on a gate
  if (signals.failing) return "urgent";                 // PR checks failing / owl run failed
  if (signals.changes_requested) return "urgent";       // reviewer blocked the PR
  if (signals.unresolved_bot_comments) return "urgent"; // bot flagged something unaddressed
  if (signals.due_today && signals.overdue) return "urgent";
  // needs-action
  if (signals.review_requested_from_you) return "needs-action";
  if (signals.approved_mergeable) return "needs-action"; // green — you can merge
  if (signals.provisional_decisions) return "needs-action"; // owl accept/pivot
  if (signals.awaiting_your_stage) return "needs-action";   // engine run needs the next stage
  if (signals.due_today) return "needs-action";
  if (signals.mention) return "needs-action";            // you were @-mentioned
  if (signals.needs_reply) return "needs-action";
  // fyi
  return "fyi";
}

/** Section skeleton for the connector-gated sources (filled by the agent in-session). */
export function pendingConnectorSection(key, title, connector, needed_for) {
  return {
    key,
    title,
    source_type: connectorSourceType(key),
    connector,
    status: "pending-interactive",
    pending_reason:
      `${connector} is an interactive-only claude.ai connector — the deterministic core cannot reach it. ` +
      `The herald skill fills this section by calling ${connector} in the interactive session.`,
    needed_for,
    items: [],
  };
}

function connectorSourceType(key) {
  return { tickets: "tickets", mail: "files", chat: "chat" }[key] || key;
}

/** Build one brief item with a computed urgency. */
export function makeItem({ id, title, detail, source, urgencySignals, action, meta }) {
  return {
    id,
    title,
    detail: detail || "",
    source,
    urgency: tagUrgency(urgencySignals || {}),
    signals: urgencySignals || {},
    action: action || null,
    meta: meta || {},
  };
}

/** Is an ISO timestamp inside [window.start, window.end]? Tolerates missing ts (false). */
export function inWindow(ts, window) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return t >= Date.parse(window.start) && t <= Date.parse(window.end);
}

/**
 * Record the completed run into state: advance the window, stamp the run, and
 * carry forward a short context note (deferred/snoozed items) for continuity.
 * Pure — returns the next state object; the caller persists it.
 */
export function recordRun(prevState, window, carryContext = [], now = new Date()) {
  const carry = Array.isArray(carryContext) ? carryContext.slice(0, 20) : [];
  return {
    last_run_ts: nowIso(now instanceof Date ? now : new Date(now)),
    last_window_end: window.end,
    carry_context: carry,
    previous_run_ts: prevState && prevState.last_run_ts ? prevState.last_run_ts : null,
  };
}

// ---------------------------------------------------------------------------
// READ-CACHE (memoization) — so a wide/overlapping window (`--days 7`, or a
// re-run) never re-surfaces items you already triaged, and a chunked read can
// resume without missing or double-reading. The connector fills (mail/chat/
// tickets) are done by the agent in-session; the agent uses these helpers to
// dedupe what it reads across chunks and across runs. `cache.seen` maps a
// stable "<source>:<id>" key -> ISO timestamp first surfaced.
// ---------------------------------------------------------------------------

/** Empty read-cache shape. */
export function emptyReadCache() {
  return { schema: "brief-read-cache-v0", seen: {} };
}

/**
 * Split `ids` for `source` into the ones not seen before (fresh) vs already
 * seen, and return a NEW cache with the fresh ids marked. Pure — caller
 * persists the returned cache. This is the memoization primitive: only the
 * `fresh` ids should be turned into brief items; the rest were already triaged.
 */
export function markSeen(cache, source, ids, now = new Date()) {
  const base = cache && cache.seen ? cache : emptyReadCache();
  const seen = { ...base.seen };
  const stamp = nowIso(now instanceof Date ? now : new Date(now));
  const fresh = [];
  const already = [];
  for (const id of ids || []) {
    const key = `${source}:${id}`;
    if (seen[key]) { already.push(id); continue; }
    seen[key] = stamp;
    fresh.push(id);
  }
  return { cache: { ...base, schema: base.schema || "brief-read-cache-v0", seen }, fresh, already };
}

/** Has this (source,id) been surfaced in a prior brief? */
export function hasSeen(cache, source, id) {
  return Boolean(cache && cache.seen && cache.seen[`${source}:${id}`]);
}

// ===========================================================================
// SECTION BUILDERS — machine-computable sources (filesystem + gh CLI).
// ===========================================================================

/**
 * Overnight: scan each root's `.owl/<run>/` for runs started in the window.
 * Reads run-meta.json, iterations.jsonl (success/fail tally), and
 * decisions.jsonl (provisional decisions awaiting accept/pivot).
 */
export function buildOvernightSection(window, owlRoots) {
  const items = [];
  const scanned = [];
  for (const root of owlRoots) {
    const base = join(root, ".owl");
    scanned.push(base);
    if (!existsSync(base)) continue;
    let entries;
    try { entries = readdirSync(base); } catch { continue; }
    for (const name of entries.sort()) {
      const runDir = join(base, name);
      const metaPath = join(runDir, "run-meta.json");
      if (!existsSync(metaPath)) continue; // notes-*.md, lock, etc. are not runs
      let meta;
      try { meta = readJson(metaPath); } catch { continue; }
      const startedAt = meta.started_at || null;
      // Include runs started in the window. Prefer started_at; only when it is
      // missing/unparseable do we fall back to the run dir's mtime.
      if (Number.isFinite(Date.parse(startedAt))) {
        if (!inWindow(startedAt, window)) continue; // present but out of window
      } else {
        try {
          if (!inWindow(nowIso(statSync(runDir).mtime), window)) continue;
        } catch { continue; }
      }
      const iters = readJsonl(join(runDir, "iterations.jsonl"));
      const successes = iters.filter((i) => i.status === "success").length;
      const failures = iters.filter((i) => i.status && i.status !== "success").length;
      const decisions = readJsonl(join(runDir, "decisions.jsonl"));
      const anyFailure = failures > 0 && successes === 0;
      items.push(makeItem({
        id: `owl:${name}`,
        title: `Overnight run: ${truncate(meta.objective || name, 80)}`,
        detail:
          `${successes} committed iteration(s), ${failures} failed/rolled-back. ` +
          `Branch ${meta.branch || "?"} in ${meta.repo || root}.` +
          (decisions.length ? ` ${decisions.length} provisional decision(s) await accept/pivot.` : ""),
        source: "owl",
        urgencySignals: {
          failing: anyFailure,
          provisional_decisions: decisions.length > 0,
        },
        action: {
          type: "owl",
          label: decisions.length
            ? "Review overnight decisions (accept/pivot)"
            : "Review overnight results",
          // Action -> dedicated run: open the run's morning-review artifact in curator.
          command: `detent curator open ${join(runDir.replace(root, "<repo>"), "..", "..", ".plans")}/owl-review-*.html`,
          run_dir: runDir,
          repo: meta.repo || root,
          decisions: decisions.map((d) => ({ id: d.id, decision_needed: d.decision_needed })),
        },
        meta: { started_at: startedAt, successes, failures, branch: meta.branch || null },
      }));
    }
  }
  return {
    key: "owl",
    title: "Overnight work",
    source_type: "code",
    status: "ok",
    scanned_roots: scanned,
    items,
  };
}

/**
 * Open PRs authored by the user that need action. Uses `gh` (a CLI, always
 * reachable headless). Injectable via deps.fetchPRs for tests.
 */
export function buildPrsSection(window, deps = {}) {
  const fetchPRs = deps.fetchPRs || ghFetchMyOpenPRs;
  let prs;
  try {
    prs = fetchPRs();
  } catch (e) {
    // gh missing/unauthenticated is a real, surfaced condition — not a silent skip.
    return {
      key: "prs",
      title: "Open PRs needing action",
      source_type: "code",
      status: "error",
      error: String(e && e.message ? e.message : e),
      enable_action: "Ensure `gh` is installed and `gh auth status` is green, then re-run.",
      items: [],
    };
  }
  const items = [];
  for (const pr of prs) {
    const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";
    const approved = pr.reviewDecision === "APPROVED";
    const failing = (pr.statusCheckRollup || []).some(
      (c) => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "CANCELLED",
    );
    const reviewRequestedFromYou = Boolean(pr.reviewRequestedFromViewer);
    const unresolvedBot = Number(pr.unresolvedBotComments || 0) > 0;
    items.push(makeItem({
      id: `pr:${pr.number}`,
      title: `PR #${pr.number}: ${truncate(pr.title || "", 80)}`,
      detail:
        `${pr.repository || ""} · review: ${pr.reviewDecision || "none"}` +
        (failing ? " · checks FAILING" : "") +
        (unresolvedBot ? ` · ${pr.unresolvedBotComments} unresolved bot comment(s)` : ""),
      source: "github",
      urgencySignals: {
        changes_requested: changesRequested,
        failing,
        unresolved_bot_comments: unresolvedBot,
        review_requested_from_you: reviewRequestedFromYou,
        approved_mergeable: approved && !failing,
      },
      action: {
        type: "pr",
        label: unresolvedBot || changesRequested ? `Respond to PR #${pr.number}` : `Handle PR #${pr.number}`,
        // Action -> dedicated run: sentinel sentinel / engine respond stage.
        command: `detent sentinel ${pr.url}`,
        alt_command: `detent run new --ticket ${pr.url}`,
        url: pr.url,
      },
      meta: { number: pr.number, url: pr.url, updatedAt: pr.updatedAt || null },
    }));
  }
  return {
    key: "prs",
    title: "Open PRs needing action",
    source_type: "code",
    status: "ok",
    items,
  };
}

/**
 * Active engine runs from the centralized .sdlc/. Light reader (does not import
 * engine.mjs, whose module body runs a CLI). Surfaces the current stage, whether
 * a pending gate blocks it, and the run age.
 */
export function buildSdlcSection(window, sdlcHome) {
  const STAGES = ["intake", "research", "plan", "implement", "recheck", "ship", "respond"];
  const items = [];
  if (existsSync(sdlcHome)) {
    for (const name of readdirSync(sdlcHome).sort()) {
      const runDir = join(sdlcHome, name);
      const runJsonPath = join(runDir, "run.json");
      if (!existsSync(runJsonPath)) continue;
      let runJson;
      try { runJson = readJson(runJsonPath); } catch { continue; }
      let stage = null;
      let stageStatus = "unknown";
      const statusPath = join(runDir, "stage-status.json");
      if (existsSync(statusPath)) {
        try {
          const st = readJson(statusPath);
          stage = STAGES.find((s) => st.stages[s] && st.stages[s].status !== "done") || null;
          stageStatus = stage ? st.stages[stage].status : "done";
        } catch { stageStatus = "unreadable"; }
      }
      if (stageStatus === "done") continue; // completed runs are not "active"
      const decisions = existsSync(join(runDir, "decisions.json"))
        ? (() => { try { return readJson(join(runDir, "decisions.json")); } catch { return []; } })()
        : [];
      const pendingGates = decisions.filter((d) => d.status === "pending");
      const blocked = stageStatus === "blocked" || pendingGates.length > 0;
      items.push(makeItem({
        id: `sdlc:${name}`,
        title: `Run ${runJson.ticket_ref || name} · stage ${stage || "?"}`,
        detail:
          `status ${stageStatus}` +
          (pendingGates.length ? ` · ${pendingGates.length} pending gate(s): ${pendingGates.map((g) => g.gate || g.id).join(", ")}` : "") +
          (runJson.repo ? ` · ${runJson.repo}` : ""),
        source: "engine",
        urgencySignals: {
          blocked,
          awaiting_your_stage: !blocked && stageStatus === "in_progress",
        },
        action: {
          type: "sdlc",
          label: blocked ? `Open gate for ${runJson.ticket_ref || name}` : `Advance run ${runJson.ticket_ref || name}`,
          // Action -> dedicated run: drive the engine run's next step.
          command: blocked
            ? `detent gate open ${(pendingGates[0] && (pendingGates[0].gate || pendingGates[0].id)) || "?"} --run ${name}`
            : `detent next --run ${name}`,
          run_id: name,
        },
        meta: { stage, stage_status: stageStatus, created_at: runJson.created_at || null },
      }));
    }
  }
  return {
    key: "sdlc",
    title: "Active engine runs",
    source_type: "code",
    status: "ok",
    sdlc_home: sdlcHome,
    items,
  };
}

/**
 * Agent self-feedback journal rollup (engine/self-feedback/CONTRACT.md). Reads
 * `journalPath` (typically `${root}/.local/self-feedback/journal.jsonl`) via
 * the shared parser (`readJournalFile` — no second implementation of the line
 * format) and surfaces new-in-window entries as ONE fyi item, never one item
 * per entry (advisory volume stays low; see the CONTRACT's "Reading it"
 * section). Never throws on a missing or malformed journal — herald assemble
 * is the daily front door and a garbage journal must not break the brief.
 */
export function buildFeedbackSection(window, journalPath) {
  const { entries, skipped_lines } = readJournalFile(journalPath);
  const inWindowEntries = entries.filter((e) => inWindow(e.ts, window));
  const items = [];
  if (inWindowEntries.length) {
    const areas = [...new Set(inWindowEntries.map((e) => e.area).filter(Boolean))];
    const n = inWindowEntries.length;
    items.push(makeItem({
      id: "self-feedback:window",
      title: `${n} new self-feedback entr${n === 1 ? "y" : "ies"} (areas: ${areas.join(", ") || "none"})`,
      detail: `Agent-logged coverage gaps since the last brief.` +
        (skipped_lines ? ` ${skipped_lines} malformed line(s) in the journal were skipped.` : ""),
      source: "self-feedback",
      urgencySignals: {},
      action: {
        type: "self-feedback",
        label: "Review self-feedback entries",
        command: `detent feedback list --since ${window.start}`,
      },
      meta: { count: n, areas, skipped_lines },
    }));
  }
  return {
    key: "self-feedback",
    title: "Agent self-feedback",
    source_type: "code",
    status: "ok",
    journal_path: journalPath,
    items,
  };
}

// --- gh plumbing (impure) ---------------------------------------------------

function readJsonl(p) {
  if (!existsSync(p)) return [];
  const rows = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* tolerate a partial trailing line */ }
  }
  return rows;
}

/**
 * Count unresolved review threads that have at least one bot-authored comment.
 * Thread resolution state (`isResolved`) is only exposed via GraphQL, so the
 * caller fetches `reviewThreads`; this stays a pure function for testability.
 * "Bot author" = GraphQL `__typename === "Bot"` (service-account bots show as
 * User and are excluded — those are the ignore-policy coverage bots anyway).
 */
export function countUnresolvedBotThreads(reviewThreads) {
  let n = 0;
  for (const t of reviewThreads ?? []) {
    if (t?.isResolved) continue;
    const nodes = t?.comments?.nodes ?? [];
    if (nodes.some((c) => c?.author?.__typename === "Bot")) n += 1;
  }
  return n;
}

// first:100 threads / first:20 comments is an unpaginated cap: a PR with more
// than 100 review threads (or a thread whose only bot comment is past the 20th)
// undercounts. Acceptable for an urgency hint; revisit if it ever misleads.
const UNRESOLVED_THCOURIER_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){" +
  "repository(owner:$owner,name:$name){pullRequest(number:$number){" +
  "reviewThreads(first:100){nodes{isResolved comments(first:20){nodes{author{__typename}}}}}}}}";

/**
 * Real gh fetch: open PRs authored by the viewer, with review decision and
 * check rollup. Then, per PR, count unresolved bot review comments. Throws on
 * any gh failure (surfaced by the caller as a section error — never silent).
 */
function ghFetchMyOpenPRs() {
  const r = spawnSync("gh", [
    "search", "prs", "--author", "@me", "--state", "open",
    "--json", "number,title,url,repository,updatedAt",
    "--limit", "30",
  ], { encoding: "utf8", timeout: 60000 });
  if (r.error) throw new Error(`gh not runnable: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh search prs failed: ${(r.stderr || "").trim()}`);
  let base;
  try { base = JSON.parse(r.stdout || "[]"); } catch (e) { throw new Error(`gh output not JSON: ${e.message}`); }
  const prs = [];
  for (const pr of base) {
    const repo = pr.repository && (pr.repository.nameWithOwner || pr.repository.name) || "";
    const enriched = { ...pr, repository: repo };
    // Per-PR review decision + checks (search json doesn't carry reviewDecision).
    if (repo && pr.number) {
      const v = spawnSync("gh", [
        "pr", "view", String(pr.number), "--repo", repo,
        "--json", "reviewDecision,statusCheckRollup,reviewRequests",
      ], { encoding: "utf8", timeout: 60000 });
      if (v.status === 0) {
        try {
          const d = JSON.parse(v.stdout);
          enriched.reviewDecision = d.reviewDecision || null;
          enriched.statusCheckRollup = d.statusCheckRollup || [];
        } catch { /* leave undefined; item still renders */ }
      }
      // Unresolved bot review threads need GraphQL (REST has no isResolved).
      // Tolerant per-PR, like the view above: a failure just leaves the count
      // unset (-> 0), it never aborts the whole brief.
      const slash = repo.indexOf("/");
      if (slash > 0) {
        // -f keeps owner/name as strings; -F (typed) would coerce an
        // all-numeric repo/owner name to Int and fail the String! variables.
        const g = spawnSync("gh", [
          "api", "graphql",
          "-f", `query=${UNRESOLVED_THCOURIER_QUERY}`,
          "-f", `owner=${repo.slice(0, slash)}`,
          "-f", `name=${repo.slice(slash + 1)}`,
          "-F", `number=${pr.number}`,
        ], { encoding: "utf8", timeout: 60000 });
        if (g.status === 0) {
          try {
            const gd = JSON.parse(g.stdout);
            const threads = gd?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
            enriched.unresolvedBotComments = countUnresolvedBotThreads(threads);
          } catch { /* leave undefined; item still renders */ }
        }
      }
    }
    prs.push(enriched);
  }
  return prs;
}

// ---------------------------------------------------------------------------
// Assemble — the machine-computable brief-data document.
// ---------------------------------------------------------------------------

function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Build the full brief-data object. Pure-ish: filesystem + gh reads, no writes.
 * Connector sections (tickets/mail/chat) are present but marked pending — the
 * agent fills them in-session. Exported for tests (inject deps.fetchPRs, roots).
 */
export function assembleBrief({ root, state, now = new Date(), owlRoots, deps = {} }) {
  const window = computeWindow(state, now, deps.lookbackHours || DEFAULT_LOOKBACK_HOURS,
    { forceLookbackHours: deps.forceLookbackHours });
  const roots = owlRoots && owlRoots.length ? owlRoots : defaultOwlRoots(root);
  const machineSections = [
    buildOvernightSection(window, roots),
    buildPrsSection(window, deps),
    buildSdlcSection(window, join(root, ".sdlc")),
    buildFeedbackSection(window, join(root, ".local", "self-feedback", "journal.jsonl")),
  ];
  const connectorSections = [
    pendingConnectorSection("tickets", "Jira assigned for today", "Atlassian MCP",
      "tickets assigned to you and due/active today"),
    pendingConnectorSection("mail", "Mail to read", "Gmail MCP",
      "unread / action-needed mail in the window"),
    pendingConnectorSection("chat", "Slack mentions & threads", "Slack MCP",
      "mentions and active threads on your channels in the window"),
  ];
  const sections = [...machineSections, ...connectorSections];
  const counts = countByUrgency(sections);
  return {
    schema: "morning-brief-data-v0",
    generated_at: nowIso(now instanceof Date ? now : new Date(now)),
    window,
    carry_context: (state && state.carry_context) || [],
    sections,
    counts,
    connectors_pending: connectorSections.map((s) => s.key),
    next_step:
      "the herald skill now: (1) runs the access-preflight for tickets/mail/chat; " +
      "(2) fills those pending sections via the interactive connectors; " +
      "(3) writes the updated brief-data back; (4) runs `brief render <brief-data.json>`.",
  };
}

function defaultOwlRoots(root) {
  const roots = new Set([root, process.cwd()]);
  const env = process.env.HERALD_OWL_ROOTS;
  if (env) for (const p of env.split(":")) if (p) roots.add(resolve(p));
  return [...roots];
}

function countByUrgency(sections) {
  const c = { urgent: 0, "needs-action": 0, fyi: 0 };
  for (const s of sections) for (const it of s.items || []) if (c[it.urgency] != null) c[it.urgency]++;
  return c;
}

// ===========================================================================
// DISPATCH LEDGER (exported pure core) — the anti-stall backbone.
//
// The failure this fixes: after the curator poll returns a long list of "Act"
// decisions, the agent had to loop over them from working memory alone. On a
// big list it could silently stall (a no-op turn) or lose track, and the
// curator never reflected which items were actually done. The ledger makes the
// worklist EXPLICIT, PERSISTED, and RESUMABLE: every Act item is one row with a
// status, so the run is provably not finished until zero rows are pending, and
// a context-summary mid-run just reloads the ledger and continues.
// ===========================================================================

export const DISPATCH_STATUSES = ["pending", "in-progress", "done", "blocked", "skipped"];
const DISPATCH_TERMINAL = new Set(["done", "blocked", "skipped"]);
// Rough per-item wall-clock band for an Act run (fix/review/reply). Used only
// to give the user a "prox time" up front — deliberately wide, not a promise.
const PER_ITEM_MIN_LOW = 3;
const PER_ITEM_MIN_HIGH = 8;
const URGENCY_ORDER = { urgent: 0, "needs-action": 1, fyi: 2 };
const DISPATCH_LABEL = {
  pending: "◻ Pending", "in-progress": "… In progress", done: "✓ Done",
  blocked: "⛔ Blocked", skipped: "– Skipped", snoozed: "💤 Snoozed", dismissed: "✕ Dismissed",
};

/**
 * Parse curator poll feedback into decisions + per-item notes + general notes.
 * Accepts the whole poll object ({prompts:[...]}), a bare prompts array, or a
 * {decisions,notes} object. A note carries the format
 *   "item:<id> — note: <text>"  (also tolerates --/- and ':' separators).
 * A decision is {type:"decision", question:"item:<id>", answer:"act|snooze|dismiss"}.
 */
export function parseDispatchFeedback(feedback) {
  const decisions = new Map();
  const notes = new Map();
  const general = [];
  const prompts = Array.isArray(feedback)
    ? feedback
    : (feedback && Array.isArray(feedback.prompts))
      ? feedback.prompts
      : [];
  const itemId = (s) => {
    const m = /^\s*item:(\S+)/.exec(String(s || ""));
    return m ? m[1] : null;
  };
  for (const p of prompts) {
    if (p && p.type === "decision" && p.question) {
      const id = itemId(p.question);
      if (id) {
        decisions.set(id, String(p.answer || "").trim().toLowerCase());
        // A note typed in curator's per-decision note field (injected under
        // every question block) rides back on the decision itself — it's an
        // instruction too, so capture it rather than dropping it. An explicit
        // comment prompt for the same id, parsed below, still takes precedence.
        if (typeof p.note === "string" && p.note.trim()) notes.set(id, p.note.trim());
      }
      continue;
    }
    if (p && (p.type === "prompt" || p.type === "comment") && (p.text || p.comment)) {
      const text = String(p.text || p.comment);
      const id = itemId(text);
      if (id) {
        // strip the "item:<id> — note:" preamble, keep the instruction
        const stripped = text.replace(/^\s*item:\S+\s*(?:[—–-]{1,2}\s*)?(?:note|comment)?\s*:?\s*/i, "").trim();
        notes.set(id, stripped || text.trim());
      } else {
        general.push(text.trim());
      }
      continue;
    }
  }
  // Also accept an explicit {decisions:{id:answer}, notes:{id:text}} shape.
  if (feedback && feedback.decisions && typeof feedback.decisions === "object" && !Array.isArray(feedback.decisions)) {
    for (const [id, ans] of Object.entries(feedback.decisions)) decisions.set(id, String(ans).trim().toLowerCase());
  }
  if (feedback && feedback.notes && typeof feedback.notes === "object" && !Array.isArray(feedback.notes)) {
    for (const [id, t] of Object.entries(feedback.notes)) notes.set(id, String(t).trim());
  }
  return { decisions, notes, general };
}

function indexItemsById(data) {
  const byId = new Map();
  for (const s of (data.sections || [])) {
    for (const it of (s.items || [])) byId.set(it.id, { ...it, section: s.title });
  }
  return byId;
}

function mkLedgerItem(base, note, iso) {
  return {
    id: base.id,
    title: base.title || base.id,
    // Normalize to a known bucket — an item carrying a non-standard urgency
    // (bad upstream data) must not crash the renderer's urgencyMeta lookup.
    urgency: URGENCIES.includes(base.urgency) ? base.urgency : "fyi",
    section: base.section || "(unknown)",
    action: base.action || {},
    note: (note && note.length) ? note : null,
    status: "pending",
    outcome: null,
    run: null,
    updated_at: iso,
  };
}

/**
 * Build a dispatch ledger from the brief-data + the curator feedback.
 *   - "act" (and any unknown decision, and any item that only got a note) -> a
 *     PENDING ledger row (a note is itself an instruction, so it implies Act).
 *   - "snooze" / "dismiss" -> recorded terminally (not work), surfaced for carry
 *     and shown in the dispatch render so the disposition is complete.
 * Items are ordered urgent -> needs-action -> fyi so the agent works the list
 * highest-severity first.
 */
export function buildDispatchLedger(data, feedback, opts = {}) {
  const now = opts.now || new Date();
  const iso = nowIso(now);
  const { decisions, notes, general } = parseDispatchFeedback(feedback);
  const byId = indexItemsById(data);
  const items = [];
  const snoozed = [];
  const dismissed = [];
  const seen = new Set();
  const baseFor = (id) => byId.get(id) || { id, title: id, urgency: "fyi", section: "(unknown)", action: {} };

  for (const [id, ans] of decisions) {
    seen.add(id);
    const base = baseFor(id);
    if (ans === "snooze") snoozed.push({ id, title: base.title, note: notes.get(id) || null });
    else if (ans === "dismiss") dismissed.push({ id, title: base.title, note: notes.get(id) || null });
    else items.push(mkLedgerItem(base, notes.get(id), iso)); // act OR unknown -> pending (never silently drop)
  }
  // A note on an item that got NO decision is still an instruction -> Act it.
  for (const [id, note] of notes) {
    if (seen.has(id)) continue;
    seen.add(id);
    items.push(mkLedgerItem(baseFor(id), note, iso));
  }
  items.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9));

  return {
    schema: "morning-brief-dispatch-v0",
    date: (data.window && data.window.end) ? data.window.end.slice(0, 10) : iso.slice(0, 10),
    window: data.window || null,
    brief_data: opts.briefDataPath || null,
    created_at: iso,
    updated_at: iso,
    items,
    snoozed,
    dismissed,
    general_notes: general,
    eta: {
      count: items.length,
      minutes_low: items.length * PER_ITEM_MIN_LOW,
      minutes_high: items.length * PER_ITEM_MIN_HIGH,
    },
  };
}

/**
 * Mark one ledger row. Throws (loudly) on unknown id or unknown status.
 * Status transitions are deliberately unconstrained — e.g. done -> pending to
 * reopen, or overwriting a wrong status — this is a correction tool, not a
 * strict state machine.
 */
export function applyDispatchUpdate(ledger, upd, now = new Date()) {
  if (!DISPATCH_STATUSES.includes(upd.status)) {
    throw new Error(`unknown dispatch status "${upd.status}" — one of: ${DISPATCH_STATUSES.join(", ")}`);
  }
  const it = (ledger.items || []).find((i) => i.id === upd.id);
  if (!it) throw new Error(`no ledger item with id "${upd.id}"`);
  it.status = upd.status;
  if (upd.outcome != null) it.outcome = String(upd.outcome);
  if (upd.run != null) it.run = String(upd.run);
  it.updated_at = nowIso(now);
  ledger.updated_at = it.updated_at;
  return ledger;
}

/** Progress rollup — `complete` iff nothing is pending/in-progress. */
export function dispatchSummary(ledger) {
  const by = { pending: 0, "in-progress": 0, done: 0, blocked: 0, skipped: 0 };
  for (const it of (ledger.items || [])) by[it.status] = (by[it.status] || 0) + 1;
  const remaining = (ledger.items || []).filter((i) => !DISPATCH_TERMINAL.has(i.status));
  return {
    total: (ledger.items || []).length,
    by,
    remaining: remaining.map((i) => ({ id: i.id, title: i.title, status: i.status })),
    complete: remaining.length === 0,
    snoozed: (ledger.snoozed || []).length,
    dismissed: (ledger.dismissed || []).length,
  };
}

/** Shape a ledger into a brief-data-like doc so renderBriefHtml can show status. */
export function ledgerToRenderData(ledger) {
  const dispatched = (ledger.items || []).map((i) => ({
    ...i,
    detail: i.note || i.detail || null,
    dispatch: { status: i.status, outcome: i.outcome, run: i.run },
  }));
  const sections = [{ title: "Dispatched", items: dispatched }];
  const extra = [
    ...(ledger.snoozed || []).map((s) => ({
      id: s.id, title: s.title, urgency: "fyi",
      detail: s.note ? `Snoozed — ${s.note}` : "Snoozed to next brief",
      action: {}, dispatch: { status: "snoozed", outcome: null, run: null },
    })),
    ...(ledger.dismissed || []).map((s) => ({
      id: s.id, title: s.title, urgency: "fyi",
      detail: s.note ? `Dismissed — ${s.note}` : "Dismissed",
      action: {}, dispatch: { status: "dismissed", outcome: null, run: null },
    })),
  ];
  if (extra.length) sections.push({ title: "Snoozed / dismissed", items: extra });
  return {
    window: ledger.window || { start: "", end: ledger.date || "", hours: 0 },
    counts: countByUrgency(sections),
    carry_context: [],
    sections,
    dispatch_mode: true,
    dispatch_summary: dispatchSummary(ledger),
    // M1: notes from the poll that weren't tied to any item:<id> — never drop
    // them; the outcome view renders them as their own panel (see renderBriefHtml).
    general_notes: ledger.general_notes || [],
  };
}

// ===========================================================================
// HTML RENDER — one self-contained, actionable curator/curator artifact.
// ===========================================================================

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * A short, human-readable label for a resource URL — e.g.
 * "github.com/example-org/webapp/pull/42" or "example.atlassian.net/browse/PROJ-42".
 * Falls back to the raw string if it does not parse as a URL.
 */
export function resourceLinkLabel(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return `${u.host}${path}${u.hash || ""}`;
  } catch {
    return String(url);
  }
}

/** Group items across all sections by urgency (urgent -> needs-action -> fyi). */
function itemsByUrgency(data) {
  const buckets = { urgent: [], "needs-action": [], fyi: [] };
  for (const s of data.sections) {
    for (const it of s.items || []) {
      const b = buckets[it.urgency] || buckets.fyi;
      b.push({ ...it, section: s.title });
    }
  }
  return buckets;
}

export function renderBriefHtml(data) {
  const buckets = itemsByUrgency(data);
  const w = data.window;
  const gap = w.hours >= 48 ? ` (${Math.round(w.hours / 24)} days — a widened window)` : "";
  const pendingConnectors = data.sections.filter((s) => s.status === "pending-interactive");
  const erroredSections = data.sections.filter((s) => s.status === "error");

  const urgencyMeta = {
    urgent: { label: "Urgent", cls: "u-urgent", blurb: "Something is wrong or blocking you right now." },
    "needs-action": { label: "Needs action", cls: "u-action", blurb: "Waiting on a decision or an action only you can take." },
    fyi: { label: "FYI", cls: "u-fyi", blurb: "Informational — no action required." },
  };

  const card = (it) => {
    // Guard against any item (ledger-sourced or not) carrying an urgency
    // outside urgent/needs-action/fyi — fall back to fyi styling rather than
    // crashing on an unindexed urgencyMeta lookup.
    const um = urgencyMeta[it.urgency] || urgencyMeta.fyi;
    const q = `item:${it.id}`;
    const act = it.action || {};
    const cmd = act.command ? `<div class="cmd"><code>${escapeHtml(act.command)}</code></div>` : "";
    // Resource link — the URL the user can click to CONFIRM why this item is
    // here (the PR, the Jira issue, the mail thread). Every item that carries a
    // url must surface it; if none is known we say so explicitly rather than
    // leaving the card unverifiable.
    const resUrl = act.url || (it.meta && it.meta.url) || it.url || "";
    // Only http(s) URLs become clickable — a javascript:/data: scheme in a
    // (future connector-sourced) url must never reach an href. Non-empty but
    // unsafe urls still show as text so the item is not silently linkless.
    const safe = /^https?:\/\//i.test(resUrl);
    let link;
    if (resUrl && safe) {
      link = `<div class="reslink"><a href="${escapeHtml(resUrl)}" target="_blank" rel="noopener">${escapeHtml(resourceLinkLabel(resUrl))} ↗</a></div>`;
    } else if (resUrl) {
      link = `<div class="reslink nolink">resource (non-web link): ${escapeHtml(resourceLinkLabel(resUrl))}</div>`;
    } else {
      link = `<div class="reslink nolink">no resource link — source unverifiable</div>`;
    }
    // In DISPATCH mode the artifact is a read-only outcome view: each card shows
    // the ledger status (done / blocked / snoozed …) instead of decision buttons.
    // Otherwise it is the actionable brief: one decision per item, plus a note box.
    let controls;
    if (it.dispatch) {
      const st = it.dispatch.status;
      const label = DISPATCH_LABEL[st] || st;
      const tail = it.dispatch.outcome ? `: ${escapeHtml(it.dispatch.outcome)}` : "";
      const run = it.dispatch.run ? `<div class="drun">${escapeHtml(it.dispatch.run)}</div>` : "";
      controls = `<div class="dstatus d-${escapeHtml(st)}">${escapeHtml(label)}${tail}</div>${run}`;
    } else {
      controls = `<div class="q" data-plan-question="${escapeHtml(q)}">
    <button class="opt act" data-plan-option="act">${escapeHtml(act.label || "Act on this")}</button>
    <button class="opt" data-plan-option="snooze">Snooze to next brief</button>
    <button class="opt" data-plan-option="dismiss">Dismiss</button>
  </div>
  <div class="note">
    <input class="note-in" type="text" placeholder="Add an action / clarification…" aria-label="Add an action or clarification for this item">
    <button class="opt note-send" type="button" data-plan-note="${escapeHtml(q)}">Send note</button>
  </div>`;
    }
    return `<div class="card ${escapeHtml(um.cls)}">
  <div class="card-h"><span class="src">${escapeHtml(it.section)}</span></div>
  <div class="card-t">${escapeHtml(it.title)}</div>
  ${it.detail ? `<div class="card-d">${escapeHtml(it.detail)}</div>` : ""}
  ${cmd}
  ${link}
  ${controls}
</div>`;
  };

  const section = (key) => {
    const meta = urgencyMeta[key];
    const items = buckets[key];
    if (!items.length) {
      return `<section class="urg ${meta.cls}"><h2>${meta.label} <span class="count">0</span></h2>
      <p class="blurb">${escapeHtml(meta.blurb)}</p><p class="empty">Nothing here.</p></section>`;
    }
    return `<section class="urg ${meta.cls}"><h2>${meta.label} <span class="count">${items.length}</span></h2>
    <p class="blurb">${escapeHtml(meta.blurb)}</p>
    <div class="cards">${items.map(card).join("\n")}</div></section>`;
  };

  const preflightPanel = (pendingConnectors.length || erroredSections.length) ? `
  <section class="panel">
    <h2>Access &amp; data completeness</h2>
    <p class="takeaway"><b>Some sources still need you.</b> The machine-computable
       parts are filled. These need an action to complete.</p>
    <ul class="access">
      ${pendingConnectors.map((s) => `<li><b>${escapeHtml(s.title)}</b> — pending.
        <span class="reason">${escapeHtml(s.pending_reason)}</span>
        <span class="enable">Enable: authenticate the ${escapeHtml(s.connector)} connector in this interactive session, then the skill fills it.</span></li>`).join("\n")}
      ${erroredSections.map((s) => `<li><b>${escapeHtml(s.title)}</b> — error: ${escapeHtml(s.error || "")}.
        <span class="enable">Enable: ${escapeHtml(s.enable_action || "resolve the error above, then re-run.")}</span></li>`).join("\n")}
    </ul>
  </section>` : "";

  const carry = (data.carry_context && data.carry_context.length) ? `
  <section class="panel">
    <h2>Context from last brief</h2>
    <ul class="carry">${data.carry_context.map((c) =>
      `<li>${escapeHtml(typeof c === "string" ? c : (c.note || JSON.stringify(c)))}</li>`).join("\n")}</ul>
  </section>` : "";

  // M1: poll feedback that wasn't tied to any item:<id> — still an instruction,
  // never silently dropped. Surfaced in both actionable and dispatch-outcome mode.
  const generalNotes = (data.general_notes && data.general_notes.length) ? `
  <section class="panel">
    <h2>General notes</h2>
    <p class="takeaway">Feedback not tied to any single item — read and action these too.</p>
    <ul class="carry">${data.general_notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("\n")}</ul>
  </section>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Morning brief — ${escapeHtml(w.end.slice(0, 10))}</title>
<style>
  :root { color-scheme: light dark;
    --ink:#1b1e23; --paper:#fbfbfa; --muted:#5b6470; --line:#d9dde3; --chip:#eef1f5;
    --urgent:#b3362b; --action:#9a6200; --fyi:#2563c9; --good:#1d7a3d; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8eaed; --paper:#191b1f; --muted:#9aa3ae; --line:#33383f; --chip:#23262b; } }
  * { box-sizing: border-box; min-width: 0; }
  body { margin:0; padding:32px 20px 80px; background:var(--paper); color:var(--ink);
    font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width:860px; margin:0 auto; display:flex; flex-direction:column; gap:26px; }
  h1 { font-size:26px; margin:0; letter-spacing:-.01em; }
  .meta { color:var(--muted); font-size:13px; margin-top:6px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.06em; margin:0 0 6px; }
  .count { color:var(--muted); font-weight:600; }
  .blurb { color:var(--muted); font-size:13px; margin:0 0 12px; }
  section.urg { border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  section.urg h2 { border-left:4px solid var(--line); padding-left:10px; }
  .u-urgent h2 { border-left-color:var(--urgent); color:var(--urgent); }
  .u-action h2 { border-left-color:var(--action); color:var(--action); }
  .u-fyi h2 { border-left-color:var(--fyi); color:var(--fyi); }
  .cards { display:flex; flex-direction:column; gap:12px; }
  .card { border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:var(--chip); }
  .card-h { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .card-t { font-weight:600; margin:3px 0; }
  .card-d { color:var(--muted); font-size:13.5px; }
  .cmd { margin:8px 0 4px; } .cmd code { font-size:12px; background:rgba(128,128,128,.14); padding:2px 6px; border-radius:5px; }
  .reslink { margin:8px 0 2px; font-size:12.5px; }
  .reslink a { color:var(--fyi); text-decoration:none; word-break:break-all; }
  .reslink a:hover { text-decoration:underline; }
  .reslink.nolink { color:var(--muted); font-style:italic; }
  .q { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }
  .opt { border:1px solid var(--line); background:none; color:var(--ink); border-radius:8px;
    padding:6px 12px; font:600 13px inherit; cursor:pointer; }
  .opt.act { border-color:var(--good); color:var(--good); }
  .opt.selected { background:var(--good); color:#fff; border-color:var(--good); }
  .note { margin-top:8px; display:flex; gap:8px; align-items:center; }
  .note-in { flex:1; min-width:0; border:1px solid var(--line); background:var(--paper); color:var(--ink);
    border-radius:8px; padding:6px 10px; font:inherit; font-size:13px; }
  .note-send { white-space:nowrap; }
  .note-send.sent { background:var(--good); color:#fff; border-color:var(--good); }
  .panel { border:1px dashed var(--line); border-radius:12px; padding:14px 18px; }
  .takeaway { margin:0 0 8px; }
  .access, .carry { margin:6px 0 0; padding-left:18px; } .access li, .carry li { margin:6px 0; }
  .reason, .enable { display:block; color:var(--muted); font-size:12.5px; }
  .enable { color:var(--action); }
  .empty { color:var(--muted); font-style:italic; }
  .dstatus { margin-top:10px; display:inline-block; font:600 12.5px inherit; padding:4px 10px; border-radius:8px;
    border:1px solid var(--line); }
  .d-done { color:var(--good); border-color:var(--good); }
  .d-blocked { color:var(--urgent); border-color:var(--urgent); }
  .d-in-progress { color:var(--action); border-color:var(--action); }
  .d-pending { color:var(--muted); }
  .d-skipped, .d-snoozed, .d-dismissed { color:var(--muted); }
  .drun { margin-top:6px; font-size:12px; color:var(--muted); word-break:break-all; }
  .dispatch-sum { margin-top:6px; font-size:13px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Morning brief${data.dispatch_mode ? " — dispatch status" : ""}</h1>
    <p class="meta">Window ${escapeHtml(w.start)} → ${escapeHtml(w.end)}${escapeHtml(gap)}
      · ${data.counts.urgent} urgent · ${data.counts["needs-action"]} needs-action · ${data.counts.fyi} FYI
      · ${data.dispatch_mode ? "read-only outcome view — each card shows what happened." : "alt-click to annotate, select text to comment, click an option to decide."}</p>
    ${data.dispatch_summary ? `<p class="dispatch-sum"><b>Dispatch:</b> ${data.dispatch_summary.by.done} done · ${data.dispatch_summary.by.blocked} blocked · ${data.dispatch_summary.by.pending + data.dispatch_summary.by["in-progress"]} in flight · ${data.dispatch_summary.by.skipped} skipped · ${data.dispatch_summary.snoozed} snoozed · ${data.dispatch_summary.dismissed} dismissed ${data.dispatch_summary.complete ? "— ✅ all resolved" : "— still working"}</p>` : ""}
  </header>
  ${carry}
  ${generalNotes}
  ${preflightPanel}
  ${section("urgent")}
  ${section("needs-action")}
  ${section("fyi")}
  <section class="panel">
    <p class="takeaway"><b>How actions work.</b> Choosing <em>Act</em> on a card
       returns a structured decision; the agent kicks off a dedicated run for it —
       a PR routes to the sentinel/engine, a ticket to clerk/engine, a
       thread to a drafted reply. <em>Snooze</em> carries the item to your next
       brief; <em>Dismiss</em> drops it.</p>
  </section>
</main>
<script>
  document.querySelectorAll('[data-plan-question]').forEach(function (q) {
    q.querySelectorAll('.opt').forEach(function (btn) {
      btn.addEventListener('click', function () {
        q.querySelectorAll('.opt').forEach(function (b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
      });
    });
  });
  // Per-card free-text action/clarification -> queued back to the agent via
  // curator's queuePrompt as a comment, tagged with the item id.
  document.querySelectorAll('.note-send').forEach(function (btn) {
    function send() {
      var box = btn.parentElement.querySelector('.note-in');
      var text = (box && box.value || '').trim();
      if (!text) return;
      var id = btn.getAttribute('data-plan-note');
      if (window.curator && typeof window.curator.queuePrompt === 'function') {
        window.curator.queuePrompt(id + ' — note: ' + text);
        btn.textContent = 'Note queued ✓'; btn.classList.add('sent');
        btn.disabled = true; if (box) box.disabled = true;
      } else {
        btn.textContent = 'curator unavailable';
      }
    }
    btn.addEventListener('click', send);
    var box = btn.parentElement.querySelector('.note-in');
    if (box) box.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  });
</script>
</body>
</html>
`;
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

function loadState(statePath) {
  if (!existsSync(statePath)) return null;
  try { return readJson(statePath); }
  catch (e) { fail(`brief-state.json is unreadable: ${e.message}`, `fix or delete ${statePath}, then re-run`); }
}

function collectOwlRoots(flags) {
  const raw = flags["owl-root"];
  if (!raw || raw === true) return null;
  return String(raw).split(",").map((p) => resolve(p)).filter(Boolean);
}

/**
 * `--days N` -> N*24 hours of forced lookback (the `herald -N` param).
 * Returns undefined when the flag is absent. Throws loudly on a non-numeric or
 * non-positive value rather than silently falling back to the default window.
 */
function forceLookbackHoursFrom(flags) {
  const raw = flags.days;
  if (raw === undefined) return undefined;
  // Bare `--days` (no value) must not silently mean 1 day — refuse loudly.
  if (raw === true) refuse("--days needs a value", "e.g. `brief assemble --days 3` for the past 3 days");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    refuse(`--days must be a positive number, got: ${raw}`, "e.g. `brief assemble --days 3` for the past 3 days");
  }
  return n * 24;
}

function cmdWindow(flags) {
  const root = detentRoot();
  const statePath = flags.state && flags.state !== true ? resolve(flags.state) : defaultStatePath(root);
  const state = loadState(statePath);
  const now = flags.now && flags.now !== true ? new Date(flags.now) : new Date();
  const window = computeWindow(state, now, DEFAULT_LOOKBACK_HOURS,
    { forceLookbackHours: forceLookbackHoursFrom(flags) });
  out({ ok: true, window, state_path: statePath,
    next_step: "this is the since-last-run window the brief will cover; run `brief assemble` to build it" });
}

function cmdAssemble(flags) {
  const root = detentRoot();
  const statePath = flags.state && flags.state !== true ? resolve(flags.state) : defaultStatePath(root);
  const state = loadState(statePath);
  const now = flags.now && flags.now !== true ? new Date(flags.now) : new Date();
  const data = assembleBrief({
    root, state, now,
    owlRoots: collectOwlRoots(flags),
    deps: { forceLookbackHours: forceLookbackHoursFrom(flags) },
  });
  const date = data.window.end.slice(0, 10);
  const outPath = flags.out && flags.out !== true ? resolve(flags.out) : join(stateDir(root), `brief-data-${date}.json`);
  writeJsonAtomic(outPath, data);
  out({
    ok: true,
    brief_data: outPath,
    window: data.window,
    counts: data.counts,
    connectors_pending: data.connectors_pending,
    next_step:
      `machine-computable sections assembled. Now (interactive session): run the source access-preflight ` +
      `(engine/sources/PREFLIGHT.md) for ${data.connectors_pending.join("/")}, fill those pending sections via ` +
      `their connectors, write the updated JSON back to ${outPath}, then: brief render ${outPath}`,
  });
}

function loadReadCache(cachePath) {
  if (!existsSync(cachePath)) return emptyReadCache();
  try { return readJson(cachePath); }
  catch (e) { fail(`brief-read-cache.json is unreadable: ${e.message}`, `fix or delete ${cachePath}, then re-run`); }
}

/**
 * `brief seen <source> --ids a,b,c` — memoization gate for the connector fills.
 * Returns the ids NOT surfaced before (fresh) and persists them as seen, so the
 * agent only builds items for fresh ids. Idempotent: re-running returns [] fresh.
 */
function cmdSeen(positional, flags) {
  const source = positional[0];
  if (!source || source === true) refuse("seen requires a source", "brief seen <mail|chat|tickets|...> --ids a,b,c");
  const raw = flags.ids;
  const ids = (!raw || raw === true) ? [] : String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  const root = detentRoot();
  const cachePath = flags["cache"] && flags["cache"] !== true ? resolve(flags["cache"]) : defaultReadCachePath(root);
  const now = flags.now && flags.now !== true ? new Date(flags.now) : new Date();
  const prev = loadReadCache(cachePath);
  const { cache, fresh, already } = markSeen(prev, source, ids, now);
  if (!flags["no-record"]) writeJsonAtomic(cachePath, cache);
  out({
    ok: true, source, fresh, already,
    cache_path: cachePath,
    next_step: fresh.length
      ? `build brief items ONLY for the ${fresh.length} fresh id(s); the ${already.length} already-seen were triaged in a prior brief`
      : `nothing fresh — all ${ids.length} id(s) were already surfaced; skip this source`,
  });
}

function cmdRender(positional, flags) {
  const root = detentRoot();
  const dataPath = positional[0] && positional[0] !== true ? resolve(positional[0]) : null;
  if (!dataPath) refuse("render requires a brief-data.json path", "brief render <brief-data.json> [--out <html>] [--no-record]");
  if (!existsSync(dataPath)) refuse(`no brief-data at ${dataPath}`, "run `brief assemble` first (it writes the brief-data JSON)");
  let data;
  try { data = readJson(dataPath); }
  catch (e) { fail(`brief-data is not valid JSON: ${e.message}`, "re-run `brief assemble` or fix the file"); }
  if (!data.window || !Array.isArray(data.sections)) {
    refuse("brief-data is missing window/sections — not a morning-brief-data document", "regenerate it with `brief assemble`");
  }
  const date = data.window.end.slice(0, 10);
  const artifact = flags.out && flags.out !== true ? resolve(flags.out) : join(plansDir(root), `morning-brief-${date}.html`);
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, renderBriefHtml(data));

  // Record the run on success (the brief actually rendered). Carry forward any
  // items the caller marked deferred/snoozed via --carry (JSON array) so
  // consecutive briefs have continuity.
  //
  // A FORCED window (`--days N`) is an ad-hoc historical sweep — it must NOT
  // advance last_window_end, or an outstanding gap wider than N would be skipped
  // forever (the daily cadence would jump straight to `now`). Forced runs never
  // record; the normal `last_window_end -> now` cadence is untouched.
  let recorded = null;
  if (!flags["no-record"] && !(data.window && data.window.forced)) {
    const statePath = flags.state && flags.state !== true ? resolve(flags.state) : defaultStatePath(root);
    const prev = loadState(statePath);
    let carry = [];
    if (flags.carry && flags.carry !== true) {
      try { carry = JSON.parse(readFileSync(resolve(flags.carry), "utf8")); }
      catch (e) { fail(`--carry file is not valid JSON: ${e.message}`, "pass --carry <json-array-file> or omit it"); }
    }
    const next = recordRun(prev, data.window, carry);
    writeJsonAtomic(statePath, next);
    recorded = { state_path: statePath, last_run_ts: next.last_run_ts, last_window_end: next.last_window_end };
  }
  out({
    ok: true,
    artifact,
    counts: data.counts,
    recorded,
    next_step:
      `the MAIN session now owns the curator loop: detent curator open ${artifact} -> poll. ` +
      `As soon as the poll returns, run \`herald dispatch-plan ${artifact.replace(/\.plans\/morning-brief-(.*)\.html$/, ".local/brief-data-$1.json")} --feedback <poll.json>\` ` +
      `to persist the Act items as a ledger, then work it to zero pending (dispatch-update per item) and dispatch-render when done. ` +
      `The ledger is the contract — never end a turn with pending items and no action.`,
  });
}

function defaultDispatchPath(root, date) {
  return join(stateDir(root), `brief-dispatch-${date}.json`);
}

function loadLedger(positional) {
  const p = positional[0] && positional[0] !== true ? resolve(positional[0]) : null;
  if (!p) refuse("this command needs a dispatch-ledger path", "pass the brief-dispatch-<date>.json written by `herald dispatch-plan`");
  if (!existsSync(p)) refuse(`no dispatch ledger at ${p}`, "run `herald dispatch-plan <brief-data.json> --feedback <poll.json>` first");
  let ledger;
  try { ledger = readJson(p); }
  catch (e) { fail(`dispatch ledger is not valid JSON: ${e.message}`, "fix or regenerate it with `herald dispatch-plan`"); }
  return { path: p, ledger };
}

/**
 * `herald dispatch-plan <brief-data.json> --feedback <poll.json>` — turn the
 * curator poll result into a persisted, ordered worklist so no Act item is ever
 * dropped or forgotten mid-run. Prints the worklist + a rough ETA.
 */
function cmdDispatchPlan(positional, flags) {
  const root = detentRoot();
  const dataPath = positional[0] && positional[0] !== true ? resolve(positional[0]) : null;
  if (!dataPath) refuse("dispatch-plan requires a brief-data.json path", "herald dispatch-plan <brief-data.json> --feedback <poll.json>");
  if (!existsSync(dataPath)) refuse(`no brief-data at ${dataPath}`, "render the brief first");
  let data;
  try { data = readJson(dataPath); }
  catch (e) { fail(`brief-data is not valid JSON: ${e.message}`, "re-run `herald assemble`"); }

  let feedback;
  if (flags.feedback && flags.feedback !== true) {
    const fp = resolve(flags.feedback);
    if (!existsSync(fp)) refuse(`no feedback file at ${fp}`, "pass --feedback <curator-poll-json>");
    try { feedback = readJson(fp); }
    catch (e) { fail(`--feedback file is not valid JSON: ${e.message}`, "pass the curator poll result JSON"); }
  } else if (flags["feedback-json"] && flags["feedback-json"] !== true) {
    try { feedback = JSON.parse(String(flags["feedback-json"])); }
    catch (e) { refuse(`--feedback-json is not valid JSON: ${e.message}`, "pass a JSON string of the poll result"); }
  } else {
    refuse("dispatch-plan needs the curator feedback", "pass --feedback <poll.json> (the curator poll result) or --feedback-json '<json>'");
  }

  const now = flags.now && flags.now !== true ? new Date(flags.now) : new Date();
  const ledger = buildDispatchLedger(data, feedback, { now, briefDataPath: dataPath });
  const outPath = flags.out && flags.out !== true ? resolve(flags.out) : defaultDispatchPath(root, ledger.date);

  // M4: a second dispatch-plan for the same date would silently clobber an
  // existing ledger, wiping in-progress/done/blocked/skipped rows (and their
  // recorded outcomes). Refuse unless --force — an unreadable/corrupt existing
  // ledger can't be proven safe to overwrite either, so it also requires --force.
  if (existsSync(outPath) && !flags.force) {
    let existing = null;
    let corrupt = false;
    try { existing = readJson(outPath); } catch { corrupt = true; }
    const hasProgress = corrupt
      || (existing && Array.isArray(existing.items) && existing.items.some((i) => i.status !== "pending"));
    if (hasProgress) {
      refuse(
        `a dispatch ledger already exists at ${outPath}` +
          (corrupt
            ? " and is unreadable — cannot confirm it is safe to overwrite"
            : " with rows that are no longer pending (in-progress, done, blocked, or skipped)"),
        "pass --force to overwrite it (any progress and recorded outcomes will be LOST), " +
          `or run \`herald dispatch-update ${outPath}\` against the existing ledger instead`,
      );
    }
  }

  writeJsonAtomic(outPath, ledger);
  const eta = ledger.eta;
  out({
    ok: true,
    ledger: outPath,
    eta,
    eta_human: eta.count
      // The dedicated runs (fixes/reviews/replies) an item kicks off can run in
      // background/parallel — but the ledger UPDATE itself must not (see M2:
      // dispatch-update has no file lock; call it serially, main-session-only).
      ? `~${eta.minutes_low}-${eta.minutes_high} min for ${eta.count} item(s) ` +
        `(rough; the work can run in the background, but call dispatch-update serially from the main session)`
      : "nothing to dispatch",
    worklist: ledger.items.map((i) => ({ id: i.id, title: i.title, urgency: i.urgency, note: i.note })),
    snoozed: ledger.snoozed.length,
    dismissed: ledger.dismissed.length,
    general_notes: ledger.general_notes,
    next_step:
      `Work the ledger top-down (urgent first). For each item: launch its run, then ` +
      `\`herald dispatch-update ${outPath} --id <id> --status done|blocked|skipped [--outcome "..."] [--run "<url>"]\` ` +
      `— call this serially from the main session only, never from concurrent background runs. ` +
      `Poll \`herald dispatch-status ${outPath}\`. NEVER end a turn while items are pending — batch and keep going. ` +
      (ledger.general_notes.length
        ? `${ledger.general_notes.length} general note(s) were not tied to any item — read \`general_notes\` in ` +
          `this ledger and act on them too (a note is an instruction, not just FYI). `
        : "") +
      `When status shows complete, \`herald dispatch-render ${outPath}\` and re-open the curator to show every outcome.`,
  });
}

/**
 * `herald dispatch-update <ledger> --id <id> --status <s> [--outcome ..] [--run ..]`
 *
 * M2 (lost-update race): this is a read-modify-write over a plain JSON file with
 * no lock. It MUST be called serially, from the main session only — background
 * runs return their outcome to the main session, which is the only caller that
 * marks the ledger. If two calls DO race, an optimistic-concurrency check below
 * catches the case where the file changed between our read and our write and
 * reapplies this update on top of the latest on-disk state instead of clobbering
 * it. This is best-effort, not a lock: a same-millisecond collision, or a change
 * landing in the reload-to-write gap, can still slip through.
 */
function cmdDispatchUpdate(positional, flags) {
  // Sample the ledger's mtime BEFORE reading its content, so a concurrent
  // writer landing in the read→stat gap can't produce equal read/write mtimes
  // and silently defeat the reload-and-reapply guard below.
  const preReadPath = positional[0] && positional[0] !== true ? resolve(positional[0]) : null;
  let mtimeAtRead;
  try { mtimeAtRead = preReadPath ? statSync(preReadPath).mtimeMs : null; } catch { mtimeAtRead = null; }
  const { path, ledger: initial } = loadLedger(positional);
  const id = flags.id && flags.id !== true ? String(flags.id) : null;
  const status = flags.status && flags.status !== true ? String(flags.status) : null;
  if (!id) refuse("dispatch-update requires --id", "herald dispatch-update <ledger> --id <item-id> --status <done|blocked|in-progress|skipped> (call this serially from the main session only)");
  if (!status) refuse("dispatch-update requires --status", `one of: ${DISPATCH_STATUSES.join(", ")}`);
  const now = flags.now && flags.now !== true ? new Date(flags.now) : new Date();
  const upd = {
    id, status,
    outcome: (flags.outcome && flags.outcome !== true) ? String(flags.outcome) : null,
    run: (flags.run && flags.run !== true) ? String(flags.run) : null,
  };
  let ledger = initial;
  try {
    applyDispatchUpdate(ledger, upd, now);
  } catch (e) {
    refuse(e.message, "check the id against `herald dispatch-status <ledger>` and use a valid status");
  }
  let mtimeAtWrite;
  try { mtimeAtWrite = statSync(path).mtimeMs; } catch { mtimeAtWrite = null; }
  if (mtimeAtRead !== mtimeAtWrite) {
    // Someone else wrote to the ledger while we were computing our update —
    // reload the latest state and reapply on top of it, not our stale copy.
    let fresh;
    try { fresh = readJson(path); }
    catch (e) { fail(`dispatch ledger became unreadable during a concurrent update: ${e.message}`, "re-run `herald dispatch-update` once the ledger file is stable"); }
    try { applyDispatchUpdate(fresh, upd, now); }
    catch (e) { refuse(e.message, "check the id against `herald dispatch-status <ledger>` and use a valid status"); }
    ledger = fresh;
  }
  writeJsonAtomic(path, ledger);
  const sum = dispatchSummary(ledger);
  out({
    ok: true, id, status, summary: sum,
    next_step: sum.complete
      ? `all ${sum.total} item(s) resolved — run \`herald dispatch-render ${path}\` and re-open the curator.`
      : `${sum.remaining.length} still pending/in-progress — keep dispatching, do not stop here.`,
  });
}

/** `herald dispatch-status <ledger>` — is the run done, and what's left? */
function cmdDispatchStatus(positional, _flags) {
  const { ledger } = loadLedger(positional);
  const sum = dispatchSummary(ledger);
  out({
    ok: true,
    summary: sum,
    items: (ledger.items || []).map((i) => ({ id: i.id, status: i.status, outcome: i.outcome, run: i.run })),
    next_step: sum.complete
      ? "complete — render the outcome view and re-open the curator."
      : `not done: ${sum.remaining.length} pending/in-progress. Launch the next item's run; never idle with pending items.`,
  });
}

/** `herald dispatch-render <ledger> [--out html]` — re-render the curator artifact with outcomes. */
function cmdDispatchRender(positional, flags) {
  const root = detentRoot();
  const { ledger } = loadLedger(positional);
  const renderData = ledgerToRenderData(ledger);
  const artifact = flags.out && flags.out !== true
    ? resolve(flags.out)
    : join(plansDir(root), `morning-brief-${ledger.date}.html`);
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, renderBriefHtml(renderData));
  out({
    ok: true, artifact, summary: dispatchSummary(ledger),
    next_step:
      `re-open the curator so the user sees every outcome: detent curator open ${artifact} ` +
      `(re-render overwrote the same file, so re-open + reload). Then report fixed / blocked / snoozed per item.`,
  });
}

const USAGE = "brief <window|assemble|render|dispatch-plan|dispatch-update|dispatch-status|dispatch-render|help> — the morning-brief generator (see docs/morning-brief.md)";

function cmdHelp() {
  out({
    ok: true,
    usage: {
      window: "brief window [--state <path>] [--now <iso>] [--days <N>] — print the since-last-run window (last_window_end -> now); --days N forces the past N days",
      assemble: "brief assemble [--state <path>] [--now <iso>] [--days <N>] [--owl-root <p1,p2>] [--out <json>] — build the machine-computable brief-data (owl + PRs + .sdlc); --days N covers the past N days (the `herald -N` param); connector sections (tickets/mail/chat) marked pending",
      seen: "brief seen <source> --ids a,b,c [--cache <path>] [--no-record] — memoization gate: returns the ids NOT surfaced in a prior brief (and marks them seen) so wide/overlapping windows don't re-raise triaged items",
      render: "brief render <brief-data.json> [--out <html>] [--carry <json-array-file>] [--no-record] — render ONE actionable curator artifact and record the new run timestamp",
      "dispatch-plan": "herald dispatch-plan <brief-data.json> --feedback <curator-poll.json> [--out <ledger.json>] [--force] — turn the poll's Act/snooze/dismiss decisions + notes into a persisted, ordered worklist (the anti-stall ledger) with a rough ETA; refuses to overwrite an existing ledger that has non-pending rows unless --force (that wipes progress/outcomes); general notes (not tied to any item) are echoed in the output — read and act on them too",
      "dispatch-update": "herald dispatch-update <ledger.json> --id <item-id> --status <done|blocked|in-progress|skipped> [--outcome \"...\"] [--run \"<url>\"] — mark one Act item's outcome. CALL SERIALLY, from the main session only — there is no file lock; concurrent calls race (a best-effort reload-and-reapply catches most cases, not all)",
      "dispatch-status": "herald dispatch-status <ledger.json> — progress rollup; `complete` iff nothing is pending/in-progress (the signal the run is actually finished)",
      "dispatch-render": "herald dispatch-render <ledger.json> [--out <html>] — re-render the curator artifact as a read-only outcome view (done/blocked/snoozed per item)",
      help: "brief help — this usage",
    },
    note: "detent herald routes here. The consolidated flow runs in the interactive session: assemble -> agent fills connectors -> render -> main session owns the curator loop. No headless data-prep.",
    next_step: "pick a command above — full flow in docs/morning-brief.md and skills/herald/SKILL.md",
  });
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [a] = positional;
  if (a === "help" || flags.help === true || a === undefined) return cmdHelp();
  if (a === "window") return cmdWindow(flags);
  if (a === "assemble") return cmdAssemble(flags);
  if (a === "seen") return cmdSeen(positional.slice(1), flags);
  if (a === "render") return cmdRender(positional.slice(1), flags);
  if (a === "dispatch-plan") return cmdDispatchPlan(positional.slice(1), flags);
  if (a === "dispatch-update") return cmdDispatchUpdate(positional.slice(1), flags);
  if (a === "dispatch-status") return cmdDispatchStatus(positional.slice(1), flags);
  if (a === "dispatch-render") return cmdDispatchRender(positional.slice(1), flags);
  refuse(`unknown command: ${positional.join(" ") || "(none)"}`, USAGE);
}

// Only run the CLI when invoked directly (so tests can import the pure core).
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath || (isAbsolute(invokedPath) && invokedPath === selfPath)) {
  try {
    main();
  } catch (e) {
    out({ ok: false, reason: `brief internal error: ${e.message}`, next_step: "this is a bug in herald.mjs — read the stack", stack: e.stack }, 1);
  }
}
