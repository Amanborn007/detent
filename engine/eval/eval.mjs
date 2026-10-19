#!/usr/bin/env node
/**
 * eval — the `engine eval` offline eval harness (module + CLI), sibling of
 * engine/bench. Zero dependencies, Node >= 18. Same dual module/CLI pattern
 * as bench.mjs: exported for `engine.mjs` to wire up as `engine eval`, and
 * directly runnable as `node engine/eval/eval.mjs`.
 *
 * Selection (select.mjs), deterministic grading (graders/deterministic.mjs),
 * baseline compare, verdict math (verdict.mjs), and ledger append are all
 * real. The judge tier (graders/judge.mjs) is also fully wired in: `runSuite`
 * calls `runJudgeCase` for every `grader:"judge"` case, `resolveJudgeCase`
 * resolves each case's prompt (optionally injecting a calibration-anchors
 * block via `anchors: "<dimension>"`) and threads the resulting RYG `band`
 * onto the case result, `--no-judge`/`--k`/`judge_max_cases` all work end to
 * end. A judge case absent a committed baseline entry stays advisory by
 * construction (see verdict.mjs's `computeDeltas` numeric-on-both-sides
 * intersection) — it can never gate on its own.
 *
 * Honesty rule (mirrors bench's computeTokens): absent data => {recorded:
 * false, note}, never a fabricated score. A suite/case with nothing to grade
 * yet is EXCLUDED from the verdict, never scored 0.
 */
"use strict";

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync,
  renameSync, readdirSync, statSync,
} from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  loadBaseline, computeDeltas, computeVerdict, aggregateSuite, BASELINE_SCHEMA,
  resolveGateMode, countGreenBaselines,
} from "./verdict.mjs";
import {
  EvalRefusal, allSuites, selectSuites as selectByChangedPaths, changedPathsFromGit,
} from "./select.mjs";
import { gradeCase } from "./graders/deterministic.mjs";
import {
  runJudgeCase, loadAnchors, formatAnchorsBlock, classifyBand,
} from "./graders/judge.mjs";
import { renderHuman, renderRebaseline } from "./render.mjs";

export const EVAL_SCHEMA = "detent-eval-v1";

// Refusal type — thrown for anything engine.mjs should map to exit 2. Lives
// in select.mjs (both modules need to throw it, without a circular import);
// re-exported here so `import { EvalRefusal } from "../eval/eval.mjs"` keeps
// working for engine.mjs and anything else that imports it from this module.
export { EvalRefusal };

// ---------------------------------------------------------------------------
// Arg parsing — tiny, positional + --flags (same idiom as engine.mjs/bench.mjs).
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const hasValue = !(next === undefined || next.startsWith("--"));
      // `--__`-prefixed flags are internal test-only seams (e.g.
      // `__judgeExecutor`, see runEval's judgeOpts) — never settable from a
      // real CLI invocation. Consume (and drop) the value too, so it can't
      // leak into `positional`.
      if (key.startsWith("__")) {
        if (hasValue) i++;
        continue;
      }
      if (hasValue) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// evals/config.yaml — tiny hand-rolled YAML-subset reader, scoped to this
// file's simple shape (top-level scalars + one nested `suites:` map of
// {select: [...], cases_dir: ...}). Self-contained here for Stage A; a later
// stage extracts a shared parser into engine/eval/yaml.mjs (per BUILD SPEC
// §1.7) rather than duplicating engine.mjs's stack.yaml parser.
// ---------------------------------------------------------------------------

function stripYamlComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "#" && !inQuote && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(v) {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseEvalYaml(text, sourceName) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const noComment = stripYamlComment(raw);
    if (!noComment.trim()) continue;
    lines.push({ indent: /^ */.exec(noComment)[0].length, text: noComment.trim() });
  }
  let i = 0;
  function keyVal(t) {
    const m = /^([^:]+):(?:\s+(.*))?$/.exec(t);
    if (!m) throw new Error(`unparsable line in ${sourceName}: '${t}'`);
    return [m[1].trim(), m[2] === undefined ? "" : m[2].trim()];
  }
  function parseMap(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const [key, val] = keyVal(lines[i].text);
      i++;
      if (val === "") {
        if (i < lines.length && lines[i].indent > indent) obj[key] = parseBlock(lines[i].indent);
        else obj[key] = null;
      } else obj[key] = parseScalar(val);
    }
    return obj;
  }
  function parseList(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
      arr.push(parseScalar(lines[i].text.slice(2)));
      i++;
    }
    return arr;
  }
  function parseBlock(indent) {
    return lines[i].text.startsWith("- ") ? parseList(indent) : parseMap(indent);
  }
  const doc = lines.length ? parseBlock(lines[0].indent) : {};
  if (i < lines.length) throw new Error(`unparsed trailing content in ${sourceName} at: '${lines[i].text}'`);
  return doc;
}

/**
 * `gate:` block (roadmap [4/8]) — `{mode: advisory|blocking, burn_in_prs: N}`.
 * Absent entirely -> `{mode:"advisory", burn_in_prs:0}` (never blocking by
 * silent default). An explicit but invalid `mode` (not advisory|blocking) or
 * a non-integer/negative `burn_in_prs` is a loud EvalRefusal — never a silent
 * fallback to the default (a typo'd `mode: blockign` must not quietly stay
 * advisory forever).
 */
function loadGateConfig(doc) {
  const raw = doc.gate;
  if (raw === undefined || raw === null) return { mode: "advisory", burn_in_prs: 0 };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new EvalRefusal(`invalid evals/config.yaml 'gate': expected a map, got ${JSON.stringify(raw)}`,
      "gate:\n  mode: advisory|blocking\n  burn_in_prs: <non-negative integer>");
  }
  const mode = raw.mode === undefined ? "advisory" : raw.mode;
  if (mode !== "advisory" && mode !== "blocking") {
    throw new EvalRefusal(`invalid evals/config.yaml 'gate.mode': '${mode}' — must be 'advisory' or 'blocking'`,
      "set gate.mode to 'advisory' or 'blocking' in evals/config.yaml");
  }
  const burnIn = raw.burn_in_prs === undefined ? 0 : raw.burn_in_prs;
  if (!Number.isInteger(burnIn) || burnIn < 0) {
    throw new EvalRefusal(`invalid evals/config.yaml 'gate.burn_in_prs': '${burnIn}' — must be a non-negative integer`,
      "set gate.burn_in_prs to a non-negative integer in evals/config.yaml");
  }
  return { mode, burn_in_prs: burnIn };
}

function loadEvalConfig(detentRoot) {
  const p = join(detentRoot, "evals", "config.yaml");
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    throw new EvalRefusal(`cannot read evals/config.yaml: ${e.message}`,
      "create evals/config.yaml — see engine/eval/README.md for the expected shape");
  }
  let doc;
  try {
    doc = parseEvalYaml(text, p);
  } catch (e) {
    throw new EvalRefusal(`malformed evals/config.yaml: ${e.message}`,
      "fix the YAML in evals/config.yaml (band/k/suites shape)");
  }
  const band = typeof doc.band === "number" ? doc.band : 0.05;
  const k = typeof doc.k === "number" ? doc.k : 1;
  const judgeMaxCases = typeof doc.judge_max_cases === "number" ? doc.judge_max_cases : 5;
  const suites = doc.suites && typeof doc.suites === "object" ? doc.suites : {};
  const gate = loadGateConfig(doc);
  return { band, k, judgeMaxCases, suites, gate };
}

// Suite selection — by name (--suite), by changed paths (--changed/--pr), or
// all (default). Glob matching + the one sandboxed git spawn for --changed
// both live in select.mjs (pure, unit-tested there); this is just the
// flag-parsing layer on top of it.
// ---------------------------------------------------------------------------

/**
 * Returns `{mode, suites}` — `mode` is one of `"suite"|"changed"|"all"`, the
 * visible half of PR binding (§1.2/1.5): the result JSON and the human
 * renderer both report WHY these suites (and not others) ran.
 */
function resolveSuiteSelection(config, flags, repoRoot) {
  if (flags.suite === true) {
    // Bare `--suite` (no value) previously fell straight through to
    // allSuites(config) — silently running EVERYTHING under a flag that
    // looks like it's scoping the run down. Refuse loudly instead (LOW-6
    // nit: fail loud, never silently do the opposite of what a bare flag
    // implies).
    throw new EvalRefusal(
      "--suite given with no value — refusing (this would silently run ALL suites)",
      "pass --suite <name>[,<name2>...], or omit --suite entirely to run every suite intentionally",
    );
  }
  if (flags.suite) {
    const requested = String(flags.suite).split(",").map((s) => s.trim()).filter(Boolean);
    const known = allSuites(config);
    const unknown = requested.filter((s) => !known.includes(s));
    if (unknown.length) {
      throw new EvalRefusal(`unknown suite(s): ${unknown.join(", ")}`,
        `known suites: ${known.join(", ") || "(none configured in evals/config.yaml)"}`);
    }
    return { mode: "suite", suites: requested };
  }
  if (flags.changed || flags.pr) {
    if (flags.pr) {
      process.stderr.write(
        `eval: --pr${flags.pr !== true ? ` ${flags.pr}` : ""} is an alias of --changed in this MVP (no gh call, no network) — value ignored\n`,
      );
    }
    const changedPaths = changedPathsFromGit(repoRoot);
    return { mode: "changed", suites: selectByChangedPaths({ changedPaths, config }) };
  }
  return { mode: "all", suites: allSuites(config) };
}

/**
 * `--k <N>` (judge panel size). Bare `--k` (no value) falls back to
 * evals/config.yaml's k, same as omitting the flag entirely. An explicit
 * but non-numeric/non-positive-integer value (`--k abc`, `--k 0`, `--k -1`,
 * `--k 1.5`) previously silently coerced to `NaN` -> effectively `k=1` via
 * judgeCase's `Math.max(1, Number(k) || 1)` — refuse instead of guessing.
 */
function resolveK(flags, config) {
  if (flags.k === undefined || flags.k === true) return config.k;
  const n = Number(flags.k);
  if (!Number.isInteger(n) || n < 1) {
    throw new EvalRefusal(
      `--k must be a positive integer, got '${flags.k}'`,
      "pass --k <N> where N is a positive integer (e.g. --k 3), or omit --k to use evals/config.yaml's k",
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Grading — loads each suite's case specs (evals/cases/<suite>/*.json) and
// grades them via graders/deterministic.mjs's CHECKS. A suite with no case
// files yet honestly reports score:null with a note (never a fabricated
// pass/fail) — this still applies to any suite not yet built out.
// ---------------------------------------------------------------------------

function relFromRoot(detentRoot, p) {
  const r = relative(detentRoot, p);
  return r.startsWith("..") ? p : r;
}

/**
 * Judge case spec shape: `{prompt}` (inline, rare) OR `{prompt_path, include?,
 * anchors?}` — the per-skill suites' shape. `prompt_path` is read relative to
 * `detentRoot`. When `anchors: "<dimension>"` is set, `loadAnchors` +
 * `formatAnchorsBlock` (graders/judge.mjs) inject that dimension's
 * calibration-anchor block into the prompt mechanically — closing the
 * documented rubric<->anchor drift gap (evals/calibration/README.md) — and
 * the loaded anchors doc is returned alongside the prompt so `runSuite` can
 * classify the recorded score into an RYG `band`. Each `include` file's
 * content is appended LAST, under a `\n\n--- <repo-relative path> ---\n`
 * header (editing the included file changes the graded input — the
 * mechanism that keeps a static-fixture judge case from being pure
 * rubric/judge-stability noise). An unreadable `prompt_path`/`include`, or an
 * invalid/missing `anchors` dimension, is a hard throw here, propagating
 * straight out of runSuite/runEval — same treatment as a malformed case
 * spec, never a silent `{recorded:false}` (that honesty path is reserved for
 * --no-judge/missing-claude/executor-failure, all AFTER the prompt is
 * known-good).
 *
 * Returns `{prompt, anchorsDoc}` — `anchorsDoc` is `null` when the case spec
 * carries no `anchors` field (no band is ever invented without one).
 */
function resolveJudgeCase(detentRoot, spec) {
  const caseId = spec.id || "?";
  let prompt;
  if (typeof spec.prompt === "string") {
    prompt = spec.prompt;
  } else {
    if (!spec.prompt_path || typeof spec.prompt_path !== "string") {
      throw new Error(`judge case ${caseId}: missing 'prompt' or 'prompt_path'`);
    }
    const promptPath = resolve(detentRoot, spec.prompt_path);
    try {
      prompt = readFileSync(promptPath, "utf8");
    } catch (e) {
      throw new Error(`judge case ${caseId}: cannot read prompt_path ${relFromRoot(detentRoot, promptPath)}: ${e.message}`);
    }
  }

  let anchorsDoc = null;
  if (spec.anchors) {
    try {
      anchorsDoc = loadAnchors(detentRoot, spec.anchors);
    } catch (e) {
      throw new Error(`judge case ${caseId}: ${e.message}`);
    }
    prompt += `\n\n${formatAnchorsBlock(anchorsDoc)}`;
  }

  for (const inc of spec.include || []) {
    const incPath = resolve(detentRoot, inc);
    let content;
    try {
      content = readFileSync(incPath, "utf8");
    } catch (e) {
      throw new Error(`judge case ${caseId}: cannot read include '${inc}' (${relFromRoot(detentRoot, incPath)}): ${e.message}`);
    }
    prompt += `\n\n--- ${relFromRoot(detentRoot, incPath)} ---\n${content}`;
  }
  return { prompt, anchorsDoc };
}

// Known non-case support files that may legitimately sit alongside case specs
// in a cases_dir (e.g. sentinel-golden's expected-work-order.json, frozen next
// to case.json). Anything else that fails to shape-match a check/judge case
// is a candidate typo (MEDIUM-3: `check` -> `chek`, `check:123`, etc.) and
// must warn loudly rather than vanish silently.
const KNOWN_SUPPORT_FILE_RE = /^expected-.*\.json$/;

// One root, deliberately: case specs, the files they grade, the baseline and
// the ledger all live in the same checkout. See the --repo refusal in runEval.
function runSuite(detentRoot, suiteName, suiteDef, judgeOpts = {}) {
  const casesDir = suiteDef && suiteDef.cases_dir
    ? resolve(detentRoot, suiteDef.cases_dir)
    : join(detentRoot, "evals", "cases", suiteName);
  const relDir = relFromRoot(detentRoot, casesDir);
  let files = [];
  if (existsSync(casesDir) && statSync(casesDir).isDirectory()) {
    files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  }
  if (files.length === 0) {
    return {
      score: null, cases: {}, judge: { recorded: false, note: "no judge-graded cases configured" },
      note: `no cases found under ${relDir} — suite not built yet`,
    };
  }
  const { noJudge = true, executor, k = 1, judgeMaxCases = 5 } = judgeOpts;
  const cases = {};
  let judgeCaseCount = 0;
  let judgeRecordedAny = false;
  let judgeSkipNote = null;
  for (const file of files) {
    const specPath = join(casesDir, file);
    let spec;
    try {
      spec = JSON.parse(readFileSync(specPath, "utf8"));
    } catch (e) {
      throw new Error(`unreadable/malformed case spec ${relFromRoot(detentRoot, specPath)}: ${e.message}`);
    }
    // A case dir may sit next to non-case JSON support data (e.g. sentinel-golden's
    // expected-work-order.json, frozen alongside case.json). Only files shaped
    // like a deterministic case-spec ({check:...}) or a judge case-spec
    // ({grader:"judge", prompt:...}) are cases; anything else at this level is
    // either a known support file (silent) or a warned-about candidate typo —
    // never silently vanished (MEDIUM-3).
    if (!spec) continue;
    const caseId = spec.id || file.replace(/\.json$/, "");
    if (typeof spec.check === "string") {
      cases[caseId] = gradeCase(detentRoot, spec);
      continue;
    }
    if (spec.grader === "judge") {
      judgeCaseCount++;
      if (judgeCaseCount > judgeMaxCases) {
        throw new Error(
          `suite ${suiteName}: judge-graded case count exceeds judge_max_cases=${judgeMaxCases} `
          + `(evals/config.yaml) — bump the cap deliberately before adding more judge cases`,
        );
      }
      const { prompt, anchorsDoc } = resolveJudgeCase(detentRoot, spec);
      const result = runJudgeCase({ ...spec, prompt }, { noJudge, executor, k, bands: anchorsDoc && anchorsDoc.bands });
      cases[caseId] = {
        score: result.recorded ? result.score : null,
        pass: null, // continuous score, not a binary check — never fabricate pass/fail
        recorded: result.recorded,
        ...(result.recorded
          ? {
            k: result.k,
            spread: result.spread,
            votes: result.votes,
            // A band is only ever printed when classifiable from a
            // committed anchors doc — no `anchors` on the case spec means no
            // `band`/`band_dimension` key at all, never an invented band.
            ...(anchorsDoc ? { band: classifyBand(result.score, anchorsDoc.bands), band_dimension: anchorsDoc.dimension } : {}),
            ...(result.uncertain_votes ? { uncertain_votes: result.uncertain_votes } : {}),
            ...(result.band_unstable ? { band_unstable: true } : {}),
          }
          : { note: result.note }),
      };
      if (result.recorded) judgeRecordedAny = true;
      else judgeSkipNote = judgeSkipNote || result.note;
      continue;
    }
    // Unrecognized shape (neither `check` nor `grader:"judge"`). A known
    // support file (expected-*.json) is silently not a case, as documented.
    // Anything else is a candidate typo/corruption — warn loudly to stderr
    // so a one-char edit (`check`->`chek`, `check:123`, ...) can't silently
    // neutralize a case (gate-evasion).
    if (KNOWN_SUPPORT_FILE_RE.test(file)) continue;
    process.stderr.write(
      `eval: ${relFromRoot(detentRoot, specPath)} is neither a check case, a judge case, nor a known `
      + `support file (expected-*.json) — check for a typo in 'check'/'grader' (this file will NOT be graded)\n`,
    );
  }
  const score = aggregateSuite(Object.values(cases).map((c) => c.score));
  const judge = judgeCaseCount === 0
    ? { recorded: false, note: "no judge-graded cases configured" }
    : judgeRecordedAny
      ? { recorded: true }
      : { recorded: false, note: judgeSkipNote };
  return { score, cases, judge };
}

/**
 * Count deterministic pass->fail flips vs baseline (verdict.mjs §3 rule 1 —
 * noise-free, the band never excuses one). Only counts a flip where the
 * baseline recorded an explicit `pass: true`; a case absent from the
 * baseline (new case, or judge case that was never recorded) can never
 * manufacture a flip.
 */
function countDeterministicFlips(suiteResults, baseline) {
  let flips = 0;
  const baseSuites = (baseline && baseline.suites) || {};
  for (const [suiteName, r] of Object.entries(suiteResults)) {
    const baseCases = (baseSuites[suiteName] && baseSuites[suiteName].cases) || {};
    for (const [caseId, c] of Object.entries(r.cases || {})) {
      if (baseCases[caseId] && baseCases[caseId].pass === true && c.pass === false) flips++;
    }
  }
  return flips;
}

/**
 * MEDIUM-3 (gate-evasion): countDeterministicFlips only ever iterates the
 * CURRENT run's case set, so a case that silently failed to load this run
 * (a one-char typo in `check`, a broken JSON shape, a stray delete) never
 * shows up as a "flip" — it just isn't there to compare. Close that hole by
 * diffing the baseline's known case IDs (for every suite actually selected
 * this run) against the current run's case IDs: any baseline-known case
 * MISSING from the current run is loud on stderr AND treated as a
 * regression, exactly like a deterministic pass->fail flip — a silently
 * dropped case must never pass.
 */
function findMissingBaselineCases(suiteResults, baseline) {
  const missing = [];
  const baseSuites = (baseline && baseline.suites) || {};
  for (const [suiteName, r] of Object.entries(suiteResults)) {
    const baseSuite = baseSuites[suiteName];
    if (!baseSuite || !baseSuite.cases) continue;
    const curCases = r.cases || {};
    for (const caseId of Object.keys(baseSuite.cases)) {
      if (!(caseId in curCases)) {
        missing.push({ suite: suiteName, case: caseId });
        process.stderr.write(
          `eval: REGRESSION — case '${caseId}' in suite '${suiteName}' is present in the committed baseline `
          + `but MISSING from this run (dropped, renamed, or its spec no longer parses as a case) — `
          + `treating as a deterministic flip (gate-evasion is not allowed)\n`,
        );
      }
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Ledger — append one line to <detentRoot>/benchmarks/ledger.jsonl (same
// mkdirSync + appendFileSync idiom as bench's appendLedger). `schema`
// discriminates eval lines from bench lines (which carry no schema key).
// ---------------------------------------------------------------------------

function appendEvalLedger(detentRoot, line) {
  const benchmarksDir = join(detentRoot, "benchmarks");
  mkdirSync(benchmarksDir, { recursive: true });
  const ledgerPath = join(benchmarksDir, "ledger.jsonl");
  appendFileSync(ledgerPath, JSON.stringify(line) + "\n");
  return ledgerPath;
}

function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, p);
}

function getGitSha(repoRoot) {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) return null;
  const sha = r.stdout.trim();
  return sha || null;
}

// ---------------------------------------------------------------------------
// runEval — the file-touching entry point used by `engine eval` and the CLI.
// ---------------------------------------------------------------------------

export function runEval({ detentRoot, flags }) {
  const startedAt = Date.now();

  if (flags.rebaseline && (flags.suite || flags.changed || flags.pr)) {
    throw new EvalRefusal("--rebaseline cannot be combined with --suite/--changed/--pr — a partial baseline is a corrupt baseline",
      "run `engine eval --rebaseline` alone, with no selector");
  }
  // Single-root invariant. `--repo` used to point the files-under-test at one
  // checkout while the case specs, baseline and ledger came from another —
  // which graded a foreign tree against this tree's specs and still reported a
  // clean verdict, and wrote a ledger line carrying the foreign tree's
  // git_sha. Refuse rather than reinterpret: silently redefining a documented
  // flag is its own bug.
  if (flags.repo !== undefined && flags.repo !== false) {
    throw new EvalRefusal("--repo is not valid for `engine eval` — eval grades the one detent checkout its config, case specs, baseline and ledger live in",
      "point DETENT_ROOT at the checkout you want evaluated, or pass --detent-root <path>");
  }

  const config = loadEvalConfig(detentRoot);

  const selection = resolveSuiteSelection(config, flags, detentRoot);
  const suiteNames = selection.suites;

  const noJudge = !!flags["no-judge"];
  const k = resolveK(flags, config);
  const judgeOpts = {
    noJudge,
    executor: flags.__judgeExecutor, // test-only seam; never set from the real CLI
    k,
    judgeMaxCases: config.judgeMaxCases,
  };

  const suiteResults = {};
  for (const name of suiteNames) {
    suiteResults[name] = runSuite(detentRoot, name, config.suites[name], judgeOpts);
  }

  const gitSha = getGitSha(detentRoot);

  if (flags.rebaseline) {
    const baselinePath = flags.baseline && flags.baseline !== true
      ? resolve(flags.baseline)
      : join(detentRoot, "evals", "baseline.json");
    const baselineDoc = {
      schema: BASELINE_SCHEMA,
      generated_at: new Date().toISOString(),
      git_sha: gitSha,
      suites: Object.fromEntries(
        Object.entries(suiteResults).map(([s, r]) => [s, { score: r.score, cases: r.cases }]),
      ),
    };
    writeJsonAtomic(baselinePath, baselineDoc);
    const rebaselineResult = {
      rebaselined: true,
      baseline_path: baselinePath,
      git_sha: gitSha,
      suites: baselineDoc.suites,
      exit_code: 0,
      next_step: "commit evals/baseline.json",
    };
    if (!flags.quiet) process.stderr.write(renderRebaseline(rebaselineResult));
    return rebaselineResult;
  }

  const baselinePath = flags.baseline && flags.baseline !== true
    ? resolve(flags.baseline)
    : join(detentRoot, "evals", "baseline.json");
  let baseline;
  try {
    baseline = loadBaseline(baselinePath);
  } catch (e) {
    throw new EvalRefusal(`missing/corrupt baseline: ${e.message}`,
      "run: engine eval --rebaseline on main to seed evals/baseline.json");
  }

  const currentScores = Object.fromEntries(
    Object.entries(suiteResults).map(([s, r]) => [s, { score: r.score, cases: r.cases }]),
  );
  const deltas = computeDeltas(currentScores, baseline);
  const baseSuitesForCases = (baseline && baseline.suites) || {};
  for (const [s, r] of Object.entries(suiteResults)) {
    if (r.note && deltas[s] && !deltas[s].note) deltas[s].note = r.note;
    if (deltas[s]) {
      // Thread each case's baseline pass/fail through to the render layer —
      // same condition as countDeterministicFlips below, so a case that was
      // already failing (or is new) at baseline is never mislabeled as a
      // "flip" by render.mjs (only an explicit baseline pass:true -> false
      // transition is a flip).
      const baseCases = (baseSuitesForCases[s] && baseSuitesForCases[s].cases) || {};
      deltas[s].cases = Object.fromEntries(
        Object.entries(r.cases).map(([caseId, c]) => [
          caseId,
          { ...c, baseline_pass: typeof baseCases[caseId]?.pass === "boolean" ? baseCases[caseId].pass : undefined },
        ]),
      );
    }
  }

  const deterministicFlips = countDeterministicFlips(suiteResults, baseline);
  const missingBaselineCases = findMissingBaselineCases(suiteResults, baseline);

  const verdictResult = computeVerdict(deltas, {
    band: config.band,
    deterministicFlips,
    missingCases: missingBaselineCases.length,
    emptySelection: suiteNames.length === 0,
  });

  // Overall judge summary: recorded:true if ANY suite recorded a real judge
  // score; otherwise recorded:false with the first skip note found (honesty
  // rule — never claim "recorded" for a run where nothing was). A run with no
  // judge-graded cases configured anywhere is reported the same way absent
  // token/model data is in bench: {recorded:false, note}, never fabricated.
  const suiteJudges = Object.values(suiteResults).map((r) => r.judge).filter(Boolean);
  const anyJudgeRecorded = suiteJudges.some((j) => j.recorded);
  const firstNote = suiteJudges.find((j) => !j.recorded && j.note && j.note !== "no judge-graded cases configured")?.note
    ?? suiteJudges.find((j) => !j.recorded && j.note)?.note;
  const judge = anyJudgeRecorded
    ? { recorded: true }
    : { recorded: false, note: firstNote || "no judge-graded cases configured" };

  // Disagreement signal (verdict.mjs §3, no verdict effect in this MVP): any
  // recorded judge case whose k-run spread exceeds 2x the band is flagged —
  // data for tuning band over time, not a gate.
  const judgeFlaky = [];
  for (const [suiteName, r] of Object.entries(suiteResults)) {
    for (const [caseId, c] of Object.entries(r.cases || {})) {
      if (c.recorded && typeof c.spread === "number" && c.spread > 2 * config.band) {
        judgeFlaky.push(`${suiteName}/${caseId}`);
      }
    }
  }

  const durationMs = Date.now() - startedAt;

  // Gate — advisory -> blocking after burn-in (roadmap [4/8]). Computed
  // BEFORE appendEvalLedger below, so this run's own ledger line can never
  // count toward its own burn-in. Missing ledger file -> "" (0 green, never
  // fabricated), same honesty rule as everywhere else in this module.
  const ledgerPath = join(detentRoot, "benchmarks", "ledger.jsonl");
  const ledgerTextForGate = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  const baselineSha = baseline.git_sha ?? null;
  const gateMode = resolveGateMode({ envValue: process.env.EVAL_BLOCKING, gate: config.gate });
  const greenBaselines = countGreenBaselines(ledgerTextForGate, { baselineSha, schema: EVAL_SCHEMA });
  // `EVAL_BLOCKING=on` is the operator's explicit emergency override — it
  // must arm blocking IMMEDIATELY, bypassing burn-in entirely, regardless of
  // `gate.burn_in_prs` (this is the "pre-existing EVAL_BLOCKING=on behavior
  // is unchanged" contract documented in README.md and the CI workflow
  // comment). Burn-in still gates a `gate.mode: blocking` config with no env
  // override — only the explicit env value is a true escape hatch.
  const envForcesBlocking = process.env.EVAL_BLOCKING === "on";
  // Tier split (deterministic day-1 value): burn-in exists ONLY to shield
  // judge/LLM variance. A deterministic signal — a pass->fail flip or a
  // baseline-known case missing from this run (verdict.mjs rule 1) — is
  // noise-free, so under a blocking config it arms the gate IMMEDIATELY,
  // with no burn-in requirement. A judge-only DEGRADE (flips==0 &&
  // missing==0, suite delta < -band) stays advisory until burn-in completes.
  // EVAL_BLOCKING=on still forces both tiers to block (unchanged emergency
  // override); EVAL_BLOCKING=off forces advisory for both (armed requires
  // gateMode === "blocking", which =off precludes).
  const deterministicDegrade = deterministicFlips > 0 || missingBaselineCases.length > 0;
  const burnInMet = greenBaselines >= config.gate.burn_in_prs;
  const armed = gateMode === "blocking" && (envForcesBlocking || burnInMet || deterministicDegrade);
  const gate = { mode: gateMode, burn_in_prs: config.gate.burn_in_prs, green_baselines: greenBaselines, armed };

  const ledgerLine = {
    schema: EVAL_SCHEMA,
    ts: new Date().toISOString(),
    kind: "eval",
    git_sha: gitSha,
    baseline_sha: baselineSha,
    verdict: verdictResult.verdict,
    band: config.band,
    suites: Object.fromEntries(
      Object.entries(deltas).map(([s, d]) => [s, { score: d.score, baseline: d.baseline, delta: d.delta }]),
    ),
    deterministic_flips: deterministicFlips,
    missing_baseline_cases: missingBaselineCases.length,
    judge: { recorded: judge.recorded },
    duration_ms: durationMs,
    gate: { mode: gateMode, armed },
  };
  appendEvalLedger(detentRoot, ledgerLine);

  let exitCode = 0;
  let nextStep = "review suites[].delta — NEUTRAL/UPGRADE need no action";
  if (verdictResult.verdict === "DEGRADE") {
    if (gateMode === "blocking") {
      if (armed) {
        exitCode = 2;
        nextStep = deterministicDegrade && !burnInMet && !envForcesBlocking
          ? `blocked: verdict DEGRADE (${verdictResult.reason}) — deterministic regressions block immediately even during burn-in (green ${greenBaselines}/${config.gate.burn_in_prs}; burn-in only shields judge noise); fix the regression, or set EVAL_BLOCKING=off to make this advisory`
          : `blocked: verdict DEGRADE (${verdictResult.reason}) — fix the regression, or set EVAL_BLOCKING=off to make this advisory`;
      } else {
        nextStep = `judge-driven DEGRADE during burn-in (green ${greenBaselines}/${config.gate.burn_in_prs} vs baseline ${baselineSha}) — advisory until burn-in completes; a deterministic flip or missing baseline case would have blocked`;
      }
    } else {
      nextStep = `DEGRADE: ${verdictResult.reason} — advisory only (set EVAL_BLOCKING=on to make this a refusal)`;
    }
  }

  // Build the result object FIRST, then render off of it — the renderer's
  // contract is "exactly the object runEval returns", so the render call
  // must never precede its own construction.
  const result = {
    schema: EVAL_SCHEMA,
    verdict: verdictResult.verdict,
    band: config.band,
    selection: { mode: selection.mode, suites: suiteNames },
    suites: deltas,
    deterministic_flips: deterministicFlips,
    missing_baseline_cases: missingBaselineCases.length,
    ...(missingBaselineCases.length ? { missing_baseline_case_details: missingBaselineCases } : {}),
    judge,
    ...(judgeFlaky.length ? { judge_flaky: judgeFlaky } : {}),
    baseline_sha: baselineSha,
    git_sha: gitSha,
    duration_ms: durationMs,
    ledger_path: ledgerPath,
    gate,
    exit_code: exitCode,
    next_step: nextStep,
  };

  if (!flags.quiet) process.stderr.write(renderHuman(result));

  return result;
}

// ---------------------------------------------------------------------------
// CLI: node engine/eval/eval.mjs [--suite ...] [--changed] [--pr ...]
//                                [--baseline <path>] [--k <N>] [--no-judge]
//                                [--rebaseline] [--detent-root <path>] [--quiet]
// (stdout is ALWAYS the single JSON line described in this module's header
// comment — there is no --json flag; it was advertised but never wired up.
// stdout is already the machine channel: CI's `tee eval.json` parses it. All
// human-facing rendering — the plain-English verdict + suite table from
// render.mjs's renderHuman/renderRebaseline — goes to stderr and is the
// default; pass --quiet to suppress it (e.g. when only the JSON line is
// wanted, or in a context that doesn't want stderr noise). --quiet never
// changes stdout.)
// ---------------------------------------------------------------------------

function standaloneDetentRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// ---------------------------------------------------------------------------
// resolveEvalRoots — decide the ONE detent checkout this run grades, and
// refuse loudly rather than grade the wrong tree.
//
// Precedence: --detent-root (explicit intent) > DETENT_ROOT > the clone this
// CLI lives in. Two refusals:
//   * `--repo` at all — the old split root (see runEval).
//   * DETENT_ROOT naming a valid but DIFFERENT detent checkout than the one
//     cwd sits in. That case is otherwise completely silent: it grades the
//     other clone end to end and emits a coherent verdict for a tree the
//     caller never touched. `--detent-root` is the escape hatch when the
//     divergence is deliberate.
// Pure w.r.t. process state (env/cwd are injected) so it is unit-testable —
// the CLI path had zero coverage before this.
// ---------------------------------------------------------------------------

function detentCheckoutAt(dir) {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, "evals", "config.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Directory IDENTITY, not string equality. `resolve()` normalizes `.`/`..` but
// canonicalizes neither symlinks nor filesystem case, and both bite here:
// `/Users/x/code/...` and `/Users/x/Code/...` are one directory with one inode
// on a case-insensitive volume, and mkdtemp's `/tmp/...` is `/private/tmp/...`
// to process.cwd(). Comparing the strings refuses a directory against itself.
function sameDir(a, b) {
  try {
    const sa = statSync(a), sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

// The shared .git of a repository — identical for a main checkout and every
// `git worktree` linked to it, which is how we tell "another worktree of MY
// repo" (fine) from "an unrelated clone" (the thing worth refusing).
function gitCommonDir(dir) {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) return null;
  const p = (r.stdout || "").trim();
  return p ? resolve(dir, p) : null;
}

export function resolveEvalRoots({ env = {}, cwd, fallbackRoot, flags = {} } = {}) {
  if (flags.repo !== undefined && flags.repo !== false) {
    throw new EvalRefusal("--repo is not valid for `engine eval` — eval grades the one detent checkout its config, case specs, baseline and ledger live in",
      "point DETENT_ROOT at the checkout you want evaluated, or pass --detent-root <path>");
  }

  const flagRoot = flags["detent-root"];
  if (flagRoot === true) {
    throw new EvalRefusal("--detent-root needs a path — a valueless flag would silently fall back to DETENT_ROOT and re-arm the very guard it exists to escape",
      "pass --detent-root <path>, or drop the flag to use DETENT_ROOT");
  }
  const explicit = flagRoot !== undefined && flagRoot !== false;
  const root = explicit ? resolve(flagRoot)
    : env.DETENT_ROOT ? resolve(env.DETENT_ROOT)
      : resolve(fallbackRoot);
  const source = explicit ? "flag" : env.DETENT_ROOT ? "env" : "fallback";
  const label = source === "flag" ? "--detent-root"
    : source === "env" ? "DETENT_ROOT" : "the resolved detent root";

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new EvalRefusal(`${label} is not a directory: ${root}`,
      "point it at your detent clone, or unset DETENT_ROOT to use the clone this CLI lives in");
  }

  if (!explicit && cwd) {
    const here = detentCheckoutAt(cwd);
    if (here && !sameDir(here, root)) {
      // Another worktree of the SAME repository is not a foreign tree — it is
      // the tree you are editing, and the one whose diff `--changed` reads. Use
      // it. Refusing these would break the post-push eval nudge and every
      // engine-created .sdlc/<run>/worktree, and the "fix" of pointing
      // --detent-root at the main clone would grade the tree you are NOT
      // editing: the exact bug this guard exists to prevent, re-offered as
      // opt-in.
      const hc = gitCommonDir(here), rc = gitCommonDir(root);
      if (hc && rc && sameDir(hc, rc)) {
        return { detentRoot: here, source, redirected_from: root };
      }
      throw new EvalRefusal(
        `${label} points at an unrelated detent checkout, not a worktree of the one you are working in — refusing rather than grading the wrong tree (its case specs, baseline and ledger would all be the other clone's):\n  ${label}: ${root}\n  current checkout: ${here}`,
        `run from ${root}, or point ${source === "env" ? "DETENT_ROOT" : "the root"} at ${here}, or pass --detent-root <path> if the divergence is deliberate`);
    }
  }

  return { detentRoot: root, source };
}

function cli(argv) {
  const { flags } = parseArgs(argv);
  try {
    const { detentRoot } = resolveEvalRoots({
      env: process.env, cwd: process.cwd(), fallbackRoot: standaloneDetentRoot(), flags,
    });
    const result = runEval({ detentRoot, flags });
    const { exit_code, ...payload } = result;
    process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
    process.exit(exit_code ?? 0);
  } catch (e) {
    if (e instanceof EvalRefusal) {
      process.stdout.write(JSON.stringify({ ok: false, reason: e.message, next_step: e.next_step, ...e.extra }) + "\n");
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: `eval: ${e.message}`,
      next_step: "this is a bug in engine/eval/eval.mjs or its inputs — read the message above",
      stack: e.stack,
    }) + "\n");
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  cli(process.argv.slice(2));
}
