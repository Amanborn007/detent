// A hand-edited intent-gate answer is matched at stage end ignoring case and surrounding whitespace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { engine, mkRun, writeArtifact, readJson, writeJson, throughResearch } from "./helpers.mjs";

function planEndAfterAnswer(answer) {
  const ctx = mkRun();
  throughResearch(ctx);
  const args = (...a) => engine([...a, "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(args("stage", "begin", "plan").code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  args("stage", "end", "plan");
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => (d.gate === "intent"
    ? { ...d, status: "answered", answer, answered_by: "human", answered_at: new Date().toISOString() }
    : d)));
  return args("stage", "end", "plan");
}

for (const answer of [" Revise ", "REVISE"]) {
  test(`intent answer ${JSON.stringify(answer)} is a revise, not an approval`, () => {
    const r = planEndAfterAnswer(answer);
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.verdict, "revise");
  });
}

test("intent answer ' Approve ' still ends plan", () => {
  const r = planEndAfterAnswer(" Approve ");
  assert.equal(r.code, 0, r.stdout);
});
