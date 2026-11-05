import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { engine, mkCuratorClone, mkRun, writeArtifact, throughResearch } from "./helpers.mjs";

const BARE_PATH = "/usr/bin:/bin";

function stub(dir) {
  return mkCuratorClone(dir, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "open") console.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: a[1] }));
if (a[0] === "drain") console.log(process.env.STUB_DRAIN);
`);
}

test("gate collect surfaces a curator stamp_error in the result and on stderr", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2);
  const cdir = mkdtempSync(join(tmpdir(), "stamp-err-"));
  stub(cdir);
  const open = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: BARE_PATH, TEST_CLONE: cdir } });
  assert.equal(open.code, 0, open.stdout + open.stderr);
  const drain = JSON.stringify({ key: realpathSync(open.json.html), status: "feedback", stamp_error: "intent: no option \"x\" found",
    prompts: [{ type: "prompt", text: "hello" }] });
  const r = engine(["gate", "collect", "--run", ctx.runId], { env: { PATH: BARE_PATH, TEST_CLONE: cdir, STUB_DRAIN: drain } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.stamp_errors, ["intent: no option \"x\" found"]);
  assert.match(r.stderr, /stamp/i);
});
