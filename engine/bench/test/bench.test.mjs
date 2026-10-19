// Unit tests for the bench module. Zero dependencies (node:test).
// Fixtures encode round-number timestamps so the arithmetic is checkable by
// hand (see engine/bench/test/fixtures/events.jsonl).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseJsonl, computePhaseTimings, computeWallClock, computeGateWait,
  computeAsyncWait, computeTokens, computeOtherMetrics, buildBenchmark,
  ledgerLine, runBenchmark, checkpointBenchmark, DEFAULT_RATES,
  effectiveRate, rateExpiresMs,
} from "../bench.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS = readFileSync(join(HERE, "fixtures", "events.jsonl"), "utf8");
const TOKENS = readFileSync(join(HERE, "fixtures", "tokens.jsonl"), "utf8");

// Cost tests price against this synthetic table, never DEFAULT_RATES: vendor
// pricing changes, and a golden cost pinned to it turns every price correction
// into a red build. Round numbers so the arithmetic is checkable by hand.
const FIXTURE_RATES = {
  _version: "test-fixture",
  opus:   { input: 10, output: 100, cache_write: 20, cache_read: 1 },
  sonnet: { input: 1,  output: 10,  cache_write: 2,  cache_read: 0.1 },
};

// Known-good constants from the fixture (all in ms).
const MIN = 60000;
const WALL = 22 * MIN;       // 10:00:00 -> 10:22:00
const GATE_WAIT = 10 * MIN;  // 10:05:00 -> 10:15:00
const ASYNC_WAIT = 5 * MIN;  // 10:16:00 -> 10:21:00
const EFFECTIVE = WALL - GATE_WAIT - ASYNC_WAIT; // 7 min

test("per-phase wall-clock derived from stage_begin/stage_end", () => {
  const events = parseJsonl(EVENTS);
  const { phases } = computePhaseTimings(events);
  assert.equal(phases.intake.wall_ms, 1 * MIN);
  assert.equal(phases.research.wall_ms, 3 * MIN);
  assert.equal(phases.plan.wall_ms, 18 * MIN); // 10:04 -> 10:22
  assert.equal(phases.intake.status, "done");
});

test("phase begun but never ended is reported incomplete, not timed", () => {
  const events = parseJsonl(
    '{"ts":"2026-07-05T10:00:00Z","event":"stage_begin","stage":"implement"}\n',
  );
  const { phases } = computePhaseTimings(events);
  assert.equal(phases.implement.status, "incomplete");
  assert.equal(phases.implement.wall_ms, null);
});

test("total wall-clock is first-event to last-event", () => {
  const wall = computeWallClock(parseJsonl(EVENTS));
  assert.equal(wall.total_ms, WALL);
  assert.equal(wall.first_ts, "2026-07-05T10:00:00Z");
  assert.equal(wall.last_ts, "2026-07-05T10:22:00Z");
});

test("human-gate wait = answered_ts - opened_ts across gates", () => {
  const gate = computeGateWait(parseJsonl(EVENTS));
  assert.equal(gate.total_ms, GATE_WAIT);
  assert.equal(gate.count, 1);
  assert.equal(gate.gates[0].decision_id, "D-001");
  assert.equal(gate.gates[0].answer, "approve");
});

test("a gate opened but never answered contributes no wait (honest)", () => {
  const events = parseJsonl(
    '{"ts":"2026-07-05T10:00:00Z","event":"gate_opened","gate":"intent","decision_id":"D-001"}\n',
  );
  const gate = computeGateWait(events);
  assert.equal(gate.total_ms, 0);
  assert.equal(gate.count, 0);
  assert.deepEqual(gate.open_unanswered, ["D-001"]);
});

test("async-external wait = response_ts - request_ts, paired by id", () => {
  const a = computeAsyncWait(parseJsonl(EVENTS));
  assert.equal(a.total_ms, ASYNC_WAIT);
  assert.equal(a.count, 1);
  assert.equal(a.by_kind.ci, ASYNC_WAIT);
});

test("async request with no response is surfaced, never guessed", () => {
  const events = parseJsonl(
    '{"ts":"2026-07-05T10:00:00Z","event":"external_request","id":"sign-1","kind":"sign_off"}\n',
  );
  const a = computeAsyncWait(events);
  assert.equal(a.total_ms, 0);
  assert.deepEqual(a.unmatched_requests, ["sign-1"]);
});

test("effective-agentic-time = wall - gate_wait - async_wait", () => {
  const b = buildBenchmark({ eventsText: EVENTS, tokensText: TOKENS });
  assert.equal(b.wall_clock_ms, WALL);
  assert.equal(b.human_gate_wait_ms, GATE_WAIT);
  assert.equal(b.async_external_wait_ms, ASYNC_WAIT);
  assert.equal(b.effective_agentic_time_ms, EFFECTIVE);
  // human_touch_ratio = gate_wait / wall
  assert.equal(b.human_touch_ratio, Math.round((GATE_WAIT / WALL) * 1e4) / 1e4);
});

test("tokens: priced totals + unpriced model surfaced, not guessed", () => {
  const t = computeTokens(TOKENS, FIXTURE_RATES);
  assert.equal(t.recorded, true);
  assert.equal(t.input_tokens, 36000);
  assert.equal(t.output_tokens, 13500);
  assert.deepEqual(t.models.sort(), ["mystery-model", "opus", "sonnet"]);
  // opus: (15000/1e6*10)+(5000/1e6*100)=0.15+0.5=0.65
  // sonnet: (20000/1e6*1)+(8000/1e6*10)=0.02+0.08=0.10
  assert.equal(t.estimated_cost_usd, 0.75);
  assert.deepEqual(t.unpriced_models, ["mystery-model"]);
});

test("tokens: cache read/write are counted and priced", () => {
  const rows = [
    // 1M cache read on opus = 1M/1e6 * 1 = $1.00
    // 0.5M cache write on opus = 0.5M/1e6 * 20 = $10.00
    JSON.stringify({ phase: "implement", model: "opus", input: 0, output: 0, cache_read: 1_000_000, cache_write: 500_000 }),
  ].join("\n");
  const t = computeTokens(rows, FIXTURE_RATES);
  assert.equal(t.cache_read_tokens, 1_000_000);
  assert.equal(t.cache_write_tokens, 500_000);
  assert.equal(t.total_tokens, 1_500_000);
  assert.equal(t.estimated_cost_usd, 11);
  assert.equal(t.by_phase.implement.cache_read, 1_000_000);
  assert.deepEqual(t.cache_unrecorded_models, []);
});

test("tokens: a row with no cache fields is flagged as understated, not zero", () => {
  // The old fixture predates cache accounting — absence must read as "unknown",
  // never as "this turn genuinely read nothing from cache".
  const t = computeTokens(TOKENS, FIXTURE_RATES);
  assert.equal(t.cache_read_tokens, 0);
  assert.ok(t.cache_unrecorded_models.includes("opus"));
  assert.match(t.cost_note, /UNDERSTATED/);
});

test("tokens: a rate row without cache rates falls back to the standard multipliers", () => {
  const rows = JSON.stringify({ phase: "x", model: "opus", input: 0, output: 0, cache_read: 1_000_000, cache_write: 1_000_000 });
  const noCacheRates = { opus: { input: 10, output: 100 } };
  // cache_read defaults to 0.1x input = 1.0 ; cache_write to 2.0x input = 20.0
  assert.equal(computeTokens(rows, noCacheRates).estimated_cost_usd, 21);
});

test("DEFAULT_RATES prices cache traffic for every model it prices", () => {
  for (const [model, rate] of Object.entries(DEFAULT_RATES)) {
    if (model.startsWith("_")) continue;
    assert.equal(typeof rate.cache_read, "number", `${model} missing cache_read`);
    assert.equal(typeof rate.cache_write, "number", `${model} missing cache_write`);
    // Tolerance, not equality: 3 * 0.1 is 0.30000000000000004 in binary float.
    assert.ok(Math.abs(rate.cache_read - rate.input * 0.1) < 1e-9, `${model} cache_read must be 0.1x input`);
    assert.ok(Math.abs(rate.cache_write - rate.input * 2.0) < 1e-9, `${model} cache_write must be 2.0x input (1h TTL)`);
  }
});

test("tokens 'unrecorded' honesty when tokens.jsonl absent", () => {
  const t = computeTokens(null);
  assert.equal(t.recorded, false);
  assert.match(t.note, /unrecorded/);
  const b = buildBenchmark({ eventsText: EVENTS, tokensText: null });
  assert.equal(b.tokens.recorded, false);
  assert.equal(b.data_sources.tokens_recorded, false);
});

test("tokens 'unrecorded' when tokens.jsonl present but empty", () => {
  const t = computeTokens("   \n");
  assert.equal(t.recorded, false);
});

test("other metrics: genuine-zero vs unrecorded are distinguished", () => {
  const m = computeOtherMetrics(parseJsonl(EVENTS));
  assert.equal(m.gates_total, 1);
  assert.equal(m.gates_answered, 1);
  // no commit/autofix events in the fixture -> recorded:false, not 0
  assert.equal(m.commits.recorded, false);
  assert.equal(m.autofix_rounds.recorded, false);
  assert.equal(m.findings_by_severity.recorded, false);
});

test("other metrics: advisor_consults counted when present; ledger line carries the additive count", () => {
  const events = parseJsonl(EVENTS +
    '{"ts":"2026-07-05T10:00:01Z","event":"advisor_consult","model":"fable","tier":"strong","trigger":"intent","decision_id":"D-001","authority":"recommend-only"}\n' +
    '{"ts":"2026-07-05T10:00:02Z","event":"advisor_consult","model":"opus","tier":"strong","trigger":"stage:plan","decision_id":null,"authority":"recommend-only"}\n');
  const m = computeOtherMetrics(events);
  assert.equal(m.advisor_consults, 2);
  const b = buildBenchmark({ eventsText: EVENTS +
    '{"ts":"2026-07-05T10:00:01Z","event":"advisor_consult","model":"fable","tier":"strong","trigger":"intent","decision_id":"D-001","authority":"recommend-only"}\n' +
    '{"ts":"2026-07-05T10:00:02Z","event":"advisor_consult","model":"opus","tier":"strong","trigger":"stage:plan","decision_id":null,"authority":"recommend-only"}\n',
    run: { run_id: "r" } });
  assert.equal(ledgerLine(b).advisor_consults, 2);
});

test("other metrics: advisor_consults 'unrecorded' honesty when no advisor_consult events; ledger line falls back to 0", () => {
  const m = computeOtherMetrics(parseJsonl(EVENTS));
  assert.equal(m.advisor_consults.recorded, false);
  assert.match(m.advisor_consults.note, /no advisor_consult events recorded/);
  const b = buildBenchmark({ eventsText: EVENTS, run: { run_id: "r" } });
  assert.equal(ledgerLine(b).advisor_consults, 0);
});

test("other metrics: pass/fail derived from stage-status.json", () => {
  const stageStatus = {
    stages: {
      intake: { status: "done" }, research: { status: "done" },
      plan: { status: "blocked" }, implement: { status: "pending" },
    },
  };
  const m = computeOtherMetrics(parseJsonl(EVENTS), stageStatus);
  assert.equal(m.phase_pass_fail.recorded, true);
  assert.equal(m.phase_pass_fail.phases.intake, "pass");
  assert.equal(m.phase_pass_fail.phases.plan, "blocked");
  assert.equal(m.phase_pass_fail.phases.implement, "pending");
});

test("findings by severity counted from finding events when present", () => {
  const events = parseJsonl(
    '{"ts":"2026-07-05T10:00:00Z","event":"finding","severity":"high"}\n' +
    '{"ts":"2026-07-05T10:00:01Z","event":"finding","severity":"high"}\n' +
    '{"ts":"2026-07-05T10:00:02Z","event":"finding","severity":"low"}\n',
  );
  const m = computeOtherMetrics(events);
  assert.equal(m.findings_by_severity.recorded, true);
  assert.equal(m.findings_by_severity.total, 3);
  assert.deepEqual(m.findings_by_severity.by_severity, { high: 2, low: 1 });
});

test("parseJsonl throws loudly on a malformed line (no silent drop)", () => {
  assert.throws(() => parseJsonl('{"ok":true}\n{bad json}\n'), /invalid JSONL at line 2/);
});

test("runBenchmark writes benchmark.json and appends the ledger line", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-root-"));
  const runDir = join(root, ".sdlc", "2026-07-05-demo");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "2026-07-05-demo", ticket_ref: "octo/repo#1" }));
  writeFileSync(join(runDir, "events.jsonl"), EVENTS);
  writeFileSync(join(runDir, "tokens.jsonl"), TOKENS);
  const { benchmark, benchmarkPath, ledgerPath } = runBenchmark(runDir);
  assert.ok(existsSync(benchmarkPath));
  assert.equal(benchmark.effective_agentic_time_ms, EFFECTIVE);
  // ledger appended under <root>/benchmarks/ledger.jsonl
  assert.equal(ledgerPath, join(root, "benchmarks", "ledger.jsonl"));
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.run_id, "2026-07-05-demo");
  assert.equal(summary.effective_agentic_time_ms, EFFECTIVE);
  assert.equal(summary.tokens.recorded, true);
  // second run appends, never overwrites
  runBenchmark(runDir);
  assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 2);
});

test("buildBenchmark tags a checkpoint build partial and carries the checkpoint block", () => {
  const b = buildBenchmark({
    eventsText: EVENTS, tokensText: TOKENS, run: { run_id: "r" },
    checkpoint: { reason: "gate-pending:intent", gate_id: "D-001", sequence: 0 },
  });
  assert.equal(b.partial, true);
  assert.equal(b.checkpoint.reason, "gate-pending:intent");
  assert.equal(b.checkpoint.gate_id, "D-001");
  assert.equal(b.checkpoint.sequence, 0);
  // covers_through_ts is the last event seen — the window ends at the park.
  assert.equal(b.checkpoint.covers_through_ts, b.last_event_ts);
  // A normal build is explicitly not partial.
  assert.equal(buildBenchmark({ eventsText: EVENTS, run: {} }).partial, false);
});

test("checkpointBenchmark writes a partial benchmark.json, appends the per-run set + a checkpoint-tagged ledger line", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-ckpt-"));
  const runDir = join(root, ".sdlc", "2026-07-05-demo");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "2026-07-05-demo", ticket_ref: "octo/repo#1" }));
  writeFileSync(join(runDir, "events.jsonl"), EVENTS);

  const res = checkpointBenchmark(runDir, { reason: "gate-pending:intent", gateId: "D-001" });
  assert.equal(res.sequence, 0);
  // benchmark.json exists and is marked partial.
  const bm = JSON.parse(readFileSync(res.benchmarkPath, "utf8"));
  assert.equal(bm.partial, true);
  assert.equal(bm.checkpoint.reason, "gate-pending:intent");
  // per-run checkpoint set has one full record.
  assert.equal(res.checkpointsPath, join(runDir, "benchmark-checkpoints.jsonl"));
  assert.equal(readFileSync(res.checkpointsPath, "utf8").trim().split("\n").length, 1);
  // ledger line is tagged partial.
  const ledgerLines = readFileSync(res.ledgerPath, "utf8").trim().split("\n");
  const line = JSON.parse(ledgerLines[ledgerLines.length - 1]);
  assert.equal(line.partial, true);
  assert.equal(line.checkpoint_reason, "gate-pending:intent");
  assert.equal(line.run_id, "2026-07-05-demo");
});

test("checkpointBenchmark: same gate + no new events is skipped (retry-safe); new events add a sequenced checkpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-ckpt-dedup-"));
  const runDir = join(root, ".sdlc", "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "run" }));
  writeFileSync(join(runDir, "events.jsonl"), EVENTS);

  const first = checkpointBenchmark(runDir, { reason: "gate-pending:intent", gateId: "D-001" });
  assert.equal(first.sequence, 0);
  // Re-running on the same gate with no new events is a no-op (no duplicate).
  const retry = checkpointBenchmark(runDir, { reason: "gate-pending:intent", gateId: "D-001" });
  assert.equal(retry.skipped, true);
  const setPath = join(runDir, "benchmark-checkpoints.jsonl");
  assert.equal(readFileSync(setPath, "utf8").trim().split("\n").length, 1, "no duplicate checkpoint");
  // A new event (the human answering, another park) yields a second checkpoint.
  writeFileSync(join(runDir, "events.jsonl"), EVENTS +
    '{"ts":"2026-07-05T10:30:00Z","event":"gate_opened","gate":"ship","decision_id":"D-002"}\n');
  const second = checkpointBenchmark(runDir, { reason: "gate-open:ship", gateId: "D-002" });
  assert.equal(second.sequence, 1);
  assert.equal(readFileSync(setPath, "utf8").trim().split("\n").length, 2);
});

test("runBenchmark refuses a directory with no events.jsonl", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-root-"));
  const runDir = join(root, ".sdlc", "empty");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "empty" }));
  assert.throws(() => runBenchmark(runDir), /no events\.jsonl/);
});

test("ledgerLine carries the headline numbers", () => {
  const b = buildBenchmark({ eventsText: EVENTS, tokensText: TOKENS, run: { run_id: "r", ticket_ref: "t" }, rates: FIXTURE_RATES });
  const line = ledgerLine(b);
  assert.equal(line.run_id, "r");
  assert.equal(line.effective_agentic_time_ms, EFFECTIVE);
  assert.equal(line.gates, 1);
  assert.equal(line.tokens.estimated_cost_usd, 0.75);
});

// --- expiry: the benchmark path must not price at a lapsed rate ------------

test("computeTokens switches a lapsed promotional row to its _list fallback", () => {
  // Before this, bench priced Sonnet at the expired introductory rate forever
  // while reporting that every model was priced — recreating the stale-rate
  // measurement bug the rate-table correction existed to fix.
  const rates = {
    _version: "t",
    sonnet: { input: 2, output: 10, cache_write: 4, cache_read: 0.2,
              _expires: "2026-08-31",
              _list: { input: 3, output: 15, cache_write: 6, cache_read: 0.3 } },
  };
  const rows = JSON.stringify({ phase: "implement", model: "sonnet", input: 1e6, output: 0 });

  const during = computeTokens(rows, rates, { asOfMs: Date.parse("2026-08-15") });
  assert.equal(during.estimated_cost_usd, 2);
  assert.deepEqual(during.rates_corrected, []);
  assert.equal(during.rate_table_version, "t");

  const after = computeTokens(rows, rates, { asOfMs: Date.parse("2026-09-01T12:00:00Z") });
  assert.equal(after.estimated_cost_usd, 3, "list pricing once the promo lapsed");
  assert.deepEqual(after.rates_corrected, ["sonnet"]);
  assert.equal(after.rate_table_version, "t+list-after-expiry",
    "the version must change, or a consumer compares figures built from different prices");
  assert.match(after.cost_note, /promotional pricing has lapsed/);
});

test("promotional pricing is live for the whole of its final day in bench too", () => {
  const rates = { _version: "t",
    sonnet: { input: 2, output: 10, _expires: "2026-08-31", _list: { input: 3, output: 15 } } };
  const rows = JSON.stringify({ phase: "x", model: "sonnet", input: 1e6, output: 0 });
  assert.equal(computeTokens(rows, rates, { asOfMs: Date.parse("2026-08-31T23:59:00Z") }).estimated_cost_usd, 2);
  assert.equal(computeTokens(rows, rates, { asOfMs: Date.parse("2026-09-01T00:00:01Z") }).estimated_cost_usd, 3);
});

test("effectiveRate leaves a lapsed row alone when it has no fallback", () => {
  const row = { input: 2, output: 10, _expires: "2026-08-31" };
  assert.equal(effectiveRate(row, Date.parse("2026-09-05")), row,
    "guessing a replacement price would be worse than reporting the problem");
  assert.equal(rateExpiresMs({ input: 1 }), null, "no _expires means it never lapses");
  assert.ok(Number.isNaN(rateExpiresMs({ _expires: "whenever" })), "unparseable is NaN, not a date");
});

test("a historical run keeps its historical price when re-benchmarked", () => {
  // Re-running an old benchmark after a promotion lapses must not reprice the
  // run at today's list rate — the number would stop describing what that run
  // actually incurred. tokens.jsonl has no timestamps, so the run's own event
  // timeline is the clock.
  const rates = { _version: "t",
    sonnet: { input: 2, output: 10, cache_write: 4, cache_read: 0.2,
              _expires: "2026-08-31",
              _list: { input: 3, output: 15, cache_write: 6, cache_read: 0.3 } } };
  const rows = JSON.stringify({ phase: "implement", model: "sonnet", input: 1e6, output: 0 });

  // A run that happened in August, benchmarked (or re-benchmarked) whenever.
  const augustRun = [
    '{"ts":"2026-08-10T10:00:00Z","event":"stage_begin","stage":"implement"}',
    '{"ts":"2026-08-10T10:30:00Z","event":"stage_end","stage":"implement"}',
  ].join("\n");
  const b = buildBenchmark({ eventsText: augustRun, tokensText: rows, rates });
  assert.equal(b.tokens.estimated_cost_usd, 2, "August pricing, regardless of today");
  assert.deepEqual(b.tokens.rates_corrected, []);

  // A run that happened after the promo lapsed pays list.
  const septRun = [
    '{"ts":"2026-09-10T10:00:00Z","event":"stage_begin","stage":"implement"}',
    '{"ts":"2026-09-10T10:30:00Z","event":"stage_end","stage":"implement"}',
  ].join("\n");
  const b2 = buildBenchmark({ eventsText: septRun, tokensText: rows, rates });
  assert.equal(b2.tokens.estimated_cost_usd, 3, "September pricing");
  assert.deepEqual(b2.tokens.rates_corrected, ["sonnet"]);
});
