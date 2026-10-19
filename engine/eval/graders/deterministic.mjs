/**
 * deterministic — the deterministic-tier case library for `engine eval`.
 *
 * Exports CHECKS, a map of named check functions `(repoRoot, caseSpec) =>
 * {pass, details}`, plus `gradeCase(repoRoot, caseSpec)` which looks up
 * `caseSpec.check` in CHECKS and shapes the result into the grader's public
 * contract: `{score: 0|1, pass, checks: [{name, ok, detail}]}`.
 *
 * Every check is a pure read of the repo, plus ONE sandboxed spawn
 * (curator-self-containment, S1-3) that runs `engine dashboard` offline
 * against a scratch DETENT_ROOT — never a network call, never a mutation
 * of the real repo under test.
 *
 * Zero dependencies, Node >= 18.
 */
"use strict";

import { readFileSync, existsSync, statSync, readdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig, scanPure } from "../../sentinel/sentinel.mjs";
import {
  computeVerdict, computeDeltas, aggregateSuite, countGreenBaselines,
} from "../verdict.mjs";

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

function fail(details) {
  return { pass: false, details: Array.isArray(details) ? details : [details] };
}

function ok(detail) {
  return { pass: true, details: [detail] };
}

/** Recursive structural diff; returns a list of "path: <a> vs <b>" strings. */
function diffPaths(expected, actual, path = "$") {
  const diffs = [];
  const isObj = (v) => v !== null && typeof v === "object";
  if (!isObj(expected) || !isObj(actual)) {
    if (expected !== actual) diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return diffs;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    diffs.push(`${path}: expected ${Array.isArray(expected) ? "array" : "object"}, got ${Array.isArray(actual) ? "array" : "object"}`);
    return diffs;
  }
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) {
      diffs.push(`${path}.length: expected ${expected.length}, got ${actual.length}`);
    }
    const n = Math.max(expected.length, actual.length);
    for (let i = 0; i < n; i++) diffs.push(...diffPaths(expected[i], actual[i], `${path}[${i}]`));
    return diffs;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of keys) diffs.push(...diffPaths(expected[k], actual[k], `${path}.${k}`));
  return diffs;
}

// ---------------------------------------------------------------------------
// S1-1 skill-frontmatter — every skills/*/SKILL.md starts with `---`
// frontmatter carrying a non-empty name: equal to its directory name, and a
// non-empty description:. String parse only — no YAML lib needed.
// ---------------------------------------------------------------------------

function checkSkillFrontmatter(repoRoot) {
  const skillsDir = join(repoRoot, "skills");
  if (!existsSync(skillsDir)) return fail(`no skills/ directory under ${repoRoot}`);
  const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  if (dirs.length === 0) return fail("skills/ has no skill directories");
  const details = [];
  for (const dir of dirs) {
    const p = join(skillsDir, dir, "SKILL.md");
    if (!existsSync(p)) { details.push(`${dir}: missing SKILL.md`); continue; }
    const text = readFileSync(p, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) { details.push(`${dir}: SKILL.md has no --- frontmatter block`); continue; }
    const nameMatch = /^name:\s*(.*)$/m.exec(fm[1]);
    const descMatch = /^description:\s*(.*)$/m.exec(fm[1]);
    const name = nameMatch ? nameMatch[1].trim() : "";
    if (!name) { details.push(`${dir}: frontmatter has no non-empty name:`); continue; }
    if (name !== dir) { details.push(`${dir}: frontmatter name '${name}' != directory name '${dir}'`); continue; }
    if (!descMatch || !descMatch[1].trim()) { details.push(`${dir}: frontmatter has no non-empty description:`); continue; }
  }
  return details.length ? fail(details) : ok(`${dirs.length} skill(s) verified: ${dirs.join(", ")}`);
}

// ---------------------------------------------------------------------------
// S1-2 hooks-kill-switch — every script referenced in hooks/hooks.json exists
// under hooks/ and is executable; every PostToolUse+matcher:"Bash" script
// additionally carries a kill-switch guard reachable within its first
// KILL_SWITCH_WINDOW (400) lines — see the comment on that constant below
// for why it's 400 rather than a tighter "first 80 lines".
// ---------------------------------------------------------------------------

const KILL_SWITCH_RE = /\$\{[A-Z_]+:-on\}.*=.*"?off"?/;
// Window is generous (not a literal "first 80 lines"): some hook scripts are
// dual-mode — a self-relaunched detached-worker branch (guarded by a
// positional arg the hook framework never passes) can textually precede the
// real PostToolUse dispatch and its kill switch by a couple hundred lines
// without the worker branch ever executing in a normal hook invocation. What
// matters is "reachable before any side effect in the hook's real entry
// path", which a fixed small line count can't distinguish from "buried deep
// in unrelated code" — so the window is wide enough to admit that shape.
const KILL_SWITCH_WINDOW = 400;

function checkHooksKillSwitch(repoRoot) {
  const hooksJsonPath = join(repoRoot, "hooks", "hooks.json");
  if (!existsSync(hooksJsonPath)) return fail(`no hooks/hooks.json under ${repoRoot}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
  } catch (e) {
    return fail(`hooks/hooks.json is not valid JSON: ${e.message}`);
  }
  const allScripts = new Set();
  const bashPostToolUse = new Set();
  for (const [eventName, entries] of Object.entries(doc.hooks || {})) {
    for (const entry of entries || []) {
      for (const h of entry.hooks || []) {
        if (h.type !== "command" || typeof h.command !== "string") continue;
        const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[^"]+)"?$/.exec(h.command.trim());
        const rel = m ? m[1] : h.command.trim();
        allScripts.add(rel);
        if (eventName === "PostToolUse" && entry.matcher === "Bash") bashPostToolUse.add(rel);
      }
    }
  }
  if (allScripts.size === 0) return fail("hooks/hooks.json declares no command hooks");
  const details = [];
  for (const rel of allScripts) {
    const full = join(repoRoot, rel);
    if (!existsSync(full)) { details.push(`${rel}: referenced in hooks.json but missing on disk`); continue; }
    const st = statSync(full);
    if (!(st.mode & 0o111)) { details.push(`${rel}: not executable (chmod +x)`); continue; }
    if (bashPostToolUse.has(rel)) {
      const window = readFileSync(full, "utf8").split(/\r?\n/).slice(0, KILL_SWITCH_WINDOW).join("\n");
      if (!KILL_SWITCH_RE.test(window)) {
        details.push(`${rel}: no kill-switch guard (\${VAR:-on} ... = "off") found in first ${KILL_SWITCH_WINDOW} lines`);
      }
    }
  }
  return details.length ? fail(details) : ok(`${allScripts.size} hook script(s) verified (${bashPostToolUse.size} kill-switch-checked)`);
}

// ---------------------------------------------------------------------------
// S1-3 curator-self-containment — `engine dashboard`, run offline against a
// scratch DETENT_ROOT, must emit a self-contained HTML artifact: no network
// fetches, a system font stack, color-scheme support, and a charset meta.
// Generated-output invariant (.plans/ is gitignored, nothing is committed).
// ---------------------------------------------------------------------------

function checkCuratorSelfContainment(repoRoot) {
  const engineCli = join(repoRoot, "engine", "cli", "engine.mjs");
  if (!existsSync(engineCli)) return fail(`missing ${engineCli}`);
  const tmp = mkdtempSync(join(tmpdir(), "detent-eval-dashboard-"));
  const r = spawnSync(process.execPath, [engineCli, "dashboard"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DETENT_ROOT: tmp },
  });
  if (r.status !== 0) {
    return fail(`engine dashboard exited ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  }
  const htmlPath = join(tmp, ".plans", "engine-dashboard.html");
  if (!existsSync(htmlPath)) return fail(`engine dashboard did not write ${htmlPath}`);
  const html = readFileSync(htmlPath, "utf8");
  const details = [];
  if (!html.includes("color-scheme: light dark")) details.push("missing 'color-scheme: light dark'");
  if (/\b(?:src|href)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\/|@import\s+["']?https?:\/\//i.test(html)) {
    details.push("found an external https?:// reference in src=/href=/url()/@import — not self-contained");
  }
  if (!(html.includes("-apple-system") || html.includes("system-ui"))) {
    details.push("no system font stack (-apple-system / system-ui)");
  }
  if (!/<meta\s+charset/i.test(html)) details.push("missing <meta charset ...>");
  // Stable detail (no ephemeral tmp path) so a committed baseline stays deterministic.
  return details.length ? fail(details) : ok(`generated .plans/engine-dashboard.html — all self-containment invariants held`);
}

// ---------------------------------------------------------------------------
// S1-4 contract-stage-parity — the STAGES array in engine/cli/engine.mjs:
// each named stage has a directory engine/stages/<stage>/ and is mentioned
// in engine/stages/CONTRACT.md. Parsed by regex on the const literal —
// brittle on purpose: a stage rename must break this loudly.
// ---------------------------------------------------------------------------

function checkContractStageParity(repoRoot) {
  const engineMjsPath = join(repoRoot, "engine", "cli", "engine.mjs");
  if (!existsSync(engineMjsPath)) return fail(`missing ${engineMjsPath}`);
  const text = readFileSync(engineMjsPath, "utf8");
  const m = /const STAGES\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!m) return fail("could not find 'const STAGES = [...]' literal in engine/cli/engine.mjs");
  const stages = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  if (stages.length === 0) return fail("STAGES array literal parsed to zero stages");
  const contractPath = join(repoRoot, "engine", "stages", "CONTRACT.md");
  const contractText = existsSync(contractPath) ? readFileSync(contractPath, "utf8") : "";
  const details = [];
  for (const stage of stages) {
    const dir = join(repoRoot, "engine", "stages", stage);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      details.push(`${stage}: missing directory engine/stages/${stage}/`);
      continue;
    }
    if (!contractText.includes(stage)) details.push(`${stage}: not mentioned in engine/stages/CONTRACT.md`);
  }
  return details.length ? fail(details) : ok(`${stages.length} stage(s) verified: ${stages.join(", ")}`);
}

// hooks-wiring-parity — reverse of S1-2: every shebang'd top-level hooks/
// script must be wired in hooks.json (not just every wired script existing).
function collectWiredScripts(doc) {
  const wired = new Set();
  for (const entries of Object.values(doc.hooks || {})) {
    for (const entry of entries || []) {
      for (const h of entry.hooks || []) {
        if (h.type !== "command" || typeof h.command !== "string") continue;
        const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[^"]+)"?$/.exec(h.command.trim());
        wired.add(m ? m[1] : h.command.trim());
      }
    }
  }
  return wired;
}

function checkHooksWiringParity(repoRoot) {
  const hooksDir = join(repoRoot, "hooks");
  const hooksJsonPath = join(hooksDir, "hooks.json");
  if (!existsSync(hooksJsonPath)) return fail(`no hooks/hooks.json under ${repoRoot}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
  } catch (e) {
    return fail(`hooks/hooks.json is not valid JSON: ${e.message}`);
  }
  const wired = collectWiredScripts(doc);
  if (wired.size === 0) return fail("hooks/hooks.json declares no command hooks");
  const details = [];
  for (const rel of wired) {
    if (!existsSync(join(repoRoot, rel))) details.push(`${rel}: referenced in hooks.json but missing on disk`);
  }
  if (!existsSync(hooksDir)) return fail(`no hooks/ directory under ${repoRoot}`);
  const topLevel = readdirSync(hooksDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(sh|mjs)$/.test(e.name))
    .map((e) => e.name);
  let scriptCount = 0;
  for (const name of topLevel) {
    const full = join(hooksDir, name);
    const firstLine = readFileSync(full, "utf8").split(/\r?\n/, 1)[0];
    if (!firstLine.startsWith("#!")) continue; // not a directly-executed hook script
    scriptCount++;
    const rel = `hooks/${name}`;
    if (!wired.has(rel)) details.push(`${rel}: has a shebang (directly-executable hook script) but is not wired anywhere in hooks.json`);
  }
  return details.length
    ? fail(details)
    : ok(`${wired.size} wired script(s) verified on disk; ${scriptCount} hooks/ script(s) verified wired`);
}

// invocation-desc-length — disable-model-invocation:true skills are
// user-invoked only; their description costs nothing per turn, so a
// 200+ char one signals a reverted invocation split. Vacuous on zero.
function extractFrontmatterValue(fmText, key) {
  const lines = fmText.split(/\r?\n/);
  const keyRe = new RegExp(`^${key}:\\s*(.*)$`);
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx === -1) return null;
  const rest = keyRe.exec(lines[idx])[1];
  if (rest.trim() && !/^[>|][+-]?\d*\s*$/.test(rest.trim())) {
    return rest.trim().replace(/^['"]|['"]$/g, "");
  }
  // Block-scalar body (> or |): fold indented lines into one string for length.
  const body = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") { body.push(""); continue; }
    if (/^\S/.test(line)) break;
    body.push(line.replace(/^\s+/, ""));
  }
  return body.filter((l) => l !== "").join(" ").trim();
}

const INVOCATION_DESC_LIMIT = 200;

function checkInvocationDescLength(repoRoot) {
  const skillsDir = join(repoRoot, "skills");
  if (!existsSync(skillsDir)) return fail(`no skills/ directory under ${repoRoot}`);
  const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  const flagged = [];
  let checked = 0;
  for (const dir of dirs) {
    const p = join(skillsDir, dir, "SKILL.md");
    if (!existsSync(p)) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(p, "utf8"));
    if (!fm) continue;
    const disabled = extractFrontmatterValue(fm[1], "disable-model-invocation");
    if (!disabled || disabled.trim() !== "true") continue;
    checked++;
    const desc = extractFrontmatterValue(fm[1], "description") || "";
    if (desc.length >= INVOCATION_DESC_LIMIT) {
      flagged.push(`${dir}: disable-model-invocation:true but description is ${desc.length} chars (>= ${INVOCATION_DESC_LIMIT})`);
    }
  }
  if (checked === 0) return ok(`0 skill(s) with disable-model-invocation:true found — vacuously valid`);
  return flagged.length ? fail(flagged) : ok(`${checked} skill(s) with disable-model-invocation:true verified under ${INVOCATION_DESC_LIMIT} chars`);
}

// curator-example-ids-unique — a duplicate data-plan-question id within one
// example artifact makes curator's answer queue ambiguous about which
// question a poll answer belongs to.
function walkFiles(dir, pattern) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, pattern));
    else if (pattern.test(e.name)) out.push(full);
  }
  return out;
}

function checkCuratorExampleIdsUnique(repoRoot) {
  const examplesDir = join(repoRoot, "engine", "curator", "examples");
  if (!existsSync(examplesDir)) return ok("engine/curator/examples/ absent — trivially valid");
  const files = walkFiles(examplesDir, /\.html?$/i);
  if (files.length === 0) return ok("no example artifact files under engine/curator/examples/ — trivially valid");
  const details = [];
  let totalIds = 0;
  for (const full of files) {
    const rel = full.slice(repoRoot.length + 1);
    const ids = [...readFileSync(full, "utf8").matchAll(/data-plan-question=["']([^"']+)["']/g)].map((m) => m[1]);
    totalIds += ids.length;
    const counts = {};
    for (const id of ids) counts[id] = (counts[id] || 0) + 1;
    const dupes = Object.entries(counts).filter(([, c]) => c > 1).map(([id, c]) => `${id} (${c}x)`);
    if (dupes.length) details.push(`${rel}: duplicate data-plan-question id(s): ${dupes.join(", ")}`);
  }
  return details.length
    ? fail(details)
    : ok(`${files.length} example artifact(s) checked, ${totalIds} data-plan-question id(s) verified unique per file`);
}

// ---------------------------------------------------------------------------
// S1-5 ledger-parseable — every non-blank line of benchmarks/ledger.jsonl
// parses as JSON and carries either schema:"detent-eval-v1" or a bench-line
// key (wall_clock_ms). An empty (or absent) file passes trivially.
// ---------------------------------------------------------------------------

function checkLedgerParseable(repoRoot) {
  const p = join(repoRoot, "benchmarks", "ledger.jsonl");
  if (!existsSync(p)) return ok("benchmarks/ledger.jsonl absent — trivially valid");
  const lines = readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return ok("benchmarks/ledger.jsonl is empty — trivially valid");
  const details = [];
  for (const [i, line] of lines.entries()) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      details.push(`line ${i + 1}: not valid JSON: ${e.message}`);
      continue;
    }
    const validShape = obj && (obj.schema === "detent-eval-v1" || typeof obj.wall_clock_ms !== "undefined");
    if (!validShape) details.push(`line ${i + 1}: neither schema:"detent-eval-v1" nor wall_clock_ms present`);
  }
  return details.length ? fail(details) : ok(`${lines.length} ledger line(s) parsed and shape-checked`);
}

// ---------------------------------------------------------------------------
// S2-1 work-order-golden — scanPure() over a committed, scrubbed PR-comment
// fixture must reproduce the frozen expected work order exactly.
// ---------------------------------------------------------------------------

function checkWorkOrderGolden(repoRoot, caseSpec) {
  const params = (caseSpec && caseSpec.params) || {};
  if (!params.fixtures_dir || !params.expected_path) {
    return fail("case spec missing params.fixtures_dir / params.expected_path");
  }
  const fixturesDir = resolve(repoRoot, params.fixtures_dir);
  const expectedPath = resolve(repoRoot, params.expected_path);
  const prKey = params.pr_key || "eval/golden#1";
  let comments;
  let config;
  let expected;
  try {
    comments = JSON.parse(readFileSync(join(fixturesDir, "comments.json"), "utf8"));
    config = loadConfig(join(fixturesDir, "config.json"));
    expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  } catch (e) {
    return fail(`fixture load failed: ${e.message}`);
  }
  const { result } = scanPure({ comments, config, state: {}, prKey });
  const diffs = diffPaths(expected, result);
  return diffs.length ? fail(diffs) : ok(`scanPure(${prKey}) matches expected-work-order.json exactly`);
}

// ---------------------------------------------------------------------------
// doc-invariants — read one or more repo-relative files and assert every
// `must_match` pattern (a regex source, matched case-insensitively) is
// present in each; an optional `must_not_match` asserts the opposite. Used by
// the per-skill eval suites to pin doctrine-critical phrases in SKILL.md
// prose (e.g. "curator", "PENDING-EXTERNAL") without regrading the whole
// file — a skill-prose rewrite that drops one of these phrases fails loudly,
// naming the exact missing phrase, never a silent no-op. Details use only
// the repo-relative path from the case spec (never an absolute tmp path) so
// the committed baseline stays deterministic across machines.
//
// Two shapes, generalized so a suite can pin phrases across MULTIPLE files
// (not just one) without a one-off check:
//   - Legacy: `params: {file, must_match?, must_not_match?}` — a single file.
//   - `params.files: [...]`, each entry either a bare repo-relative path
//     string (sharing the top-level `must_match`/`must_not_match`) or its own
//     `{file, must_match?, must_not_match?}` object (independent phrase sets
//     per file — e.g. one set for CONTRACT.md, a different set for README.md).
// Both `file` and `files` may be given together; every resolved file is
// checked and ALL of their failures are reported together, never just the
// first.
// ---------------------------------------------------------------------------

function checkOneDocInvariant(repoRoot, relFile, mustMatch, mustNotMatch) {
  const fullPath = resolve(repoRoot, relFile);
  if (!existsSync(fullPath)) return { pass: false, details: [`${relFile}: file not found`] };
  const text = readFileSync(fullPath, "utf8");
  const details = [];
  for (const pattern of mustMatch || []) {
    const re = new RegExp(pattern, "i");
    if (!re.test(text)) details.push(`${relFile}: missing required phrase matching /${pattern}/i`);
  }
  for (const pattern of mustNotMatch || []) {
    const re = new RegExp(pattern, "i");
    if (re.test(text)) details.push(`${relFile}: forbidden phrase matching /${pattern}/i is present`);
  }
  return details.length ? { pass: false, details } : { pass: true, details: [`${relFile}: all invariant phrase(s) matched`] };
}

function checkDocInvariants(repoRoot, caseSpec) {
  const params = (caseSpec && caseSpec.params) || {};
  const targets = [];
  if (params.file) targets.push({ file: params.file, must_match: params.must_match, must_not_match: params.must_not_match });
  for (const entry of params.files || []) {
    if (typeof entry === "string") {
      targets.push({ file: entry, must_match: params.must_match, must_not_match: params.must_not_match });
    } else if (entry && typeof entry === "object" && entry.file) {
      targets.push(entry);
    } else {
      return fail(`params.files entries must be a path string or {file, must_match?, must_not_match?}, got ${JSON.stringify(entry)}`);
    }
  }
  if (targets.length === 0) return fail("case spec missing params.file or params.files");

  const allDetails = [];
  const oks = [];
  for (const t of targets) {
    const r = checkOneDocInvariant(repoRoot, t.file, t.must_match, t.must_not_match);
    if (r.pass) oks.push(...r.details);
    else allDetails.push(...r.details);
  }
  return allDetails.length ? fail(allDetails) : ok(oks.join("; "));
}

// ---------------------------------------------------------------------------
// calibration-anchors-valid — walk evals/calibration/*/anchors.json and
// assert the schema this repo's judge-calibration convention requires (see
// evals/calibration/README.md): the schema key is present, every anchor's
// `label` is one of {red,yellow,green}, at least one anchor of each color
// exists, every sample is non-empty, every `expected_range` is a 2-tuple
// inside [0,1] with lo <= hi, and (when the doc declares `bands`) the bands
// are ordered green >= yellow >= red with no gaps reversed. An absent
// evals/calibration/ directory is a hard fail — the case exists BECAUSE the
// directory is supposed to.
// ---------------------------------------------------------------------------

const ANCHOR_LABELS = ["red", "yellow", "green"];

function checkCalibrationAnchorsValid(repoRoot) {
  const calibDir = join(repoRoot, "evals", "calibration");
  if (!existsSync(calibDir)) return fail(`no evals/calibration/ directory under ${repoRoot}`);
  const dims = readdirSync(calibDir).filter((d) => statSync(join(calibDir, d)).isDirectory());
  if (dims.length === 0) return fail("evals/calibration/ has no dimension directories");
  const details = [];
  for (const dim of dims) {
    const relAnchors = join("evals", "calibration", dim, "anchors.json");
    const p = join(calibDir, dim, "anchors.json");
    if (!existsSync(p)) { details.push(`${dim}: missing anchors.json`); continue; }
    let doc;
    try {
      doc = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      details.push(`${dim}: ${relAnchors} is not valid JSON: ${e.message}`);
      continue;
    }
    if (doc.schema !== "detent-eval-anchors-v1") {
      details.push(`${dim}: ${relAnchors} missing schema:"detent-eval-anchors-v1"`);
      continue;
    }
    // `scenario` (top-level, optional) — when present, must be a non-empty
    // string (the one-paragraph fixed scenario all anchors respond to).
    if (doc.scenario !== undefined && (typeof doc.scenario !== "string" || !doc.scenario.trim())) {
      details.push(`${dim}: 'scenario' is present but not a non-empty string`);
    }
    const anchors = Array.isArray(doc.anchors) ? doc.anchors : [];
    if (anchors.length === 0) { details.push(`${dim}: anchors array is empty`); continue; }
    const labelsSeen = new Set();
    for (const [i, a] of anchors.entries()) {
      const label = a && a.label;
      if (!ANCHOR_LABELS.includes(label)) {
        details.push(`${dim}: anchors[${i}] has invalid label '${label}' (must be one of ${ANCHOR_LABELS.join(", ")})`);
        continue;
      }
      labelsSeen.add(label);
      if (!a.sample || typeof a.sample !== "string" || !a.sample.trim()) {
        details.push(`${dim}: anchors[${i}] (${label}) has an empty sample`);
      }
      // `why` (per-anchor, optional) — when present, must be a non-empty
      // string (one sentence naming what earns/costs the band). Unknown
      // fields are otherwise ignored by design; `why` is the one exception
      // this check validates, per the BUILD SPEC.
      if (a.why !== undefined && (typeof a.why !== "string" || !a.why.trim())) {
        details.push(`${dim}: anchors[${i}] (${label}) has a 'why' field that is not a non-empty string`);
      }
      const range = a.expected_range;
      const rangeOk = Array.isArray(range) && range.length === 2
        && typeof range[0] === "number" && typeof range[1] === "number"
        && range[0] >= 0 && range[1] <= 1 && range[0] <= range[1];
      if (!rangeOk) {
        details.push(`${dim}: anchors[${i}] (${label}) has an invalid expected_range (must be [lo,hi] inside [0,1] with lo<=hi)`);
      }
    }
    for (const need of ANCHOR_LABELS) {
      if (!labelsSeen.has(need)) details.push(`${dim}: missing at least one '${need}' anchor`);
    }
    const bands = doc.bands;
    if (!bands || !bands.red || !bands.yellow || !bands.green) {
      details.push(`${dim}: missing bands.{red,yellow,green}`);
    } else {
      for (const color of ANCHOR_LABELS) {
        const b = bands[color];
        const bandOk = Array.isArray(b) && b.length === 2
          && typeof b[0] === "number" && typeof b[1] === "number"
          && b[0] >= 0 && b[1] <= 1 && b[0] <= b[1];
        if (!bandOk) details.push(`${dim}: bands.${color} is not a valid [lo,hi] inside [0,1]`);
      }
      if (bands.green && bands.yellow && bands.green[0] < bands.yellow[1]) {
        details.push(`${dim}: bands.green.lo (${bands.green[0]}) is below bands.yellow.hi (${bands.yellow[1]}) — bands out of order`);
      }
      if (bands.yellow && bands.red && bands.yellow[0] < bands.red[1]) {
        details.push(`${dim}: bands.yellow.lo (${bands.yellow[0]}) is below bands.red.hi (${bands.red[1]}) — bands out of order`);
      }
    }
  }
  return details.length ? fail(details) : ok(`${dims.length} calibration dimension(s) verified: ${dims.join(", ")}`);
}

// ---------------------------------------------------------------------------
// json-shape — generic reusable check: `params: {file, required_keys?,
// schema?}`. Asserts the file exists, parses as JSON, `doc.schema ===
// schema` when a `schema` param is given, and every `required_keys` entry is
// present as a top-level key. Deliberately generic (no baseline/hooks/anchor
// specifics baked in) so future one-off "does this JSON file have the shape
// I expect" cases can reuse it instead of growing another bespoke check.
// ---------------------------------------------------------------------------

function checkJsonShape(repoRoot, caseSpec) {
  const params = (caseSpec && caseSpec.params) || {};
  if (!params.file) return fail("case spec missing params.file");
  const relFile = params.file;
  const fullPath = resolve(repoRoot, relFile);
  if (!existsSync(fullPath)) return fail(`${relFile}: file not found`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (e) {
    return fail(`${relFile}: not valid JSON: ${e.message}`);
  }
  const details = [];
  if (params.schema !== undefined && (!doc || doc.schema !== params.schema)) {
    details.push(`${relFile}: expected schema '${params.schema}', got ${JSON.stringify(doc && doc.schema)}`);
  }
  for (const key of params.required_keys || []) {
    if (!doc || typeof doc !== "object" || !(key in doc)) {
      details.push(`${relFile}: missing required key '${key}'`);
    }
  }
  return details.length ? fail(details) : ok(`${relFile}: valid JSON, shape matched`);
}

// ---------------------------------------------------------------------------
// harness-degradation-selftest — the eval harness grading ITSELF. No params,
// pure (no file I/O beyond importing verdict.mjs, no spawn, no network — the
// zero-network CI guarantee holds). Asserts a fixed set of edge-case truths
// about verdict.mjs's math directly, in-process: any weakening of that math
// (e.g. someone "simplifying" the band comparison to `<=`, or dropping the
// flip-override) flips this case's assertions and therefore DEGRADEs the
// harness on itself — the harness is self-protecting.
// ---------------------------------------------------------------------------

function checkHarnessDegradationSelftest() {
  const BAND = 0.05;
  const details = [];
  const record = (label, fn) => {
    try {
      fn();
      details.push(`${label}: ok`);
    } catch (e) {
      details.push(`${label}: FAILED — ${e.message}`);
    }
  };

  record("deterministic-flip-forces-degrade-despite-zero-delta", () => {
    const deltas = { s1: { score: 1, baseline: 1, delta: 0 } };
    const v = computeVerdict(deltas, { band: BAND, deterministicFlips: 1 });
    if (v.verdict !== "DEGRADE") throw new Error(`expected DEGRADE, got ${v.verdict}`);
  });

  record("missing-baseline-case-forces-degrade", () => {
    const deltas = { s1: { score: 1, baseline: 1, delta: 0 } };
    const v = computeVerdict(deltas, { band: BAND, missingCases: 1 });
    if (v.verdict !== "DEGRADE") throw new Error(`expected DEGRADE, got ${v.verdict}`);
  });

  record("delta-exactly-neg-band-is-not-degrade", () => {
    const deltas = { s1: { score: 0.95, baseline: 1, delta: -BAND } };
    const v = computeVerdict(deltas, { band: BAND });
    if (v.verdict === "DEGRADE") throw new Error("expected non-DEGRADE at delta === -band (band is inclusive), got DEGRADE");
  });

  record("delta-just-past-neg-band-is-degrade", () => {
    const deltas = { s1: { score: 0.9499, baseline: 1, delta: -BAND - 0.0001 } };
    const v = computeVerdict(deltas, { band: BAND });
    if (v.verdict !== "DEGRADE") throw new Error(`expected DEGRADE just past -band, got ${v.verdict}`);
  });

  record("delta-exactly-pos-band-is-not-upgrade", () => {
    const deltas = { s1: { score: 1.05, baseline: 1, delta: BAND } };
    const v = computeVerdict(deltas, { band: BAND });
    if (v.verdict === "UPGRADE") throw new Error("expected non-UPGRADE at delta === +band (band is inclusive), got UPGRADE");
  });

  record("delta-just-past-pos-band-is-upgrade", () => {
    const deltas = { s1: { score: 1.0501, baseline: 1, delta: BAND + 0.0001 } };
    const v = computeVerdict(deltas, { band: BAND });
    if (v.verdict !== "UPGRADE") throw new Error(`expected UPGRADE just past +band, got ${v.verdict}`);
  });

  record("null-score-suite-never-manufactures-a-verdict", () => {
    const current = { s1: { score: null, cases: {} } };
    const deltas = computeDeltas(current, { suites: { s1: { score: 0.5, cases: {} } } });
    if (deltas.s1.delta !== null) throw new Error(`expected delta:null for a score:null suite, got ${JSON.stringify(deltas.s1)}`);
    const v = computeVerdict(deltas, { band: BAND });
    if (v.verdict !== "NEUTRAL") throw new Error(`expected NEUTRAL when the only suite contributes delta:null, got ${v.verdict}`);
  });

  record("added-removed-case-ids-excluded-from-the-delta-intersection", () => {
    const current = { s1: { score: 1, cases: { A: { score: 1 }, NEW: { score: 0 } } } };
    const baseline = { suites: { s1: { score: 1, cases: { A: { score: 1 }, GONE: { score: 0 } } } } };
    const deltas = computeDeltas(current, baseline);
    if (deltas.s1.delta !== 0) throw new Error(`expected delta 0 over the shared {A} intersection only, got ${deltas.s1.delta}`);
    if (!(deltas.s1.added || []).includes("NEW")) throw new Error("expected 'NEW' reported in added");
    if (!(deltas.s1.removed || []).includes("GONE")) throw new Error("expected 'GONE' reported in removed");
  });

  record("empty-selection-is-neutral-no-suites-selected", () => {
    const v = computeVerdict({}, { band: BAND, emptySelection: true });
    if (v.verdict !== "NEUTRAL" || !/no suites selected/.test(v.reason)) {
      throw new Error(`expected NEUTRAL 'no suites selected', got ${JSON.stringify(v)}`);
    }
  });

  record("aggregate-suite-drops-non-numeric-entries-never-scores-zero", () => {
    const withUnrecorded = aggregateSuite([1, null, 1]);
    if (withUnrecorded !== 1) throw new Error(`expected aggregateSuite([1,null,1]) === 1, got ${withUnrecorded}`);
    const empty = aggregateSuite([]);
    if (empty !== null) throw new Error(`expected aggregateSuite([]) === null (nothing scoreable), got ${empty}`);
  });

  record("count-green-baselines-excludes-hollow-and-null-sha-lines", () => {
    const lines = [
      JSON.stringify({ schema: "detent-eval-v1", verdict: "NEUTRAL", git_sha: null, baseline_sha: "abc", suites: { s1: { score: 1 } } }),
      JSON.stringify({ schema: "detent-eval-v1", verdict: "NEUTRAL", git_sha: "def", baseline_sha: "abc", suites: {} }),
      JSON.stringify({ schema: "detent-eval-v1", verdict: "NEUTRAL", git_sha: "real1", baseline_sha: "abc", suites: { s1: { score: 1 } } }),
    ].join("\n") + "\n";
    const n = countGreenBaselines(lines, { baselineSha: "abc", schema: "detent-eval-v1" });
    if (n !== 1) throw new Error(`expected exactly 1 green baseline (git_sha:null and suites:{} lines excluded), got ${n}`);
  });

  const failed = details.filter((d) => d.includes("FAILED"));
  return failed.length ? fail(details) : ok(`${details.length} degradation/edge-case self-assertion(s) held: ${details.join("; ")}`);
}

// ---------------------------------------------------------------------------
// self-feedback-roundtrip — behavioral check for engine/self-feedback: spawns
// `node engine/self-feedback/feedback.mjs add ...` with DETENT_ROOT pointed
// at a scratch mkdtemp dir (same sandbox idiom as curator-self-containment —
// never the real repo under test), then `list`, and asserts the entry
// round-trips; then re-runs `add` with DETENT_SELF_FEEDBACK=off and asserts
// recorded:false with the journal left untouched (still exactly one line).
// ---------------------------------------------------------------------------

function checkSelfFeedbackRoundtrip(repoRoot) {
  const cli = join(repoRoot, "engine", "self-feedback", "feedback.mjs");
  if (!existsSync(cli)) return fail(`missing ${cli}`);
  const tmp = mkdtempSync(join(tmpdir(), "detent-eval-selffb-"));
  const details = [];

  const addResult = spawnSync(process.execPath, [
    cli, "add", "--area", "eval-selftest", "--note", "harness self-test roundtrip",
    "--kind", "coverage-gap", "--source", "hook",
  ], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, DETENT_ROOT: tmp } });
  if (addResult.status !== 0) {
    return fail(`feedback add exited ${addResult.status}: ${(addResult.stderr || addResult.stdout || "").slice(0, 300)}`);
  }
  let addJson;
  try {
    addJson = JSON.parse(addResult.stdout);
  } catch (e) {
    return fail(`feedback add did not print parseable JSON: ${e.message}`);
  }
  if (addJson.recorded !== true) details.push(`feedback add: expected recorded:true, got ${JSON.stringify(addJson.recorded)}`);

  const listResult = spawnSync(process.execPath, [cli, "list", "--area", "eval-selftest"], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, DETENT_ROOT: tmp },
  });
  if (listResult.status !== 0) {
    return fail(`feedback list exited ${listResult.status}: ${(listResult.stderr || listResult.stdout || "").slice(0, 300)}`);
  }
  let listJson;
  try {
    listJson = JSON.parse(listResult.stdout);
  } catch (e) {
    return fail(`feedback list did not print parseable JSON: ${e.message}`);
  }
  const found = (listJson.entries || []).find((e) => e.id === addJson.id);
  if (!found) details.push(`feedback list: added entry id ${addJson.id} did not round-trip`);
  else if (found.note !== "harness self-test roundtrip") details.push(`feedback list: round-tripped entry has an unexpected note: ${JSON.stringify(found)}`);

  const offResult = spawnSync(process.execPath, [
    cli, "add", "--area", "eval-selftest", "--note", "should not land",
  ], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, DETENT_ROOT: tmp, DETENT_SELF_FEEDBACK: "off" } });
  let offJson = {};
  try {
    offJson = JSON.parse(offResult.stdout);
  } catch (e) {
    details.push(`feedback add (DETENT_SELF_FEEDBACK=off): did not print parseable JSON: ${e.message}`);
  }
  if (offJson.recorded !== false) details.push(`feedback add with DETENT_SELF_FEEDBACK=off: expected recorded:false, got ${JSON.stringify(offJson.recorded)}`);
  const journalPath = join(tmp, ".local", "self-feedback", "journal.jsonl");
  const linesAfterOff = existsSync(journalPath) ? readFileSync(journalPath, "utf8").split("\n").filter(Boolean).length : 0;
  if (linesAfterOff !== 1) details.push(`DETENT_SELF_FEEDBACK=off: journal should still have exactly 1 line (untouched), got ${linesAfterOff}`);

  return details.length ? fail(details) : ok("self-feedback add/list round-trip verified in a scratch DETENT_ROOT; kill switch honored, journal untouched");
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export const CHECKS = {
  "skill-frontmatter": checkSkillFrontmatter,
  "hooks-kill-switch": checkHooksKillSwitch,
  "curator-self-containment": checkCuratorSelfContainment,
  "contract-stage-parity": checkContractStageParity,
  "ledger-parseable": checkLedgerParseable,
  "work-order-golden": checkWorkOrderGolden,
  "doc-invariants": checkDocInvariants,
  "calibration-anchors-valid": checkCalibrationAnchorsValid,
  "json-shape": checkJsonShape,
  "harness-degradation-selftest": checkHarnessDegradationSelftest,
  "self-feedback-roundtrip": checkSelfFeedbackRoundtrip,
  "hooks-wiring-parity": checkHooksWiringParity,
  "invocation-desc-length": checkInvocationDescLength,
  "curator-example-ids-unique": checkCuratorExampleIdsUnique,
};

/**
 * Grade one case spec `{id, check, params}` against `repoRoot`. Returns the
 * grader's public contract: `{score: 0|1, pass, checks: [{name, ok, detail}]}`.
 * Deterministic checks are binary — score is exactly pass ? 1 : 0, never a
 * fabricated partial credit.
 */
export function gradeCase(repoRoot, caseSpec) {
  const name = caseSpec && caseSpec.check;
  const fn = CHECKS[name];
  if (!fn) {
    throw new Error(`unknown deterministic check '${name}' (known: ${Object.keys(CHECKS).join(", ")})`);
  }
  const { pass, details } = fn(repoRoot, caseSpec);
  return {
    score: pass ? 1 : 0,
    pass,
    checks: [{ name, ok: pass, detail: details.join("; ") }],
  };
}
