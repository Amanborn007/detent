// A hand-edited intent-gate answer is matched like decision options elsewhere: ignoring case and surrounding whitespace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setup, drive, readJson, writeJson } from "./drive-kit.mjs";

function answerIntent(t, answer) {
  const p = join(t.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => (d.gate === "intent" ? { ...d, status: "answered", answer, answered_by: "human", answered_at: new Date().toISOString() } : d)));
}

test("a ' Revise ' intent answer is a revise, not an approval", () => {
  const t = setup();
  drive(t, {});
  answerIntent(t, " Revise ");
  const r = drive(t, {});
  assert.notEqual(r.json.stopped, "before_implement", r.stdout + r.stderr);
  assert.notEqual(readJson(join(t.runDir, "stage-status.json")).stages.plan.status, "done");
});

test("an ' Approve ' intent answer still ends plan and stops before implement", () => {
  const t = setup();
  drive(t, {});
  answerIntent(t, " Approve ");
  const r = drive(t, {});
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "before_implement");
});
