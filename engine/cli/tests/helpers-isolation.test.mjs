// The helpers must only ever stop daemons they started, and must hand every child the markers that keep it isolated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { engine, engineEnv, trackCuratorStateDir, trackedCuratorStateDirs, stopCuratorDaemons } from "./helpers.mjs";

const inherited = mkdtempSync(join(tmpdir(), "inherited-curator-"));
process.env.CURATOR_STATE_DIR = inherited; // a developer's shell, pointing at their real daemon

test("a CURATOR_STATE_DIR inherited from the shell is neither passed to the child nor queued for stopping", () => {
  const r = engine(["help"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!trackedCuratorStateDirs().has(inherited), "inherited dir was registered for cleanup");
  assert.equal(engineEnv({}).CURATOR_STATE_DIR, undefined);
});

test("an explicit CURATOR_STATE_DIR the test passes is tracked", () => {
  const dir = mkdtempSync(join(tmpdir(), "explicit-curator-"));
  engine(["help"], { env: { CURATOR_STATE_DIR: dir } });
  assert.ok(trackedCuratorStateDirs().has(dir));
  trackedCuratorStateDirs().delete(dir);
});

test("children carry NODE_TEST_CONTEXT and the test process as CURATOR_OWNER_PID, but never CURATOR_ALLOW_DAEMON", () => {
  const e = engineEnv({});
  assert.ok(e.NODE_TEST_CONTEXT);
  assert.equal(e.CURATOR_OWNER_PID, String(process.pid));
  assert.equal(e.CURATOR_ALLOW_DAEMON, undefined);
});

test("cleanup treats a recorded pid that is dead or now someone else's as stopped, and leaves the someone else alone", async () => {
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => gone.on("exit", r));
  const dirs = [bystander.pid, gone.pid].map((pid) => {
    const dir = mkdtempSync(join(tmpdir(), "reused-pid-"));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ pid, port: 59999 }));
    trackCuratorStateDir(dir);
    return dir;
  });
  try {
    stopCuratorDaemons();
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), "an unrelated process was killed");
  } finally {
    bystander.kill("SIGKILL");
    for (const d of dirs) trackedCuratorStateDirs().delete(d);
  }
});
