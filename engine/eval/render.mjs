/**
 * render — pure human renderer for the `engine eval` result object (see
 * eval.mjs's runEval). Exports `renderHuman(result)` (the normal-run report)
 * and `renderRebaseline(result)` (the short `--rebaseline` confirmation).
 * Both are pure functions of their input — no I/O, no process/env access —
 * so they're unit-testable in isolation from eval.mjs's file-touching side
 * effects. stdout stays the single machine-readable JSON line everywhere
 * (`eval.mjs`); this module only ever produces the stderr-bound human text.
 *
 * Honesty rules (mirrors eval.mjs/verdict.mjs's honesty rules):
 *   - A null suite score is NEVER rendered as 0 — always "not scored yet"
 *     (current score) or "no baseline" (baseline column), plus the suite's
 *     `note` when one is present.
 *   - Every currently-failing deterministic case's exact FAILING check
 *     detail is printed verbatim (`cases[id].checks[].detail` for checks
 *     where `ok === false`) — the missing invariant is NAMED, never merely
 *     implied by a suite-level number, and passing checks aren't noise.
 *   - "flipped pass→fail" is only ever said of a case whose baseline pass
 *     was `true` (`cases[id].baseline_pass === true`) — a case already
 *     failing at baseline, or a brand-new case absent from baseline, is
 *     reported as failing, never mislabeled a flip.
 *   - Nothing here fabricates data the result object doesn't carry — e.g. no
 *     per-suite "what it checks" prose is invented; the table only ever
 *     prints numbers and notes that are actually present in `result`.
 *   - A judge-tier RYG `band` is only ever printed when the case's result
 *     object actually carries a `band` key (i.e. a committed anchors doc
 *     classified it) — a band-less judge case renders its score with no
 *     band, never a guessed one.
 *   - A skipped judge tier (`result.judge.recorded === false`) is always
 *     SAID explicitly (`Judge tier: skipped (deterministic only) — <note>`),
 *     never silently implied by the absence of a judge section.
 *
 * Zero dependencies, Node >= 18.
 */
"use strict";

const DIVIDER = "─".repeat(72);

function fmtCurrentScore(n) {
  return typeof n === "number" ? n.toFixed(4) : "not scored yet";
}

function fmtBaselineScore(n) {
  return typeof n === "number" ? n.toFixed(4) : "no baseline";
}

function fmtDelta(n) {
  if (n == null) return "n/a";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(4)}`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function verdictBanner(result) {
  const band = result.band ?? 0.05;
  const verdict = result.verdict;
  if (verdict === "DEGRADE") {
    return "VERDICT: DEGRADE — this change makes something worse than the baseline.";
  }
  if (verdict === "UPGRADE") {
    return `VERDICT: UPGRADE — this change makes something measurably better than\n`
      + `the baseline (a suite moved beyond the ±${band} noise band, nothing regressed).`;
  }
  return `VERDICT: NEUTRAL — nothing got worse, nothing got better (all changes\n`
    + `within the ±${band} noise band, and no previously-passing check now fails).`;
}

/** "Which suites ran, and why" — the visible half of PR binding (§1.2). */
function selectionLine(result) {
  const sel = result.selection;
  const names = Object.keys(result.suites || {});
  if (!sel || !sel.mode) {
    return names.length
      ? `Suites in this run: ${names.join(", ")}.`
      : "No suites were selected for this run.";
  }
  const listed = (sel.suites && sel.suites.length ? sel.suites : names).join(", ") || "(none)";
  if (sel.mode === "all") {
    return `Every suite in evals/config.yaml ran (no --changed/--suite filter): ${listed}.`;
  }
  if (sel.mode === "suite") {
    return `Suite(s) explicitly requested via --suite: ${listed}.`;
  }
  return `Suite(s) selected because this PR's diff touches their files: ${listed}.`;
}

function suiteTable(result) {
  const suites = result.suites || {};
  const names = Object.keys(suites);
  if (names.length === 0) return "  (no suites ran)";
  const lines = [`  ${pad("suite", 20)} ${pad("score", 10)} ${pad("baseline", 12)} ${pad("delta", 9)} note`];
  for (const name of names) {
    const d = suites[name] || {};
    const scoreStr = fmtCurrentScore(d.score);
    const baseStr = fmtBaselineScore(d.baseline);
    const deltaStr = fmtDelta(d.delta);
    const note = d.note || "";
    lines.push(`  ${pad(name, 20)} ${pad(scoreStr, 10)} ${pad(baseStr, 12)} ${pad(deltaStr, 9)} ${note}`);
  }
  return lines.join("\n");
}

/**
 * Regressions block. On a clean run, one honest "none" line quoting the two
 * counters the verdict itself is built from. On a DEGRADE (or any run that
 * carries a non-zero flip/missing count), name every currently-failing
 * deterministic case's exact FAILING check detail, verbatim — never merely a
 * suite number — plus every baseline-known case missing from this run.
 *
 * A failing case is only ever called "flipped pass→fail" when its baseline
 * pass was `true` (`c.baseline_pass === true`) — the exact condition
 * countDeterministicFlips uses (eval.mjs), kept authoritative here rather
 * than re-derived. A case already failing at baseline, or a brand-new case
 * with no baseline entry, is reported as failing — never a flip.
 */
function regressionsSection(result) {
  const flips = result.deterministic_flips ?? 0;
  const missing = result.missing_baseline_cases ?? 0;

  if (flips === 0 && missing === 0) {
    return `Regressions: none. ${flips} check(s) flipped pass→fail; ${missing} baseline case(s) missing.`;
  }

  const lines = [];
  const suites = result.suites || {};
  let named = 0;
  for (const [suiteName, d] of Object.entries(suites)) {
    const cases = (d && d.cases) || {};
    for (const [caseId, c] of Object.entries(cases)) {
      if (c && c.pass === false) {
        named++;
        const isFlip = c.baseline_pass === true;
        lines.push(
          isFlip
            ? `  ✗ ${suiteName} case ${caseId} flipped pass→fail:`
            : `  ✗ ${suiteName} case ${caseId} is failing:`,
        );
        for (const check of c.checks || []) {
          if (check && check.ok === false) lines.push(`      ${check.detail}`);
        }
      }
    }
  }
  for (const m of result.missing_baseline_case_details || []) {
    named++;
    lines.push(
      `  ✗ baseline case '${m.case}' in suite '${m.suite}' is MISSING from this run`
      + ` (dropped, renamed, or its spec no longer parses — treated as a failure;`
      + ` a deleted check can never silently pass).`,
    );
  }
  if (named === 0) {
    // Counts disagree with what the current cases[] can name (shouldn't
    // happen in practice, but never silently print nothing) — say so honestly.
    lines.push(`${flips} check(s) flipped pass→fail; ${missing} baseline case(s) missing (no per-case detail available in this result).`);
  }
  return lines.join("\n");
}

/**
 * Judge tier section — printed between the suite table and the regressions
 * block. Absent `result.judge` entirely => `null` (renders nothing; keeps
 * the pre-judge-tier renderHuman output byte-identical for callers/tests
 * that don't set it, and is defensive against a minimal result shape).
 * `result.judge.recorded === false` => one honest skipped line, always said,
 * never implied. `result.judge.recorded === true` => one line per judge-
 * graded case found anywhere in `result.suites[*].cases` (detected by the
 * presence of a boolean `recorded` key, which only judge cases carry —
 * deterministic cases carry `pass`/`checks` instead).
 */
function judgeSection(result) {
  const judge = result.judge;
  if (!judge) return null;
  if (!judge.recorded) {
    return `Judge tier: skipped (deterministic only) — ${judge.note || "no judge-graded cases configured"}`;
  }
  const flaky = new Set(result.judge_flaky || []);
  const lines = ["Judge tier (advisory — quality grading):"];
  const suites = result.suites || {};
  for (const [suiteName, d] of Object.entries(suites)) {
    const cases = (d && d.cases) || {};
    for (const [caseId, c] of Object.entries(cases)) {
      if (!c || typeof c.recorded !== "boolean") continue; // not a judge case
      const key = `${suiteName}/${caseId}`;
      if (!c.recorded) {
        lines.push(`  ${key}  not recorded — ${c.note || "unknown"}`);
        continue;
      }
      const scoreStr = typeof c.score === "number" ? c.score.toFixed(4) : "n/a";
      const kStr = typeof c.k === "number" ? c.k : "?";
      const spreadStr = typeof c.spread === "number" ? c.spread.toFixed(2) : "n/a";
      const parts = [`score ${scoreStr}`];
      if (c.band) parts.push(c.band.toUpperCase()); // never invented — only printed when the case result carries one
      parts.push(`(k=${kStr}, spread ${spreadStr})`);
      let line = `  ${key}  ${parts.join("  ")}`;
      if (flaky.has(key)) {
        line += " — judge-uncertain (votes disagree beyond 2×band; treat as low-confidence)";
      }
      lines.push(line);
    }
  }
  return lines.join("\n");
}

function gateLine(result) {
  const gate = result.gate;
  if (!gate) return null;
  if (gate.mode !== "blocking") {
    return "Gate: advisory — a DEGRADE never fails CI here (informational only).";
  }
  if (gate.armed) {
    return "Gate: blocking and ARMED — CI will fail this PR (exit 2) until fixed.";
  }
  const burnIn = gate.burn_in_prs ?? 0;
  const green = gate.green_baselines ?? 0;
  return `Gate: blocking, burn-in ${green}/${burnIn} green runs — a JUDGE-driven DEGRADE is still ADVISORY\n`
    + `(won't fail CI) until ${burnIn} green post-merge runs are committed; a deterministic\n`
    + `regression (pass->fail flip or missing baseline case) blocks immediately.`;
}

function footer(result) {
  const lines = [];
  if (result.verdict === "DEGRADE") {
    lines.push("What to do: fix the named check(s) above and re-run `engine eval --changed`.");
    lines.push("If the old expectation is genuinely obsolete, change it deliberately and");
    lines.push("rebaseline (engine/eval/README.md) — never delete a case to get green.");
  } else {
    lines.push("First PR here? Each suite re-runs invariant checks that passed on main.");
    lines.push("NEUTRAL/UPGRADE = merge normally. DEGRADE = a named check below got worse —");
    lines.push('fix it, or rebaseline deliberately (engine/eval/README.md, "Rebaseline").');
  }
  lines.push("Machine-readable result: the single JSON line on stdout.");
  return lines.join("\n");
}

/**
 * The default human report, written to stderr by eval.mjs unless `--quiet`.
 * Tolerates a minimal `{verdict, band, suites:{}}` shape (or even `{}`)
 * without throwing — every field access below is defensive.
 */
export function renderHuman(result) {
  result = result || {};
  const parts = [
    "engine eval — did this change make the agent-facing behavior worse?",
    DIVIDER,
    verdictBanner(result),
    "",
    selectionLine(result),
    "",
    suiteTable(result),
    "",
  ];
  const judge = judgeSection(result);
  if (judge) parts.push(judge, "");
  parts.push(regressionsSection(result));
  const gate = gateLine(result);
  if (gate) parts.push("", gate);
  parts.push("", footer(result));
  return parts.join("\n") + "\n";
}

/**
 * Judge-seeding line for `--rebaseline` — counts judge-graded cases (any
 * case carrying a boolean `recorded` key) across `result.suites[*].cases`:
 * `recorded:true` means the panel actually ran and its score got baked into
 * the committed baseline ("seeded"); `recorded:false` means it landed as
 * `{score:null, pass:null, recorded:false}` — advisory-until-seeded by
 * construction (see verdict.mjs's computeDeltas). Returns `null` when no
 * judge-graded case exists anywhere in this rebaseline (nothing to say).
 */
function judgeSeedingLine(result) {
  const suites = result.suites || {};
  let seeded = 0;
  let unrecorded = 0;
  for (const d of Object.values(suites)) {
    const cases = (d && d.cases) || {};
    for (const c of Object.values(cases)) {
      if (!c || typeof c.recorded !== "boolean") continue;
      if (c.recorded) seeded++;
      else unrecorded++;
    }
  }
  if (seeded === 0 && unrecorded === 0) return null;
  if (seeded > 0) {
    return `${seeded} judge case(s) seeded${unrecorded ? ` (${unrecorded} left unrecorded)` : ""}.`;
  }
  return "judge cases left unrecorded (--no-judge) — advisory until seeded.";
}

/** Short confirmation for `--rebaseline` — never the full report (there's no verdict to render). */
export function renderRebaseline(result) {
  result = result || {};
  const sha = result.git_sha || "unknown sha";
  const path = result.baseline_path || "evals/baseline.json";
  const base = `engine eval --rebaseline: baseline rewritten at ${path} (git ${sha}) — `
    + `commit evals/baseline.json; this resets gate burn-in by design (a new baseline must re-earn trust).`;
  const judgeLine = judgeSeedingLine(result);
  return judgeLine ? `${base}\n${judgeLine}\n` : `${base}\n`;
}
