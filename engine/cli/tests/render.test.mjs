// render.test.mjs — a terminal gets readable text, a pipe keeps the JSON line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderText, describeNext } from "../render.mjs";
import { engine, mkRun } from "./helpers.mjs";

const CTX = {
  ticket: "octo/repo#1",
  stages: {
    intake: { status: "done" }, research: { status: "done" },
    plan: { status: "blocked", blocked_on: ["D-001"] },
    implement: { status: "pending" },
  },
  gates: [{ id: "D-001", gate: "intent", question: "Does the plan match the brief?", options: ["approve", "revise"] }],
};
const OBJ = {
  ok: true, run_id: "2026-10-21-octo-repo-1", stage: "plan", status: "blocked",
  next_step: "engine gate open intent --run 2026-10-21-octo-repo-1 --repo /w",
};

test("renderText lists stages with marks, open gates, and the next step in words", () => {
  const t = renderText(OBJ, CTX);
  assert.match(t, /2026-10-21-octo-repo-1 \(octo\/repo#1\)/);
  assert.match(t, /✓ intake/);
  assert.match(t, /■ plan/);
  assert.match(t, /D-001/);
  assert.match(t, /Does the plan match the brief\?/);
  assert.match(t, /Next: .*intent gate/);
  assert.ok(!t.includes('{"'), "no raw JSON");
});

test("renderText shows a refusal as a sentence plus the way out", () => {
  const t = renderText({ ok: false, reason: "no run 'x'", next_step: "check --run" }, {});
  assert.match(t, /Refused: no run 'x'/);
  assert.match(t, /Next: check --run/);
});

test("describeNext turns known engine commands into words and passes others through", () => {
  assert.match(describeNext("engine stage begin plan --run r"), /^Begin the plan stage/);
  assert.match(describeNext("engine stage end plan --run r"), /^Finish the plan stage/);
  assert.match(describeNext("engine gate open intent --run r"), /^Open the intent gate/);
  assert.equal(describeNext("write the thing"), "write the thing");
});

test("DETENT_FORCE_TTY renders text, --json forces the JSON line back", () => {
  const ctx = mkRun();
  const base = ["next", "--run", ctx.runId, "--repo", ctx.repo];
  const env = { DETENT_FORCE_TTY: "1" };
  const text = engine(base, { env });
  assert.equal(text.json, null, text.stdout);
  assert.match(text.stdout, /intake/);
  assert.match(text.stdout, /Next:/);
  const json = engine([...base, "--json"], { env });
  assert.equal(json.json.run_id, ctx.runId);
  const piped = engine(base, { env: { DETENT_FORCE_TTY: "" } });
  assert.equal(piped.json.run_id, ctx.runId);
});
