// A missing upstream artifact must stop drive with a next_step that can be followed, before the stage is begun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setup, drive, throughStage, readJson } from "./drive-kit.mjs";

const cases = [
  { name: "research without brief.md", upTo: "research", stage: "research", file: "brief.md" },
  { name: "plan without brief.md", upTo: "plan", stage: "plan", file: "brief.md" },
  { name: "plan without access-report.json", upTo: "plan", stage: "plan", file: "access-report.json" },
];

for (const c of cases) {
  test(`missing artifact: ${c.name} names the path and the new-run command, and does not begin the stage`, () => {
    const t = setup();
    throughStage(t, c.upTo);
    rmSync(join(t.runDir, c.file));
    const r = drive(t, {}, ["--max-steps", "1"]);
    const out = JSON.parse(r.stdout);
    assert.equal(r.code, 1);
    assert.equal(out.reason, "inputs_artifact_missing");
    assert.equal(r.calls.length, 0, "no child was spawned");
    assert.ok(out.next_step.includes(join(t.runDir, c.file)), `next_step lacks the absolute path: ${out.next_step}`);
    assert.ok(out.next_step.includes("engine run new --ticket octo/repo#1"), `next_step lacks the new-run command: ${out.next_step}`);
    assert.ok(!/re-run the stage/.test(out.next_step), out.next_step);
    assert.equal(readJson(join(t.runDir, "stage-status.json")).stages[c.stage].status, "pending", "stage was begun before the check");
  });
}
