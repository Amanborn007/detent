// Unit tests for the spend module. Zero dependencies (node:test).
//
// Each test here pins one of the three bugs that produced a wrong answer in an
// ad-hoc version of this analysis. All three were silent: they returned a
// plausible number with no signal it was wrong, which is why they get tests
// rather than a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeSpend, findTranscripts, isSubagentPath, rateKeyFor, costOf, SPEND_SCHEMA,
  trackingLine, compareTracking, expiredRates, applyExpiry,
} from "../spend.mjs";

const RATES = {
  _version: "test",
  opus: { input: 10, output: 100, cache_write: 20, cache_read: 1 },
  sonnet: { input: 1, output: 10, cache_write: 2, cache_read: 0.1 },
};

function turn(model, usage, { ts = "2026-08-01T00:00:00Z", id = null } = {}) {
  return JSON.stringify({
    type: "assistant", timestamp: ts,
    message: { id, model, usage },
  });
}

function mkroot(files) {
  const root = mkdtempSync(join(tmpdir(), "spend-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

// --- BUG 1: glob depth silently excluded every sub-agent transcript --------

test("traversal is recursive — sub-agent transcripts nest one level deeper", () => {
  const root = mkroot({
    "proj/main.jsonl": "",
    "proj/<sid>/subagents/a.jsonl": "",
    "proj/<sid>/subagents/workflows/wf_1/b.jsonl": "",
  });
  const found = findTranscripts(root);
  assert.equal(found.length, 3, "a depth-limited walk would miss the nested ones");
});

test("sub-agent traffic is identified by path, not by the isSidechain field", () => {
  assert.equal(isSubagentPath("/x/proj/abc/subagents/f.jsonl"), true);
  assert.equal(isSubagentPath("/x/proj/abc/subagents/workflows/wf_1/f.jsonl"), true);
  assert.equal(isSubagentPath("/x/proj/f.jsonl"), false);
  // isSidechain is uniformly false in main-thread files, so reading it alone
  // concludes there are no sub-agents at all.
  assert.equal(isSubagentPath("/x/subagents-not-a-dir.jsonl"), false);
});

test("sub-agent spend is attributed separately and counted in the total", () => {
  const u = { input: 0, output: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1e6 };
  const root = mkroot({
    "p/main.jsonl": turn("claude-opus-5", u, { id: "m1" }),
    "p/s1/subagents/a.jsonl": turn("claude-opus-5", u, { id: "s1" }),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.by_origin.main.cost, 1);
  assert.equal(r.by_origin.subagent.cost, 1);
  assert.equal(r.total_cost_usd, 2);
  assert.equal(r.subagent_share, 0.5);
  assert.equal(r.coverage.subagent_files, 1);
});

// --- BUG 2: streamed duplicate records were summed ------------------------

test("repeated message ids within a file are counted once", () => {
  const u = { input: 0, output: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1e6 };
  const root = mkroot({
    "p/main.jsonl": [turn("claude-opus-5", u, { id: "dup" }),
                     turn("claude-opus-5", u, { id: "dup" }),
                     turn("claude-opus-5", u, { id: "dup" })].join("\n"),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.total_cost_usd, 1, "3 copies of one reply must bill once");
  assert.equal(r.coverage.records_deduped, 2);
});

test("the same id in two different files is ONE call — resume copies records forward", () => {
  // CORRECTED. This test previously asserted the opposite, on the assumption
  // that "resume writes a fresh file" meant fresh records. It does not: resume
  // copies the prior records into the new file with their message ids intact.
  // On a real corpus a double-digit share of records share an id with a record
  // in a different file, and treating them as distinct overstated spend.
  const u = { input: 0, output: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1e6 };
  const root = mkroot({
    "p/a.jsonl": turn("claude-opus-5", u, { id: "x" }),
    "p/b.jsonl": turn("claude-opus-5", u, { id: "x" }),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.total_cost_usd, 1);
  assert.equal(r.coverage.records_deduped_cross_file, 1,
    "cross-file overlap must be COUNTED, not merely absent — invisibility is what hid the 13% error");
});

// --- BUG 3: a stale rate table overstated spend ~3x -----------------------

test("model ids map to rate keys longest-first so fable never loses to a substring", () => {
  const rates = { _version: "t", opus: {}, fable: {}, sonnet: {} };
  assert.equal(rateKeyFor("claude-opus-4-8", rates), "opus");
  assert.equal(rateKeyFor("claude-fable-5", rates), "fable");
  assert.equal(rateKeyFor("claude-sonnet-5", rates), "sonnet");
});

test("an unknown model is reported with the traffic it hides, never priced at zero", () => {
  // A bare count cannot tell a harmless placeholder from a real model whose rate
  // is missing — and only the latter drops spend from the total.
  const root = mkroot({
    "p/a.jsonl": turn("mystery-model-9", { input_tokens: 5, output_tokens: 5 }, { id: "z" }),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.total_cost_usd, 0);
  assert.deepEqual(r.coverage.unpriced_models, { "mystery-model-9": { records: 1, billable_tokens: 10 } });
  assert.deepEqual(Object.keys(r.coverage.unpriced_models_with_traffic), ["mystery-model-9"]);
});

test("an unpriced model carrying NO tokens drops nothing and is not flagged", () => {
  // `<synthetic>` appears on real transcripts with zero tokens.
  // Refusing on it would block recording forever.
  const root = mkroot({
    "p/a.jsonl": turn("<synthetic>", { input_tokens: 0, output_tokens: 0 }, { id: "z" }),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.deepEqual(r.coverage.unpriced_models, { "<synthetic>": { records: 1, billable_tokens: 0 } });
  assert.deepEqual(r.coverage.unpriced_models_with_traffic, {},
    "nothing was dropped, so nothing should block recording");
});

test("cost includes cache traffic, which dominates this workload", () => {
  const c = costOf(
    { input: 0, output: 0, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 },
    RATES.opus);
  assert.equal(c.cost, 21); // 1M write @20 + 1M read @1
});

test("a rate row without cache rates falls back to standard multipliers", () => {
  const c = costOf({ cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 },
                   { input: 10, output: 100 });
  assert.equal(c.cost, 21); // read 0.1x=1, write 2.0x=20
});

// --- windowing ------------------------------------------------------------

test("the window bounds by record timestamp, not by file mtime", () => {
  const u = { cache_read_input_tokens: 1e6 };
  const root = mkroot({
    // One long-lived file spanning the boundary: an mtime filter would take
    // both records or neither.
    "p/a.jsonl": [turn("claude-opus-5", u, { ts: "2026-06-01T00:00:00Z", id: "old" }),
                  turn("claude-opus-5", u, { ts: "2026-08-01T00:00:00Z", id: "new" })].join("\n"),
  });
  const r = analyzeSpend({ root, rates: RATES, sinceMs: Date.parse("2026-07-01T00:00:00Z") });
  assert.equal(r.total_cost_usd, 1);
  assert.deepEqual(Object.keys(r.by_day), ["2026-08-01"]);
});

// --- honesty --------------------------------------------------------------

test("coverage is reported alongside the figure so a silent miss is visible", () => {
  const r = analyzeSpend({ root: mkroot({ "p/a.jsonl": "" }), rates: RATES });
  assert.equal(r.schema, SPEND_SCHEMA);
  assert.equal(r.coverage.files_scanned, 1);
  assert.equal(r.coverage.files_with_usage, 0);
  assert.match(r.note, /LOWER BOUND/);
});

test("a missing root yields an empty scan rather than throwing", () => {
  const r = analyzeSpend({ root: join(tmpdir(), "definitely-not-here-9f3a"), rates: RATES });
  assert.equal(r.coverage.files_scanned, 0);
  assert.equal(r.total_cost_usd, 0);
});

// --- tracking: the interventions only show up in a time series -------------

test("a tracking line keeps the two ratios the interventions are meant to move", () => {
  const u = { cache_read_input_tokens: 1e6 };
  const root = mkroot({
    "p/main.jsonl": turn("claude-opus-5", u, { id: "m" }),
    "p/s/subagents/a.jsonl": turn("claude-sonnet-5", u, { id: "s" }),
  });
  const line = trackingLine(analyzeSpend({ root, rates: RATES }),
                            { ts: "2026-08-14T00:00:00Z", window_days: 30 });
  assert.equal(line.main_cost_usd, 1);      // 1M read @ $1
  assert.equal(line.subagent_cost_usd, 0.1); // 1M read @ $0.10
  assert.equal(line.main_cost_per_turn, 1);
  assert.equal(line.subagent_cost_per_turn, 0.1);
  assert.equal(line.strong_tier_share, 0.9091);
  assert.equal(line.schema, SPEND_SCHEMA);
  assert.equal(SPEND_SCHEMA, "detent-spend-v2", "dedupe semantics changed; v1 lines must not silently compare");
});

test("a first measurement has no trend rather than a fake zero delta", () => {
  assert.equal(compareTracking(null, { ts: "x" }), null,
    "inventing 0% would read as 'nothing changed' instead of 'nothing to compare'");
});

test("a delta is flagged incomparable when schema, rates, window or sampling moved", () => {
  const base = { ts: "2026-01-01T00:00:00Z", schema: "s1", window_days: 30, rate_table_version: "v1",
                 rate_regime: "promo",
                 total_cost_usd: 100, main_cost_per_turn: 0.5, subagent_share: 0.2, strong_tier_share: 0.9 };
  const later = { ...base, ts: "2026-03-01T00:00:00Z" };
  assert.equal(compareTracking(base, later).comparable, true);

  // Schema: what counts as a turn changed. This is the v1->v2 dedupe fix, and
  // without this guard the next delta would read as a spectacular improvement.
  const reschema = { ...later, schema: "s2" };
  assert.equal(compareTracking(base, reschema).comparable, false);
  assert.match(compareTracking(base, reschema).incomparable_reason, /schema changed/);

  const repriced = { ...later, rate_table_version: "v2" };
  assert.match(compareTracking(base, repriced).incomparable_reason, /rate table changed/);

  const wider = { ...later, window_days: 60 };
  assert.match(compareTracking(base, wider).incomparable_reason, /window changed 30d -> 60d/);

  // Overlap: two 30d samples a day apart share 29/30 of their data, so a
  // near-zero delta means nothing and must not read as "the change did nothing".
  const tooSoon = { ...base, ts: "2026-01-02T00:00:00Z" };
  const d = compareTracking(base, tooSoon);
  assert.equal(d.comparable, false);
  assert.match(d.incomparable_reason, /mostly overlap/);
});

test("deltas report direction: cheaper main turns and more sub-agent share", () => {
  const prev = { ts: "2026-01-01T00:00:00Z", schema: "s1", window_days: 30, rate_table_version: "v1",
                 rate_regime: "promo",
                 total_cost_usd: 100, main_cost_per_turn: 0.50, subagent_share: 0.20, strong_tier_share: 0.95 };
  const curr = { ts: "2026-03-01T00:00:00Z", schema: "s1", window_days: 30, rate_table_version: "v1",
                 rate_regime: "promo",
                 total_cost_usd: 75, main_cost_per_turn: 0.25, subagent_share: 0.45, strong_tier_share: 0.80 };
  const d = compareTracking(prev, curr);
  assert.equal(d.comparable, true);
  assert.equal(d.total_cost_usd_pct, -0.25);      // 25% cheaper
  assert.equal(d.main_cost_per_turn_pct, -0.5);   // halved
  assert.equal(d.subagent_share_pp, 0.25);        // +25 points, absolute
  assert.equal(d.strong_tier_share_pp, -0.15);
});

// --- TTL-aware cache-write pricing ----------------------------------------

test("cache writes are priced by TTL when the transcript breaks them out", () => {
  // 5m bills 1.25x input, 1h bills 2.0x. RATES.opus input is 10 -> 12.5 / 20.
  const c = costOf({ cache_creation_input_tokens: 2e6,
                     cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } },
                   RATES.opus);
  assert.equal(c.cost, 32.5);
  assert.equal(c.ttl_known, true);
  assert.equal(c.cache_write, 2e6);
});

test("no TTL breakdown falls back to the 1h rate and says the TTL is unknown", () => {
  const c = costOf({ cache_creation_input_tokens: 1e6 }, RATES.opus);
  assert.equal(c.cost, 20);
  assert.equal(c.ttl_known, false);
});

// --- silent skips are counted ----------------------------------------------

test("unparseable lines and undated records are counted, not merely skipped", () => {
  const root = mkroot({
    // Must contain "usage" or the fast-path filter skips it before parsing —
    // a non-usage line is not a parse failure, it is simply not our business.
    "p/a.jsonl": ['{"usage": broken',
                  JSON.stringify({ type: "assistant", message: { id: "n", model: "claude-opus-5", usage: { cache_read_input_tokens: 1e6 } } })].join("\n"),
  });
  // No sinceMs: an undated record is priced, but still counted.
  const all = analyzeSpend({ root, rates: RATES });
  assert.equal(all.coverage.lines_unparseable, 1);
  assert.equal(all.coverage.records_no_timestamp, 1);
  assert.equal(all.total_cost_usd, 1);

  // With a window, an undated record fails CLOSED — it cannot be shown to be
  // inside the window, so it must not inflate it.
  const windowed = analyzeSpend({ root, rates: RATES, sinceMs: Date.parse("2020-01-01T00:00:00Z") });
  assert.equal(windowed.total_cost_usd, 0);
});

// --- _expires must do something, or it is a phantom knob -------------------

test("a lapsed promotional rate row is reported, not silently trusted", () => {
  const promo = { _version: "t", sonnet: { input: 2, output: 10, _expires: "2026-08-31" } };
  assert.deepEqual(expiredRates(promo, Date.parse("2026-08-14")), []);
  const lapsed = expiredRates(promo, Date.parse("2026-09-01"));
  assert.equal(lapsed.length, 1);
  assert.equal(lapsed[0].model, "sonnet");
  assert.match(lapsed[0].reason, /lapsed/);
});

test("an unparseable _expires is reported rather than treated as never expiring", () => {
  const bad = { _version: "t", sonnet: { input: 2, output: 10, _expires: "soon" } };
  assert.match(expiredRates(bad).at(0).reason, /unparseable/);
});

// --- streaming partials: the LAST record carries the real output count -----

test("a duplicate id resolves to the COMPLETE record, not the first partial", () => {
  // Streaming writes several records per message; only the one with a
  // stop_reason has the final output_tokens. Keeping the first understated
  // sub-agent output by a large factor on real transcripts.
  const mk = (out, stop) => JSON.stringify({
    type: "assistant", timestamp: "2026-08-01T00:00:00Z",
    message: { id: "m1", model: "claude-opus-5", stop_reason: stop,
               usage: { output_tokens: out, cache_read_input_tokens: 0 } },
  });
  const root = mkroot({ "p/a.jsonl": [mk(4, null), mk(4, null), mk(233, "tool_use")].join("\n") });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.by_origin.main.output, 233, "the finished record must win");
  assert.equal(r.by_origin.main.turns, 1);
  assert.equal(r.coverage.records_deduped, 2);
});

test("cross-file dedupe counts every superseded record, including partials", () => {
  const mk = (out, stop) => JSON.stringify({
    type: "assistant", timestamp: "2026-08-01T00:00:00Z",
    message: { id: "m1", model: "claude-opus-5", stop_reason: stop,
               usage: { output_tokens: out } },
  });
  const root = mkroot({ "p/a.jsonl": mk(10, "end_turn"),
                        "p/b.jsonl": [mk(1, null), mk(2, null), mk(3, "end_turn")].join("\n") });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.by_origin.main.turns, 1);
  assert.equal(r.coverage.records_deduped, 3);
  assert.equal(r.coverage.records_deduped_cross_file, 3);
});

// --- compareTracking must fail CLOSED on an unreadable gap -----------------

test("an unparseable or backwards timestamp refuses the comparison", () => {
  const base = { ts: "2026-01-01T00:00:00Z", schema: "s1", window_days: 30, rate_table_version: "v1",
                 rate_regime: "promo",
                 total_cost_usd: 100, main_cost_per_turn: 0.5, subagent_share: 0.2, strong_tier_share: 0.9 };
  const unreadable = { ...base, ts: "not-a-date" };
  const d1 = compareTracking(base, unreadable);
  assert.equal(d1.comparable, false, "an unverifiable gap must not read as a verified one");
  assert.match(d1.incomparable_reason, /cannot read the gap/);

  const backwards = { ...base, ts: "2025-11-01T00:00:00Z" };
  const d2 = compareTracking(base, backwards);
  assert.equal(d2.comparable, false);
  assert.match(d2.incomparable_reason, /out of order/);
  // The gap is reported as a magnitude — "by 61d", never "by -61d". A plain
  // /-\d/ would match the hyphens inside the ISO dates.
  assert.doesNotMatch(d2.incomparable_reason, /by -/, "no negative day count in the message");
});

// --- Review fix: a date-only _expires means end of that day --------------

test("promotional pricing is live for the WHOLE of its final day", () => {
  // "through 2026-08-31" parsed naively lands at 00:00 UTC, marking the rate
  // expired for almost the entire day it is still valid.
  const promo = { _version: "t", sonnet: { input: 2, output: 10, _expires: "2026-08-31" } };
  assert.deepEqual(expiredRates(promo, Date.parse("2026-08-31T23:59:00Z")), [],
    "still valid at the last minute of the final day");
  assert.equal(expiredRates(promo, Date.parse("2026-09-01T00:00:01Z")).length, 1,
    "expired the moment the next day starts");
});

test("a full timestamp _expires is honoured exactly, not rounded to a day", () => {
  const promo = { _version: "t", sonnet: { input: 2, _expires: "2026-08-31T12:00:00Z" } };
  assert.deepEqual(expiredRates(promo, Date.parse("2026-08-31T11:59:00Z")), []);
  assert.equal(expiredRates(promo, Date.parse("2026-08-31T12:00:01Z")).length, 1);
});

// --- an expired rate must be ACTED on, not merely reported -----------------

test("a lapsed row with a _list fallback is corrected before anything is priced", () => {
  const promo = { _version: "t",
    opus: { input: 10, output: 100, cache_read: 1, cache_write: 20 },
    sonnet: { input: 2, output: 10, cache_read: 0.2, cache_write: 4,
              _expires: "2026-08-31",
              _list: { input: 3, output: 15, cache_read: 0.3, cache_write: 6 } } };
  const after = applyExpiry(promo, Date.parse("2026-09-02T00:00:00Z"));
  assert.equal(after.rates.sonnet.input, 3, "list pricing takes over");
  assert.equal(after.rates.sonnet._expires, undefined, "the promo marker does not survive");
  assert.equal(after.corrected.length, 1);
  assert.deepEqual(after.unresolved, []);
  // Untouched while still in promo.
  assert.equal(applyExpiry(promo, Date.parse("2026-08-15")).rates.sonnet.input, 2);
});

test("a lapsed row with NO fallback stays unresolved so the caller can refuse", () => {
  const promo = { _version: "t", sonnet: { input: 2, output: 10, _expires: "2026-08-31" } };
  const after = applyExpiry(promo, Date.parse("2026-09-02T00:00:00Z"));
  assert.deepEqual(after.corrected, []);
  assert.equal(after.unresolved.length, 1);
  assert.equal(after.rates.sonnet.input, 2, "left in place — the caller decides, not this function");
});

test("each record is priced at the rate that applied WHEN IT HAPPENED", () => {
  // CORRECTED. This test previously asserted a global pre-scan swap, which
  // repriced history: a window straddling the expiry charged pre-expiry traffic
  // at post-expiry rates. That is the stale-rate bug in a new costume.
  const rates = { _version: "t",
    opus: { input: 10, output: 100, cache_read: 1, cache_write: 20,
            _expires: "2026-08-31",
            _list: { input: 20, output: 200, cache_read: 2, cache_write: 40 } } };
  const u = { cache_read_input_tokens: 1e6 };
  const root = mkroot({
    "p/a.jsonl": [turn("claude-opus-5", u, { ts: "2026-08-15T00:00:00Z", id: "during" }),
                  turn("claude-opus-5", u, { ts: "2026-09-05T00:00:00Z", id: "after" })].join("\n"),
  });
  // Scanned well after the expiry, but the August record keeps August's price.
  const r = analyzeSpend({ root, rates, asOfMs: Date.parse("2026-09-10") });
  assert.equal(r.total_cost_usd, 3, "1 (promo, August) + 2 (list, September)");
  assert.deepEqual(r.rates_corrected, ["claude-opus-5"], "the swap is reported");
  // A boolean version suffix collapsed every mix into one value, so a window
  // with one list-priced day compared as equivalent to one with thirty. The
  // regime, and the cost split behind it, is what makes that visible.
  assert.equal(r.rate_regime, "mixed");
  assert.deepEqual(r.rate_regime_cost_usd, { promo: 1, list: 2 });
  assert.deepEqual(r.expired_rates, [], "a row WITH a _list fallback is not an outstanding problem");
});

test("a window entirely before the expiry is untouched and keeps its version", () => {
  const rates = { _version: "t",
    opus: { input: 10, output: 100, cache_read: 1, cache_write: 20,
            _expires: "2026-08-31",
            _list: { input: 20, output: 200, cache_read: 2, cache_write: 40 } } };
  const root = mkroot({
    "p/a.jsonl": turn("claude-opus-5", { cache_read_input_tokens: 1e6 }, { ts: "2026-08-15T00:00:00Z", id: "x" }),
  });
  const r = analyzeSpend({ root, rates, asOfMs: Date.parse("2026-09-10") });
  assert.equal(r.total_cost_usd, 1);
  assert.deepEqual(r.rates_corrected, []);
  assert.equal(r.rate_table_version, "t");
  assert.equal(r.rate_regime, "promo");
});

test("a lapsed row with NO fallback is left as an outstanding problem", () => {
  const rates = { _version: "t",
    opus: { input: 10, output: 100, cache_read: 1, cache_write: 20, _expires: "2026-08-31" } };
  const root = mkroot({
    "p/a.jsonl": turn("claude-opus-5", { cache_read_input_tokens: 1e6 }, { ts: "2026-09-05T00:00:00Z", id: "x" }),
  });
  const r = analyzeSpend({ root, rates, asOfMs: Date.parse("2026-09-10") });
  assert.equal(r.expired_rates.length, 1, "the CLI refuses to --record while this is non-empty");
  assert.equal(r.total_cost_usd, 1, "still priced at the lapsed rate — reported, not silently guessed at");
});

// --- a blended-price window is comparable to nothing ------------------------

test("a window that straddles a pricing change is comparable to nothing", () => {
  const base = { ts: "2026-01-01T00:00:00Z", schema: "s1", window_days: 30,
                 rate_table_version: "v1", rate_regime: "promo", total_cost_usd: 100,
                 main_cost_per_turn: 0.5, subagent_share: 0.2, strong_tier_share: 0.9 };
  const later = { ...base, ts: "2026-03-01T00:00:00Z" };
  assert.equal(compareTracking(base, later).comparable, true);

  // Mixed on either side: never comparable, not even mixed-to-mixed, because a
  // blended price belongs to its exact date span.
  const mixed = { ...later, rate_regime: "mixed" };
  assert.equal(compareTracking(base, mixed).comparable, false);
  assert.match(compareTracking(base, mixed).incomparable_reason, /blended price/);
  assert.equal(compareTracking(mixed, { ...mixed, ts: "2026-05-01T00:00:00Z" }).comparable, false);

  // Pure regimes on both sides but different ones: also incomparable, though
  // for the simpler reason that the prices differ.
  const list = { ...later, rate_regime: "list" };
  assert.equal(compareTracking(base, list).comparable, false);
  assert.match(compareTracking(base, list).incomparable_reason, /regime changed promo -> list/);
});

test("a line with NO rate_regime is incomparable — absence is unknown, not benign", () => {
  // INVERTED after review. Being lenient here left a hole: a pre-field line
  // could sit on either side of a price change, so comparing it is a guess. The
  // committed baselines were migrated to carry the field rather than exempted.
  const base = { ts: "2026-01-01T00:00:00Z", schema: "s1", window_days: 30,
                 rate_table_version: "v1", total_cost_usd: 100,
                 main_cost_per_turn: 0.5, subagent_share: 0.2, strong_tier_share: 0.9 };
  const d = compareTracking(base, { ...base, ts: "2026-03-01T00:00:00Z" });
  assert.equal(d.comparable, false);
  assert.match(d.incomparable_reason, /no rate_regime/);
  // And one side alone is enough to refuse.
  const withRegime = { ...base, ts: "2026-03-01T00:00:00Z", rate_regime: "list" };
  assert.equal(compareTracking(base, withRegime).comparable, false);
});

// --- permanent-rate models must not poison the regime ----------------------

test("a model with no _expires is regime-NEUTRAL, not promotional", () => {
  // The bug: opus/haiku always take rawRate, so counting that as "promo" made
  // every window containing them "mixed" once sonnet lapsed — and a mixed window
  // compares to nothing, so the tracking series would have gone permanently
  // silent from 2026-09-01.
  const rates = { _version: "t",
    opus: { input: 10, output: 100, cache_read: 1, cache_write: 20 },   // permanent
    sonnet: { input: 2, output: 10, cache_read: 0.2, cache_write: 4,
              _expires: "2026-08-31",
              _list: { input: 3, output: 15, cache_read: 0.3, cache_write: 6 } } };
  const u = { cache_read_input_tokens: 1e6 };

  // Wholly AFTER the expiry, with permanent-rate traffic alongside.
  const after = mkroot({ "p/a.jsonl": [
    turn("claude-opus-5", u, { ts: "2026-09-05T00:00:00Z", id: "o" }),
    turn("claude-sonnet-5", u, { ts: "2026-09-05T00:00:00Z", id: "s" }),
  ].join("\n") });
  const r = analyzeSpend({ root: after, rates, asOfMs: Date.parse("2026-09-10") });
  assert.equal(r.rate_regime, "list", "opus must not drag this to mixed");

  // Wholly BEFORE the expiry.
  const before = mkroot({ "p/a.jsonl": [
    turn("claude-opus-5", u, { ts: "2026-08-05T00:00:00Z", id: "o" }),
    turn("claude-sonnet-5", u, { ts: "2026-08-05T00:00:00Z", id: "s" }),
  ].join("\n") });
  assert.equal(analyzeSpend({ root: before, rates, asOfMs: Date.parse("2026-09-10") }).rate_regime, "promo");

  // Permanent-rate traffic ONLY: no regime question arises.
  const neutral = mkroot({ "p/a.jsonl": turn("claude-opus-5", u, { ts: "2026-09-05T00:00:00Z", id: "o" }) });
  assert.equal(analyzeSpend({ root: neutral, rates, asOfMs: Date.parse("2026-09-10") }).rate_regime, "none");
});

test("'none' clashes with nothing — the table in force was the same", () => {
  const base = { ts: "2026-01-01T00:00:00Z", schema: "s1", window_days: 30,
                 rate_table_version: "v1", total_cost_usd: 100,
                 main_cost_per_turn: 0.5, subagent_share: 0.2, strong_tier_share: 0.9 };
  const at = (regime, ts) => ({ ...base, rate_regime: regime, ts });
  // A window with no expiring traffic is comparable to either pure regime: a
  // differing usage mix is not a pricing change.
  assert.equal(compareTracking(at("none", "2026-01-01T00:00:00Z"), at("list", "2026-03-01T00:00:00Z")).comparable, true);
  assert.equal(compareTracking(at("promo", "2026-01-01T00:00:00Z"), at("none", "2026-03-01T00:00:00Z")).comparable, true);
  // But a genuine promo -> list difference is still refused.
  assert.equal(compareTracking(at("promo", "2026-01-01T00:00:00Z"), at("list", "2026-03-01T00:00:00Z")).comparable, false);
});

// --- cold resumes: the biggest lever, and it was unmeasured ----------------

const HOUR = 3600_000;
function at(msOffset, id, model = "claude-opus-5") {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(Date.parse("2026-08-01T00:00:00Z") + msOffset).toISOString(),
    message: { id, model, stop_reason: "end_turn",
               usage: { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0 } },
  });
}

test("turns are bucketed by the gap since the previous turn in the same session", () => {
  const root = mkroot({
    "p/a.jsonl": [
      at(0, "t0"),                       // first turn — no preceding gap
      at(60_000, "t1"),                  // +1m   -> warm
      at(60_000 + 10 * 60_000, "t2"),    // +10m  -> recent
      at(60_000 + 10 * 60_000 + 3 * HOUR, "t3"), // +3h -> cold
    ].join("\n"),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.resume.warm.turns, 1);
  assert.equal(r.resume.recent.turns, 1);
  assert.equal(r.resume.cold.turns, 1);
  // The first turn of a session has no gap and is counted in none of them.
  assert.equal(r.resume.warm.turns + r.resume.recent.turns + r.resume.cold.turns, 3);
});

test("gaps are per SESSION — two sessions do not create a phantom cold turn", () => {
  // Without per-file grouping, turn 1 of session B looks like a 3h resume of
  // session A and the penalty would be invented out of ordinary parallel work.
  const root = mkroot({
    "p/a.jsonl": [at(0, "a0"), at(60_000, "a1")].join("\n"),
    "p/b.jsonl": [at(3 * HOUR, "b0"), at(3 * HOUR + 60_000, "b1")].join("\n"),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.resume.cold.turns, 0, "a different session is not a resume");
  assert.equal(r.resume.warm.turns, 2);
});

test("sub-agent turns never count as resumes — they are discarded, not resumed", () => {
  const root = mkroot({
    "p/s/subagents/a.jsonl": [at(0, "s0"), at(3 * HOUR, "s1")].join("\n"),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.resume.cold.turns, 0);
});

test("cold_excess_usd is the RECOVERABLE part, not the whole cold cost", () => {
  // A cold turn still does work; only the difference from a warm turn is what
  // ending the session instead of resuming would have saved.
  const root = mkroot({
    "p/a.jsonl": [at(0, "c0"), at(60_000, "c1"), at(4 * HOUR, "c2")].join("\n"),
  });
  const r = analyzeSpend({ root, rates: RATES });
  assert.equal(r.resume.cold.turns, 1);
  const expected = r.resume.cold.cost - r.resume.warm.mean_cost_usd;
  assert.ok(Math.abs(r.resume.cold_excess_usd - expected) < 0.01,
    `excess ${r.resume.cold_excess_usd} should be cold minus one warm turn (${expected})`);
  assert.ok(r.resume.cold_excess_usd < r.resume.cold.cost);
});

test("the tracking line carries the cold-resume figures", () => {
  const root = mkroot({
    "p/a.jsonl": [at(0, "x0"), at(60_000, "x1"), at(5 * HOUR, "x2")].join("\n"),
  });
  const line = trackingLine(analyzeSpend({ root, rates: RATES }),
                            { ts: "2026-08-17T00:00:00Z", window_days: 30 });
  assert.equal(typeof line.cold_resume_cost_usd, "number");
  assert.equal(typeof line.cold_resume_excess_usd, "number");
  assert.equal(typeof line.cold_resume_share_of_main, "number");
  assert.ok(line.cold_resume_share_of_main > 0, "a session with a 5h gap must register");
});
