// dashboard.test.mjs — `engine dashboard` assembles ALL runs
// under the centralized DETENT_ROOT/.sdlc into one data set (per run: stage,
// status, pending gates, age) plus a self-contained curator HTML artifact,
// and prints the open command as next_step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { engine, readJson, writeJson } from "./helpers.mjs";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function mkHome() {
  return mkdtempSync(join(tmpdir(), "detent-home-"));
}

function mkGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "engine-dash-repo-"));
  spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
    { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  return dir;
}

test("dashboard with no runs reports an empty run list, exit 0", () => {
  const home = mkHome();
  const r = engine(["dashboard"], { env: { DETENT_ROOT: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.runs, []);
  assert.ok(r.json.next_step, "next_step present even when empty");
});

test("dashboard assembles every run under the centralized .sdlc (stage, status, pending gates, age)", () => {
  const home = mkHome();
  const env = { DETENT_ROOT: home };
  const repoA = mkGitRepo();
  const repoB = mkGitRepo();

  // Run 1: fresh (all pending).
  const r1 = engine(["run", "new", "--ticket", "octo/repo#21", "--slug", "fresh",
    "--repo", repoA, "--no-worktree"], { env });
  assert.equal(r1.code, 0, r1.stdout);

  // Run 2 (other repo): intake in_progress with a pending decision blocking implement.
  const r2 = engine(["run", "new", "--ticket", "octo/repo#22", "--slug", "moving",
    "--repo", repoB, "--no-worktree"], { env });
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(engine(["stage", "begin", "intake", "--repo", repoB, "--run", r2.json.run_id],
    { env }).code, 0);
  const run2Dir = join(home, ".sdlc", r2.json.run_id);
  writeJson(join(run2Dir, "decisions.json"), [{
    id: "D-001", raised_by: "intake", blocks: ["implement"],
    question: "Retry forever or cap at N?", options: ["cap", "forever"], status: "pending",
  }]);

  const r = engine(["dashboard"], { env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.runs.length, 2, "both runs, across repos, in one dashboard");

  const run1 = r.json.runs.find((x) => x.run_id === r1.json.run_id);
  const run2 = r.json.runs.find((x) => x.run_id === r2.json.run_id);
  assert.ok(run1 && run2, "both run ids present");

  assert.equal(run1.ticket_ref, "octo/repo#21");
  assert.equal(run1.repo, repoA);
  assert.equal(run1.stage, "intake");
  assert.equal(run1.stage_status, "pending");
  assert.deepEqual(run1.pending_gates, []);
  assert.ok(run1.created_at, "created_at carried through");
  assert.ok(typeof run1.age === "string" && run1.age.length > 0, "human-readable age");

  assert.equal(run2.stage, "intake");
  assert.equal(run2.stage_status, "in_progress");
  assert.equal(run2.pending_gates.length, 1);
  assert.equal(run2.pending_gates[0].id, "D-001");
  assert.match(run2.pending_gates[0].question, /Retry forever/);
  assert.deepEqual(run2.pending_gates[0].blocks, ["implement"]);
});

test("dashboard renders a self-contained curator artifact and prints the open next_step", () => {
  const home = mkHome();
  const env = { DETENT_ROOT: home };
  const repo = mkGitRepo();
  const r1 = engine(["run", "new", "--ticket", "octo/repo#31", "--slug", "art",
    "--repo", repo, "--no-worktree"], { env });
  assert.equal(r1.code, 0, r1.stdout);

  const r = engine(["dashboard"], { env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const artifact = r.json.artifact;
  assert.ok(artifact, "artifact path in output");
  assert.equal(artifact, join(home, ".plans", "engine-dashboard.html"),
    ".plans/ is centralized in the detent home too");
  assert.ok(existsSync(artifact), "artifact written");
  const html = readFileSync(artifact, "utf8");
  assert.ok(html.includes(r1.json.run_id), "artifact lists the run");
  assert.ok(html.includes("<style"), "inline CSS (self-contained)");
  assert.ok(!/https?:\/\//.test(html), "no external URLs — curator artifacts are self-contained");
  assert.match(r.json.next_step, /open/i, "next_step tells how to open the dashboard");
  assert.ok(r.json.next_step.includes(artifact), "next_step names the artifact");
});

test("dashboard escapes untrusted text (decision questions) in the artifact", () => {
  const home = mkHome();
  const env = { DETENT_ROOT: home };
  const repo = mkGitRepo();
  const r1 = engine(["run", "new", "--ticket", "octo/repo#41", "--slug", "xss",
    "--repo", repo, "--no-worktree"], { env });
  assert.equal(r1.code, 0, r1.stdout);
  const runDir = join(home, ".sdlc", r1.json.run_id);
  writeJson(join(runDir, "decisions.json"), [{
    id: "D-001", raised_by: "intake", blocks: ["implement"],
    question: "<script>alert(1)</script> which retry policy?", status: "pending",
  }]);
  const r = engine(["dashboard"], { env });
  assert.equal(r.code, 0, r.stdout);
  const html = readFileSync(r.json.artifact, "utf8");
  assert.ok(!html.includes("<script>alert(1)</script>"), "question HTML-escaped");
  assert.ok(html.includes("&lt;script&gt;"), "escaped form present");
});
