// Integration test for engine/eval/eval.mjs's runEval() — the one gap MEDIUM-4
// in the PR #44 principal review flagged: nothing exercised the FULL grading
// path (config -> case grading -> baseline compare -> verdict -> exit-code
// mapping) end to end. Hermetic: everything lives under a scratch DETENT_ROOT
// built with mkdtempSync; no live model (--no-judge / no judge cases at all),
// no network, no dependency on this repo's own evals/config.yaml or
// evals/baseline.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval, EvalRefusal } from "../eval.mjs";

// ---------------------------------------------------------------------------
// Scratch DETENT_ROOT builder — one suite ("test-suite"), one deterministic
// case ("case1") that grades via the real "ledger-parseable" check
// (graders/deterministic.mjs) against <root>/benchmarks/ledger.jsonl. That
// check is trivially controllable: an absent/empty ledger passes, a ledger
// with a non-JSON line fails — perfect for flipping a case from pass to fail
// between the rebaseline run and the "current" run, with zero model/network
// dependency.
// ---------------------------------------------------------------------------

function mkScratchRoot(gate) {
  const root = mkdtempSync(join(tmpdir(), "eval-integration-"));
  mkdirSync(join(root, "evals", "cases", "test-suite"), { recursive: true });
  const gateLines = gate
    ? ["", "gate:", `  mode: ${gate.mode}`, `  burn_in_prs: ${gate.burn_in_prs}`]
    : [];
  writeFileSync(
    join(root, "evals", "config.yaml"),
    [
      "band: 0.05",
      "k: 1",
      "judge_max_cases: 5",
      ...gateLines,
      "",
      "suites:",
      "  test-suite:",
      "    select:",
      '      - "dummy/**"',
      "    cases_dir: evals/cases/test-suite",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "evals", "cases", "test-suite", "case1.json"),
    JSON.stringify({ id: "case1", suite: "test-suite", check: "ledger-parseable", params: {} }, null, 2) + "\n",
  );
  return root;
}

// ---------------------------------------------------------------------------
// Judge-only-degrade fixture (tier split): hermetic, no model. Rebaselines
// case1 normally (deterministic, pass:true, score:1), then rewrites the
// committed baseline so case1 carries `pass: null` — exactly the shape a
// real judge case has (eval.mjs:401, "never fabricate pass/fail") — while
// keeping `score: 1`. The ledger is then corrupted so case1 fails THIS run
// (score 0). Net effect: deterministicFlips===0 (countDeterministicFlips
// requires baseline `pass === true`, and this baseline's `pass` is `null`),
// missingBaselineCases===0 (case1 is still present, just failing), and the
// suite delta is -1 (< -band) — a DEGRADE via verdict.mjs rule 2 ("below
// band"), never rule 1 (flip/missing). This is the "judge tier" signal the
// burn-in gate exists to shield, simulated without any judge grading.
// ---------------------------------------------------------------------------
function mkJudgeOnlyDegradeFixture(root) {
  runEval({ detentRoot: root, flags: { rebaseline: true } });
  const baselinePath = join(root, "evals", "baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  baseline.suites["test-suite"].cases.case1.pass = null;
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  mkdirSync(join(root, "benchmarks"), { recursive: true });
  writeFileSync(join(root, "benchmarks", "ledger.jsonl"), "this is not json\n");
}

test("integration: full grading path — a case flipping pass->fail vs baseline yields DEGRADE with deterministic_flips===1", () => {
  const root = mkScratchRoot();
  try {
    // 1. Rebaseline with NO benchmarks/ledger.jsonl present — ledger-parseable
    //    passes trivially ("absent -> trivially valid"), so case1 is pass:true
    //    in the committed baseline.
    const rebaselineResult = runEval({ detentRoot: root, flags: { rebaseline: true } });
    assert.equal(rebaselineResult.rebaselined, true);
    assert.equal(rebaselineResult.suites["test-suite"].cases.case1.pass, true);

    // 2. Simulate the regression: benchmarks/ledger.jsonl now contains a line
    //    that isn't valid JSON, so ledger-parseable now fails this case.
    mkdirSync(join(root, "benchmarks"), { recursive: true });
    writeFileSync(join(root, "benchmarks", "ledger.jsonl"), "this is not json\n");

    // 3. Run the grader path again (deterministic-only, no judge tier, no
    //    model/network) against the SAME baseline.
    const result = runEval({
      detentRoot: root,
      flags: { suite: "test-suite", "no-judge": true },
    });

    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.deterministic_flips, 1);
    assert.match(result.suites["test-suite"].cases.case1.checks[0].detail, /not valid JSON/);
    // Advisory by default (EVAL_BLOCKING unset) — a DEGRADE never fails the
    // process unless the CI job explicitly opts in.
    assert.equal(result.exit_code, 0);
    assert.match(result.next_step, /DEGRADE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: EVAL_BLOCKING=on maps a DEGRADE verdict to exit_code 2 (advisory -> blocking)", () => {
  const root = mkScratchRoot();
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    runEval({ detentRoot: root, flags: { rebaseline: true } });
    mkdirSync(join(root, "benchmarks"), { recursive: true });
    writeFileSync(join(root, "benchmarks", "ledger.jsonl"), "this is not json\n");

    process.env.EVAL_BLOCKING = "on";
    const blocked = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(blocked.verdict, "DEGRADE");
    assert.equal(blocked.deterministic_flips, 1);
    assert.equal(blocked.exit_code, 2);
    assert.match(blocked.next_step, /blocked/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: no regression (ledger stays absent) => NEUTRAL, deterministic_flips===0, exit_code 0", () => {
  const root = mkScratchRoot();
  try {
    runEval({ detentRoot: root, flags: { rebaseline: true } });
    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "NEUTRAL");
    assert.equal(result.deterministic_flips, 0);
    assert.equal(result.exit_code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gate — advisory -> blocking after burn-in (roadmap [4/8]).
// ---------------------------------------------------------------------------

// NOTE (tier split, spec-mandated rewrite — not a weaken-to-pass): this test
// used to assert that a DEGRADE with an empty ledger (0 green baselines)
// stayed NOT armed / exit 0 during burn-in. It manufactured its DEGRADE via
// the deterministic corrupt-ledger trick (a pass->fail flip), so under the
// new tier split that DEGRADE is now correctly ARMED IMMEDIATELY — burn-in
// only ever shields the judge tier, never a deterministic flip. The old
// assertions were therefore testing behavior the spec explicitly changes;
// this test is rewritten (not preserved) into the deterministic-tier case
// below, and a new judge-only-tier test captures the burn-in-shielded path
// the old test's name implied but its fixture never actually exercised.
test("integration: gate mode:blocking, burn_in_prs:2, deterministic flip during burn-in -> ARMED immediately (deterministic tier never waits for burn-in) -> exit_code 2", () => {
  const root = mkScratchRoot({ mode: "blocking", burn_in_prs: 2 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    delete process.env.EVAL_BLOCKING;
    runEval({ detentRoot: root, flags: { rebaseline: true } });
    // Simulate the regression (same mechanism as the first test above), with
    // NO green ledger lines pre-seeded — burn-in has not accrued at all.
    mkdirSync(join(root, "benchmarks"), { recursive: true });
    writeFileSync(join(root, "benchmarks", "ledger.jsonl"), "this is not json\n");

    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.deterministic_flips, 1);
    assert.equal(result.gate.mode, "blocking");
    assert.equal(result.gate.armed, true);
    assert.equal(result.gate.green_baselines, 0);
    assert.equal(result.exit_code, 2);
    assert.match(result.next_step, /^blocked:/);
    assert.match(result.next_step, /deterministic/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: gate mode:blocking, burn_in_prs:2, judge-only DEGRADE during burn-in -> NOT armed (judge tier IS shielded by burn-in) -> exit_code 0", () => {
  const root = mkScratchRoot({ mode: "blocking", burn_in_prs: 2 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    delete process.env.EVAL_BLOCKING;
    mkJudgeOnlyDegradeFixture(root);

    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.deterministic_flips, 0);
    assert.equal(result.missing_baseline_cases, 0);
    assert.equal(result.gate.mode, "blocking");
    assert.equal(result.gate.armed, false);
    assert.equal(result.gate.green_baselines, 0);
    assert.equal(result.exit_code, 0);
    assert.match(result.next_step, /burn-in/);
    assert.match(result.next_step, /judge-driven/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: gate mode:blocking, burn_in_prs:2, judge-only DEGRADE with burn-in MET (2 green ledger lines) -> ARMED -> exit_code 2 (README exit-paths row 2)", () => {
  const root = mkScratchRoot({ mode: "blocking", burn_in_prs: 2 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    delete process.env.EVAL_BLOCKING;
    mkJudgeOnlyDegradeFixture(root);

    // Seed burn-in on top of the fixture's corrupt ledger line: two green
    // (NEUTRAL, baseline_sha:null — matching this git-less scratch root)
    // lines, appended after the corrupt one, are enough to satisfy
    // burn_in_prs:2. Once burn-in is met, even a judge-only DEGRADE (no
    // deterministic flips, no missing cases) must arm the gate.
    const ledgerPath = join(root, "benchmarks", "ledger.jsonl");
    const corruptLedgerText = readFileSync(ledgerPath, "utf8");
    const greenLines = [
      JSON.stringify({
        schema: "detent-eval-v1", verdict: "NEUTRAL", git_sha: "aaa", baseline_sha: null,
        suites: { "test-suite": { score: 1 } },
      }),
      JSON.stringify({
        schema: "detent-eval-v1", verdict: "NEUTRAL", git_sha: "bbb", baseline_sha: null,
        suites: { "test-suite": { score: 1 } },
      }),
    ];
    writeFileSync(ledgerPath, corruptLedgerText.trimEnd() + "\n" + greenLines.join("\n") + "\n");

    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.deterministic_flips, 0);
    assert.equal(result.missing_baseline_cases, 0);
    assert.equal(result.gate.mode, "blocking");
    assert.equal(result.gate.green_baselines, 2);
    assert.equal(result.gate.armed, true);
    assert.equal(result.exit_code, 2);
    assert.match(result.next_step, /^blocked:/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: gate mode:blocking, burn_in_prs:2, 2 green ledger lines vs baseline -> armed -> DEGRADE exit_code 2 (and warn-skips the bad line)", () => {
  const root = mkScratchRoot({ mode: "blocking", burn_in_prs: 2 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    delete process.env.EVAL_BLOCKING;
    const rebaselineResult = runEval({ detentRoot: root, flags: { rebaseline: true } });
    assert.equal(rebaselineResult.git_sha, null, "scratch root has no git repo — baseline_sha is null");

    mkdirSync(join(root, "benchmarks"), { recursive: true });
    const greenSuites = { "test-suite": { score: 1, baseline: 1, delta: 0 } };
    const greenLines = [
      JSON.stringify({ schema: "detent-eval-v1", verdict: "NEUTRAL", git_sha: "aaa", baseline_sha: null, suites: greenSuites }),
      JSON.stringify({ schema: "detent-eval-v1", verdict: "NEUTRAL", git_sha: "bbb", baseline_sha: null, suites: greenSuites }),
    ];
    writeFileSync(
      join(root, "benchmarks", "ledger.jsonl"),
      [...greenLines, "this is not json"].join("\n") + "\n",
    );

    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { stderrChunks.push(String(chunk)); return origWrite(chunk, ...rest); };
    let result;
    try {
      result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.exit_code, 2);
    assert.equal(result.gate.mode, "blocking");
    assert.equal(result.gate.green_baselines, 2);
    assert.equal(result.gate.armed, true);
    assert.match(result.next_step, /blocked/);
    assert.match(stderrChunks.join(""), /unparsable ledger line/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: EVAL_BLOCKING=on bypasses burn-in entirely (armed immediately) even with an empty ledger vs a configured burn_in_prs -> exit_code 2", () => {
  const root = mkScratchRoot({ mode: "advisory", burn_in_prs: 5 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    runEval({ detentRoot: root, flags: { rebaseline: true } });
    mkdirSync(join(root, "benchmarks"), { recursive: true });
    // Regression, and ZERO green ledger lines — burn-in has not accrued at
    // all (0/5). Without the env override this would be advisory (see the
    // burn-in test above). EVAL_BLOCKING=on must still force exit 2 — the
    // operator's explicit override is a true escape hatch, not gated by
    // burn_in_prs.
    writeFileSync(join(root, "benchmarks", "ledger.jsonl"), "this is not json\n");

    process.env.EVAL_BLOCKING = "on";
    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.gate.mode, "blocking");
    assert.equal(result.gate.green_baselines, 0);
    assert.equal(result.gate.armed, true);
    assert.equal(result.exit_code, 2);
    assert.match(result.next_step, /blocked/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: EVAL_BLOCKING=on also forces blocking+armed for a judge-only DEGRADE (tier split: env override bypasses burn-in for BOTH tiers, not just the deterministic one)", () => {
  const root = mkScratchRoot({ mode: "advisory", burn_in_prs: 5 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    mkJudgeOnlyDegradeFixture(root);

    process.env.EVAL_BLOCKING = "on";
    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.deterministic_flips, 0);
    assert.equal(result.gate.mode, "blocking");
    assert.equal(result.gate.armed, true);
    assert.equal(result.exit_code, 2);
    assert.match(result.next_step, /^blocked:/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: EVAL_BLOCKING=off overrides a blocking config -> advisory, exit_code 0", () => {
  const root = mkScratchRoot({ mode: "blocking", burn_in_prs: 0 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    runEval({ detentRoot: root, flags: { rebaseline: true } });
    mkdirSync(join(root, "benchmarks"), { recursive: true });
    writeFileSync(join(root, "benchmarks", "ledger.jsonl"), "this is not json\n");

    process.env.EVAL_BLOCKING = "off";
    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.gate.mode, "advisory");
    assert.equal(result.gate.armed, false);
    assert.equal(result.exit_code, 0);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: EVAL_BLOCKING=off forces advisory even for a deterministic flip during burn-in (tier split: env=off beats the new deterministic immediate-block)", () => {
  const root = mkScratchRoot({ mode: "blocking", burn_in_prs: 5 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    runEval({ detentRoot: root, flags: { rebaseline: true } });
    mkdirSync(join(root, "benchmarks"), { recursive: true });
    writeFileSync(join(root, "benchmarks", "ledger.jsonl"), "this is not json\n");

    process.env.EVAL_BLOCKING = "off";
    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.deterministic_flips, 1);
    assert.equal(result.gate.mode, "advisory");
    assert.equal(result.gate.armed, false);
    assert.equal(result.exit_code, 0);
    assert.match(result.next_step, /advisory only/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: invalid gate.mode in evals/config.yaml -> EvalRefusal (never a silent fallback)", () => {
  const root = mkScratchRoot({ mode: "bogus", burn_in_prs: 0 });
  try {
    assert.throws(
      () => runEval({ detentRoot: root, flags: { rebaseline: true } }),
      (e) => e instanceof EvalRefusal && /gate\.mode/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Judge case with prompt_path + include — the per-skill suites' shape.
// Hermetic: uses an injected __judgeExecutor, never a real `claude` spawn.
// ---------------------------------------------------------------------------

function mkScratchRootWithJudgeCase() {
  const root = mkdtempSync(join(tmpdir(), "eval-integration-judge-"));
  mkdirSync(join(root, "evals", "cases", "judge-suite"), { recursive: true });
  mkdirSync(join(root, "skills", "widget"), { recursive: true });
  writeFileSync(
    join(root, "evals", "config.yaml"),
    [
      "band: 0.05",
      "k: 1",
      "judge_max_cases: 5",
      "",
      "suites:",
      "  judge-suite:",
      "    select:",
      '      - "dummy/**"',
      "    cases_dir: evals/cases/judge-suite",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "evals", "cases", "judge-suite", "rubric.md"), "RUBRIC-MARKER: grade the included skill.\n");
  writeFileSync(join(root, "skills", "widget", "SKILL.md"), "INCLUDE-MARKER: widget skill body.\n");
  writeFileSync(
    join(root, "evals", "cases", "judge-suite", "case1.json"),
    JSON.stringify({
      id: "case1",
      suite: "judge-suite",
      grader: "judge",
      prompt_path: "evals/cases/judge-suite/rubric.md",
      include: ["skills/widget/SKILL.md"],
    }, null, 2) + "\n",
  );
  return root;
}

test("integration: judge case with prompt_path+include — injected executor receives rubric text AND included file content", () => {
  const root = mkScratchRootWithJudgeCase();
  try {
    runEval({ detentRoot: root, flags: { rebaseline: true, "no-judge": true } });
    const seenPrompts = [];
    const executor = ({ prompt }) => {
      seenPrompts.push(prompt);
      return { stdout: '{"score": 0.9, "reasoning": "looks fine"}' };
    };
    const result = runEval({
      detentRoot: root,
      flags: { suite: "judge-suite", __judgeExecutor: executor },
    });
    assert.equal(seenPrompts.length, 1);
    assert.match(seenPrompts[0], /RUBRIC-MARKER/);
    assert.match(seenPrompts[0], /INCLUDE-MARKER/);
    assert.match(seenPrompts[0], /--- skills\/widget\/SKILL\.md ---/);
    assert.equal(result.suites["judge-suite"].cases.case1.score, 0.9);
    assert.equal(result.suites["judge-suite"].cases.case1.recorded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: judge case with prompt_path+include — --no-judge leaves it {recorded:false} and the suite NEUTRAL vs its own rebaseline", () => {
  const root = mkScratchRootWithJudgeCase();
  try {
    const rebaselineResult = runEval({ detentRoot: root, flags: { rebaseline: true, "no-judge": true } });
    assert.equal(rebaselineResult.suites["judge-suite"].cases.case1.recorded, false);
    assert.equal(rebaselineResult.suites["judge-suite"].cases.case1.score, null);

    const result = runEval({ detentRoot: root, flags: { suite: "judge-suite", "no-judge": true } });
    assert.equal(result.suites["judge-suite"].cases.case1.recorded, false);
    assert.equal(result.verdict, "NEUTRAL", JSON.stringify(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: judge case with a missing prompt_path file => hard throw (never a silent {recorded:false})", () => {
  const root = mkScratchRootWithJudgeCase();
  try {
    rmSync(join(root, "evals", "cases", "judge-suite", "rubric.md"));
    assert.throws(
      () => runEval({ detentRoot: root, flags: { suite: "judge-suite", "no-judge": true } }),
      /cannot read prompt_path/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MEDIUM-3 (gate-evasion) — a baseline-known case entirely missing from the
// current run (not just failing) must ALSO be treated as a regression, never
// silently dropped.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Judge case with an `anchors` dimension — the calibration-anchor injection
// path, plus the "advisory-not-gating" and "seeded direction" guarantees.
// ---------------------------------------------------------------------------

function mkScratchRootWithAnchoredJudgeCase() {
  const root = mkdtempSync(join(tmpdir(), "eval-integration-anchors-"));
  mkdirSync(join(root, "evals", "cases", "judge-suite"), { recursive: true });
  mkdirSync(join(root, "evals", "calibration", "widget"), { recursive: true });
  writeFileSync(
    join(root, "evals", "config.yaml"),
    [
      "band: 0.05",
      "k: 1",
      "judge_max_cases: 5",
      "",
      "suites:",
      "  judge-suite:",
      "    select:",
      '      - "dummy/**"',
      "    cases_dir: evals/cases/judge-suite",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "evals", "calibration", "widget", "anchors.json"),
    JSON.stringify({
      schema: "detent-eval-anchors-v1",
      dimension: "widget",
      bands: { green: [0.75, 1], yellow: [0.4, 0.75], red: [0, 0.4] },
      anchors: [
        { label: "green", sample: "GREEN-ANCHOR-SAMPLE", expected_range: [0.8, 1] },
        { label: "yellow", sample: "YELLOW-ANCHOR-SAMPLE", expected_range: [0.5, 0.6] },
        { label: "red", sample: "RED-ANCHOR-SAMPLE", expected_range: [0, 0.2] },
      ],
    }, null, 2),
  );
  writeFileSync(join(root, "evals", "cases", "judge-suite", "rubric.md"), "RUBRIC-MARKER: grade the fixture.\n");
  writeFileSync(
    join(root, "evals", "cases", "judge-suite", "case1.json"),
    JSON.stringify({
      id: "case1",
      suite: "judge-suite",
      grader: "judge",
      prompt_path: "evals/cases/judge-suite/rubric.md",
      anchors: "widget",
    }, null, 2) + "\n",
  );
  return root;
}

test("integration: judge case with anchors — executor's received prompt contains the anchor samples, and the recorded result carries a band matching classifyBand", () => {
  const root = mkScratchRootWithAnchoredJudgeCase();
  try {
    runEval({ detentRoot: root, flags: { rebaseline: true, "no-judge": true } });
    const seenPrompts = [];
    const executor = ({ prompt }) => {
      seenPrompts.push(prompt);
      return { stdout: '{"score": 0.9, "reasoning": "matches green anchor"}' };
    };
    const result = runEval({ detentRoot: root, flags: { suite: "judge-suite", __judgeExecutor: executor } });
    assert.equal(seenPrompts.length, 1);
    assert.match(seenPrompts[0], /RUBRIC-MARKER/);
    assert.match(seenPrompts[0], /GREEN-ANCHOR-SAMPLE/);
    assert.match(seenPrompts[0], /YELLOW-ANCHOR-SAMPLE/);
    assert.match(seenPrompts[0], /RED-ANCHOR-SAMPLE/);
    const c = result.suites["judge-suite"].cases.case1;
    assert.equal(c.recorded, true);
    assert.equal(c.score, 0.9);
    assert.equal(c.band, "green");
    assert.equal(c.band_dimension, "widget");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: advisory-not-gating — a judge case rebaselined with --no-judge (score:null) never gates, even when a later run's judge score is LOW", () => {
  const root = mkScratchRootWithAnchoredJudgeCase();
  try {
    const rebaselineResult = runEval({ detentRoot: root, flags: { rebaseline: true, "no-judge": true } });
    assert.equal(rebaselineResult.suites["judge-suite"].cases.case1.recorded, false);
    assert.equal(rebaselineResult.suites["judge-suite"].cases.case1.score, null);

    const lowExecutor = () => ({ stdout: '{"score": 0.1, "reasoning": "matches red anchor"}' });
    const result = runEval({ detentRoot: root, flags: { suite: "judge-suite", __judgeExecutor: lowExecutor } });
    assert.equal(result.suites["judge-suite"].cases.case1.recorded, true);
    assert.equal(result.suites["judge-suite"].cases.case1.score, 0.1);
    // The suite delta must exclude this case (baseline side is score:null,
    // not numeric) — computeDeltas's numeric-on-both-sides intersection.
    assert.equal(result.suites["judge-suite"].delta, null, JSON.stringify(result.suites["judge-suite"]));
    assert.equal(result.verdict, "NEUTRAL", JSON.stringify(result));
    assert.equal(result.exit_code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: seeded direction — once a judge case IS seeded (rebaselined with a real recorded score), a later regression on that case is visible in the delta (NEUTRAL when unchanged, DEGRADE when it drops)", () => {
  const root = mkScratchRootWithAnchoredJudgeCase();
  try {
    const seedExecutor = () => ({ stdout: '{"score": 0.9, "reasoning": "matches green anchor"}' });
    runEval({ detentRoot: root, flags: { rebaseline: true, __judgeExecutor: seedExecutor } });

    const sameExecutor = () => ({ stdout: '{"score": 0.9, "reasoning": "still green"}' });
    const neutral = runEval({ detentRoot: root, flags: { suite: "judge-suite", __judgeExecutor: sameExecutor } });
    assert.equal(neutral.verdict, "NEUTRAL", JSON.stringify(neutral));

    const regressedExecutor = () => ({ stdout: '{"score": 0.3, "reasoning": "now yellow/red"}' });
    const degraded = runEval({ detentRoot: root, flags: { suite: "judge-suite", __judgeExecutor: regressedExecutor } });
    assert.equal(degraded.verdict, "DEGRADE", JSON.stringify(degraded));
    // CI's merge gate always runs --no-judge, so this DEGRADE is only ever
    // visible on a run where the judge actually ran — never in the gate job.
    assert.equal(degraded.exit_code, 0, "advisory by default (EVAL_BLOCKING unset)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a case spec referencing a missing anchors dimension hard-throws (never a silent {recorded:false})", () => {
  const root = mkScratchRootWithAnchoredJudgeCase();
  try {
    writeFileSync(
      join(root, "evals", "cases", "judge-suite", "case1.json"),
      JSON.stringify({
        id: "case1",
        suite: "judge-suite",
        grader: "judge",
        prompt_path: "evals/cases/judge-suite/rubric.md",
        anchors: "nonexistent-dimension",
      }, null, 2) + "\n",
    );
    assert.throws(
      () => runEval({ detentRoot: root, flags: { suite: "judge-suite", "no-judge": true } }),
      /cannot read calibration anchors/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a baseline case missing from the current run (e.g. its spec no longer parses as a case) => DEGRADE, loud on stderr", () => {
  const root = mkScratchRoot();
  try {
    runEval({ detentRoot: root, flags: { rebaseline: true } });

    // Corrupt case1's shape so it no longer matches either the deterministic
    // ({check:...}) or judge ({grader:"judge",...}) case shape — a one-char
    // typo, same class of bug MEDIUM-3 targets.
    writeFileSync(
      join(root, "evals", "cases", "test-suite", "case1.json"),
      JSON.stringify({ id: "case1", suite: "test-suite", chek: "ledger-parseable", params: {} }, null, 2) + "\n",
    );

    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { stderrChunks.push(String(chunk)); return origWrite(chunk, ...rest); };
    let result;
    try {
      result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.deterministic_flips, 0, "this is a MISSING case, not a pass->fail flip");
    assert.equal(result.missing_baseline_cases, 1);
    assert.match(result.next_step, /DEGRADE/);
    const stderrText = stderrChunks.join("");
    assert.match(stderrText, /REGRESSION/);
    assert.match(stderrText, /case1/);
    assert.match(stderrText, /neither a check case, a judge case, nor a known support file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: gate mode:blocking, burn_in_prs:2, missing baseline case (typo'd check key) during burn-in -> ARMED immediately (missing-case tier never waits for burn-in, MEDIUM-3 gate-evasion) -> exit_code 2", () => {
  const root = mkScratchRoot({ mode: "blocking", burn_in_prs: 2 });
  const prevBlocking = process.env.EVAL_BLOCKING;
  try {
    delete process.env.EVAL_BLOCKING;
    runEval({ detentRoot: root, flags: { rebaseline: true } });

    // Same corruption as the advisory-config missing-case test above (a
    // one-char typo'd `check` -> `chek` key, matching neither the
    // deterministic nor judge case shape), but now under a blocking gate
    // with an empty ledger (burn-in has not accrued at all: 0/2). A dropped
    // spec key must NOT get the burn-in grace window — this is the exact
    // gate-evasion vector the "a deterministic flip or missing baseline case
    // would have blocked" next_step text promises against.
    writeFileSync(
      join(root, "evals", "cases", "test-suite", "case1.json"),
      JSON.stringify({ id: "case1", suite: "test-suite", chek: "ledger-parseable", params: {} }, null, 2) + "\n",
    );

    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    assert.equal(result.verdict, "DEGRADE", JSON.stringify(result));
    assert.equal(result.deterministic_flips, 0, "this is a MISSING case, not a pass->fail flip");
    assert.equal(result.missing_baseline_cases, 1);
    assert.equal(result.gate.mode, "blocking");
    assert.equal(result.gate.green_baselines, 0);
    assert.equal(result.gate.armed, true);
    assert.equal(result.exit_code, 2);
    assert.match(result.next_step, /^blocked:/);
    assert.match(result.next_step, /deterministic regressions block immediately/);
  } finally {
    if (prevBlocking === undefined) delete process.env.EVAL_BLOCKING;
    else process.env.EVAL_BLOCKING = prevBlocking;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Single-root invariant — eval grades ONE checkout: the one its config, case
// specs, baseline and ledger live in. `--repo` used to split those apart
// (files-under-test from repoRoot, specs/baseline/ledger from detentRoot),
// which silently graded a foreign tree against this tree's specs: new pins
// went unexercised while the run still reported a clean NEUTRAL, and the
// ledger line it wrote carried the FOREIGN tree's git_sha, advancing this
// clone's burn-in with runs that never graded it.
// ---------------------------------------------------------------------------

test("integration: --repo is refused — eval always grades its own detent checkout", () => {
  const root = mkScratchRoot();
  const other = mkdtempSync(join(tmpdir(), "eval-otherrepo-"));
  try {
    assert.throws(
      () => runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true, repo: other } }),
      (e) => e instanceof EvalRefusal && /--repo/.test(e.message),
      "a split root must refuse loudly, never grade a foreign tree silently",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("integration: the ledger eval WRITES is the same file ledger-parseable READS", () => {
  const root = mkScratchRoot();
  try {
    // case1 grades `ledger-parseable` against <root>/benchmarks/ledger.jsonl.
    // Seed that exact file with a corrupt line: if the check reads the same
    // path runEval appends to, the case must FAIL. Under the old split these
    // were two different files, so the corruption was invisible.
    mkdirSync(join(root, "benchmarks"), { recursive: true });
    writeFileSync(join(root, "benchmarks", "ledger.jsonl"), "{not json\n");
    runEval({ detentRoot: root, flags: { rebaseline: true, "no-judge": true } });
    const result = runEval({ detentRoot: root, flags: { suite: "test-suite", "no-judge": true } });
    const c = result.suites["test-suite"].cases.case1;
    assert.equal(c.pass, false, "ledger-parseable must read the ledger runEval writes: " + JSON.stringify(c));
    // And the ledger eval reports appending to is that same seeded file — the
    // reader and the writer must never diverge again.
    assert.equal(result.ledger_path, join(root, "benchmarks", "ledger.jsonl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
