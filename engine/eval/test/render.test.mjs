// Unit tests for render.mjs — pure human renderer, no I/O. Every test builds
// a synthetic `result` shape (exactly what runEval returns, per its own
// contract) and asserts on the returned string only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHuman, renderRebaseline } from "../render.mjs";

test("renderHuman: NEUTRAL run says nothing got worse, nothing got better", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: ["context-adherence"] },
    suites: {
      "context-adherence": { score: 1, baseline: 1, delta: 0, cases: { "S1-1": { score: 1, pass: true, checks: [{ name: "skill-frontmatter", ok: true, detail: "ok" }] } } },
    },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
    baseline_sha: "abc1234",
    git_sha: "def5678",
    next_step: "review suites[].delta — NEUTRAL/UPGRADE need no action",
  };
  const out = renderHuman(result);
  assert.match(out, /VERDICT: NEUTRAL/);
  assert.match(out, /nothing got worse, nothing got better/);
  assert.match(out, /Regressions: none\. 0 check\(s\) flipped pass→fail; 0 baseline case\(s\) missing\./);
  assert.match(out, /the single JSON line on stdout/);
});

test("renderHuman: DEGRADE names the flipped case id and prints its exact check detail verbatim", () => {
  const result = {
    verdict: "DEGRADE",
    band: 0.05,
    selection: { mode: "suite", suites: ["context-adherence"] },
    suites: {
      "context-adherence": {
        score: 0.8333,
        baseline: 1,
        delta: -0.1667,
        cases: {
          "S1-1": {
            score: 0,
            pass: false,
            baseline_pass: true,
            checks: [{ name: "skill-frontmatter", ok: false, detail: "deslop: frontmatter has no non-empty description:" }],
          },
          "S1-2": { score: 1, pass: true, baseline_pass: true, checks: [{ name: "hooks-kill-switch", ok: true, detail: "ok" }] },
        },
      },
    },
    deterministic_flips: 1,
    missing_baseline_cases: 0,
    gate: { mode: "blocking", burn_in_prs: 5, green_baselines: 5, armed: true },
    baseline_sha: "abc1234",
    git_sha: "def5678",
    next_step: "blocked: verdict DEGRADE",
  };
  const out = renderHuman(result);
  assert.match(out, /VERDICT: DEGRADE/);
  assert.match(out, /S1-1 flipped pass→fail/);
  assert.match(out, /deslop: frontmatter has no non-empty description:/);
  assert.doesNotMatch(out, /S1-2 flipped/);
  assert.match(out, /Gate: blocking and ARMED/);
});

test("renderHuman: a case already failing at baseline (non-flip) is reported as failing, never called a flip", () => {
  const result = {
    verdict: "DEGRADE",
    band: 0.05,
    selection: { mode: "suite", suites: ["context-adherence"] },
    suites: {
      "context-adherence": {
        score: 0.5,
        baseline: 0.75,
        delta: -0.25,
        cases: {
          // Genuine flip — baseline pass was true, now false. Contributes to
          // deterministic_flips:1 below.
          "S1-1": {
            score: 0,
            pass: false,
            baseline_pass: true,
            checks: [{ name: "skill-frontmatter", ok: false, detail: "flip-detail: frontmatter regressed" }],
          },
          // Already failing at baseline (pass:false there too) — NOT a flip,
          // even though it's currently failing.
          "S1-2": {
            score: 0,
            pass: false,
            baseline_pass: false,
            checks: [{ name: "hooks-kill-switch", ok: false, detail: "preexisting-detail: still no kill switch" }],
          },
          // Brand-new case absent from baseline (no baseline_pass at all) —
          // also NOT a flip.
          "S1-3": {
            score: 0,
            pass: false,
            checks: [{ name: "new-case-check", ok: false, detail: "new-detail: brand-new case fails" }],
          },
        },
      },
    },
    deterministic_flips: 1,
    missing_baseline_cases: 0,
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /S1-1 flipped pass→fail/);
  assert.match(out, /S1-2 is failing:/);
  assert.doesNotMatch(out, /S1-2 flipped/);
  assert.match(out, /preexisting-detail: still no kill switch/);
  assert.match(out, /S1-3 is failing:/);
  assert.doesNotMatch(out, /S1-3 flipped/);
  assert.match(out, /new-detail: brand-new case fails/);
});

test("renderHuman: only failing (ok:false) check details are printed, passing checks on a failing case are omitted", () => {
  const result = {
    verdict: "DEGRADE",
    band: 0.05,
    selection: { mode: "suite", suites: ["context-adherence"] },
    suites: {
      "context-adherence": {
        score: 0.5,
        baseline: 1,
        delta: -0.5,
        cases: {
          "S1-1": {
            score: 0.5,
            pass: false,
            baseline_pass: true,
            checks: [
              { name: "skill-frontmatter", ok: false, detail: "actual-failure-detail: this one broke" },
              { name: "hooks-kill-switch", ok: true, detail: "passing-check-detail-should-not-appear" },
            ],
          },
        },
      },
    },
    deterministic_flips: 1,
    missing_baseline_cases: 0,
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /actual-failure-detail: this one broke/);
  assert.doesNotMatch(out, /passing-check-detail-should-not-appear/);
});

test("renderHuman: a null-score suite renders 'not scored yet', never 0, plus its note", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: ["self-feedback"] },
    suites: {
      "self-feedback": { score: null, baseline: null, delta: null, note: "no cases yet — nothing to score", cases: {} },
    },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /not scored yet/);
  assert.match(out, /no cases yet — nothing to score/);
  assert.doesNotMatch(out, /self-feedback\s+0\.0000/);
});

test("renderHuman: gate line reflects burn-in (not yet armed)", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: [] },
    suites: {},
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    gate: { mode: "blocking", burn_in_prs: 5, green_baselines: 2, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /burn-in 2\/5 green runs/);
  assert.match(out, /ADVISORY/);
  assert.doesNotMatch(out, /ARMED/);
});

test("renderHuman: gate line reflects armed blocking", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: [] },
    suites: {},
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    gate: { mode: "blocking", burn_in_prs: 5, green_baselines: 5, armed: true },
  };
  const out = renderHuman(result);
  assert.match(out, /Gate: blocking and ARMED/);
});

test("renderHuman: gate line for advisory mode", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: [] },
    suites: {},
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /Gate: advisory/);
});

test("renderHuman: a missing-baseline-case is rendered in the regressions block", () => {
  const result = {
    verdict: "DEGRADE",
    band: 0.05,
    selection: { mode: "changed", suites: ["referee"] },
    suites: {
      referee: { score: 1, baseline: 1, delta: 0, cases: { "REFEREE-D1": { score: 1, pass: true, checks: [{ name: "doc-invariants", ok: true, detail: "ok" }] } } },
    },
    deterministic_flips: 0,
    missing_baseline_cases: 1,
    missing_baseline_case_details: [{ suite: "referee", case: "REFEREE-D1-OLD" }],
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /REFEREE-D1-OLD/);
  assert.match(out, /MISSING from this run/);
  assert.match(out, /never silently pass/);
});

test("renderHuman: renders without throwing on a minimal {verdict, band, suites:{}} shape", () => {
  assert.doesNotThrow(() => renderHuman({ verdict: "NEUTRAL", band: 0.05, suites: {} }));
  const out = renderHuman({ verdict: "NEUTRAL", band: 0.05, suites: {} });
  assert.match(out, /VERDICT: NEUTRAL/);
});

test("renderHuman: renders without throwing on a fully empty object", () => {
  assert.doesNotThrow(() => renderHuman({}));
  assert.doesNotThrow(() => renderHuman());
});

test("renderHuman: selection line distinguishes 'all' vs 'changed' vs 'suite'", () => {
  const base = {
    verdict: "NEUTRAL", band: 0.05, deterministic_flips: 0, missing_baseline_cases: 0,
    suites: { s1: { score: 1, baseline: 1, delta: 0, cases: {} } },
  };
  const all = renderHuman({ ...base, selection: { mode: "all", suites: ["s1"] } });
  assert.match(all, /Every suite in evals\/config\.yaml ran/);
  const changed = renderHuman({ ...base, selection: { mode: "changed", suites: ["s1"] } });
  assert.match(changed, /this PR's diff touches their files/);
  const suite = renderHuman({ ...base, selection: { mode: "suite", suites: ["s1"] } });
  assert.match(suite, /explicitly requested via --suite/);
});

test("renderHuman: UPGRADE verdict banner", () => {
  const result = {
    verdict: "UPGRADE",
    band: 0.05,
    selection: { mode: "all", suites: ["s1"] },
    suites: { s1: { score: 1, baseline: 0.9, delta: 0.1, cases: {} } },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /VERDICT: UPGRADE/);
});

// ---------------------------------------------------------------------------
// Judge tier section
// ---------------------------------------------------------------------------

test("renderHuman: a recorded judge run renders score + RYG band line", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: ["clerk"] },
    suites: {
      clerk: {
        score: 1, baseline: 1, delta: 0,
        cases: {
          "CLERK-J2": {
            score: 0.9, pass: null, recorded: true, k: 3, spread: 0.1, band: "green", band_dimension: "clerk",
          },
        },
      },
    },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    judge: { recorded: true },
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /Judge tier \(advisory — quality grading\):/);
  assert.match(out, /clerk\/CLERK-J2\s+score 0\.9000\s+GREEN\s+\(k=3, spread 0\.10\)/);
});

test("renderHuman: a band-less judge case (no anchors configured) renders its score with no band, never a guessed one", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: ["clerk"] },
    suites: {
      clerk: {
        score: 1, baseline: 1, delta: 0,
        cases: { "CLERK-J1": { score: 0.9, pass: null, recorded: true, k: 1, spread: 0 } },
      },
    },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    judge: { recorded: true },
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /clerk\/CLERK-J1\s+score 0\.9000\s+\(k=1, spread 0\.00\)/);
  assert.doesNotMatch(out, /GREEN|YELLOW|RED/);
});

test("renderHuman: a skipped judge run renders exactly one honest line, and no per-case lines", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: ["clerk"] },
    suites: {
      clerk: { score: 1, baseline: 1, delta: 0, cases: { "CLERK-J1": { score: null, pass: null, recorded: false, note: "--no-judge set (case CLERK-J1)" } } },
    },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    judge: { recorded: false, note: "--no-judge set (case CLERK-J1)" },
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /Judge tier: skipped \(deterministic only\) — --no-judge set \(case CLERK-J1\)/);
  assert.doesNotMatch(out, /Judge tier \(advisory/);
});

test("renderHuman: a judge_flaky case gets the judge-uncertain suffix", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: ["scribe"] },
    suites: {
      scribe: {
        score: 1, baseline: 1, delta: 0,
        cases: { "SCRIBE-SLOP-1": { score: 0.5, pass: null, recorded: true, k: 3, spread: 0.3, band: "yellow" } },
      },
    },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    judge: { recorded: true },
    judge_flaky: ["scribe/SCRIBE-SLOP-1"],
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /judge-uncertain \(votes disagree beyond 2×band; treat as low-confidence\)/);
});

test("renderHuman: an unrecorded case inside an otherwise-recorded judge run is listed as 'not recorded'", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: ["clerk"] },
    suites: {
      clerk: {
        score: 1, baseline: 1, delta: 0,
        cases: {
          "CLERK-J1": { score: 0.9, pass: null, recorded: true, k: 1, spread: 0 },
          "CLERK-J2": { score: null, pass: null, recorded: false, note: "judge executor failed for case CLERK-J2: boom" },
        },
      },
    },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    judge: { recorded: true },
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.match(out, /clerk\/CLERK-J2\s+not recorded — judge executor failed for case CLERK-J2: boom/);
});

test("renderHuman: no judge field at all renders nothing extra (byte-identical to pre-judge-tier behavior)", () => {
  const result = {
    verdict: "NEUTRAL",
    band: 0.05,
    selection: { mode: "all", suites: ["s1"] },
    suites: { s1: { score: 1, baseline: 1, delta: 0, cases: {} } },
    deterministic_flips: 0,
    missing_baseline_cases: 0,
    gate: { mode: "advisory", burn_in_prs: 0, green_baselines: 0, armed: false },
  };
  const out = renderHuman(result);
  assert.doesNotMatch(out, /Judge tier/);
});

test("renderRebaseline: judge cases seeded — mentions the count", () => {
  const out = renderRebaseline({
    rebaselined: true,
    baseline_path: "/repo/evals/baseline.json",
    git_sha: "abc1234",
    suites: { clerk: { score: 1, cases: { "CLERK-J2": { score: 0.9, pass: null, recorded: true } } } },
  });
  assert.match(out, /1 judge case\(s\) seeded/);
});

test("renderRebaseline: judge cases left unrecorded (--no-judge) — advisory until seeded", () => {
  const out = renderRebaseline({
    rebaselined: true,
    baseline_path: "/repo/evals/baseline.json",
    git_sha: "abc1234",
    suites: { clerk: { score: 1, cases: { "CLERK-J1": { score: null, pass: null, recorded: false, note: "--no-judge set" } } } },
  });
  assert.match(out, /judge cases left unrecorded \(--no-judge\) — advisory until seeded/);
});

test("renderRebaseline: short confirmation names the baseline path and mentions burn-in reset", () => {
  const out = renderRebaseline({ rebaselined: true, baseline_path: "/repo/evals/baseline.json", git_sha: "abc1234" });
  assert.match(out, /baseline rewritten/);
  assert.match(out, /evals\/baseline\.json/);
  assert.match(out, /resets gate burn-in/);
});

test("renderRebaseline: does not throw on a minimal shape", () => {
  assert.doesNotThrow(() => renderRebaseline({}));
});
