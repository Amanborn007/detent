#!/usr/bin/env node
/**
 * bench — the SDLC run benchmark harness (module + CLI).
 *
 * Derives per-run metrics from a run's append-only event log (events.jsonl,
 * emitted by engine.mjs per stage/gate transition) plus optional token
 * accounting (tokens.jsonl). Pure reads; never mutates a run's authoritative
 * state. Zero dependencies, Node >= 18.
 *
 * The headline number is EFFECTIVE AGENTIC TIME:
 *
 *   effective_agentic_time = wall_clock − human_gate_wait − async_external_wait
 *
 * i.e. how long the agent was actually the thing making progress, with the two
 * kinds of waiting-on-something-else factored out:
 *   - human_gate_wait     — time a gate sat open waiting for a human answer.
 *   - async_external_wait  — time spent waiting on things outside the run:
 *                            PENDING-EXTERNAL sign-offs, CI, bot comments.
 *
 * Everything is best-effort and HONEST: if a stream is absent (e.g. no
 * tokens.jsonl) the harness says so ("unrecorded") rather than fabricating.
 *
 * As a module it exports pure compute functions (unit-tested); as a CLI it
 * reads a run directory, writes <run>/benchmark.json, and appends a one-line
 * summary to <detent-root>/benchmarks/ledger.jsonl.
 */
"use strict";

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// Editable per-model rate table — USD per 1,000,000 tokens (input / output).
// Keyed by whatever string tokens.jsonl records in its `model` field. Edit
// these to match current pricing; add rows for models you actually use. A
// model with no row here is left UNPRICED (surfaced in `unpriced_models`),
// never guessed. Tiers mirror the model-selection tiers in the harness docs.
// ---------------------------------------------------------------------------

export const DEFAULT_RATES = {
  _note: "USD per 1e6 tokens; unlisted models are left unpriced, not guessed. cache_read is 0.1x input; cache_write is the 1h-TTL rate (2.0x input). computeTokens reads ONLY cache_read/cache_write — there is no 5m knob here, so cache_creation is priced as 1h TTL. Rows carrying promotional pricing MUST set _expires so the table fails loud instead of drifting.",
  _version: "2026-08-14",
  // STRONG tier (planning/architecture/tricky work).
  "fable":   { input: 10, output: 50, cache_write: 20, cache_read: 1.0 },
  "opus":    { input: 5,  output: 25, cache_write: 10, cache_read: 0.5 },
  // FAST tier (code + commit execution).
  // Introductory pricing, in effect through 2026-08-31; list is 3/15. Pricing
  // it at list would overstate Sonnet spend by 50%.
  "sonnet":  { input: 2,  output: 10, cache_write: 4,  cache_read: 0.2, _expires: "2026-08-31", _list: { input: 3, output: 15, cache_write: 6, cache_read: 0.3 } },
  // LIGHT tier (mechanical).
  "haiku":   { input: 1,  output: 5,  cache_write: 2,  cache_read: 0.1 },
};

/**
 * When a rate row's promotional pricing ends, in ms. `null` if it never does.
 *
 * A date-only `_expires` means "through the END of that day": `Date.parse` puts
 * it at 00:00 UTC, which would retire pricing documented as effective "through
 * 2026-08-31" for almost all of that date.
 */
export function rateExpiresMs(row) {
  if (!row || typeof row !== "object" || !row._expires) return null;
  const raw = String(row._expires).trim();
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return NaN; // unparseable — caller decides
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parsed + 86399999 : parsed;
}

/**
 * The rate that applied to traffic AT `atMs`.
 *
 * Rate selection is per-record on purpose. Swapping the whole table before a
 * scan reprices history: a 30-day window that straddles an expiry would charge
 * the pre-expiry traffic at post-expiry prices, which is a new version of the
 * stale-rate bug rather than a fix for it. A row with no usable fallback is
 * returned unchanged — the caller reports it rather than guessing.
 */
export function effectiveRate(row, atMs) {
  const exp = rateExpiresMs(row);
  if (exp === null) return row;
  if (!Number.isFinite(exp)) return row;
  if (atMs <= exp) return row;
  return row._list && typeof row._list === "object" ? row._list : row;
}

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

/** Parse JSONL text into an array of objects. Blank lines skipped; a bad line
 *  throws loudly with its line number (no silent drop of malformed records). */
export function parseJsonl(text) {
  if (!text) return [];
  const rows = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`bench: invalid JSONL at line ${i + 1}: ${e.message}`);
    }
  }
  return rows;
}

function tsMs(event) {
  const t = Date.parse(event.ts);
  if (!Number.isFinite(t)) {
    throw new Error(`bench: event has no parseable ts: ${JSON.stringify(event)}`);
  }
  return t;
}

function isoOf(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Human-friendly duration for a millisecond span (readability only). */
export function humanMs(ms) {
  if (ms == null) return null;
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h}h${rm}m` : `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function round(n, places = 4) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Per-phase wall-clock — from stage_begin / stage_end events.
// ---------------------------------------------------------------------------

/**
 * @returns { [stage]: { begin_ts, end_ts, wall_ms, wall_human, status } }
 *   status: "done" (begin+end seen) | "incomplete" (begin, no end).
 * A stage_end with no matching stage_begin is skipped (can't be timed) and
 * reported in `.orphan_ends`.
 */
export function computePhaseTimings(events) {
  const openBegin = new Map(); // stage -> begin ms
  const phases = {};
  const orphanEnds = [];
  for (const e of events) {
    if (e.event === "stage_begin") {
      openBegin.set(e.stage, tsMs(e));
    } else if (e.event === "stage_end") {
      const b = openBegin.get(e.stage);
      if (b == null) {
        orphanEnds.push(e.stage);
        continue;
      }
      const end = tsMs(e);
      phases[e.stage] = {
        begin_ts: isoOf(b),
        end_ts: isoOf(end),
        wall_ms: end - b,
        wall_human: humanMs(end - b),
        status: "done",
      };
      openBegin.delete(e.stage);
    }
  }
  for (const [stage, b] of openBegin) {
    phases[stage] = {
      begin_ts: isoOf(b),
      end_ts: null,
      wall_ms: null,
      wall_human: null,
      status: "incomplete",
    };
  }
  return { phases, orphan_ends: orphanEnds };
}

// ---------------------------------------------------------------------------
// Total wall-clock — first event to last event.
// ---------------------------------------------------------------------------

export function computeWallClock(events) {
  if (!events.length) return { total_ms: 0, total_human: "0s", first_ts: null, last_ts: null };
  let min = Infinity, max = -Infinity;
  for (const e of events) {
    const t = tsMs(e);
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return {
    total_ms: max - min,
    total_human: humanMs(max - min),
    first_ts: isoOf(min),
    last_ts: isoOf(max),
  };
}

// ---------------------------------------------------------------------------
// Human-gate wait — sum(gate_answered_ts − gate_opened_ts) across gates.
// Paired by decision_id (fall back to gate name). Uses the EARLIEST open for a
// gate and the answered timestamp; answered ts prefers the human's answered_at
// field, else the event ts. Gates opened but never answered are surfaced but
// contribute no wait (honest: we don't know when/if a human will answer).
// ---------------------------------------------------------------------------

export function computeGateWait(events) {
  const opened = new Map(); // key -> earliest open ms
  const answered = new Map(); // key -> { ms, answer }
  for (const e of events) {
    const key = e.decision_id || e.gate;
    if (!key) continue;
    if (e.event === "gate_opened") {
      const t = tsMs(e);
      if (!opened.has(key) || t < opened.get(key)) opened.set(key, t);
    } else if (e.event === "gate_answered") {
      const t = e.answered_at ? Date.parse(e.answered_at) : tsMs(e);
      if (!Number.isFinite(t)) throw new Error(`bench: gate_answered has bad time: ${JSON.stringify(e)}`);
      answered.set(key, { ms: t, answer: e.answer ?? null });
    }
  }
  const gates = [];
  let total = 0;
  for (const [key, a] of answered) {
    if (!opened.has(key)) continue; // answered but never observed opening — can't time
    const wait = Math.max(0, a.ms - opened.get(key));
    gates.push({
      decision_id: key,
      opened_ts: isoOf(opened.get(key)),
      answered_ts: isoOf(a.ms),
      answer: a.answer,
      wait_ms: wait,
      wait_human: humanMs(wait),
    });
    total += wait;
  }
  const openUnanswered = [...opened.keys()].filter((k) => !answered.has(k));
  return { total_ms: total, total_human: humanMs(total), count: gates.length, gates, open_unanswered: openUnanswered };
}

// ---------------------------------------------------------------------------
// Async-external wait — sum(external_response_ts − external_request_ts).
// Covers PENDING-EXTERNAL sign-offs, CI waits, bot-comment waits: any
// external_request / external_response event pair, correlated by `id`. `kind`
// (sign_off | ci | bot_comment | ...) is carried through for the breakdown.
// Sums whatever is present; unmatched requests are surfaced, never guessed.
// ---------------------------------------------------------------------------

export function computeAsyncWait(events) {
  const openReq = new Map(); // id -> { ms, kind }
  const waits = [];
  const byKind = {};
  let total = 0;
  for (const e of events) {
    if (e.event === "external_request") {
      if (e.id == null) throw new Error(`bench: external_request missing id: ${JSON.stringify(e)}`);
      openReq.set(e.id, { ms: tsMs(e), kind: e.kind || "unknown" });
    } else if (e.event === "external_response") {
      const req = openReq.get(e.id);
      if (!req) continue; // response with no request — nothing to time
      const wait = Math.max(0, tsMs(e) - req.ms);
      const kind = req.kind || e.kind || "unknown";
      waits.push({ id: e.id, kind, wait_ms: wait, wait_human: humanMs(wait) });
      byKind[kind] = (byKind[kind] || 0) + wait;
      total += wait;
      openReq.delete(e.id);
    }
  }
  return {
    total_ms: total,
    total_human: humanMs(total),
    count: waits.length,
    by_kind: byKind,
    waits,
    unmatched_requests: [...openReq.keys()],
  };
}

// ---------------------------------------------------------------------------
// Tokens + models + cost — best-effort from tokens.jsonl rows {phase, model,
// input, output, cache_read?, cache_write?}. Absent stream => { recorded: false }
// (honest, no fabrication). Cache traffic dominates real agent spend, so a row omitting the cache fields
// yields a cost that is understated, and says so rather than reading as zero.
// ---------------------------------------------------------------------------

export function computeTokens(tokensText, rates = DEFAULT_RATES, { asOfMs = null } = {}) {
  const asOf = asOfMs ?? Date.now();
  const expiryCorrected = new Set();
  if (!tokensText || !tokensText.trim()) {
    return {
      recorded: false,
      note: "tokens unrecorded — no tokens.jsonl for this run (token/model/cost metrics unavailable)",
    };
  }
  const rows = parseJsonl(tokensText);
  if (rows.length === 0) {
    return { recorded: false, note: "tokens unrecorded — tokens.jsonl present but empty" };
  }
  const byModel = {};
  const byPhase = {};
  const unpriced = new Set();
  const uncachedModels = new Set();
  let inputTotal = 0, outputTotal = 0, cacheReadTotal = 0, cacheWriteTotal = 0, costTotal = 0;
  for (const r of rows) {
    const input = Number(r.input) || 0;
    const output = Number(r.output) || 0;
    // Cache fields are optional: a row without them is a pre-2026-08 row that
    // predates cache accounting, NOT a turn that happened to read nothing.
    const hasCache = r.cache_read !== undefined || r.cache_write !== undefined;
    const cacheRead = Number(r.cache_read) || 0;
    const cacheWrite = Number(r.cache_write) || 0;
    const model = r.model || "unknown";
    const phase = r.phase || "unknown";
    if (!hasCache) uncachedModels.add(model);
    inputTotal += input;
    outputTotal += output;
    cacheReadTotal += cacheRead;
    cacheWriteTotal += cacheWrite;
    (byModel[model] ||= { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 });
    byModel[model].input += input;
    byModel[model].output += output;
    byModel[model].cache_read += cacheRead;
    byModel[model].cache_write += cacheWrite;
    (byPhase[phase] ||= { input: 0, output: 0, cache_read: 0, cache_write: 0 });
    byPhase[phase].input += input;
    byPhase[phase].output += output;
    byPhase[phase].cache_read += cacheRead;
    byPhase[phase].cache_write += cacheWrite;
    // tokens.jsonl rows carry no timestamp, so a run is priced as of `asOfMs`
    // (default: now). Coarser than the per-record selection in engine/spend,
    // but a benchmark measures one run at one point in time, and pricing it
    // with a rate that has since lapsed is the exact bug this table was
    // corrected to stop.
    const rawRate = rates[model];
    const rate = effectiveRate(rawRate, asOf);
    if (rate !== rawRate) expiryCorrected.add(model);
    if (rate && typeof rate.input === "number" && typeof rate.output === "number") {
      // Cache rates default to the standard multipliers when a rate row omits
      // them, so an older rate table still prices cache traffic rather than
      // silently valuing it at zero.
      const rRead = typeof rate.cache_read === "number" ? rate.cache_read : rate.input * 0.1;
      const rWrite = typeof rate.cache_write === "number" ? rate.cache_write : rate.input * 2.0;
      const c = (input / 1e6) * rate.input
              + (output / 1e6) * rate.output
              + (cacheRead / 1e6) * rRead
              + (cacheWrite / 1e6) * rWrite;
      byModel[model].cost_usd = round(byModel[model].cost_usd + c);
      costTotal += c;
    } else {
      unpriced.add(model);
    }
  }
  const notes = [];
  if (unpriced.size) {
    notes.push(`estimated cost EXCLUDES unpriced model(s): ${[...unpriced].join(", ")} — add rates to price them`);
  }
  if (uncachedModels.size) {
    notes.push(`cache tokens unrecorded for: ${[...uncachedModels].join(", ")} — cost is UNDERSTATED (cache traffic is typically the majority of spend)`);
  }
  if (expiryCorrected.size) {
    notes.push(`promotional pricing has lapsed for: ${[...expiryCorrected].join(", ")} — priced at the _list fallback, not the expired rate`);
  }
  return {
    recorded: true,
    input_tokens: inputTotal,
    output_tokens: outputTotal,
    cache_read_tokens: cacheReadTotal,
    cache_write_tokens: cacheWriteTotal,
    total_tokens: inputTotal + outputTotal + cacheReadTotal + cacheWriteTotal,
    models: Object.keys(byModel),
    by_model: byModel,
    by_phase: byPhase,
    estimated_cost_usd: round(costTotal),
    unpriced_models: [...unpriced],
    cache_unrecorded_models: [...uncachedModels],
    // A corrected row means these numbers came from different prices than the
    // table's nominal version implies. Saying so is what lets a consumer refuse
    // to compare across the boundary.
    rate_table_version: expiryCorrected.size
      ? `${rates._version || "unknown"}+list-after-expiry`
      : (rates._version || "unknown"),
    rates_corrected: [...expiryCorrected],
    cost_note: notes.length ? notes.join("; ") : "all models priced from the rate table, cache traffic included",
  };
}

// ---------------------------------------------------------------------------
// Other metrics — all best-effort, derived from event types. When an entire
// category has no relevant events, it is reported with recorded:false so a
// genuine zero is never confused with "the run didn't emit these".
// ---------------------------------------------------------------------------

function countable(events, matcher) {
  return events.filter(matcher).length;
}

export function computeOtherMetrics(events, stageStatus = null) {
  const gatesRaised = events.filter((e) => e.event === "gate_raised");
  const gatesAnswered = events.filter((e) => e.event === "gate_answered");
  const autofix = events.filter((e) => e.event === "autofix_round" || e.event === "recheck_round");
  const commits = events.filter((e) => e.event === "commit");
  const apiDrops = events.filter((e) => e.event === "api_drop");
  const resumes = events.filter((e) => e.event === "resume" || e.event === "run_resumed");
  const advisorConsults = events.filter((e) => e.event === "advisor_consult");

  // Findings by severity: from `finding` events carrying a `severity` field.
  const findingEvents = events.filter((e) => e.event === "finding");
  let findingsBySeverity = { recorded: false, note: "no finding events recorded" };
  if (findingEvents.length) {
    const bySev = {};
    for (const f of findingEvents) {
      const sev = f.severity || "unspecified";
      bySev[sev] = (bySev[sev] || 0) + 1;
    }
    findingsBySeverity = { recorded: true, total: findingEvents.length, by_severity: bySev };
  }

  // Pass/fail per phase from stage-status.json (done => pass).
  let phasePassFail = { recorded: false, note: "stage-status.json not provided" };
  if (stageStatus && stageStatus.stages) {
    const map = {};
    for (const [stage, s] of Object.entries(stageStatus.stages)) {
      map[stage] = s.status === "done" ? "pass"
        : s.status === "blocked" ? "blocked"
        : s.status; // pending | in_progress
    }
    phasePassFail = { recorded: true, phases: map };
  }

  return {
    gates_total: gatesRaised.length,
    gates_answered: gatesAnswered.length,
    autofix_rounds: autofix.length
      ? autofix.length
      : { recorded: false, note: "no autofix_round/recheck_round events recorded" },
    commits: commits.length
      ? commits.length
      : { recorded: false, note: "no commit events recorded" },
    api_drops: apiDrops.length,
    resumes: resumes.length,
    advisor_consults: advisorConsults.length
      ? advisorConsults.length
      : { recorded: false, note: "no advisor_consult events recorded" },
    findings_by_severity: findingsBySeverity,
    phase_pass_fail: phasePassFail,
  };
}

// ---------------------------------------------------------------------------
// buildBenchmark — assemble the full per-run benchmark object from raw inputs.
// Pure: takes text + parsed run metadata, returns the object. No file I/O.
// ---------------------------------------------------------------------------

export const BENCHMARK_SCHEMA = "detent-benchmark-v1";

export function buildBenchmark({ eventsText, tokensText, run = {}, stageStatus = null, rates = DEFAULT_RATES, checkpoint = null }) {
  const events = parseJsonl(eventsText);
  const wall = computeWallClock(events);
  const { phases, orphan_ends } = computePhaseTimings(events);
  const gate = computeGateWait(events);
  const asyncWait = computeAsyncWait(events);
  // Price the run as of when it RAN, not when the benchmark is recomputed.
  // Re-running an old benchmark after a promotion lapses would otherwise
  // reprice the whole run at today's list rate, so the reported cost would stop
  // describing what that run actually incurred. tokens.jsonl rows carry no
  // timestamps, so the run's own event timeline is the best available clock.
  const runAtMs = Date.parse(wall.last_ts || wall.first_ts || "");
  const tokens = computeTokens(tokensText, rates,
    Number.isFinite(runAtMs) ? { asOfMs: runAtMs } : {});
  const metrics = computeOtherMetrics(events, stageStatus);

  const effective = wall.total_ms - gate.total_ms - asyncWait.total_ms;
  const humanTouchRatio = wall.total_ms > 0 ? round(gate.total_ms / wall.total_ms) : 0;

  return {
    schema: BENCHMARK_SCHEMA,
    run_id: run.run_id || null,
    ticket_ref: run.ticket_ref || null,
    repo: run.repo || null,
    generated_at: isoOf(Date.now()),
    event_count: events.length,

    // A checkpoint benchmark is PARTIAL: it measures the run only up to the
    // event window seen so far (the last event is the gate/park that stopped
    // the run), so the impending human/async wait is NOT yet counted. A final
    // (non-checkpoint) benchmark is authoritative for the whole run.
    partial: !!checkpoint,
    ...(checkpoint
      ? { checkpoint: { ...checkpoint, covers_through_ts: wall.last_ts } }
      : {}),

    wall_clock_ms: wall.total_ms,
    wall_clock_human: wall.total_human,
    first_event_ts: wall.first_ts,
    last_event_ts: wall.last_ts,

    human_gate_wait_ms: gate.total_ms,
    async_external_wait_ms: asyncWait.total_ms,
    effective_agentic_time_ms: effective,
    effective_agentic_time_human: humanMs(effective),
    human_touch_ratio: humanTouchRatio,

    phases,
    ...(orphan_ends.length ? { phase_warnings: { orphan_ends } } : {}),
    gates: gate,
    async_external: asyncWait,
    tokens,
    metrics,

    data_sources: {
      tokens_recorded: tokens.recorded,
      async_events_present: asyncWait.count > 0 || asyncWait.unmatched_requests.length > 0,
      gate_events_present: gate.count > 0 || gate.open_unanswered.length > 0,
      stage_status_present: !!(stageStatus && stageStatus.stages),
    },
  };
}

// ---------------------------------------------------------------------------
// ledgerLine — the one-line committed summary appended to benchmarks/ledger.jsonl.
// ---------------------------------------------------------------------------

export function ledgerLine(b) {
  return {
    ts: b.generated_at,
    run_id: b.run_id,
    ticket_ref: b.ticket_ref,
    ...(b.partial
      ? {
          partial: true,
          checkpoint_reason: b.checkpoint?.reason ?? null,
          checkpoint_sequence: b.checkpoint?.sequence ?? null,
        }
      : {}),
    wall_clock_ms: b.wall_clock_ms,
    human_gate_wait_ms: b.human_gate_wait_ms,
    async_external_wait_ms: b.async_external_wait_ms,
    effective_agentic_time_ms: b.effective_agentic_time_ms,
    human_touch_ratio: b.human_touch_ratio,
    phases: Object.keys(b.phases).length,
    gates: b.gates.count,
    // Additive field — schema-less bench lines tolerate this; readers filter
    // on presence. Count only (0 when unrecorded), same normalization as
    // `gates` above — the honesty-wrapped {recorded:false} shape lives on
    // metrics.advisor_consults itself, not on this ledger summary.
    advisor_consults: typeof b.metrics.advisor_consults === "number" ? b.metrics.advisor_consults : 0,
    tokens: b.tokens.recorded
      ? {
          recorded: true,
          input: b.tokens.input_tokens,
          output: b.tokens.output_tokens,
          models: b.tokens.models,
          estimated_cost_usd: b.tokens.estimated_cost_usd,
        }
      : { recorded: false },
  };
}

// ---------------------------------------------------------------------------
// runBenchmark — the file-touching entry point used by the CLI and by
// `engine bench`. Reads a run directory, writes <run>/benchmark.json, appends
// one line to <detent-root>/benchmarks/ledger.jsonl. Returns the pieces.
// ---------------------------------------------------------------------------

function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, p);
}

export function runBenchmark(runDir, opts = {}) {
  runDir = resolve(runDir);
  const runJsonPath = join(runDir, "run.json");
  if (!existsSync(runJsonPath)) {
    throw new Error(`bench: no run.json in ${runDir} — is this a run directory?`);
  }
  const run = JSON.parse(readFileSync(runJsonPath, "utf8"));
  const eventsText = readIfExists(join(runDir, "events.jsonl"));
  if (eventsText == null) {
    throw new Error(`bench: no events.jsonl in ${runDir} — nothing to derive timings from`);
  }
  const tokensText = readIfExists(join(runDir, "tokens.jsonl"));
  const statusText = readIfExists(join(runDir, "stage-status.json"));
  const stageStatus = statusText ? JSON.parse(statusText) : null;

  let rates = DEFAULT_RATES;
  if (opts.ratesPath) {
    rates = JSON.parse(readFileSync(resolve(opts.ratesPath), "utf8"));
  }

  const benchmark = buildBenchmark({ eventsText, tokensText, run, stageStatus, rates });

  const benchmarkPath = join(runDir, "benchmark.json");
  writeJsonAtomic(benchmarkPath, benchmark);

  // Ledger lives at <detent-root>/benchmarks/ledger.jsonl. Root defaults to
  // the clone two levels above .sdlc/<run> (i.e. runDir/../..).
  const line = ledgerLine(benchmark);
  const ledgerPath = appendLedger(runDir, opts.detentRoot, line);

  return { benchmark, benchmarkPath, ledgerPath, ledgerLine: line };
}

// Ledger lives at <detent-root>/benchmarks/ledger.jsonl. Root defaults to the
// clone two levels above .sdlc/<run> (i.e. runDir/../..). Shared by the final
// and checkpoint writers so both land in the one committed ledger.
function appendLedger(runDir, detentRootOpt, line) {
  const detentRoot = detentRootOpt ? resolve(detentRootOpt) : resolve(runDir, "..", "..");
  const benchmarksDir = join(detentRoot, "benchmarks");
  mkdirSync(benchmarksDir, { recursive: true });
  const ledgerPath = join(benchmarksDir, "ledger.jsonl");
  appendFileSync(ledgerPath, JSON.stringify(line) + "\n");
  return ledgerPath;
}

// ---------------------------------------------------------------------------
// checkpointBenchmark — write a PARTIAL benchmark at a park boundary (a run
// about to block on a human gate or an async-external sign-off). The whole
// point: a slow human/async response can take hours or days, and we must have
// the benchmark of the agentic work done SO FAR in place before that wait
// starts — never only at run completion. So this is called the instant a run
// parks, and it:
//   - writes <run>/benchmark.json          (latest snapshot; one always exists)
//   - appends <run>/benchmark-checkpoints.jsonl  (the growing set of checkpoints
//                                                 for this run — never overwritten)
//   - appends one checkpoint-tagged line to the global benchmarks/ledger.jsonl
// The measured window ends at the last event (the gate/park), so the pending
// wait is not yet counted — computeGateWait/computeAsyncWait already add zero
// for an opened-but-unanswered gate or an unmatched request.
//
// Idempotent under retry: if the newest checkpoint already covers the same gate
// at the same event_count (no new events since), it is skipped rather than
// duplicated — so re-running `engine stage end` on a still-pending gate does
// not spam the set.
// ---------------------------------------------------------------------------

export function checkpointBenchmark(runDir, opts = {}) {
  runDir = resolve(runDir);
  const runJsonPath = join(runDir, "run.json");
  if (!existsSync(runJsonPath)) {
    throw new Error(`bench: no run.json in ${runDir} — is this a run directory?`);
  }
  const run = JSON.parse(readFileSync(runJsonPath, "utf8"));
  const eventsText = readIfExists(join(runDir, "events.jsonl"));
  if (eventsText == null) {
    throw new Error(`bench: no events.jsonl in ${runDir} — nothing to checkpoint`);
  }
  const tokensText = readIfExists(join(runDir, "tokens.jsonl"));
  const statusText = readIfExists(join(runDir, "stage-status.json"));
  const stageStatus = statusText ? JSON.parse(statusText) : null;

  let rates = DEFAULT_RATES;
  if (opts.ratesPath) {
    rates = JSON.parse(readFileSync(resolve(opts.ratesPath), "utf8"));
  }

  const gateId = opts.gateId ?? null;
  const reason = opts.reason ?? "park";

  // Prior checkpoints for this run — for sequencing and retry-dedup.
  const checkpointsPath = join(runDir, "benchmark-checkpoints.jsonl");
  const priorText = readIfExists(checkpointsPath);
  const prior = priorText ? parseJsonl(priorText) : [];
  const eventCount = parseJsonl(eventsText).length;
  const last = prior[prior.length - 1];
  if (last && last.event_count === eventCount && (last.checkpoint?.gate_id ?? null) === gateId) {
    return {
      skipped: true,
      reason: "no new events since the last checkpoint for this gate",
      benchmarkPath: join(runDir, "benchmark.json"),
      checkpointsPath,
      sequence: prior.length - 1,
    };
  }

  const checkpoint = { reason, gate_id: gateId, sequence: prior.length };
  const benchmark = buildBenchmark({ eventsText, tokensText, run, stageStatus, rates, checkpoint });

  const benchmarkPath = join(runDir, "benchmark.json");
  writeJsonAtomic(benchmarkPath, benchmark);

  // Append the FULL benchmark (compact) to the per-run checkpoint set.
  appendFileSync(checkpointsPath, JSON.stringify(benchmark) + "\n");

  const line = ledgerLine(benchmark);
  const ledgerPath = appendLedger(runDir, opts.detentRoot, line);

  return { benchmark, benchmarkPath, checkpointsPath, ledgerPath, ledgerLine: line, sequence: checkpoint.sequence };
}

// ---------------------------------------------------------------------------
// CLI: node bench.mjs <run-dir> [--rates <file>] [--detent-root <dir>]
//                     [--checkpoint [--reason <str>] [--gate <id>]]
// ---------------------------------------------------------------------------

function cli(argv) {
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
  const runDir = positional[0];
  if (!runDir) {
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: "bench requires a run directory",
      next_step: "node engine/bench/bench.mjs <run-dir> [--rates <json>] [--detent-root <dir>]",
    }) + "\n");
    process.exit(2);
  }
  const common = {
    ratesPath: flags.rates && flags.rates !== true ? flags.rates : undefined,
    detentRoot: flags["detent-root"] && flags["detent-root"] !== true ? flags["detent-root"] : undefined,
  };
  try {
    if (flags.checkpoint) {
      const res = checkpointBenchmark(runDir, {
        ...common,
        reason: flags.reason && flags.reason !== true ? flags.reason : "park",
        gateId: flags.gate && flags.gate !== true ? flags.gate : null,
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        checkpoint: true,
        ...(res.skipped
          ? { skipped: true, reason: res.reason }
          : {
              run_id: res.benchmark.run_id,
              sequence: res.sequence,
              benchmark_path: res.benchmarkPath,
              checkpoints_path: res.checkpointsPath,
              ledger_path: res.ledgerPath,
              summary: res.ledgerLine,
            }),
        next_step: res.skipped
          ? "no new events since the last checkpoint — nothing written"
          : `partial benchmark written to ${res.benchmarkPath}; appended ${res.checkpointsPath} + ${res.ledgerPath}`,
      }) + "\n");
      return;
    }
    const { benchmark, benchmarkPath, ledgerPath } = runBenchmark(runDir, common);
    process.stdout.write(JSON.stringify({
      ok: true,
      run_id: benchmark.run_id,
      benchmark_path: benchmarkPath,
      ledger_path: ledgerPath,
      summary: ledgerLine(benchmark),
      next_step: `benchmark written to ${benchmarkPath}; summary appended to ${ledgerPath}`,
    }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: e.message,
      next_step: "fix the input above and re-run",
    }) + "\n");
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  cli(process.argv.slice(2));
}
