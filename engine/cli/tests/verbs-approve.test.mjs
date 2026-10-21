// verbs-approve.test.mjs — `approve` and `revise` answer a gate, and only a human at a terminal can.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { engine, mkRun, readJson, writeJson } from "./helpers.mjs";
import { HUMAN, toIntentGate, decisionsOf, eventsText } from "./verbs-helpers.mjs";

const TTY = { ...HUMAN, DETENT_FORCE_TTY: "1" };

function setup() {
  const ctx = mkRun();
  const gate = toIntentGate(ctx);
  return { ctx, gate };
}

test("approve answers the pending intent gate after a y confirmation", () => {
  const { ctx, gate } = setup();
  const r = engine(["approve", "--json"], { cwd: ctx.repo, env: TTY, input: "y\n" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.run_id, ctx.runId);
  assert.equal(r.json.ticket, "octo/repo#1");
  assert.equal(r.json.answer, "approve");
  const d = decisionsOf(ctx).find((x) => x.id === gate.id);
  assert.equal(d.status, "answered");
  assert.equal(d.answer, "approve");
  assert.equal(d.answered_by, "human");
  assert.equal(d.answered_via, "terminal");
  assert.match(r.stderr, /Answer D-\d+ on run .* \(octo\/repo#1\) with "approve"\? \[y\/N\]/);
  assert.match(eventsText(ctx), /"answered_via":"terminal"/);
});

test("anything but y leaves the gate pending", () => {
  const { ctx, gate } = setup();
  const r = engine(["approve"], { cwd: ctx.repo, env: TTY, input: "n\n" });
  assert.equal(r.code, 2, r.stdout);
  assert.equal(decisionsOf(ctx).find((x) => x.id === gate.id).status, "pending");
});

test("revise records the note", () => {
  const { ctx, gate } = setup();
  const r = engine(["revise", "--note", "split step 2", "--json"], { cwd: ctx.repo, env: TTY, input: "y\n" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const d = decisionsOf(ctx).find((x) => x.id === gate.id);
  assert.equal(d.answer, "revise");
  assert.equal(d.note, "split step 2");
});

test("an agent session, a drive child, or a pipe cannot approve", () => {
  const { ctx, gate } = setup();
  const cases = [
    ["CLAUDECODE", { ...TTY, CLAUDECODE: "1" }],
    ["DETENT_DRIVE_CHILD", { ...TTY, DETENT_DRIVE_CHILD: "1" }],
    ["no TTY", { ...HUMAN }],
  ];
  for (const [name, env] of cases) {
    const r = engine(["approve", "--json"], { cwd: ctx.repo, env, input: "y\n" });
    assert.equal(r.code, 2, `${name}: ${r.stdout}`);
    assert.equal(r.json.ok, false, name);
  }
  assert.equal(decisionsOf(ctx).find((x) => x.id === gate.id).status, "pending");
});

test("a named decision without approve/revise options points to decide", () => {
  const { ctx } = setup();
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, [...readJson(p), { id: "D-050", raised_by: "plan", blocks: ["implement"],
    question: "Reuse or rewrite?", options: ["reuse", "rewrite"], status: "pending" }]);
  const r = engine(["approve", "D-050", "--json"], { cwd: ctx.repo, env: TTY, input: "y\n" });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.next_step, /detent decide/);
});

test("approve with no pending intent gate refuses", () => {
  const ctx = mkRun();
  const r = engine(["approve", "--json"], { cwd: ctx.repo, env: TTY, input: "y\n" });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /no pending/);
});

test("after approve the plan stage is no longer shown as waiting on the answered gate", () => {
  const { ctx, gate } = setup();
  const r = engine(["approve"], { cwd: ctx.repo, env: TTY, input: "y\n" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, new RegExp(`waiting on ${gate.id}`));
  const plan = readJson(join(ctx.runDir, "stage-status.json")).stages.plan;
  assert.notEqual(plan.status, "blocked");
  assert.deepEqual(plan.blocked_on || [], []);
});

test("approve text output has no en or em dash", () => {
  const { ctx } = setup();
  const r = engine(["approve"], { cwd: ctx.repo, env: TTY, input: "y\n" });
  assert.doesNotMatch(r.stdout, /[–—]/);
});
