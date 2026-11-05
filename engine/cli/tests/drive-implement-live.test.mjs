// drive-implement-live.test.mjs — `drive --implement` against the real claude, real sandbox and real host box.
// Skipped unless DETENT_LIVE_CLAUDE=1. It spends money and needs an OAuth login; never part of CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { approvedRun, drive, git, readJson } from "./drive-kit.mjs";
import { engine } from "./helpers.mjs";

const ON = process.env.DETENT_LIVE_CLAUDE === "1";
const SKIP = ON ? false : "set DETENT_LIVE_CLAUDE=1 to run against the real claude (spends money, needs an OAuth login)";

function managedSettingsPresent() {
  return ["/Library/Application Support/ClaudeCode/managed-settings.json", "/Library/Application Support/ClaudeCode/managed-settings.d"].some(existsSync);
}

function liveDrive(t) {
  return engine(["drive", "--run", t.runId, "--repo", t.repo, "--stack", t.stack, "--implement", "--budget", "2"],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR } });
}

test("live: an implement step makes a commit, verifies it in a box, and imports it", { skip: SKIP }, () => {
  assert.ok(!managedSettingsPresent(), "this machine has managed Claude settings; the live run refuses to start");
  const t = approvedRun({ verify: "test -f hello.txt" });
  const r = liveDrive(t);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(git(t.repo, "rev-parse", "--verify", `refs/heads/detent/${t.runId}`).status === 0);
  assert.ok(existsSync(join(t.runDir, "recheck.md")));
  assert.equal(readJson(join(t.runDir, "drive-last.json")).implement.verify.exit_code, 0);
});

test("live: a child that tries to write outside its clone leaves nothing outside it", { skip: SKIP }, () => {
  const t = approvedRun({ verify: "true" });
  const r = liveDrive(t);
  assert.ok(r.code === 0 || r.code === 1, r.stdout + r.stderr);
  const stray = spawnSync("ls", [join(t.d, "stray")], { encoding: "utf8" });
  assert.notEqual(stray.status, 0, "no file outside the clone");
});

test("live: --implement with an API key in the environment is refused and spends nothing", { skip: SKIP }, () => {
  const t = approvedRun();
  const r = engine(["drive", "--run", t.runId, "--repo", t.repo, "--stack", t.stack, "--implement"],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, ANTHROPIC_API_KEY: "sk-ant-live-test-not-real-0123456789" } });
  assert.equal(r.code, 2);
  assert.equal(r.json.reason, "implement_api_key_refused");
});

test("live: without --implement the run stops at before_implement", { skip: SKIP }, () => {
  const t = approvedRun();
  const r = drive(t, {});
  assert.equal(r.json.stopped, "before_implement");
  assert.ok(!readFileSync(join(t.runDir, "events.jsonl"), "utf8").includes("implement_started"));
});
