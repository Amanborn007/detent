/**
 * verdict — pure math for the `engine eval` harness (no file I/O except
 * `loadBaseline`, which is a plain read+parse). Zero dependencies, Node >= 18.
 *
 * Case score in [0,1]. Suite score = arithmetic mean of its case scores.
 * Delta per suite = current.score - baseline.suites[s].score. A suite with no
 * entry in the baseline (or no scoreable cases yet) contributes delta:null and
 * is EXCLUDED from the verdict — it can never manufacture a DEGRADE.
 *
 * Variance band (epsilon, config `band`, default 0.05) shields judge/noise
 * ONLY. Rules, in order:
 *   1. Any deterministic pass->fail flip vs baseline => DEGRADE (band never
 *      excuses a flip — flips are noise-free).
 *   2. Else if any suite delta < -band => DEGRADE.
 *   3. Else if any suite delta > +band (and none below -band) => UPGRADE.
 *   4. Else NEUTRAL.
 */
"use strict";

import { readFileSync } from "node:fs";

export const BASELINE_SCHEMA = "detent-eval-baseline-v1";

/** Round to `places` decimals (default 4dp, mirrors bench.mjs's round()). */
export function round(n, places = 4) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Read+parse a baseline.json. Throws (loudly, no fallback) if unreadable,
 * not valid JSON, or missing a `suites` map — callers map this to a refusal
 * with the "run --rebaseline" next_step; this function itself stays pure IO,
 * no refusal shaping.
 */
export function loadBaseline(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read baseline at ${path}: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`baseline at ${path} is not valid JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== "object" || !doc.suites || typeof doc.suites !== "object") {
    throw new Error(`baseline at ${path} is missing a 'suites' map — corrupt baseline`);
  }
  return doc;
}

/**
 * Arithmetic mean of case scores, rounded to 4dp. Non-numeric entries
 * (e.g. an unrecorded judge case) are dropped, never scored 0 — an absent
 * case must never manufacture a DEGRADE. Empty/all-absent => null (honest:
 * "nothing scoreable yet", never a fabricated 0 or 1).
 */
export function aggregateSuite(caseScores) {
  const scores = caseScores.filter((s) => typeof s === "number");
  if (scores.length === 0) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return round(mean);
}

/**
 * current: { <suite>: number|null | {score, cases} }  — either a plain
 *   already-aggregated suite score (legacy shape), or `{score, cases}` where
 *   `cases` is the same `{<caseId>: {score, ...}}` map `runSuite` returns.
 * baseline: a baseline.json doc ({ suites: { <suite>: { score, cases } } }).
 * Returns { <suite>: { score, baseline, delta, note?, added?, removed? } }.
 *
 * When BOTH sides carry a `cases` map, the delta is computed over the
 * INTERSECTION of case IDs recorded (numeric score) on BOTH sides — a case
 * added or removed since the baseline was cut (e.g. a stray file rename, a
 * case dropped due to a malformed spec), AND a case whose score is numeric
 * on only ONE side (e.g. a judge case rebaselined with `--no-judge`, so it's
 * `score:null` in the baseline, then recorded on a later run) is excluded
 * from the mean on BOTH sides — never folded into a suite-mean comparison
 * that could manufacture a DEGRADE out of pure case-set drift or asymmetric
 * recording. `added`/`removed` still only reflect ID-set drift (case present
 * on one side, absent on the other); a case present on both sides but
 * unrecorded on one is silently excluded from the delta without appearing in
 * `added`/`removed` (it isn't a set-membership difference). `score`/`baseline`
 * in the output still report the suites' real (full-case) aggregate scores —
 * only the `delta` itself is computed over the shared, numeric-on-both-sides
 * subset. Falls back to the old whole-suite-mean delta when either side has
 * no case map (e.g. a caller that only has aggregated scores).
 */
export function computeDeltas(current, baseline) {
  const out = {};
  const baseSuites = (baseline && baseline.suites) || {};
  for (const [suite, entry] of Object.entries(current)) {
    const score = entry && typeof entry === "object" ? entry.score : entry;
    const curCases = (entry && typeof entry === "object" && entry.cases) || null;
    const base = baseSuites[suite];

    if (score == null) {
      out[suite] = {
        score: null,
        baseline: base && typeof base.score === "number" ? base.score : null,
        delta: null,
        note: "no cases yet — nothing to score",
      };
      continue;
    }
    if (!base || typeof base.score !== "number") {
      out[suite] = { score, baseline: null, delta: null, note: "no baseline — rebaseline to include" };
      continue;
    }

    const baseCases = base.cases || null;
    if (!curCases || !baseCases) {
      out[suite] = { score, baseline: base.score, delta: round(score - base.score) };
      continue;
    }

    const curIds = Object.keys(curCases);
    const baseIds = Object.keys(baseCases);
    const baseIdSet = new Set(baseIds);
    const curIdSet = new Set(curIds);
    const shared = curIds.filter((id) => baseIdSet.has(id));
    const added = curIds.filter((id) => !baseIdSet.has(id));
    const removed = baseIds.filter((id) => !curIdSet.has(id));

    // Intersect on IDs where BOTH sides carry a numeric score (not merely
    // "present on both sides") — filtering each side independently would let
    // a judge case that is score:null in the baseline (e.g. rebaselined with
    // --no-judge) but recorded on a later run enter curMean while staying
    // absent from baseMean, producing an asymmetric mean and a spurious
    // delta. See engine/eval/README.md's "intersection of case IDs recorded
    // on both sides" — this is what actually implements that claim.
    const numericShared = shared.filter((id) => {
      const cs = curCases[id] && curCases[id].score;
      const bs = baseCases[id] && baseCases[id].score;
      return typeof cs === "number" && typeof bs === "number";
    });
    const curShared = numericShared.map((id) => curCases[id].score);
    const baseShared = numericShared.map((id) => baseCases[id].score);

    const entryOut = { score, baseline: base.score };
    if (curShared.length && baseShared.length) {
      const curMean = curShared.reduce((a, b) => a + b, 0) / curShared.length;
      const baseMean = baseShared.reduce((a, b) => a + b, 0) / baseShared.length;
      entryOut.delta = round(curMean - baseMean);
    } else {
      entryOut.delta = null;
      entryOut.note = "no cases shared with baseline — nothing comparable";
    }
    if (added.length) entryOut.added = added;
    if (removed.length) entryOut.removed = removed;
    out[suite] = entryOut;
  }
  return out;
}

/**
 * deltas: output of computeDeltas.
 * opts.band: epsilon (default 0.05).
 * opts.deterministicFlips: count of deterministic pass->fail flips vs baseline.
 * opts.missingCases: count of baseline-known case IDs missing from the
 *   current run (MEDIUM-3) — a silently-dropped case (typo'd `check`,
 *   deleted spec, ...) is treated exactly like a flip: noise-free, DEGRADE
 *   regardless of band.
 * opts.emptySelection: true when the suite SELECTION itself was empty (e.g.
 *   `--changed` matched nothing) — distinct from "selected suites but none
 *   had a comparable delta", which gets its own reason text.
 */
export function computeVerdict(deltas, opts = {}) {
  const band = opts.band ?? 0.05;
  const flips = opts.deterministicFlips ?? 0;
  const missing = opts.missingCases ?? 0;

  if (opts.emptySelection) {
    return { verdict: "NEUTRAL", band, reason: "no suites selected" };
  }
  if (flips > 0 || missing > 0) {
    const parts = [];
    if (flips > 0) parts.push(`${flips} deterministic case(s) flipped pass→fail vs baseline`);
    if (missing > 0) parts.push(`${missing} baseline case(s) missing from this run (dropped/malformed case spec — treated as a flip)`);
    return { verdict: "DEGRADE", band, reason: parts.join("; ") };
  }

  const contributing = Object.entries(deltas).filter(([, d]) => d.delta !== null);

  const below = contributing.filter(([, d]) => d.delta < -band);
  if (below.length) {
    return { verdict: "DEGRADE", band, reason: `suite(s) below band: ${below.map(([s]) => s).join(", ")}` };
  }

  const above = contributing.filter(([, d]) => d.delta > band);
  if (above.length) {
    return { verdict: "UPGRADE", band, reason: `suite(s) above band: ${above.map(([s]) => s).join(", ")}` };
  }

  return {
    verdict: "NEUTRAL",
    band,
    reason: contributing.length
      ? "all deltas within band"
      : "no suites contributed a comparable delta (no baseline entries / no cases yet)",
  };
}

/** Median of N judge-run scores for one case (k-median rule). */
export function medianOf(scores) {
  if (!scores.length) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** max-min spread of N judge-run scores for one case (flakiness signal). */
export function spreadOf(scores) {
  if (!scores.length) return 0;
  return round(Math.max(...scores) - Math.min(...scores));
}

// ---------------------------------------------------------------------------
// Gate — advisory -> blocking after burn-in (roadmap item [4/8]).
// ---------------------------------------------------------------------------

/**
 * Effective gate mode precedence: `EVAL_BLOCKING=on` -> "blocking",
 * `EVAL_BLOCKING=off` -> "advisory" (either env value is an explicit
 * CI/operator override and always wins), any other/unset envValue ->
 * `gate.mode` (already validated by eval.mjs's loadEvalConfig — never
 * re-validated here, this function stays pure precedence logic).
 */
export function resolveGateMode({ envValue, gate }) {
  if (envValue === "on") return "blocking";
  if (envValue === "off") return "advisory";
  return (gate && gate.mode) || "advisory";
}

/**
 * Green-baseline count for burn-in: the number of DISTINCT `git_sha` values
 * across eval-schema ledger lines whose `verdict` is NEUTRAL or UPGRADE AND
 * whose `baseline_sha` matches the current baseline's `git_sha` (a
 * rebaseline therefore resets burn-in — intended, a new baseline must re-earn
 * trust). Lines with `git_sha: null` are skipped (can't attribute a green run
 * to a commit — honesty rule, never fabricated). Lines that aren't valid JSON
 * are skipped with a loud stderr warning (ledger integrity is separately
 * gated by the `ledger-parseable` deterministic check — this function just
 * degrades gracefully around a corrupt line rather than crashing the gate).
 * Missing/empty ledger text -> 0, never fabricated.
 *
 * A line whose `suites` map is empty/absent recorded a NO-OP run — e.g.
 * `engine eval --changed` with an empty diff (or run on a freshly-pulled
 * `main`, where `origin/main...HEAD` is empty by construction) selects zero
 * suites, which `computeVerdict` calls NEUTRAL ("no suites selected"). That
 * NEUTRAL still satisfies every other filter here (schema, verdict, git_sha,
 * baseline_sha match) despite zero suites ever having executed, so such
 * lines are excluded from the green count — burn-in must be earned by a run
 * that actually graded something, never by a hollow "nothing to grade"
 * NEUTRAL.
 */
export function countGreenBaselines(ledgerText, { baselineSha, schema }) {
  const shas = new Set();
  if (!ledgerText) return 0;
  for (const raw of ledgerText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let doc;
    try {
      doc = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`eval: unparsable ledger line skipped while counting gate burn-in: ${e.message}\n`);
      continue;
    }
    if (!doc || typeof doc !== "object" || doc.schema !== schema) continue;
    if (doc.verdict !== "NEUTRAL" && doc.verdict !== "UPGRADE") continue;
    if (doc.git_sha === null || doc.git_sha === undefined) continue;
    if ((doc.baseline_sha ?? null) !== (baselineSha ?? null)) continue;
    if (!doc.suites || typeof doc.suites !== "object" || Object.keys(doc.suites).length === 0) continue;
    shas.add(doc.git_sha);
  }
  return shas.size;
}
