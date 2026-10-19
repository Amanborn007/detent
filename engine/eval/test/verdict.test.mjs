// Unit tests for verdict.mjs. Zero dependencies (node:test). Pure math except
// loadBaseline, which gets its own scratch-file fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  round, loadBaseline, aggregateSuite, computeDeltas, computeVerdict,
  medianOf, spreadOf, BASELINE_SCHEMA, resolveGateMode, countGreenBaselines,
} from "../verdict.mjs";

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "verdict-test-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// round
// ---------------------------------------------------------------------------

test("round: 4dp default, trims float noise", () => {
  assert.equal(round(1 / 3), 0.3333);
  assert.equal(round(0.1 + 0.2), 0.3);
  assert.equal(round(1.23456, 2), 1.23);
});

// ---------------------------------------------------------------------------
// loadBaseline
// ---------------------------------------------------------------------------

test("loadBaseline: valid file round-trips", () => {
  const p = tmpFile("baseline.json", JSON.stringify({
    schema: BASELINE_SCHEMA, generated_at: "2026-01-01T00:00:00Z", git_sha: "abc123",
    suites: { s1: { score: 1, cases: {} } },
  }));
  const doc = loadBaseline(p);
  assert.equal(doc.git_sha, "abc123");
  assert.equal(doc.suites.s1.score, 1);
});

test("loadBaseline: missing file throws", () => {
  assert.throws(() => loadBaseline("/nonexistent/path/baseline.json"), /cannot read baseline/);
});

test("loadBaseline: invalid JSON throws", () => {
  const p = tmpFile("bad.json", "{ not json");
  assert.throws(() => loadBaseline(p), /not valid JSON/);
});

test("loadBaseline: missing 'suites' key throws (corrupt baseline)", () => {
  const p = tmpFile("no-suites.json", JSON.stringify({ schema: BASELINE_SCHEMA }));
  assert.throws(() => loadBaseline(p), /missing a 'suites' map/);
});

// ---------------------------------------------------------------------------
// aggregateSuite
// ---------------------------------------------------------------------------

test("aggregateSuite: arithmetic mean, rounded to 4dp", () => {
  assert.equal(aggregateSuite([1, 0, 1]), 0.6667);
  assert.equal(aggregateSuite([1, 1, 1]), 1);
});

test("aggregateSuite: non-numeric entries (unrecorded judge cases) are dropped, never scored 0", () => {
  assert.equal(aggregateSuite([1, null, 1]), 1);
  assert.equal(aggregateSuite([null, undefined]), null);
});

test("aggregateSuite: empty array => null (nothing scoreable, not a fabricated 0)", () => {
  assert.equal(aggregateSuite([]), null);
});

// ---------------------------------------------------------------------------
// computeDeltas
// ---------------------------------------------------------------------------

test("computeDeltas: normal delta vs a recorded baseline score", () => {
  const deltas = computeDeltas({ s1: 0.9 }, { suites: { s1: { score: 0.8 } } });
  assert.deepEqual(deltas.s1, { score: 0.9, baseline: 0.8, delta: 0.1 });
});

test("computeDeltas: current score null => delta null, honest 'nothing to score yet' note", () => {
  const deltas = computeDeltas({ s1: null }, { suites: { s1: { score: 0.8 } } });
  assert.equal(deltas.s1.score, null);
  assert.equal(deltas.s1.delta, null);
  assert.match(deltas.s1.note, /nothing to score/);
});

test("computeDeltas: suite missing from baseline => delta null, 'rebaseline to include' note, never manufactures DEGRADE", () => {
  const deltas = computeDeltas({ s1: 1 }, { suites: {} });
  assert.equal(deltas.s1.score, 1);
  assert.equal(deltas.s1.baseline, null);
  assert.equal(deltas.s1.delta, null);
  assert.match(deltas.s1.note, /no baseline/);
});

// ---------------------------------------------------------------------------
// computeDeltas — case-ID INTERSECTION (MEDIUM-2 fix): a case added/removed
// since the baseline was cut must never manufacture a DEGRADE by itself.
// ---------------------------------------------------------------------------

test("computeDeltas: a case removed from current (vs baseline) is excluded from the mean, not scored as a failure", () => {
  // Baseline had c1(1), c2(1) => baseline suite score 1. Current only has
  // c1(1) (c2 dropped, e.g. a flaky/renamed case) => naive whole-suite delta
  // would still be 0 since c1 alone means 1 too, so use a case that WOULD
  // manufacture a DEGRADE under the old "compare over each side's own set"
  // logic: current keeps c1(1) and gains c3(0), losing c2(1) from baseline.
  const current = {
    s1: { score: 0.5, cases: { c1: { score: 1 }, c3: { score: 0 } } },
  };
  const baseline = {
    suites: { s1: { score: 1, cases: { c1: { score: 1 }, c2: { score: 1 } } } },
  };
  const deltas = computeDeltas(current, baseline);
  // Intersection is {c1} only: curMean=1, baseMean=1 => delta 0 (NEUTRAL),
  // NOT -0.5 (which the old whole-suite-mean comparison would have produced).
  assert.equal(deltas.s1.delta, 0);
  assert.deepEqual(deltas.s1.added, ["c3"]);
  assert.deepEqual(deltas.s1.removed, ["c2"]);
  // Reported score/baseline still reflect the real (full-case) suite scores.
  assert.equal(deltas.s1.score, 0.5);
  assert.equal(deltas.s1.baseline, 1);
});

test("computeDeltas: an actual regression on a case present on BOTH sides still shows up in the intersection delta", () => {
  const current = { s1: { score: 0, cases: { c1: { score: 0 } } } };
  const baseline = { suites: { s1: { score: 1, cases: { c1: { score: 1 } } } } };
  const deltas = computeDeltas(current, baseline);
  assert.equal(deltas.s1.delta, -1);
});

test("computeDeltas: no cases shared with baseline => delta null with a distinct note, still reports added/removed", () => {
  const current = { s1: { score: 1, cases: { c3: { score: 1 } } } };
  const baseline = { suites: { s1: { score: 1, cases: { c2: { score: 1 } } } } };
  const deltas = computeDeltas(current, baseline);
  assert.equal(deltas.s1.delta, null);
  assert.match(deltas.s1.note, /no cases shared/);
  assert.deepEqual(deltas.s1.added, ["c3"]);
  assert.deepEqual(deltas.s1.removed, ["c2"]);
});

test("computeDeltas: asymmetric recording (judge case null-in-baseline, recorded-now) must be excluded from BOTH means, not just filtered independently (the computeDeltas fix — would fail on the pre-fix code)", () => {
  // A suite with one deterministic case (score 1 both sides) and one judge
  // case that was --no-judge rebaselined (score:null in baseline) but is
  // recorded now (score 0.6). The pre-fix code filtered curShared/baseShared
  // INDEPENDENTLY: J1 would enter curMean (0.6 is numeric) while being absent
  // from baseMean (null is not numeric) — an asymmetric mean, producing
  // curMean=0.8, baseMean=1.0, delta=-0.2 (spurious DEGRADE). The fix must
  // exclude J1 from BOTH means since it isn't numeric on both sides, leaving
  // only D1 in the intersection: curMean=1, baseMean=1, delta=0.
  const current = {
    s1: {
      score: 0.8,
      cases: { D1: { score: 1 }, J1: { score: 0.6, recorded: true } },
    },
  };
  const baseline = {
    suites: {
      s1: {
        score: 1,
        cases: { D1: { score: 1 }, J1: { score: null, recorded: false, note: "--no-judge set (case J1)" } },
      },
    },
  };
  const deltas = computeDeltas(current, baseline);
  assert.equal(deltas.s1.delta, 0, JSON.stringify(deltas.s1));
  // J1 is present on both sides (not an ID-set difference), so it must NOT
  // show up in added/removed either — it's excluded from the delta purely
  // because it isn't numeric on both sides.
  assert.equal(deltas.s1.added, undefined);
  assert.equal(deltas.s1.removed, undefined);
});

test("computeDeltas: falls back to legacy whole-suite delta when either side has no case map", () => {
  const deltas = computeDeltas({ s1: { score: 0.9 } }, { suites: { s1: { score: 0.8 } } });
  assert.deepEqual(deltas.s1, { score: 0.9, baseline: 0.8, delta: round(0.1) });
});

// ---------------------------------------------------------------------------
// computeVerdict — band boundaries, flip override, empty selection
// ---------------------------------------------------------------------------

const BAND = 0.05;

test("computeVerdict: delta exactly -band => NEUTRAL (band is inclusive)", () => {
  const deltas = { s1: { score: 0.75, baseline: 0.8, delta: -0.05 } };
  const v = computeVerdict(deltas, { band: BAND });
  assert.equal(v.verdict, "NEUTRAL");
});

test("computeVerdict: delta just past -band (-band - 0.0001) => DEGRADE", () => {
  const deltas = { s1: { score: 0.7499, baseline: 0.8, delta: -0.0501 } };
  const v = computeVerdict(deltas, { band: BAND });
  assert.equal(v.verdict, "DEGRADE");
  assert.match(v.reason, /below band/);
});

test("computeVerdict: delta exactly +band => NEUTRAL", () => {
  const deltas = { s1: { score: 0.85, baseline: 0.8, delta: 0.05 } };
  const v = computeVerdict(deltas, { band: BAND });
  assert.equal(v.verdict, "NEUTRAL");
});

test("computeVerdict: delta just past +band => UPGRADE", () => {
  const deltas = { s1: { score: 0.8501, baseline: 0.8, delta: 0.0501 } };
  const v = computeVerdict(deltas, { band: BAND });
  assert.equal(v.verdict, "UPGRADE");
  assert.match(v.reason, /above band/);
});

test("computeVerdict: any deterministic flip => DEGRADE regardless of positive deltas (band never excuses a flip)", () => {
  const deltas = { s1: { score: 1, baseline: 0.5, delta: 0.5 } };
  const v = computeVerdict(deltas, { band: BAND, deterministicFlips: 1 });
  assert.equal(v.verdict, "DEGRADE");
  assert.match(v.reason, /flipped pass.*fail/);
});

test("computeVerdict: missingCases (a baseline case silently dropped this run) => DEGRADE, same as a flip (MEDIUM-3)", () => {
  const deltas = { s1: { score: 1, baseline: 0.5, delta: 0.5 } };
  const v = computeVerdict(deltas, { band: BAND, missingCases: 1 });
  assert.equal(v.verdict, "DEGRADE");
  assert.match(v.reason, /missing from this run/);
});

test("computeVerdict: a suite with delta:null (missing baseline) is excluded — never manufactures DEGRADE", () => {
  const deltas = {
    s1: { score: 1, baseline: null, delta: null, note: "no baseline — rebaseline to include" },
    s2: { score: 0.8, baseline: 0.8, delta: 0 },
  };
  const v = computeVerdict(deltas, { band: BAND });
  assert.equal(v.verdict, "NEUTRAL");
});

test("computeVerdict: unrecorded-judge like-for-like — a null-delta suite never triggers DEGRADE even with other suites in band", () => {
  const deltas = {
    judge_suite: { score: null, baseline: null, delta: null, note: "no cases yet — nothing to score yet" },
    det_suite: { score: 1, baseline: 1, delta: 0 },
  };
  const v = computeVerdict(deltas, { band: BAND });
  assert.equal(v.verdict, "NEUTRAL");
});

test("computeVerdict: emptySelection => NEUTRAL with 'no suites selected', independent of deltas content", () => {
  const v = computeVerdict({}, { band: BAND, emptySelection: true });
  assert.equal(v.verdict, "NEUTRAL");
  assert.match(v.reason, /no suites selected/);
});

test("computeVerdict: no suites contributed a comparable delta (all null) => NEUTRAL with distinct reason", () => {
  const deltas = { s1: { score: null, baseline: null, delta: null } };
  const v = computeVerdict(deltas, { band: BAND });
  assert.equal(v.verdict, "NEUTRAL");
  assert.match(v.reason, /no suites contributed a comparable delta/);
});

test("computeVerdict: default band is 0.05 when omitted", () => {
  const deltas = { s1: { score: 0.94, baseline: 1, delta: -0.06 } };
  const v = computeVerdict(deltas, {});
  assert.equal(v.band, 0.05);
  assert.equal(v.verdict, "DEGRADE");
});

// ---------------------------------------------------------------------------
// medianOf / spreadOf — judge k-tier support
// ---------------------------------------------------------------------------

test("medianOf: odd count picks the middle value", () => {
  assert.equal(medianOf([0.2, 0.9, 0.5]), 0.5);
});

test("medianOf: even count averages the two middle values", () => {
  assert.equal(medianOf([0.2, 0.4, 0.6, 0.8]), 0.5);
});

test("medianOf: empty array => null", () => {
  assert.equal(medianOf([]), null);
});

test("spreadOf: max - min, rounded", () => {
  assert.equal(spreadOf([0.2, 0.9, 0.5]), 0.7);
  assert.equal(spreadOf([]), 0);
});

// ---------------------------------------------------------------------------
// resolveGateMode — precedence: env on/off always wins, else gate.mode.
// ---------------------------------------------------------------------------

test("resolveGateMode: EVAL_BLOCKING=on -> blocking, regardless of gate.mode", () => {
  assert.equal(resolveGateMode({ envValue: "on", gate: { mode: "advisory" } }), "blocking");
  assert.equal(resolveGateMode({ envValue: "on", gate: { mode: "blocking" } }), "blocking");
});

test("resolveGateMode: EVAL_BLOCKING=off -> advisory, regardless of gate.mode", () => {
  assert.equal(resolveGateMode({ envValue: "off", gate: { mode: "advisory" } }), "advisory");
  assert.equal(resolveGateMode({ envValue: "off", gate: { mode: "blocking" } }), "advisory");
});

test("resolveGateMode: unset envValue falls through to gate.mode", () => {
  assert.equal(resolveGateMode({ envValue: undefined, gate: { mode: "advisory" } }), "advisory");
  assert.equal(resolveGateMode({ envValue: undefined, gate: { mode: "blocking" } }), "blocking");
});

test("resolveGateMode: unset envValue and no gate -> advisory default", () => {
  assert.equal(resolveGateMode({ envValue: undefined, gate: undefined }), "advisory");
});

// ---------------------------------------------------------------------------
// countGreenBaselines — green-baseline count for burn-in.
// ---------------------------------------------------------------------------

const SCHEMA = "detent-eval-v1";

function ledgerLine(fields) {
  return JSON.stringify({
    schema: SCHEMA,
    verdict: "NEUTRAL",
    git_sha: "aaa",
    baseline_sha: "base1",
    suites: { "some-suite": { score: 1, baseline: 1, delta: 0 } },
    ...fields,
  });
}

test("countGreenBaselines: empty ledger text -> 0", () => {
  assert.equal(countGreenBaselines("", { baselineSha: "base1", schema: SCHEMA }), 0);
});

test("countGreenBaselines: counts NEUTRAL/UPGRADE lines matching baseline_sha, dedup by git_sha", () => {
  const text = [
    ledgerLine({ git_sha: "aaa" }),
    ledgerLine({ git_sha: "bbb", verdict: "UPGRADE" }),
    ledgerLine({ git_sha: "aaa" }), // duplicate sha — dedup'd
  ].join("\n");
  assert.equal(countGreenBaselines(text, { baselineSha: "base1", schema: SCHEMA }), 2);
});

test("countGreenBaselines: DEGRADE lines are excluded", () => {
  const text = [ledgerLine({ git_sha: "aaa", verdict: "DEGRADE" })].join("\n");
  assert.equal(countGreenBaselines(text, { baselineSha: "base1", schema: SCHEMA }), 0);
});

test("countGreenBaselines: lines with a different baseline_sha are excluded (rebaseline resets burn-in)", () => {
  const text = [ledgerLine({ git_sha: "aaa", baseline_sha: "some-other-baseline" })].join("\n");
  assert.equal(countGreenBaselines(text, { baselineSha: "base1", schema: SCHEMA }), 0);
});

test("countGreenBaselines: schema-less lines (bench ledger lines) are excluded", () => {
  const text = [JSON.stringify({ verdict: "NEUTRAL", git_sha: "aaa", baseline_sha: "base1" })].join("\n");
  assert.equal(countGreenBaselines(text, { baselineSha: "base1", schema: SCHEMA }), 0);
});

test("countGreenBaselines: git_sha:null lines are skipped (can't attribute)", () => {
  const text = [ledgerLine({ git_sha: null })].join("\n");
  assert.equal(countGreenBaselines(text, { baselineSha: "base1", schema: SCHEMA }), 0);
});

test("countGreenBaselines: a garbage (non-JSON) line is skipped with a stderr warning, not thrown", () => {
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { stderrChunks.push(String(chunk)); return origWrite(chunk, ...rest); };
  let n;
  try {
    const text = ["this is not json", ledgerLine({ git_sha: "aaa" })].join("\n");
    n = countGreenBaselines(text, { baselineSha: "base1", schema: SCHEMA });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(n, 1);
  assert.match(stderrChunks.join(""), /unparsable ledger line/);
});

test("countGreenBaselines: baselineSha null matches a baseline_sha:null line (scratch/no-git baselines)", () => {
  const text = [ledgerLine({ git_sha: "aaa", baseline_sha: null })].join("\n");
  assert.equal(countGreenBaselines(text, { baselineSha: null, schema: SCHEMA }), 1);
});

test("countGreenBaselines: a NEUTRAL line with an empty suites map (no-op run, e.g. `--changed` with an empty diff) does NOT count", () => {
  const text = [ledgerLine({ git_sha: "aaa", suites: {} })].join("\n");
  assert.equal(countGreenBaselines(text, { baselineSha: "base1", schema: SCHEMA }), 0);
});

test("countGreenBaselines: a NEUTRAL line with no suites field at all does NOT count", () => {
  const text = [JSON.stringify({ schema: SCHEMA, verdict: "NEUTRAL", git_sha: "aaa", baseline_sha: "base1" })].join("\n");
  assert.equal(countGreenBaselines(text, { baselineSha: "base1", schema: SCHEMA }), 0);
});
