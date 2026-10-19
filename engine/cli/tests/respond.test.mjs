// respond.test.mjs — roadmap #5: `engine respond --pr`, the synthetic
// standalone entry into the `respond` stage. No network: a fake `gh` shim on
// a scratch PATH dir (prepended via engine()'s opts.env) returns canned
// `gh pr view` JSON — every case here is offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { engine, readJson, writeJson, eventsOf } from "./helpers.mjs";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function mkHome() {
  return mkdtempSync(join(tmpdir(), "detent-home-"));
}

function mkGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "engine-respond-repo-"));
  spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
    { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  return dir;
}

function currentBranch(repo) {
  return spawnSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

/** A fake `gh` on a scratch dir: `gh pr view ...` returns canned JSON (or
 *  fails with the given exit code); anything else is a loud "unsupported". */
function fakeGhBin({ json, exitCode, stderr } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const body = exitCode
    ? `process.stderr.write(${JSON.stringify((stderr || "fake gh error") + "\n")});\nprocess.exit(${exitCode});\n`
    : `process.stdout.write(${JSON.stringify(JSON.stringify(json))});\n`;
  const script =
    `#!/usr/bin/env node\n` +
    `const a = process.argv.slice(2);\n` +
    `if (a[0] === "pr" && a[1] === "view") {\n${body}} else {\n` +
    `process.stderr.write("fake gh: unsupported args: " + a.join(" ") + "\\n");\n` +
    `process.exit(1);\n}\n`;
  const bin = join(dir, "gh");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return dir;
}

function withFakeGh(bin, extra = {}) {
  return { PATH: `${bin}${delimiter}${process.env.PATH}`, ...extra };
}

function openPr(overrides = {}) {
  return {
    url: "https://github.com/acme/widget/pull/42",
    number: 42,
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    headRefName: "feature/fix",
    headRefOid: "abc1234",
    ...overrides,
  };
}

test("respond --pr requires --pr", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const r = engine(["respond", "--repo", repo], { env: { DETENT_ROOT: home } });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /--pr/);
});

test("respond --pr happy path: synthetic run, priors skipped (never faked done), respond pending", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const bin = fakeGhBin({ json: openPr() });
  const r = engine(
    ["respond", "--pr", "https://github.com/acme/widget/pull/42", "--repo", repo, "--no-worktree"],
    { env: { DETENT_ROOT: home, ...withFakeGh(bin) } },
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.synthetic, true);
  assert.equal(r.json.stage, "respond");

  const runDir = join(home, ".sdlc", r.json.run_id);
  const runJson = readJson(join(runDir, "run.json"));
  assert.equal(runJson.synthetic, true);
  assert.equal(runJson.entry, "respond-pr");
  assert.equal(runJson.ticket_ref, "https://github.com/acme/widget/pull/42");
  assert.equal(runJson.pr.url, "https://github.com/acme/widget/pull/42");
  assert.equal(runJson.pr.number, 42);
  assert.equal(runJson.pr.head_ref, "feature/fix");
  assert.equal(runJson.pr.head_sha, "abc1234");

  const status = readJson(join(runDir, "stage-status.json"));
  for (const s of ["intake", "research", "plan", "implement", "recheck", "ship"]) {
    assert.equal(status.stages[s].status, "skipped", `${s} is skipped, never faked done`);
    assert.ok(status.stages[s].reason, `${s} carries a skip reason`);
    assert.ok(status.stages[s].updated_at, `${s} carries updated_at`);
  }
  assert.equal(status.stages.respond.status, "pending");
  assert.deepEqual(readJson(join(runDir, "decisions.json")), []);

  const lines = eventsOf(runDir);
  assert.equal(lines[0].event, "run_created");
  const skipEvent = lines.find((e) => e.event === "stages_skipped");
  assert.ok(skipEvent, "stages_skipped event recorded — audit trail, honesty");
  assert.deepEqual(skipEvent.stages, ["intake", "research", "plan", "implement", "recheck", "ship"]);

  // stage begin respond succeeds (all priors done|skipped satisfies D2)
  const begin = engine(["stage", "begin", "respond", "--repo", repo, "--run", r.json.run_id],
    { env: { DETENT_ROOT: home } });
  assert.equal(begin.code, 0, begin.stdout + begin.stderr);

  // `next` targets respond, not a skipped prior
  const next = engine(["next", "--repo", repo, "--run", r.json.run_id], { env: { DETENT_ROOT: home } });
  assert.equal(next.code, 0, next.stdout);
  assert.equal(next.json.stage, "respond");
});

test("respond --pr refuses a closed PR", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const bin = fakeGhBin({ json: openPr({ state: "CLOSED" }) });
  const r = engine(["respond", "--pr", "42", "--repo", repo, "--no-worktree"],
    { env: { DETENT_ROOT: home, ...withFakeGh(bin) } });
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /not open/i);
});

test("respond --pr refuses a draft PR (dormant until ready)", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const bin = fakeGhBin({ json: openPr({ isDraft: true }) });
  const r = engine(["respond", "--pr", "42", "--repo", repo, "--no-worktree"],
    { env: { DETENT_ROOT: home, ...withFakeGh(bin) } });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /draft/i);
  assert.match(r.json.next_step, /ready/i);
});

test("respond --pr refuses a fork PR (cross-repository) — MVP refuses loudly rather than half-working", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const bin = fakeGhBin({ json: openPr({ isCrossRepository: true }) });
  const r = engine(["respond", "--pr", "42", "--repo", repo, "--no-worktree"],
    { env: { DETENT_ROOT: home, ...withFakeGh(bin) } });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /fork|cross-repo/i);
});

test("respond --pr refuses a duplicate run dir (run-ids are immutable)", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const bin = fakeGhBin({ json: openPr() });
  const env = { DETENT_ROOT: home, ...withFakeGh(bin) };
  const a = engine(
    ["respond", "--pr", "https://github.com/acme/widget/pull/42", "--repo", repo, "--no-worktree", "--slug", "dup"],
    { env },
  );
  assert.equal(a.code, 0, a.stdout);
  const b = engine(
    ["respond", "--pr", "https://github.com/acme/widget/pull/42", "--repo", repo, "--no-worktree", "--slug", "dup"],
    { env },
  );
  assert.equal(b.code, 2, b.stdout);
  assert.match(b.json.reason, /already exists/);
});

test("a pending escalation decision blocks stage begin respond (gate machinery intact)", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const bin = fakeGhBin({ json: openPr() });
  const env = { DETENT_ROOT: home, ...withFakeGh(bin) };
  const r = engine(["respond", "--pr", "https://github.com/acme/widget/pull/42", "--repo", repo, "--no-worktree"], { env });
  assert.equal(r.code, 0, r.stdout);
  const runDir = join(home, ".sdlc", r.json.run_id);
  writeJson(join(runDir, "decisions.json"), [{
    id: "D-001", raised_by: "respond", blocks: ["respond"],
    question: "reviewer asked why re-enqueue instead of the scheduler hook", status: "pending",
  }]);
  const begin = engine(["stage", "begin", "respond", "--repo", repo, "--run", r.json.run_id], { env });
  assert.equal(begin.code, 2, begin.stdout);
  assert.equal(begin.json.ok, false);
  assert.match(begin.json.reason, /gate rule/i);
});

test("respond --pr checks out the PR's own head branch as the run worktree", () => {
  const home = mkHome();
  // A real "origin" with a feature branch to fetch (worktree add's target).
  const origin = mkGitRepo();
  const base = currentBranch(origin);
  spawnSync("git", ["-C", origin, "checkout", "-q", "-b", "feature/fix"], { encoding: "utf8" });
  spawnSync("git", ["-C", origin, "commit", "-q", "--allow-empty", "-m", "feature work"],
    { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  const headSha = spawnSync("git", ["-C", origin, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  // Leave origin's HEAD back on its base branch — otherwise `git clone` below
  // would check the clone's own working copy out onto feature/fix (it follows
  // the remote's HEAD symref), pre-occupying the very branch we're testing.
  spawnSync("git", ["-C", origin, "checkout", "-q", base], { encoding: "utf8" });
  const repo = mkdtempSync(join(tmpdir(), "engine-respond-clone-"));
  const clone = spawnSync("git", ["clone", "-q", origin, repo], { encoding: "utf8" });
  assert.equal(clone.status, 0, clone.stderr);

  const bin = fakeGhBin({ json: openPr({ headRefName: "feature/fix", headRefOid: headSha }) });
  const r = engine(["respond", "--pr", "https://github.com/acme/widget/pull/42", "--repo", repo],
    { env: { DETENT_ROOT: home, ...withFakeGh(bin) } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const runDir = join(home, ".sdlc", r.json.run_id);
  const worktree = join(runDir, "worktree");
  assert.ok(existsSync(worktree), "worktree created");
  const branch = spawnSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(branch, "feature/fix", "worktree is on the PR's OWN head branch, not a new sdlc/ branch");
  const runJson = readJson(join(runDir, "run.json"));
  assert.equal(runJson.branch, "feature/fix");
  assert.equal(runJson.worktree, worktree);
});

test("respond --pr refuses loudly and cleans up when git worktree add fails (branch checked out elsewhere)", () => {
  const home = mkHome();
  const origin = mkGitRepo();
  const base = currentBranch(origin);
  spawnSync("git", ["-C", origin, "checkout", "-q", "-b", "feature/busy"], { encoding: "utf8" });
  spawnSync("git", ["-C", origin, "commit", "-q", "--allow-empty", "-m", "work"],
    { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  const headSha = spawnSync("git", ["-C", origin, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", origin, "checkout", "-q", base], { encoding: "utf8" }); // see note above
  const repo = mkdtempSync(join(tmpdir(), "engine-respond-clone2-"));
  spawnSync("git", ["clone", "-q", origin, repo], { encoding: "utf8" });
  // Occupy the branch elsewhere so `git worktree add` refuses.
  spawnSync("git", ["-C", repo, "fetch", "origin", "feature/busy"], { encoding: "utf8" });
  const other = mkdtempSync(join(tmpdir(), "engine-respond-other-wt-"));
  const busy = spawnSync("git", ["-C", repo, "worktree", "add", other, "feature/busy"], { encoding: "utf8" });
  assert.equal(busy.status, 0, busy.stderr);

  const bin = fakeGhBin({ json: openPr({ headRefName: "feature/busy", headRefOid: headSha }) });
  const r = engine(["respond", "--pr", "https://github.com/acme/widget/pull/42", "--repo", repo],
    { env: { DETENT_ROOT: home, ...withFakeGh(bin) } });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.next_step, /--no-worktree/);
  // nothing half-created
  const sdlc = join(home, ".sdlc");
  const remaining = existsSync(sdlc) ? readdirSync(sdlc) : [];
  assert.deepEqual(remaining, [], "the half-created run dir was cleaned up");
});

test("dashboard renders the synthetic respond run (all-skipped priors) without crashing", () => {
  const home = mkHome();
  const repo = mkGitRepo();
  const bin = fakeGhBin({ json: openPr() });
  const r = engine(["respond", "--pr", "https://github.com/acme/widget/pull/42", "--repo", repo, "--no-worktree"],
    { env: { DETENT_ROOT: home, ...withFakeGh(bin) } });
  assert.equal(r.code, 0, r.stdout);
  const dash = engine(["dashboard"], { env: { DETENT_ROOT: home } });
  assert.equal(dash.code, 0, dash.stdout + dash.stderr);
  const run = dash.json.runs.find((x) => x.run_id === r.json.run_id);
  assert.ok(run, "dashboard lists the synthetic run");
  assert.equal(run.stage, "respond", "skipped priors are not mistaken for the current stage");
  assert.equal(run.stage_status, "pending");
  assert.ok(existsSync(dash.json.artifact), "artifact written without crashing");
});
