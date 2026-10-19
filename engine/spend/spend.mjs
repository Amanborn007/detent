/**
 * spend — measure what Claude Code actually cost, from the local transcripts.
 *
 * WHY THIS IS A COMMITTED TOOL AND NOT A SCRATCH SCRIPT
 *   Every ad-hoc version of this analysis got a materially different answer,
 *   and each wrong answer changed which fixes looked worth building:
 *
 *     - Pricing opus at $15/$75 (a stale table) overstated spend ~3x.
 *     - Summing streamed duplicate records double-counted most turns.
 *     - Globbing `projects/*​/*.jsonl` matched only the top-level transcript
 *       files, silently excluding EVERY sub-agent transcript, which live one level
 *       deeper under `<session-uuid>/subagents/`. That is what made sub-agent
 *       spend look like zero and produced a total well under the billed figure.
 *
 *   All three failures were invisible in the output: each produced a plausible
 *   number with no signal that it was wrong. So this module reports its own
 *   coverage (`files_scanned`, `records_deduped`, `unpriced`) alongside every
 *   figure, and the traversal is recursive by construction rather than by a
 *   glob depth that has to be remembered.
 *
 * WHAT IT MEASURES
 *   Local transcripts are a LOWER BOUND on the invoice, not a substitute for
 *   it: they cover what this machine recorded. Reconcile against the usage
 *   console before treating any figure as authoritative — a gap means a whole
 *   category of traffic is unrecorded here, which is exactly the failure the
 *   `subagents/` miss represented.
 *
 * PURE. Reads transcripts; writes nothing. Node >= 18. Zero dependencies.
 */
"use strict";

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RATES, effectiveRate, rateExpiresMs } from "../bench/bench.mjs";

// v2: dedupe became scan-global. v1 deduped per file, which double-counted
// every record a resumed session copied forward, a large share of main-thread
// records. That changes what counts as a turn, so
// v1 and v2 lines are NOT comparable and `compareTracking` refuses to mix them.
export const SPEND_SCHEMA = "detent-spend-v2";

/**
 * Map a wire model id (`claude-opus-4-8`) onto a rate-table key (`opus`).
 * Longest key first so `fable` never loses to a shorter substring match.
 * Returns null rather than guessing — an unpriced model is reported, never
 * silently valued at zero.
 */
export function rateKeyFor(model, rates = DEFAULT_RATES) {
  const m = String(model || "").toLowerCase();
  const keys = Object.keys(rates).filter((k) => !k.startsWith("_")).sort((a, b) => b.length - a.length);
  return keys.find((k) => m.includes(k)) ?? null;
}

/**
 * Rate rows whose promotional pricing has lapsed, as of `asOfMs`.
 *
 * `_expires` is only worth carrying if something reads it. A rate table that
 * documents an expiry nothing enforces is the same phantom-knob defect as a
 * documented flag no code consults — it drifts silently, which is the one
 * failure mode this module exists to eliminate.
 */
export function expiredRates(rates = DEFAULT_RATES, asOfMs = Date.now()) {
  const out = [];
  for (const [k, v] of Object.entries(rates)) {
    if (k.startsWith("_") || !v || typeof v !== "object" || !v._expires) continue;
    // Date maths lives in bench.mjs, which owns the rate table.
    const t = rateExpiresMs(v);
    if (!Number.isFinite(t)) {
      out.push({ model: k, expires: v._expires, reason: "unparseable _expires" });
      continue;
    }
    if (asOfMs > t) {
      out.push({ model: k, expires: v._expires, reason: "promotional pricing has lapsed — this row now understates cost" });
    }
  }
  return out;
}

/**
 * Recursive walk. The whole point: no depth assumption — sub-agent transcripts
 * nest under `<session>/subagents/`, and a fixed-depth glob silently drops them.
 *
 * `stats.dirsUnreadable` is incremented rather than thrown on: one unreadable
 * subtree should not abort a whole scan, but it must not vanish either, since a
 * quietly-shrunken total is the exact failure this module exists to prevent.
 * Symlinked directories are not followed (cycle safety) and count as skipped.
 */
export function findTranscripts(root, stats = null) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      if (stats) stats.dirsUnreadable = (stats.dirsUnreadable || 0) + 1;
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isSymbolicLink()) {
        // Not followed (cycle safety). Counted separately from unreadable
        // directories — a counter named for one thing must not tally another,
        // or the first person debugging a short scan is sent the wrong way.
        if (stats) stats.symlinksSkipped = (stats.symlinksSkipped || 0) + 1;
      } else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  return out;
}

/**
 * A transcript under a `subagents/` path segment is sub-agent traffic.
 *
 * The `isSidechain` field on the record cannot be used for this: in main-thread
 * files it is uniformly `false`, so reading it alone concludes there are no
 * sub-agents at all. Path is the reliable signal.
 */
export function isSubagentPath(path) {
  return path.split("/").includes("subagents");
}

/**
 * Cost of one usage block, in USD.
 *
 * Cache WRITES are priced by TTL when the transcript breaks them out
 * (`usage.cache_creation.ephemeral_5m_input_tokens` / `..._1h_...`): the 5-minute
 * tier bills 1.25x input, the 1-hour tier 2.0x. On the corpus this was built
 * against the split is 100% 1h, so the flat 2.0x fallback happens to be right —
 * but only happens to be. Pricing the breakdown when it exists means the first
 * 5m traffic to appear is costed correctly instead of 60% high and silent.
 */
export function costOf(usage, rate) {
  const i = Number(usage.input_tokens) || 0;
  const o = Number(usage.output_tokens) || 0;
  const cwTotal = Number(usage.cache_creation_input_tokens) || 0;
  const cr = Number(usage.cache_read_input_tokens) || 0;
  const rRead = typeof rate.cache_read === "number" ? rate.cache_read : rate.input * 0.1;
  const rWrite1h = typeof rate.cache_write === "number" ? rate.cache_write : rate.input * 2.0;
  // 5m is 1.25x input; derive it from the 1h rate so a rate table that only
  // carries cache_write stays internally consistent (1h is 2.0x, so 5m is
  // 0.625 of it).
  const rWrite5m = typeof rate.cache_write_5m === "number" ? rate.cache_write_5m : rWrite1h * 0.625;

  const bd = usage.cache_creation;
  let cw5m = 0, cw1h = 0, ttlKnown = false, ttlRemainder = 0;
  if (bd && typeof bd === "object") {
    const a = Number(bd.ephemeral_5m_input_tokens) || 0;
    const b = Number(bd.ephemeral_1h_input_tokens) || 0;
    if (a || b) { cw5m = a; cw1h = b; ttlKnown = true; }
  }
  if (!ttlKnown) {
    cw1h = cwTotal; // no breakdown: assume 1h, the conservative tier
  } else if (cwTotal > cw5m + cw1h) {
    // A breakdown that does not sum to the total means a TTL tier this code does
    // not know about. Trusting the buckets alone would drop the difference from
    // both the cost and the coverage while still reporting full confidence —
    // tokens vanishing silently is the one thing this module may not do. Charge
    // the remainder at the conservative (1h) rate and surface it.
    ttlRemainder = cwTotal - (cw5m + cw1h);
    cw1h += ttlRemainder;
  }

  return {
    cost: (i * rate.input + o * rate.output + cr * rRead + cw5m * rWrite5m + cw1h * rWrite1h) / 1e6,
    input: i, output: o, cache_read: cr,
    cache_write: cw5m + cw1h,
    cache_write_5m: cw5m, cache_write_1h: cw1h,
    // `ttl_known` is only true when the buckets ACCOUNT for the total. A partial
    // breakdown is partial knowledge, and must not read as full confidence.
    ttl_known: ttlKnown && ttlRemainder === 0,
    ttl_remainder: ttlRemainder,
  };
}

function blank() {
  return { cost: 0, turns: 0, input: 0, output: 0, cache_write: 0, cache_read: 0 };
}

function add(acc, c) {
  acc.cost += c.cost; acc.turns += 1;
  acc.input += c.input; acc.output += c.output;
  acc.cache_write += c.cache_write; acc.cache_read += c.cache_read;
}

/**
 * Scan transcripts and aggregate.
 *
 * `sinceMs` bounds by RECORD timestamp, never by file mtime: one long-lived
 * file spans many days, so an mtime filter both drops old-but-in-window records
 * and admits out-of-window ones.
 */
/**
 * Swap any lapsed promotional row for its `_list` fallback.
 *
 * Reporting an expired rate while still pricing with it is worse than not
 * checking: the figure is wrong, the warning is easy to miss, and `--record`
 * would persist the understated number into the trend series. A row that
 * carries `_list` is corrected automatically; one that does not is left in
 * place and stays in `expired_rates`, where the CLI refuses to record it.
 */
export function applyExpiry(rates = DEFAULT_RATES, asOfMs = Date.now()) {
  const lapsed = expiredRates(rates, asOfMs);
  if (lapsed.length === 0) return { rates, corrected: [], unresolved: [] };
  const out = { ...rates };
  const corrected = [], unresolved = [];
  for (const l of lapsed) {
    const row = rates[l.model];
    if (row && row._list && typeof row._list === "object") {
      out[l.model] = { ...row._list };
      corrected.push({ model: l.model, expires: l.expires, now_using: "_list" });
    } else {
      unresolved.push(l);
    }
  }
  return { rates: out, corrected, unresolved };
}

export function analyzeSpend({
  root, sinceMs = null, rates = DEFAULT_RATES, asOfMs = null,
} = {}) {
  const nowMs = asOfMs ?? Date.now();
  // Cost priced under each pricing regime, so a window can say not just THAT it
  // straddled an expiry but how much of it fell on each side.
  const regimeCost = { promo: 0, list: 0 };
  // Rate selection happens PER RECORD, against that record's own timestamp —
  // see effectiveRate() in bench.mjs. Swapping the table once before the scan
  // repriced history: a 30-day window straddling an expiry charged the
  // pre-expiry traffic at post-expiry prices, which is the stale-rate bug in a
  // new costume rather than a fix for it.
  const correctedModels = new Set();
  const walkStats = { dirsUnreadable: 0, symlinksSkipped: 0 };
  const files = findTranscripts(root, walkStats);
  const dirsUnreadable = walkStats.dirsUnreadable;
  const symlinksSkipped = walkStats.symlinksSkipped || 0;
  const byOrigin = { main: blank(), subagent: blank() };
  const byModel = {};
  const byDay = {};
  const unpriced = {};
  let recordsDeduped = 0, recordsDedupedCrossFile = 0, recordsPriced = 0, filesWithUsage = 0;
  let filesUnreadable = 0, linesUnparseable = 0, recordsNoTimestamp = 0;
  let cacheWrite5m = 0, cacheWrite1h = 0, recordsTtlUnknown = 0, ttlRemainderTotal = 0;

  // Dedupe is SCAN-GLOBAL, not per file. Resuming a session writes a fresh
  // transcript AND copies the prior records into it with their message ids
  // intact, so the same API call appears in several files, a large share of
  // main-thread records. Deduping per
  // file re-creates, one level up, exactly the double-count this module exists
  // to prevent, and it biases the headline ratios: it inflates main-thread
  // turns (which are the resumed ones) while sub-agent files, which are never
  // resumed, are untouched.
  // Dedupe is SCAN-GLOBAL, not per file. Resuming a session writes a fresh
  // transcript AND copies the prior records into it with their message ids
  // intact, so the same API call appears in several files. Deduping per file
  // re-creates, one level up, exactly the double-count this module exists to
  // prevent, and it biases the headline ratios: only main-thread files are ever
  // resumed, so it inflates main-thread turns while sub-agents are untouched.
  //
  // WHICH copy wins matters just as much. One API message is written as several
  // records sharing an id as it streams, and the EARLY ones carry a partial
  // `output_tokens` — only the record with a non-null `stop_reason` has the
  // final count. Keeping the first record understated sub-agent output by 10x
  // (1.6M tokens against 19.3M) and skewed the very main-vs-sub-agent ratio
  // this module exists to measure. So candidates are collected and the most
  // COMPLETE record for each id wins, rather than the first one seen.
  const byId = new Map();
  let noIdSeq = 0;

  /** A record is better if it finished; ties break on the larger output count. */
  function better(a, b) {
    if (!b) return true;
    const af = a.stopped ? 1 : 0, bf = b.stopped ? 1 : 0;
    if (af !== bf) return af > bf;
    return (Number(a.usage.output_tokens) || 0) > (Number(b.usage.output_tokens) || 0);
  }

  for (const path of files) {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      filesUnreadable += 1;
      continue;
    }
    const origin = isSubagentPath(path) ? "subagent" : "main";
    let sawInWindow = false;
    for (const line of raw.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        linesUnparseable += 1;
        continue;
      }
      if (d.type !== "assistant") continue;
      const msg = d.message || {};
      const usage = msg.usage;
      if (!usage) continue;

      // Window first: an out-of-window record must not claim an id or land in
      // the unpriced tally, or `coverage` describes traffic nobody asked about.
      let day = null;
      if (d.timestamp) {
        const t = Date.parse(d.timestamp);
        if (Number.isFinite(t)) {
          if (sinceMs !== null && t < sinceMs) continue;
          day = new Date(t).toISOString().slice(0, 10);
        } else {
          recordsNoTimestamp += 1;
          if (sinceMs !== null) continue; // fail CLOSED: unknown date is in no window
        }
      } else {
        recordsNoTimestamp += 1;
        if (sinceMs !== null) continue;
      }

      sawInWindow = true;
      const key = msg.id || `__noid__${noIdSeq++}`;
      const tsMs = d.timestamp ? Date.parse(d.timestamp) : NaN;
      const cand = { origin, model: msg.model, usage, day, file: path,
                     tsMs: Number.isFinite(tsMs) ? tsMs : null,
                     stopped: msg.stop_reason != null };
      const prev = byId.get(key);
      if (prev) {
        recordsDeduped += 1;
        if (prev.file !== path) recordsDedupedCrossFile += 1;
        if (better(cand, prev)) byId.set(key, { ...cand, file: prev.file, origin: prev.origin });
      } else {
        byId.set(key, cand);
      }
    }
    if (sawInWindow) filesWithUsage += 1;
  }

  // Cost of each priced record, kept alongside its session and timestamp so
  // resume gaps can be derived below.
  const priced = [];

  for (const rec of byId.values()) {
    const rk = rateKeyFor(rec.model, rates);
    if (!rk) {
      // Record how much BILLABLE traffic each unpriced model hides. The count
      // alone cannot distinguish a harmless placeholder from a real model whose
      // rate is missing: `<synthetic>` appears 126 times on this machine with
      // zero tokens, while an unrecognised model name would silently drop real
      // spend and make the total look like an improvement.
      const u = rec.usage || {};
      const billable = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
        + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
      const key = rec.model || "(none)";
      (unpriced[key] ||= { records: 0, billable_tokens: 0 });
      unpriced[key].records += 1;
      unpriced[key].billable_tokens += billable;
      continue;
    }
    // An undated record cannot be placed relative to an expiry, so it is priced
    // as of the scan — the only defensible choice, and the count of such records
    // is already reported as `records_no_timestamp`.
    const rawRate = rates[rk];
    const rate = effectiveRate(rawRate, rec.tsMs ?? nowMs);
    if (rate !== rawRate) correctedModels.add(rec.model);
    const c = costOf(rec.usage, rate);
    // ONLY rows that can expire participate in the regime. Opus and Haiku carry
    // no `_expires`, so they always take rawRate — counting that as "promo" made
    // every window containing them "mixed" the moment Sonnet lapsed, and a mixed
    // window is comparable to nothing. The tracking series would have gone
    // permanently silent from 2026-09-01, which is the opposite of the point.
    if (rateExpiresMs(rawRate) !== null) {
      regimeCost[rate === rawRate ? "promo" : "list"] += c.cost;
    }
    cacheWrite5m += c.cache_write_5m;
    cacheWrite1h += c.cache_write_1h;
    if (!c.ttl_known && c.cache_write > 0) recordsTtlUnknown += 1;
    ttlRemainderTotal += c.ttl_remainder;
    add(byOrigin[rec.origin], c);
    (byModel[rec.model] ||= blank());
    add(byModel[rec.model], c);
    if (rec.day) {
      (byDay[rec.day] ||= { cost: 0, turns: 0 });
      byDay[rec.day].cost += c.cost;
      byDay[rec.day].turns += 1;
    }
    priced.push({ file: rec.file, tsMs: rec.tsMs, origin: rec.origin, cost: c.cost, cacheWrite: c.cache_write });
    recordsPriced += 1;
  }

  // RESUME BUCKETS. A prompt cache expires after roughly an hour, so a turn
  // taken more than that after the previous one in the same session re-uploads
  // the whole conversation. Those turns were 17-25% of spend when first
  // measured, entirely from ~2% of turns — the largest single lever in this
  // analysis, and until now the tool that exists to track spend did not measure
  // it. Gaps are computed WITHIN a session file and for main-thread traffic
  // only: a sub-agent is created and discarded, so it never resumes.
  const bySession = new Map();
  for (const r of priced) {
    if (r.origin !== "main" || !Number.isFinite(r.tsMs)) continue;
    (bySession.get(r.file) ?? bySession.set(r.file, []).get(r.file)).push(r);
  }
  const resume = {
    warm: { turns: 0, cost: 0, cache_write: 0 },      // < 5m since the previous turn
    recent: { turns: 0, cost: 0, cache_write: 0 },    // 5m .. 1h
    cold: { turns: 0, cost: 0, cache_write: 0 },      // > 1h — the cache is gone
  };
  for (const rows of bySession.values()) {
    rows.sort((a, b) => a.tsMs - b.tsMs);
    for (let i = 1; i < rows.length; i++) {
      const gapS = (rows[i].tsMs - rows[i - 1].tsMs) / 1000;
      const b = gapS < 300 ? resume.warm : gapS < 3600 ? resume.recent : resume.cold;
      b.turns += 1; b.cost += rows[i].cost; b.cache_write += rows[i].cacheWrite;
    }
  }
  for (const b of Object.values(resume)) {
    b.cost = round2(b.cost);
    b.mean_cost_usd = b.turns ? round4(b.cost / b.turns) : 0;
    b.mean_cache_write = b.turns ? Math.round(b.cache_write / b.turns) : 0;
    delete b.cache_write;
  }
  const mainCost = byOrigin.main.cost;
  resume.cold_share_of_main = mainCost > 0 ? round4(resume.cold.cost / mainCost) : 0;
  // How much the cold turns would have cost at the warm mean — the part that is
  // recoverable by not resuming, as distinct from work that had to happen anyway.
  resume.cold_excess_usd = round2(
    Math.max(0, resume.cold.cost - resume.cold.turns * resume.warm.mean_cost_usd));

  const total = byOrigin.main.cost + byOrigin.subagent.cost;
  const days = Object.keys(byDay).sort();
  return {
    schema: SPEND_SCHEMA,
    rate_table_version: rates._version || "unknown",
    // WHICH pricing regime produced these numbers, not merely whether an expiry
    // was involved. A boolean "+list-after-expiry" marker collapsed a window
    // with one list-priced day and a window with thirty into the same value, so
    // the two compared as equivalent and a price change could be read as an
    // effect of the intervention. `mixed` is never comparable to anything —
    // a blended price belongs to its exact date span and to nothing else.
    // "none" means no expiring-rate traffic in this window at all — a genuine
    // third state, not a synonym for "promo". Collapsing it into promo is what
    // caused the permanent-mixed bug.
    rate_regime: regimeCost.promo > 0 && regimeCost.list > 0 ? "mixed"
      : regimeCost.list > 0 ? "list"
      : regimeCost.promo > 0 ? "promo"
      : "none",
    rate_regime_cost_usd: { promo: round2(regimeCost.promo), list: round2(regimeCost.list) },
    // `expired_rates` lists only rows that could NOT be corrected — those are
    // the ones whose figures are still wrong, and the CLI refuses to --record
    // while any remain.
    expired_rates: expiredRates(rates, nowMs).filter((e) => {
      const row = rates[e.model];
      return !(row && row._list && typeof row._list === "object");
    }),
    rates_corrected: [...correctedModels],
    coverage: {
      files_scanned: files.length,
      // Files with at least one record INSIDE the window, not merely any usage.
      files_with_usage: filesWithUsage,
      records_priced: recordsPriced,
      records_deduped: recordsDeduped,
      // How much of the dedupe came from resumed sessions copying records
      // forward. Non-zero here is normal; it being INVISIBLE is what produced
      // a 13% overstatement before.
      records_deduped_cross_file: recordsDedupedCrossFile,
      unpriced_models: unpriced,
      // Only these actually drop spend from the total. A placeholder with no
      // tokens is noise; one of these means the figure is understated.
      unpriced_models_with_traffic: Object.fromEntries(
        Object.entries(unpriced).filter(([, v]) => v.billable_tokens > 0)),
      subagent_files: files.filter(isSubagentPath).length,
      // Non-fatal skips are fine; unlogged skips are how an under-scan hides.
      dirs_unreadable: dirsUnreadable,
      symlinks_skipped: symlinksSkipped,
      files_unreadable: filesUnreadable,
      lines_unparseable: linesUnparseable,
      records_no_timestamp: recordsNoTimestamp,
      cache_write_ttl_mix: { "5m": cacheWrite5m, "1h": cacheWrite1h, unknown_records: recordsTtlUnknown,
        // Non-zero means a TTL tier exists that this code does not model. The
        // tokens are charged conservatively rather than dropped, but the number
        // is a signal to add the tier.
        unaccounted_tokens: ttlRemainderTotal },
    },
    total_cost_usd: total,
    by_origin: byOrigin,
    subagent_share: total > 0 ? byOrigin.subagent.cost / total : 0,
    by_model: byModel,
    by_day: byDay,
    resume,
    active_days: days.length,
    first_day: days[0] ?? null,
    last_day: days[days.length - 1] ?? null,
    cost_per_active_day: days.length ? total / days.length : 0,
    note: "Local transcripts are a LOWER BOUND on the invoice — reconcile against the usage console. A material gap means a category of traffic is unrecorded here.",
  };
}

/**
 * The subset of a scan worth keeping as a time series.
 *
 * Deliberately small and flat: a tracking line is compared against its
 * predecessors months later, so it must stay readable without the code that
 * produced it. `schema` and `rate_table_version` are included precisely because
 * the two things most likely to shift underfoot are what counts as a turn and
 * what a token costs — a series that silently mixes rate tables is worse than
 * no series.
 */
export function trackingLine(result, { ts, window_days, note = null }) {
  const strong = Object.entries(result.by_model)
    .filter(([m]) => /opus|fable/i.test(m))
    .reduce((a, [, v]) => a + v.cost, 0);
  return {
    ts,
    schema: result.schema,
    rate_table_version: result.rate_table_version,
    rate_regime: result.rate_regime,
    window_days,
    total_cost_usd: round2(result.total_cost_usd),
    main_cost_usd: round2(result.by_origin.main.cost),
    subagent_cost_usd: round2(result.by_origin.subagent.cost),
    main_turns: result.by_origin.main.turns,
    subagent_turns: result.by_origin.subagent.turns,
    // The two ratios the interventions are meant to move. Everything else in
    // the series is context for reading these.
    main_cost_per_turn: result.by_origin.main.turns ? round4(result.by_origin.main.cost / result.by_origin.main.turns) : 0,
    subagent_cost_per_turn: result.by_origin.subagent.turns ? round4(result.by_origin.subagent.cost / result.by_origin.subagent.turns) : 0,
    subagent_share: round4(result.subagent_share),
    strong_tier_share: result.total_cost_usd > 0 ? round4(strong / result.total_cost_usd) : 0,
    // The recoverable part of the cold-resume penalty. This is what "end the
    // session instead of resuming it" is worth, and it belongs in the series.
    cold_resume_cost_usd: result.resume ? result.resume.cold.cost : null,
    cold_resume_excess_usd: result.resume ? result.resume.cold_excess_usd : null,
    cold_resume_share_of_main: result.resume ? result.resume.cold_share_of_main : null,
    active_days: result.active_days,
    files_scanned: result.coverage.files_scanned,
    records_priced: result.coverage.records_priced,
    ...(note ? { note } : {}),
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Compare two tracking lines. Returns null when there is no prior line — a
 * first measurement has no trend, and inventing a 0% delta would read as
 * "nothing changed" rather than "nothing to compare".
 */
export function compareTracking(prev, curr) {
  if (!prev) return null;
  const pct = (a, b) => (b === 0 ? null : round4((a - b) / b));
  // Ways a comparison is meaningless, in the order they bite:
  //   schema  — what counts as a turn changed (v1 deduped per file, v2 globally)
  //   rates   — what a token costs changed
  //   window  — different amounts of history
  //   overlap — two runs closer together than the window share most of their
  //             data, so the delta is ~0 and reads as "the change did nothing"
  // Fail CLOSED on a timestamp we cannot read or that runs backwards: an
  // unverifiable gap must not read as a verified one. This is the same lie the
  // ledger-corruption guard exists to prevent, one field down.
  const gapMs = Date.parse(curr.ts) - Date.parse(prev.ts);
  const gapDays = gapMs / 86400000;
  const gapKnown = Number.isFinite(gapDays);
  const reason =
    prev.schema !== curr.schema ? `schema changed ${prev.schema} -> ${curr.schema} (what counts as a turn is different)`
    : prev.rate_table_version !== curr.rate_table_version ? `rate table changed ${prev.rate_table_version} -> ${curr.rate_table_version}`
    // A window that straddles an expiry has a blended price unique to its span,
    // so it is comparable to nothing — not even to another mixed window.
    : (curr.rate_regime === "mixed" || prev.rate_regime === "mixed")
      ? `a window spans a pricing change (${prev.rate_regime} -> ${curr.rate_regime}); a blended price is not comparable to any other span`
    // An ABSENT regime is unknown, not benign: a line written before the field
    // existed could sit on either side of a price change, so comparing it would
    // be a guess. The committed baselines were migrated rather than exempted.
    : (!prev.rate_regime || !curr.rate_regime)
      ? `a line has no rate_regime (${prev.rate_regime || "absent"} -> ${curr.rate_regime || "absent"}); which prices produced it is unknown, so the comparison would be a guess`
    // Only a promo-vs-list clash is a real price difference. "none" (no
    // expiring-rate traffic) clashes with nothing: the table in force was the
    // same, so a differing usage mix is not a pricing change.
    : (prev.rate_regime === "promo" && curr.rate_regime === "list") ||
      (prev.rate_regime === "list" && curr.rate_regime === "promo")
      ? `pricing regime changed ${prev.rate_regime} -> ${curr.rate_regime}`
    : prev.window_days !== curr.window_days ? `window changed ${prev.window_days}d -> ${curr.window_days}d`
    : !gapKnown ? `cannot read the gap between ${prev.ts} and ${curr.ts} — refusing to call an unverifiable comparison sound`
    : gapDays < 0 ? `ledger is out of order: ${curr.ts} predates ${prev.ts} by ${round2(Math.abs(gapDays))}d`
    : gapDays < curr.window_days ? `only ${round2(gapDays)}d apart on a ${curr.window_days}d window — the samples mostly overlap, so a near-zero delta means nothing`
    : null;
  return {
    since: prev.ts,
    comparable: reason === null,
    incomparable_reason: reason,
    // _pct entries are fractional change; _pp entries are absolute point moves.
    total_cost_usd_pct: pct(curr.total_cost_usd, prev.total_cost_usd),
    main_cost_per_turn_pct: pct(curr.main_cost_per_turn, prev.main_cost_per_turn),
    subagent_share_pp: round4(curr.subagent_share - prev.subagent_share),
    strong_tier_share_pp: round4(curr.strong_tier_share - prev.strong_tier_share),
  };
}
