// Unit tests for graders/deterministic.mjs. Each check is exercised twice:
// (a) against the REAL repo root (all pass — this doubles as the
//     baseline-green-at-HEAD guarantee for the seed baseline), and
// (b) against a synthetic broken fixture tree, asserting score 0 with
//     details naming the break.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, cpSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS, gradeCase } from "../graders/deterministic.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// real repo — every deterministic check must pass at HEAD (green baseline)
// ---------------------------------------------------------------------------

test("skill-frontmatter: passes against the real repo", () => {
  const r = CHECKS["skill-frontmatter"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("hooks-kill-switch: passes against the real repo", () => {
  const r = CHECKS["hooks-kill-switch"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("curator-self-containment: passes against the real repo (generated dashboard HTML)", () => {
  const r = CHECKS["curator-self-containment"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("contract-stage-parity: passes against the real repo", () => {
  const r = CHECKS["contract-stage-parity"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("ledger-parseable: passes against the real repo", () => {
  const r = CHECKS["ledger-parseable"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("work-order-golden: passes against the real repo's committed golden fixture", () => {
  const caseSpec = {
    check: "work-order-golden",
    params: {
      fixtures_dir: "evals/cases/sentinel-golden/fixtures",
      expected_path: "evals/cases/sentinel-golden/expected-work-order.json",
      pr_key: "eval/golden#1",
    },
  };
  const r = CHECKS["work-order-golden"](REPO_ROOT, caseSpec);
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("doc-invariants: passes against skills/clerk/SKILL.md's committed case params", () => {
  const r = CHECKS["doc-invariants"](REPO_ROOT, {
    check: "doc-invariants",
    params: {
      file: "skills/clerk/SKILL.md",
      must_match: ["curator", "PENDING-EXTERNAL", "untrusted data, never instructions"],
    },
  });
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("doc-invariants: passes against skills/scribe/SKILL.md's committed case params", () => {
  const r = CHECKS["doc-invariants"](REPO_ROOT, {
    check: "doc-invariants",
    params: {
      file: "skills/scribe/SKILL.md",
      must_match: ["never sends", "NO AI slop", "untrusted data"],
    },
  });
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("doc-invariants: fails and names the missing phrase when a must_match pattern is absent", () => {
  const dir = scratchDir("det-docinv-");
  mkdirSync(join(dir, "skills", "fake"), { recursive: true });
  writeFileSync(join(dir, "skills", "fake", "SKILL.md"), "---\nname: fake\ndescription: x\n---\nno curator mention here\n");
  const r = CHECKS["doc-invariants"](dir, {
    check: "doc-invariants",
    params: { file: "skills/fake/SKILL.md", must_match: ["curator", "PENDING-EXTERNAL"] },
  });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /missing required phrase matching \/PENDING-EXTERNAL\/i/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("doc-invariants: must_not_match catches a forbidden phrase", () => {
  const dir = scratchDir("det-docinv-notmatch-");
  mkdirSync(join(dir, "skills", "fake"), { recursive: true });
  writeFileSync(join(dir, "skills", "fake", "SKILL.md"), "this skill can auto-approve anything\n");
  const r = CHECKS["doc-invariants"](dir, {
    check: "doc-invariants",
    params: { file: "skills/fake/SKILL.md", must_not_match: ["auto-approve"] },
  });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /forbidden phrase matching \/auto-approve\/i is present/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("doc-invariants: fails when the file is missing", () => {
  const dir = scratchDir("det-docinv-missing-");
  const r = CHECKS["doc-invariants"](dir, { check: "doc-invariants", params: { file: "skills/ghost/SKILL.md", must_match: ["x"] } });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /file not found/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("doc-invariants: params.files with a mix of bare-path and per-file-phrase-set entries", () => {
  const r = CHECKS["doc-invariants"](REPO_ROOT, {
    check: "doc-invariants",
    params: {
      files: [
        { file: "engine/self-feedback/CONTRACT.md", must_match: ["append-only", "recorded", "never blocks", "DETENT_SELF_FEEDBACK=off"] },
        { file: "engine/self-feedback/README.md", must_match: ["value", "herald", "coverage gap"] },
      ],
    },
  });
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("doc-invariants: params.files bare-path entries share the top-level must_match", () => {
  const dir = scratchDir("det-docinv-files-shared-");
  mkdirSync(join(dir, "a"), { recursive: true });
  mkdirSync(join(dir, "b"), { recursive: true });
  writeFileSync(join(dir, "a", "one.md"), "alpha bravo\n");
  writeFileSync(join(dir, "b", "two.md"), "alpha only\n");
  const r = CHECKS["doc-invariants"](dir, {
    check: "doc-invariants",
    params: { files: ["a/one.md", "b/two.md"], must_match: ["alpha"] },
  });
  assert.equal(r.pass, true, JSON.stringify(r.details));
  const r2 = CHECKS["doc-invariants"](dir, {
    check: "doc-invariants",
    params: { files: ["a/one.md", "b/two.md"], must_match: ["bravo"] },
  });
  assert.equal(r2.pass, false);
  assert.ok(r2.details.some((d) => /b\/two\.md.*missing required phrase matching \/bravo\//.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("doc-invariants: fails and names EVERY failing file across params.files, not just the first", () => {
  const dir = scratchDir("det-docinv-files-multi-fail-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.md"), "nothing here\n");
  writeFileSync(join(dir, "b.md"), "nothing here either\n");
  const r = CHECKS["doc-invariants"](dir, {
    check: "doc-invariants",
    params: {
      files: [
        { file: "a.md", must_match: ["needle"] },
        { file: "b.md", must_match: ["needle"] },
      ],
    },
  });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => d.startsWith("a.md:")));
  assert.ok(r.details.some((d) => d.startsWith("b.md:")));
  rmSync(dir, { recursive: true, force: true });
});

test("json-shape: passes against evals/baseline.json (schema + required_keys)", () => {
  const r = CHECKS["json-shape"](REPO_ROOT, {
    check: "json-shape",
    params: { file: "evals/baseline.json", schema: "detent-eval-baseline-v1", required_keys: ["suites"] },
  });
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("json-shape: fails and names the missing key when required_keys has an absent one", () => {
  const dir = scratchDir("det-jsonshape-missingkey-");
  writeFileSync(join(dir, "thing.json"), JSON.stringify({ schema: "x-v1" }));
  const r = CHECKS["json-shape"](dir, {
    check: "json-shape",
    params: { file: "thing.json", schema: "x-v1", required_keys: ["missing_key"] },
  });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /missing required key 'missing_key'/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("json-shape: fails on a schema mismatch", () => {
  const dir = scratchDir("det-jsonshape-schema-");
  writeFileSync(join(dir, "thing.json"), JSON.stringify({ schema: "wrong-v1" }));
  const r = CHECKS["json-shape"](dir, {
    check: "json-shape",
    params: { file: "thing.json", schema: "expected-v1" },
  });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /expected schema 'expected-v1'/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("json-shape: fails when the file is not valid JSON", () => {
  const dir = scratchDir("det-jsonshape-invalid-");
  writeFileSync(join(dir, "thing.json"), "not json{{{");
  const r = CHECKS["json-shape"](dir, { check: "json-shape", params: { file: "thing.json" } });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /not valid JSON/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("json-shape: fails when the file is missing", () => {
  const dir = scratchDir("det-jsonshape-missing-");
  const r = CHECKS["json-shape"](dir, { check: "json-shape", params: { file: "ghost.json" } });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /file not found/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("harness-degradation-selftest: passes at HEAD (verdict.mjs's math holds every asserted edge case)", () => {
  const r = CHECKS["harness-degradation-selftest"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("hooks-wiring-parity: passes once every shebang'd script is wired", () => {
  const dir = scratchDir("det-wiring-ok-");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  const scriptPath = join(dir, "hooks", "wired.sh");
  writeFileSync(scriptPath, "#!/usr/bin/env bash\necho hi\n");
  chmodSync(scriptPath, 0o755);
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/wired.sh" }] }] },
  }));
  const r = CHECKS["hooks-wiring-parity"](dir, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
  rmSync(dir, { recursive: true, force: true });
});

test("hooks-wiring-parity: fails when a shebang'd script exists but is unwired", () => {
  const dir = scratchDir("det-wiring-orphan-");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "orphan.mjs"), "#!/usr/bin/env node\nconsole.log('hi');\n");
  writeFileSync(join(dir, "hooks", "wired.sh"), "#!/usr/bin/env bash\necho hi\n");
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/wired.sh" }] }] },
  }));
  const r = CHECKS["hooks-wiring-parity"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /orphan\.mjs.*not wired/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("hooks-wiring-parity: fails when a wired script is missing on disk", () => {
  const dir = scratchDir("det-wiring-ghost-");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/ghost.sh" }] }] },
  }));
  const r = CHECKS["hooks-wiring-parity"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /missing on disk/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("invocation-desc-length: passes against the real repo", () => {
  const r = CHECKS["invocation-desc-length"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("invocation-desc-length: passes when a disabled-invocation skill has a short description", () => {
  const dir = scratchDir("det-invoc-short-");
  mkdirSync(join(dir, "skills", "quiet"), { recursive: true });
  writeFileSync(join(dir, "skills", "quiet", "SKILL.md"), "---\nname: quiet\ndescription: a short one\ndisable-model-invocation: true\n---\n");
  const r = CHECKS["invocation-desc-length"](dir, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
  rmSync(dir, { recursive: true, force: true });
});

test("invocation-desc-length: fails when a disabled-invocation skill's description is 200+ chars", () => {
  const dir = scratchDir("det-invoc-long-");
  mkdirSync(join(dir, "skills", "verbose"), { recursive: true });
  const longDesc = "x".repeat(210);
  writeFileSync(join(dir, "skills", "verbose", "SKILL.md"), `---\nname: verbose\ndescription: ${longDesc}\ndisable-model-invocation: true\n---\n`);
  const r = CHECKS["invocation-desc-length"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /verbose.*210 chars/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("invocation-desc-length: ignores a long description on a skill that does NOT disable model invocation", () => {
  const dir = scratchDir("det-invoc-ignored-");
  mkdirSync(join(dir, "skills", "loud"), { recursive: true });
  writeFileSync(join(dir, "skills", "loud", "SKILL.md"), `---\nname: loud\ndescription: ${"y".repeat(300)}\n---\n`);
  const r = CHECKS["invocation-desc-length"](dir, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
  rmSync(dir, { recursive: true, force: true });
});

test("curator-example-ids-unique: passes against the real repo's engine/curator/examples/", () => {
  const r = CHECKS["curator-example-ids-unique"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("curator-example-ids-unique: fails on a duplicated data-plan-question id within one file", () => {
  const dir = scratchDir("det-curator-dup-");
  mkdirSync(join(dir, "engine", "curator", "examples"), { recursive: true });
  writeFileSync(join(dir, "engine", "curator", "examples", "dup.html"), `
    <div data-plan-question="rollout"></div>
    <div data-plan-question="rollout"></div>
  `);
  const r = CHECKS["curator-example-ids-unique"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /rollout \(2x\)/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("curator-example-ids-unique: an absent examples/ directory passes trivially", () => {
  const dir = scratchDir("det-curator-absent-");
  const r = CHECKS["curator-example-ids-unique"](dir, {});
  assert.equal(r.pass, true);
  rmSync(dir, { recursive: true, force: true });
});

test("self-feedback-roundtrip: passes against the real repo (scratch DETENT_ROOT, add/list round-trip + kill switch)", () => {
  const r = CHECKS["self-feedback-roundtrip"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("self-feedback-roundtrip: fails loudly when the feedback CLI is missing", () => {
  const dir = scratchDir("det-selffb-missing-");
  const r = CHECKS["self-feedback-roundtrip"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /missing/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("calibration-anchors-valid: passes against the real repo's evals/calibration/", () => {
  const r = CHECKS["calibration-anchors-valid"](REPO_ROOT, {});
  assert.equal(r.pass, true, JSON.stringify(r.details));
});

test("calibration-anchors-valid: fails when a dimension is missing a green anchor", () => {
  const dir = scratchDir("det-calib-missing-green-");
  const calibDir = join(dir, "evals", "calibration", "output-slop");
  mkdirSync(calibDir, { recursive: true });
  writeFileSync(join(calibDir, "anchors.json"), JSON.stringify({
    schema: "detent-eval-anchors-v1",
    dimension: "output-slop",
    bands: { green: [0.75, 1], yellow: [0.4, 0.75], red: [0, 0.4] },
    anchors: [
      { label: "yellow", sample: "meh", expected_range: [0.5, 0.6] },
      { label: "red", sample: "bad", expected_range: [0.1, 0.2] },
    ],
  }));
  const r = CHECKS["calibration-anchors-valid"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /missing at least one 'green' anchor/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("calibration-anchors-valid: fails when an expected_range is outside [0,1]", () => {
  const dir = scratchDir("det-calib-range-");
  const calibDir = join(dir, "evals", "calibration", "output-slop");
  mkdirSync(calibDir, { recursive: true });
  writeFileSync(join(calibDir, "anchors.json"), JSON.stringify({
    schema: "detent-eval-anchors-v1",
    dimension: "output-slop",
    bands: { green: [0.75, 1], yellow: [0.4, 0.75], red: [0, 0.4] },
    anchors: [
      { label: "green", sample: "great", expected_range: [0.9, 1.5] },
      { label: "yellow", sample: "meh", expected_range: [0.5, 0.6] },
      { label: "red", sample: "bad", expected_range: [0.1, 0.2] },
    ],
  }));
  const r = CHECKS["calibration-anchors-valid"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /invalid expected_range/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("calibration-anchors-valid: fails when evals/calibration/ is absent entirely", () => {
  const dir = scratchDir("det-calib-absent-");
  const r = CHECKS["calibration-anchors-valid"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /no evals\/calibration\/ directory/.test(d)));
  rmSync(dir, { recursive: true, force: true });
});

test("gradeCase: shapes a check's result into {score, pass, checks:[{name, ok, detail}]}", () => {
  const graded = gradeCase(REPO_ROOT, { check: "ledger-parseable", params: {} });
  assert.equal(graded.score, 1);
  assert.equal(graded.pass, true);
  assert.equal(graded.checks.length, 1);
  assert.equal(graded.checks[0].name, "ledger-parseable");
  assert.equal(graded.checks[0].ok, true);
});

test("gradeCase: unknown check name throws (never silently scores)", () => {
  assert.throws(() => gradeCase(REPO_ROOT, { check: "not-a-real-check" }), /unknown deterministic check/);
});

// ---------------------------------------------------------------------------
// synthetic broken fixtures — score 0 with details naming the break
// ---------------------------------------------------------------------------

test("skill-frontmatter: fails when a skill's SKILL.md name != its directory", () => {
  const dir = scratchDir("det-skill-");
  mkdirSync(join(dir, "skills", "clerk"), { recursive: true });
  writeFileSync(join(dir, "skills", "clerk", "SKILL.md"), "---\nname: wrong-name\ndescription: does a thing\n---\n");
  const r = CHECKS["skill-frontmatter"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /name 'wrong-name' != directory name 'clerk'/.test(d)));
});

test("skill-frontmatter: fails when frontmatter is missing entirely", () => {
  const dir = scratchDir("det-skill-nofm-");
  mkdirSync(join(dir, "skills", "owl"), { recursive: true });
  writeFileSync(join(dir, "skills", "owl", "SKILL.md"), "# just a heading, no frontmatter\n");
  const r = CHECKS["skill-frontmatter"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /no --- frontmatter block/.test(d)));
});

test("hooks-kill-switch: fails when a PostToolUse+Bash script has no kill switch", () => {
  const dir = scratchDir("det-hooks-noswitch-");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  const scriptPath = join(dir, "hooks", "no-switch.sh");
  writeFileSync(scriptPath, "#!/usr/bin/env bash\necho hi\n");
  chmodSync(scriptPath, 0o755);
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/no-switch.sh" }] }],
    },
  }));
  const r = CHECKS["hooks-kill-switch"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /no kill-switch guard/.test(d)));
});

test("hooks-kill-switch: fails when a referenced script is missing on disk", () => {
  const dir = scratchDir("det-hooks-missing-");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/ghost.sh" }] }],
    },
  }));
  const r = CHECKS["hooks-kill-switch"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /missing on disk/.test(d)));
});

test("hooks-kill-switch: fails when a referenced script exists but is not executable", () => {
  const dir = scratchDir("det-hooks-noexec-");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  const scriptPath = join(dir, "hooks", "no-exec.sh");
  writeFileSync(scriptPath, "#!/usr/bin/env bash\necho hi\n");
  chmodSync(scriptPath, 0o644);
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/no-exec.sh" }] }],
    },
  }));
  const r = CHECKS["hooks-kill-switch"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /not executable/.test(d)));
});

test("contract-stage-parity: fails when a stage's directory is removed", () => {
  const dir = scratchDir("det-stage-");
  mkdirSync(join(dir, "engine", "cli"), { recursive: true });
  mkdirSync(join(dir, "engine", "stages", "research"), { recursive: true });
  // "implement" deliberately has no directory.
  writeFileSync(join(dir, "engine", "cli", "engine.mjs"),
    'const STAGES = ["intake", "research", "implement"];\n');
  mkdirSync(join(dir, "engine", "stages", "intake"), { recursive: true });
  writeFileSync(join(dir, "engine", "stages", "CONTRACT.md"), "intake research implement\n");
  const r = CHECKS["contract-stage-parity"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /implement: missing directory/.test(d)));
});

test("contract-stage-parity: fails when a stage dir exists but isn't mentioned in CONTRACT.md", () => {
  const dir = scratchDir("det-stage-contract-");
  mkdirSync(join(dir, "engine", "cli"), { recursive: true });
  writeFileSync(join(dir, "engine", "cli", "engine.mjs"), 'const STAGES = ["intake"];\n');
  mkdirSync(join(dir, "engine", "stages", "intake"), { recursive: true });
  writeFileSync(join(dir, "engine", "stages", "CONTRACT.md"), "no stages named here\n");
  const r = CHECKS["contract-stage-parity"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /not mentioned in engine\/stages\/CONTRACT\.md/.test(d)));
});

test("ledger-parseable: fails on a line that isn't valid JSON", () => {
  const dir = scratchDir("det-ledger-bad-");
  mkdirSync(join(dir, "benchmarks"), { recursive: true });
  writeFileSync(join(dir, "benchmarks", "ledger.jsonl"), '{"schema":"detent-eval-v1"}\nnot json at all\n');
  const r = CHECKS["ledger-parseable"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /not valid JSON/.test(d)));
});

test("ledger-parseable: fails on a line missing both schema and wall_clock_ms", () => {
  const dir = scratchDir("det-ledger-shape-");
  mkdirSync(join(dir, "benchmarks"), { recursive: true });
  writeFileSync(join(dir, "benchmarks", "ledger.jsonl"), '{"unrelated":"line"}\n');
  const r = CHECKS["ledger-parseable"](dir, {});
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => /neither schema/.test(d)));
});

test("ledger-parseable: an empty ledger file passes trivially", () => {
  const dir = scratchDir("det-ledger-empty-");
  mkdirSync(join(dir, "benchmarks"), { recursive: true });
  writeFileSync(join(dir, "benchmarks", "ledger.jsonl"), "");
  const r = CHECKS["ledger-parseable"](dir, {});
  assert.equal(r.pass, true);
});

test("work-order-golden: fails and reports diverging key paths on a mismatched expectation", () => {
  const dir = scratchDir("det-golden-mismatch-");
  const caseDir = join(dir, "evals", "cases", "sentinel-golden");
  cpSync(join(REPO_ROOT, "evals", "cases", "sentinel-golden", "fixtures"), join(caseDir, "fixtures"), { recursive: true });
  writeFileSync(join(caseDir, "expected-work-order.json"), JSON.stringify({ pr: "eval/golden#1", iteration: 99 }));
  const r = CHECKS["work-order-golden"](dir, {
    check: "work-order-golden",
    params: {
      fixtures_dir: "evals/cases/sentinel-golden/fixtures",
      expected_path: "evals/cases/sentinel-golden/expected-work-order.json",
      pr_key: "eval/golden#1",
    },
  });
  assert.equal(r.pass, false);
  assert.ok(r.details.some((d) => d.includes("iteration")));
  rmSync(dir, { recursive: true, force: true });
});
