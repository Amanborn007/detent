/**
 * judge — the optional LLM-judge tier for `engine eval`.
 *
 * A judge case spec looks like `{id, grader:"judge", prompt, params?}`
 * (distinct from a deterministic case spec, which carries `check` instead of
 * `grader`/`prompt` — see graders/deterministic.mjs). The judge prompt asks
 * the model to emit a JSON object containing a numeric `score` (0..1) and it
 * is parsed back out of the executor's stdout.
 *
 * Every call to the model goes through an INJECTABLE `executor` function
 * (`{prompt, timeoutMs} => {stdout}`), defaulting to the runtime port
 * (DETENT_RUNTIME: claude-code runs `claude -p`, openai-compatible calls the
 * configured endpoint; scores are not comparable across runtimes). The
 * prompt is piped over STDIN, never as an
 * argv element (a prompt beginning with `-` must never be parsable as a
 * `claude` CLI flag, e.g. `--dangerously-skip-permissions`). Tests always
 * inject a fake executor — this module never spawns a real model in
 * `node --test`.
 *
 * "Panel" here means k independent runs of the SAME judge prompt (the `--k`
 * CLI flag / `k` config value), aggregated by median (verdict.mjs's
 * `medianOf`) with `spread` (max-min) as a disagreement signal — never a
 * multi-model ensemble. Reusing verdict.mjs's median/spread helpers keeps the
 * k-aggregation math in one place rather than duplicating it here.
 *
 * Honesty rule (mirrors bench's computeTokens / deterministic honesty rule):
 * `--no-judge`, a missing `claude` binary, or an executor that throws all
 * degrade to `{recorded:false, note}` plus a LOUD stderr line
 * (`eval: judge tier skipped — <why>; deterministic tier only`) — NEVER a
 * silently fabricated score, and never a score that could manufacture a
 * DEGRADE on its own (unrecorded cases are excluded from suite means by
 * `aggregateSuite`, same as deterministic honesty rules elsewhere).
 *
 * Anchors — per-dimension RYG calibration exemplars (`evals/calibration/<dim>/
 * anchors.json`, schema `detent-eval-anchors-v1`, see evals/calibration/
 * README.md). `loadAnchors` hard-throws on a missing/unparsable/shape-invalid
 * anchors file (same treatment as an unreadable `prompt_path` — a bad anchors
 * reference is a bug in the case spec, never a silent `{recorded:false}`,
 * which is reserved for --no-judge/missing-claude/executor-failure AFTER the
 * prompt is known-good). `formatAnchorsBlock` mechanically injects the
 * anchor set into the judge prompt (closing the documented rubric<->anchor
 * drift gap — see evals/calibration/README.md's former "Deferred" bullet).
 * `classifyBand` maps a recorded score to green/yellow/red using the same
 * doc's `bands`, returning `null` (never a nearest-guess) for a score that
 * falls in a gap between non-contiguous bands.
 *
 * Zero dependencies, Node >= 18.
 */
"use strict";

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { medianOf, spreadOf } from "../verdict.mjs";
import { getRuntime, resolveRuntimeName } from "../../runtime/runtime.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// loadAnchors / formatAnchorsBlock / classifyBand — calibration anchors.
// ---------------------------------------------------------------------------

/**
 * Reads and shape-validates `evals/calibration/<dimension>/anchors.json`.
 * Hard-throws (never `{recorded:false}`) on a missing file, unparsable JSON,
 * wrong schema, a missing red/yellow/green anchor, or a missing `bands` map —
 * a case spec that names a bad `anchors` dimension is a bug to fix, not a
 * degradation to shrug off.
 */
export function loadAnchors(detentRoot, dimension) {
  const relPath = join("evals", "calibration", dimension, "anchors.json");
  const p = join(detentRoot, relPath);
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`judge: cannot read calibration anchors for dimension '${dimension}' at ${relPath}: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`judge: ${relPath} is not valid JSON: ${e.message}`);
  }
  if (!doc || doc.schema !== "detent-eval-anchors-v1") {
    throw new Error(`judge: ${relPath} missing schema:"detent-eval-anchors-v1"`);
  }
  const anchors = Array.isArray(doc.anchors) ? doc.anchors : [];
  const labelsSeen = new Set(anchors.map((a) => a && a.label));
  for (const need of ["red", "yellow", "green"]) {
    if (!labelsSeen.has(need)) {
      throw new Error(`judge: ${relPath} missing at least one '${need}' anchor`);
    }
  }
  if (!doc.bands || !doc.bands.red || !doc.bands.yellow || !doc.bands.green) {
    throw new Error(`judge: ${relPath} missing bands.{red,yellow,green}`);
  }
  return doc;
}

/**
 * Pure, deterministic prompt block for an anchors doc: scenario (when
 * present), then one line per anchor quoting its sample + why verbatim,
 * prefixed with an explicit "these are reference points, not the graded
 * output" framing — anchor-comparison scoring (ranking the fixture against
 * fixed alternatives) is what keeps classification stable across judge-model
 * versions, vs. an absolute 0..1 scale with no fixed points.
 */
export function formatAnchorsBlock(doc) {
  const lines = [
    "These are fixed calibration reference points, NOT the output you are grading. Rank the output below against them.",
    "",
  ];
  if (doc.scenario) {
    lines.push(`Scenario: ${doc.scenario}`, "");
  }
  for (const a of doc.anchors || []) {
    const range = Array.isArray(a.expected_range) ? a.expected_range : [null, null];
    const why = a.why ? ` — ${a.why}` : "";
    lines.push(`**${a.label}** (expected score ${range[0]}–${range[1]}): "${a.sample}"${why}`);
  }
  return lines.join("\n");
}

/**
 * Classify a recorded score against a dimension's RYG bands. Lo-inclusive,
 * hi-exclusive, EXCEPT a band whose hi is exactly 1 (always green in
 * practice) is hi-inclusive too — otherwise a perfect score of 1.0 could
 * never classify as anything. A score in a gap between non-contiguous bands
 * (the validity check permits gaps, just not reversed overlaps) returns
 * `null` — never a nearest-guess.
 */
export function classifyBand(score, bands) {
  if (typeof score !== "number" || !bands) return null;
  for (const label of ["red", "yellow", "green"]) {
    const b = bands[label];
    if (!Array.isArray(b) || b.length !== 2) continue;
    const [lo, hi] = b;
    const hiInclusive = hi === 1;
    if (score >= lo && (hiInclusive ? score <= hi : score < hi)) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// claude on PATH — a plain `which`/`where` probe. Injectable (`exec` param)
// so tests can assert "missing binary" behavior without touching real PATH.
// ---------------------------------------------------------------------------

export function claudeOnPath(exec = spawnSync) {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = exec(finder, ["claude"], { encoding: "utf8" });
  if (!r || r.status !== 0) return null;
  const first = (r.stdout || "").trim().split(/\r?\n/)[0];
  return first || null;
}

// ---------------------------------------------------------------------------
// Default executor — one prompt through the runtime port (DETENT_RUNTIME,
// default claude-code). Only ever reached when no executor was injected; for
// claude-code runJudgeCase also checks claudeOnPath() first.
// ---------------------------------------------------------------------------

// The request each runtime gets. claude-code keeps today's inherit-everything call;
// a runtime without a profile is refused rather than guessed at.
const JUDGE_REQUEST = Object.freeze({
  "claude-code": Object.freeze({ tools: "inherit", mcp: "inherit", settings: Object.freeze({ sources: "inherit" }) }),
  "openai-compatible": Object.freeze({ tools: "none", mcp: "none", settings: Object.freeze({ sources: "none" }) }),
});

function defaultExecutor({ prompt, timeoutMs }) {
  const runtime = resolveRuntimeName();
  const profile = JUDGE_REQUEST[runtime];
  if (!profile) throw new Error(`judge has no request profile for runtime ${runtime}`);
  // Prompt goes over STDIN inside the port, never argv — a prompt beginning with `-` (e.g.
  // "--dangerously-skip-permissions") must never be parsed as a CLI flag. See HIGH-1 in the PR #44 principal review.
  const res = getRuntime({ name: runtime }).run({
    prompt, cwd: process.cwd(), output: "text", ...profile, timeout_ms: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (runtime !== "claude-code" && res.error) throw new Error(`${runtime} ${res.error.kind}: ${res.error.message}`);
  if (res.error && (res.error.kind === "spawn" || res.error.kind === "timeout")) throw new Error(res.error.message);
  if (res.error) {
    throw new Error(`claude -p exited ${res.raw.exit_code}: ${(res.raw.stderr || res.raw.stdout || "").slice(0, 300)}`);
  }
  return { stdout: res.text };
}

// ---------------------------------------------------------------------------
// Score parsing — scan the executor's stdout for a JSON object carrying a
// numeric `score` field (models often wrap it in prose); take the LAST match
// so trailing "final answer" framing wins over earlier reasoning that happens
// to mention a score-shaped object. Throws (never guesses) if none parse.
// ---------------------------------------------------------------------------

export function parseJudgeOutput(stdout, caseId) {
  const matches = [...(stdout || "").matchAll(/\{[^{}]*"score"\s*:\s*-?\d+(?:\.\d+)?[^{}]*\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i][0]);
      if (typeof obj.score === "number" && Number.isFinite(obj.score)) {
        // `uncertain` (optional bool) — pass through as-is; anything other
        // than a literal `true` is treated as "not flagged uncertain" (a
        // stray truthy-but-non-boolean value is not a signal to trust).
        return { ...obj, uncertain: obj.uncertain === true };
      }
    } catch {
      // not valid JSON — keep scanning earlier matches
    }
  }
  throw new Error(`judge case ${caseId || "?"}: could not parse a {"score": <number>} JSON object from judge output`);
}

// Honesty rule: a score outside [0,1] (e.g. a judge that answered on a
// 0..100 scale) is UNUSABLE, not "close enough to clamp" — clamping would
// fabricate an in-range score the judge never actually gave. Throws so the
// caller (runJudgeCase) routes it through the normal {recorded:false}/skip
// path, loud on stderr, exactly like any other unparsable judge output.
function assertInRange(n, caseId) {
  if (n < 0 || n > 1) {
    throw new Error(`judge case ${caseId}: score ${n} outside [0,1] — unusable (not clamped), skipping`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// judgeCase — the panel: run the case's prompt through `executor` k times,
// aggregate by median, report spread. Always uses the given executor — no
// degradation logic here (that lives in runJudgeCase); this throws straight
// through on any executor/parse failure, exactly like gradeCase does for
// deterministic checks.
// ---------------------------------------------------------------------------

export function judgeCase(caseSpec, opts = {}) {
  const { executor = defaultExecutor, k = 1, timeoutMs, bands } = opts;
  const caseId = (caseSpec && caseSpec.id) || "unknown";
  const prompt = caseSpec && caseSpec.prompt;
  if (!prompt || typeof prompt !== "string") {
    throw new Error(`judge case ${caseId}: missing params.prompt (string)`);
  }
  const runs = Math.max(1, Number(k) || 1);
  const votes = [];
  for (let i = 0; i < runs; i++) {
    const { stdout } = executor({ prompt, timeoutMs, attempt: i });
    const parsed = parseJudgeOutput(stdout, caseId);
    const uncertain = parsed.uncertain === true;
    votes.push({
      // An uncertain vote is excluded from aggregation entirely (see below) —
      // its score is still range-checked when present (never fabricated),
      // but a garbage/placeholder score on an uncertain vote must never crash
      // the whole panel, so only a genuinely out-of-range NUMBER throws here,
      // same as any other vote.
      score: assertInRange(parsed.score, caseId),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : null,
      uncertain,
    });
  }
  const uncertainVotes = votes.filter((v) => v.uncertain).length;
  if (uncertainVotes === runs) {
    throw new Error(`judge case ${caseId}: all ${runs} vote(s) uncertain — unusable`);
  }
  const scores = votes.filter((v) => !v.uncertain).map((v) => v.score);

  // band_unstable — optional low-confidence flag (never a verdict input):
  // set when the panel's individual (non-uncertain) vote scores straddle two
  // or more different RYG bands, even though the aggregate median lands
  // cleanly in one. Only computed when the caller supplies `bands` (the
  // case's anchors doc, when one is configured) — absent bands => never set.
  let bandUnstable = false;
  if (bands && scores.length > 1) {
    const voteBands = new Set(scores.map((s) => classifyBand(s, bands)).filter((b) => b !== null));
    bandUnstable = voteBands.size > 1;
  }

  return {
    recorded: true,
    score: medianOf(scores),
    k: runs,
    votes,
    spread: spreadOf(scores),
    uncertain_votes: uncertainVotes,
    ...(bandUnstable ? { band_unstable: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// runJudgeCase — the degrading entry point `engine eval` actually calls.
// Order of degradation, each LOUD on stderr, never silent:
//   1. --no-judge (or any explicit `noJudge`) => skip, no executor touched.
//   2. No injected executor AND claudeOnPath() finds nothing => skip.
//   3. judgeCase() throws (bad prompt, executor failure, unparsable output)
//      => caught here, skip with the error's message.
// Every skip path returns {recorded:false, note}, never a fabricated score.
// ---------------------------------------------------------------------------

export function runJudgeCase(caseSpec, opts = {}) {
  const { noJudge = false, executor, k = 1, timeoutMs, hasClaude, bands } = opts;
  const caseId = (caseSpec && caseSpec.id) || "unknown";

  const skip = (note) => {
    process.stderr.write(`eval: judge tier skipped — ${note}; deterministic tier only\n`);
    return { recorded: false, note };
  };

  if (noJudge) {
    return skip(`--no-judge set (case ${caseId})`);
  }
  if (!executor) {
    let runtime;
    try { runtime = resolveRuntimeName(); } catch (e) { return skip(`${e.message} (case ${caseId})`); }
    if (runtime === "claude-code") {
      const found = typeof hasClaude === "function" ? hasClaude() : claudeOnPath();
      if (!found) return skip(`claude not found on PATH (case ${caseId})`);
    }
  }
  try {
    return judgeCase(caseSpec, { executor, k, timeoutMs, bands });
  } catch (e) {
    return skip(`judge executor failed for case ${caseId}: ${e.message}`);
  }
}
