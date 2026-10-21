// verbs-status.test.mjs — `status` is `next` plus the stage map, readable at a terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { engine, mkRun } from "./helpers.mjs";
import { HUMAN, toIntentGate } from "./verbs-helpers.mjs";

test("status --json is the next output plus a stages map", () => {
  const ctx = mkRun();
  const next = engine(["next"], { cwd: ctx.repo, env: HUMAN });
  const st = engine(["status", "--json"], { cwd: ctx.repo, env: HUMAN });
  assert.equal(st.code, 0, st.stdout);
  const { stages, ...rest } = st.json;
  assert.deepEqual(rest, next.json);
  assert.equal(stages.intake.status, "pending");
  assert.ok("respond" in stages);
});

test("status at a terminal lists stages, the pending gate, and the next step in words", () => {
  const ctx = mkRun();
  toIntentGate(ctx);
  const st = engine(["status"], { cwd: ctx.repo, env: { ...HUMAN, DETENT_FORCE_TTY: "1" } });
  assert.equal(st.code, 0, st.stdout);
  assert.match(st.stdout, /✓ intake/);
  assert.match(st.stdout, /■ plan/);
  assert.match(st.stdout, /D-\d+ intent/);
  assert.match(st.stdout, /Next: /);
});
