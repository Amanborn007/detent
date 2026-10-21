// start builds or refreshes the work repo's index before run new, so the run picks up suggested.verify.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { engine, mkRepo, readJson, detentHome } from "./helpers.mjs";
import { HUMAN, scratch, stubBin, setOrigin } from "./verbs-helpers.mjs";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function probes() {
  const d = scratch();
  return { DETENT_GIT_CMD: stubBin(d, "git", 'case "$2" in user.name) echo Ada;; user.email) echo a@example.invalid;; esac'),
    DETENT_GH_CMD: stubBin(d, "gh", "echo octocat"), DETENT_INDEX_TAGGER: "regex" };
}

function project() {
  const repo = mkRepo();
  setOrigin(repo, "https://github.com/octo/repo.git");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "a.mjs"), "export function alpha() {}\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-q", "-m", "code"], { env: { ...process.env, ...GIT_ENV } });
  return repo;
}

const run = (repo, extra = []) => engine(["start", "octo/repo#1", "--slug", "go", ...extra], { cwd: repo, env: { ...HUMAN, ...probes() } });

test("start builds the index, prints one count line, and run new seeds suggested.verify", () => {
  const repo = project();
  const r = run(repo);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(repo, ".detent", "index", "manifest.json")));
  const lines = r.stderr.split("\n").filter((l) => /^index:/.test(l));
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /build.*\d+ files, \d+ symbols, tagger regex/);
  const env = readJson(join(detentHome(), ".sdlc", r.json.run_id, "env.json"));
  assert.deepEqual(env.suggested.verify, { source: "index", command: "npm test" });
});

test("start refreshes a stale index and leaves a fresh one alone", () => {
  const repo = project();
  assert.equal(run(repo).code, 0);
  writeFileSync(join(repo, "b.mjs"), "export function beta() {}\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-q", "-m", "more"], { env: { ...process.env, ...GIT_ENV } });
  const second = engine(["start", "octo/repo#1", "--slug", "two"], { cwd: repo, env: { ...HUMAN, ...probes() } });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stderr, /^index: refresh/m);
  const third = engine(["start", "octo/repo#1", "--slug", "three"], { cwd: repo, env: { ...HUMAN, ...probes() } });
  assert.equal(third.code, 0, third.stdout + third.stderr);
  assert.match(third.stderr, /^index: fresh.*\d+ files, \d+ symbols, tagger regex/m);
});

test("start --no-index builds nothing", () => {
  const repo = project();
  const r = run(repo, ["--no-index"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(repo, ".detent")), false);
  assert.doesNotMatch(r.stderr, /^index:/m);
});

test("start refuses, naming the index error, when indexing fails and --no-index was not given", () => {
  const repo = project();
  mkdirSync(join(repo, ".detent", "index"), { recursive: true });
  writeFileSync(join(repo, ".detent", "index", "manifest.json"), "{not json");
  const r = run(repo);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.json.reason, /index/i);
  assert.match(r.json.next_step, /--no-index/);
  assert.match(r.stderr, /index/i);
  assert.equal(existsSync(join(detentHome(), ".sdlc")) ? readdirSync(join(detentHome(), ".sdlc")).length : 0, 0, "no run created");
});
