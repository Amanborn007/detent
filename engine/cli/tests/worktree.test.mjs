// worktree.test.mjs — run state is centralized under the
// detent clone (DETENT_ROOT/.sdlc), and `engine run new` creates a dedicated
// git worktree for the run BY DEFAULT (the documented flow). --no-worktree
// opts out; a repo the worktree cannot be created in refuses loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { engine, readJson, mkRun } from "./helpers.mjs";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function mkHome() {
  return mkdtempSync(join(tmpdir(), "detent-home-"));
}

/** Work repo with one commit (a worktree needs a born HEAD). */
function mkGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "engine-wt-repo-"));
  spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
    { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  return dir;
}

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

test("run new centralizes run state under DETENT_ROOT/.sdlc, not the work repo", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const r = engine(["run", "new", "--ticket", "octo/repo#7", "--slug", "central", "--repo", repo],
    { env: { DETENT_ROOT: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const runDir = join(home, ".sdlc", r.json.run_id);
  assert.equal(r.json.run_dir, runDir, "run_dir points at the detent home");
  assert.ok(existsSync(join(runDir, "run.json")), "run.json lives under DETENT_ROOT/.sdlc");
  assert.ok(!existsSync(join(repo, ".sdlc")), "no .sdlc/ created in the work repo");
  const runJson = readJson(join(runDir, "run.json"));
  assert.equal(runJson.repo, repo, "run.json records the work repo");
});

test("run new creates a dedicated git worktree for the run by default", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const r = engine(["run", "new", "--ticket", "octo/repo#8", "--slug", "wt", "--repo", repo],
    { env: { DETENT_ROOT: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const runDir = join(home, ".sdlc", r.json.run_id);
  const worktree = join(runDir, "worktree");
  assert.equal(r.json.worktree, worktree, "output names the worktree path");
  assert.ok(existsSync(worktree), "worktree directory exists");
  // it is a real worktree of the work repo, on the run branch
  const branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  assert.equal(branch, `sdlc/${r.json.run_id}`);
  const list = git(repo, ["worktree", "list"]).stdout;
  assert.ok(list.includes(worktree), "work repo lists the run worktree");
  const runJson = readJson(join(runDir, "run.json"));
  assert.equal(runJson.worktree, worktree);
  assert.equal(runJson.branch, `sdlc/${r.json.run_id}`);
});

test("run new --no-worktree skips worktree creation", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const r = engine(["run", "new", "--ticket", "octo/repo#9", "--slug", "nowt", "--repo", repo,
    "--no-worktree"], { env: { DETENT_ROOT: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const runDir = join(home, ".sdlc", r.json.run_id);
  assert.ok(!existsSync(join(runDir, "worktree")), "no worktree dir");
  const runJson = readJson(join(runDir, "run.json"));
  assert.equal(runJson.worktree, null);
  assert.equal(runJson.branch, null);
});

test("run new refuses loudly when the default worktree cannot be created (no commits)", () => {
  const home = mkHome();
  const repo = mkdtempSync(join(tmpdir(), "engine-wt-bare-"));
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" }); // unborn HEAD
  const r = engine(["run", "new", "--ticket", "octo/repo#10", "--slug", "bad", "--repo", repo],
    { env: { DETENT_ROOT: home } });
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /worktree/i);
  assert.match(r.json.next_step, /--no-worktree/, "next_step offers the opt-out");
  // nothing half-created: a retry with --no-worktree must not hit 'already exists'
  const retry = engine(["run", "new", "--ticket", "octo/repo#10", "--slug", "bad", "--repo", repo,
    "--no-worktree"], { env: { DETENT_ROOT: home } });
  assert.equal(retry.code, 0, retry.stdout);
});

test("run resolution without --run is scoped to the work repo (centralized home, many repos)", () => {
  const home = mkHome();
  const repoA = mkGitRepo();
  const repoB = mkGitRepo();
  const r = engine(["run", "new", "--ticket", "octo/repo#11", "--slug", "scope", "--repo", repoA],
    { env: { DETENT_ROOT: home } });
  assert.equal(r.code, 0, r.stdout);
  // repoB sees no runs even though the shared home has one
  const miss = engine(["next", "--repo", repoB], { env: { DETENT_ROOT: home } });
  assert.equal(miss.code, 2, miss.stdout);
  assert.equal(miss.json.ok, false);
  // repoA resolves its run without --run
  const hit = engine(["next", "--repo", repoA], { env: { DETENT_ROOT: home } });
  assert.equal(hit.code, 0, hit.stdout);
  assert.equal(hit.json.stage, "intake");
  // --run resolves regardless of --repo (multi-repo tasks share the one home)
  const byId = engine(["next", "--repo", repoB, "--run", r.json.run_id],
    { env: { DETENT_ROOT: home } });
  assert.equal(byId.code, 0, byId.stdout);
  assert.equal(byId.json.stage, "intake");
});

test("run new records base_sha equal to the repo HEAD at creation", () => {
  const ctx = mkRun();
  const head = spawnSync("git", ["-C", ctx.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const run = readJson(join(ctx.runDir, "run.json"));
  assert.equal(run.base_sha, head);
});
