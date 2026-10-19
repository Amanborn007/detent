// tdd-ordering.test.mjs, implement RECORDS a tdd block, recheck ASSERTS it
// from git objects. See engine/stages/CONTRACT.md and engine/cli/engine.mjs's
// checkTddOrdering(). Ordering only: red_sha an ancestor of green_sha, never
// proof the test was observed failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { engine, mkRun, writeArtifact, readJson, writeJson, throughResearch } from "./helpers.mjs";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(repo, message) {
  const r = spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-q", "-m", message],
    { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Two commits that each descend straight from HEAD but not from each other. */
function divergentPair(repo) {
  const base = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-q", "-b", "tmp-a"]);
  const a = commit(repo, "a");
  git(repo, ["checkout", "-q", base]);
  git(repo, ["checkout", "-q", "-b", "tmp-b"]);
  const b = commit(repo, "b");
  return { a, b };
}

function toPlanDone(ctx) {
  throughResearch(ctx);
  let r = engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  r = engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2, r.stdout); // intent gate pending
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() }
    : d));
  r = engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
}

/** Drive implement to done, passing extra `stage end implement` args (tdd flags). */
function toImplementDone(ctx, extraEndArgs = []) {
  toPlanDone(ctx);
  let r = engine(["stage", "begin", "implement", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  r = engine(["stage", "end", "implement", "--repo", ctx.repo, "--run", ctx.runId, ...extraEndArgs]);
  assert.equal(r.code, 0, r.stdout);
  return r;
}

function beginRecheck(ctx) {
  const r = engine(["stage", "begin", "recheck", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
}

test("recheck refuses when the implement entry has no tdd block", () => {
  const ctx = mkRun({});
  toImplementDone(ctx);
  beginRecheck(ctx);
  writeArtifact(ctx.runDir, "recheck.md", "# recheck\n");
  const r = engine(["stage", "end", "recheck", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /tdd/i);
  assert.equal(readJson(join(ctx.runDir, "stage-status.json")).stages.recheck.status, "in_progress");
});

test("recheck refuses when tdd.red_sha does not resolve to a git object", () => {
  const ctx = mkRun({});
  const green = commit(ctx.repo, "implementation");
  toImplementDone(ctx, [
    "--tdd-test", "sender.retry",
    "--tdd-red", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    "--tdd-green", green,
  ]);
  beginRecheck(ctx);
  writeArtifact(ctx.runDir, "recheck.md", "# recheck\n");
  const r = engine(["stage", "end", "recheck", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /red_sha/);
  assert.match(r.json.reason, /does not resolve/);
});

test("recheck refuses when red_sha is not an ancestor of green_sha", () => {
  const ctx = mkRun({});
  const { a: red, b: green } = divergentPair(ctx.repo);
  toImplementDone(ctx, ["--tdd-test", "sender.retry", "--tdd-red", red, "--tdd-green", green]);
  beginRecheck(ctx);
  writeArtifact(ctx.runDir, "recheck.md", "# recheck\n");
  const r = engine(["stage", "end", "recheck", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /not an ancestor/);
});

test("recheck refuses when tdd.red_sha equals tdd.green_sha", () => {
  const ctx = mkRun({});
  const sha = commit(ctx.repo, "single commit stands in for both");
  toImplementDone(ctx, ["--tdd-test", "sender.retry", "--tdd-red", sha, "--tdd-green", sha]);
  beginRecheck(ctx);
  writeArtifact(ctx.runDir, "recheck.md", "# recheck\n");
  const r = engine(["stage", "end", "recheck", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /equals/);
});

test("recheck passes when red_sha precedes green_sha", () => {
  const ctx = mkRun({});
  const red = commit(ctx.repo, "red: failing test, retryable failure is re-attempted");
  const green = commit(ctx.repo, "green: route sender through lib/retry.ts");
  toImplementDone(ctx, ["--tdd-test", "sender.retry", "--tdd-red", red, "--tdd-green", green]);
  beginRecheck(ctx);
  writeArtifact(ctx.runDir, "recheck.md", "# recheck\n");
  const r = engine(["stage", "end", "recheck", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  const status = readJson(join(ctx.runDir, "stage-status.json"));
  assert.equal(status.stages.recheck.status, "done");
  assert.equal(status.stages.implement.tdd.red_sha, red);
  assert.equal(status.stages.implement.tdd.green_sha, green);
});

test("recheck passes on a recorded tdd exemption", () => {
  const ctx = mkRun({});
  toImplementDone(ctx, ["--tdd-exempt", "CONDITIONAL on D-002, still pending, no behavior change to TDD"]);
  beginRecheck(ctx);
  writeArtifact(ctx.runDir, "recheck.md", "# recheck\n");
  const r = engine(["stage", "end", "recheck", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  const status = readJson(join(ctx.runDir, "stage-status.json"));
  assert.equal(status.stages.implement.tdd.exempt, "CONDITIONAL on D-002, still pending, no behavior change to TDD");
});

test("stage end recheck refuses when recheck.md is missing", () => {
  const ctx = mkRun({});
  const red = commit(ctx.repo, "red");
  const green = commit(ctx.repo, "green");
  toImplementDone(ctx, ["--tdd-test", "sender.retry", "--tdd-red", red, "--tdd-green", green]);
  beginRecheck(ctx);
  const r = engine(["stage", "end", "recheck", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /recheck\.md/);
});

test("stage end implement refuses a partial tdd block (missing --tdd-green)", () => {
  const ctx = mkRun({});
  toPlanDone(ctx);
  let r = engine(["stage", "begin", "implement", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  r = engine(["stage", "end", "implement", "--repo", ctx.repo, "--run", ctx.runId,
    "--tdd-test", "sender.retry", "--tdd-red", "abc1234"]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /--tdd-test.*--tdd-red.*--tdd-green/);
});
