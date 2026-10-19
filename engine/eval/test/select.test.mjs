// Unit tests for select.mjs. Zero dependencies (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvalRefusal, allSuites, selectSuites, globToRegExp, changedPathsFromGit, mergeBaseRef,
} from "../select.mjs";

const CONFIG = {
  suites: {
    "context-adherence": { select: ["skills/**", "hooks/**", "engine/cli/**"] },
    "sentinel-golden": { select: ["engine/sentinel/**", "hooks/sentinel-autoscan.sh"] },
  },
};

// ---------------------------------------------------------------------------
// allSuites / globToRegExp
// ---------------------------------------------------------------------------

test("allSuites: declaration order, empty config => empty list", () => {
  assert.deepEqual(allSuites(CONFIG), ["context-adherence", "sentinel-golden"]);
  assert.deepEqual(allSuites({}), []);
  assert.deepEqual(allSuites({ suites: {} }), []);
});

test("globToRegExp: ** crosses directories, * stays within one segment", () => {
  assert.ok(globToRegExp("skills/**").test("skills/clerk/SKILL.md"));
  assert.ok(globToRegExp("evals/cases/*/case.json").test("evals/cases/foo/case.json"));
  assert.ok(!globToRegExp("evals/cases/*/case.json").test("evals/cases/foo/bar/case.json"));
});

test("globToRegExp: ? matches exactly one character, never crossing a '/'", () => {
  const re = globToRegExp("evals/cases/?/case.json");
  assert.ok(re.test("evals/cases/a/case.json"));
  assert.ok(!re.test("evals/cases/ab/case.json"));
  assert.ok(!re.test("evals/cases//case.json"));
});

test("globToRegExp: a middle /**/  also matches the ZERO-segment case (LOW-8)", () => {
  const re = globToRegExp("a/**/b");
  assert.ok(re.test("a/b"), "a/**/b should match a/b (zero segments in between)");
  assert.ok(re.test("a/x/b"));
  assert.ok(re.test("a/x/y/b"));
  assert.ok(!re.test("a/b/c"));
  assert.ok(!re.test("a"));
});

// ---------------------------------------------------------------------------
// selectSuites — pure glob -> suite mapping
// ---------------------------------------------------------------------------

test("selectSuites: a changed path matching one suite's globs selects only that suite", () => {
  const selected = selectSuites({ changedPaths: ["skills/clerk/SKILL.md"], config: CONFIG });
  assert.deepEqual(selected, ["context-adherence"]);
});

test("selectSuites: a changed path matching multiple suites selects all of them", () => {
  const selected = selectSuites({
    changedPaths: ["hooks/sentinel-autoscan.sh"],
    config: CONFIG,
  });
  assert.deepEqual(selected, ["context-adherence", "sentinel-golden"]);
});

test("selectSuites: empty changed-set => empty selection (never 'select everything' by accident)", () => {
  assert.deepEqual(selectSuites({ changedPaths: [], config: CONFIG }), []);
});

test("selectSuites: a changed path matching no suite's globs => empty selection", () => {
  assert.deepEqual(selectSuites({ changedPaths: ["README.md"], config: CONFIG }), []);
});

// ---------------------------------------------------------------------------
// changedPathsFromGit / mergeBaseRef — against a scratch git repo
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Scratch repo with a `main` branch and a feature branch one commit ahead, touching one file. */
function mkScratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "select-test-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  mkdirSync(join(dir, "skills", "clerk"), { recursive: true });
  writeFileSync(join(dir, "skills", "clerk", "SKILL.md"), "---\nname: clerk\n---\n");
  git(dir, ["add", "skills"]);
  git(dir, ["commit", "-q", "-m", "add clerk skill"]);
  return dir;
}

test("mergeBaseRef: falls back to 'main' when 'origin/main' does not exist", () => {
  const dir = mkScratchRepo();
  assert.equal(mergeBaseRef(dir), "main");
});

test("mergeBaseRef: refuses (EvalRefusal) when neither origin/main nor main exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "select-test-norefs-"));
  git(dir, ["init", "-q", "-b", "trunk"]);
  writeFileSync(join(dir, "f.txt"), "x\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  assert.throws(() => mergeBaseRef(dir), EvalRefusal);
});

test("changedPathsFromGit: lists paths changed on the feature branch vs main", () => {
  const dir = mkScratchRepo();
  const paths = changedPathsFromGit(dir);
  assert.deepEqual(paths, ["skills/clerk/SKILL.md"]);
});

test("changedPathsFromGit: an explicit base ref overrides the origin/main -> main fallback", () => {
  const dir = mkScratchRepo();
  const paths = changedPathsFromGit(dir, "main");
  assert.deepEqual(paths, ["skills/clerk/SKILL.md"]);
});

test("changedPathsFromGit: end to end with selectSuites picks the right suite from a real diff", () => {
  const dir = mkScratchRepo();
  const paths = changedPathsFromGit(dir);
  assert.deepEqual(selectSuites({ changedPaths: paths, config: CONFIG }), ["context-adherence"]);
});
