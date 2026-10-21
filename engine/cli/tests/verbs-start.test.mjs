// verbs-start.test.mjs — `detent start <owner/repo#N>` checks the repo, sets up, creates the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { engine, mkRepo } from "./helpers.mjs";
import { HUMAN, scratch, stubBin, setOrigin } from "./verbs-helpers.mjs";

function probes() {
  const d = scratch();
  return { DETENT_GIT_CMD: stubBin(d, "git", 'case "$2" in user.name) echo Ada;; user.email) echo a@example.invalid;; esac'),
    DETENT_GH_CMD: stubBin(d, "gh", "echo octocat") };
}

test("start refuses when the repo origin is a different owner/repo", () => {
  const repo = mkRepo();
  setOrigin(repo, "https://github.com/other/thing.git");
  const r = engine(["start", "octo/repo#1", "--repo", "."], { cwd: repo, env: { ...HUMAN, ...probes() } });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /other\/thing/);
  assert.match(r.json.reason, /octo\/repo/);
});

test("start refuses a repo with no origin remote", () => {
  const repo = mkRepo();
  const r = engine(["start", "octo/repo#1"], { cwd: repo, env: { ...HUMAN, ...probes() } });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /origin/);
});

test("start refuses anything that is not owner/repo#N", () => {
  const repo = mkRepo();
  const r = engine(["start", "PROJ-35"], { cwd: repo, env: { ...HUMAN, ...probes() } });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /owner\/repo#N/);
});

test("start runs setup when stack.yaml is missing, then creates the run (https and ssh origins)", () => {
  for (const url of ["https://github.com/Octo/Repo.git", "git@github.com:octo/repo.git"]) {
    const repo = mkRepo();
    setOrigin(repo, url);
    const r = engine(["start", "octo/repo#1", "--slug", "go"], { cwd: repo, env: { ...HUMAN, ...probes() } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(repo, "stack.yaml")), "setup wrote stack.yaml");
    assert.match(r.json.run_id, /octo-repo-1-go$/);
    assert.equal(r.json.ticket, "octo/repo#1");
    assert.equal(r.json.setup, "ran");
    assert.match(r.json.next_step, /detent continue/);
  }
});

test("start leaves an existing stack.yaml alone", () => {
  const repo = mkRepo();
  setOrigin(repo, "https://github.com/octo/repo");
  const first = engine(["start", "octo/repo#1", "--slug", "a"], { cwd: repo, env: { ...HUMAN, ...probes() } });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const second = engine(["start", "octo/repo#1", "--slug", "b"], { cwd: repo, env: { ...HUMAN, ...probes() } });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.equal(second.json.setup, "present");
});

test("start text output has no en or em dash", () => {
  const repo = mkRepo();
  setOrigin(repo, "https://github.com/octo/repo");
  const r = engine(["start", "octo/repo#1"], { cwd: repo, env: { ...HUMAN, ...probes(), DETENT_FORCE_TTY: "1" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /[\u2013\u2014]/);
});
