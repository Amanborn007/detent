// verbs-decide.test.mjs — `decide` opens the gate, waits on curator, collects the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { engine, mkRun } from "./helpers.mjs";
import { HUMAN, scratch, stubBin, toIntentGate, decisionsOf, BARE_PATH } from "./verbs-helpers.mjs";

test("decide without curator prints the terminal fallback the gate already has", () => {
  const ctx = mkRun();
  toIntentGate(ctx);
  const r = engine(["decide"], { cwd: ctx.repo, env: { ...HUMAN, PATH: BARE_PATH } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.mode, "terminal_fallback");
  assert.equal(r.json.run_id, ctx.runId);
  assert.equal(r.json.ticket, "octo/repo#1");
  assert.match(r.json.next_step, /detent approve/);
});

test("decide opens curator, blocks on poll, collects the answer, prints the next step", () => {
  const ctx = mkRun();
  const gate = toIntentGate(ctx);
  const bin = scratch();
  const log = join(scratch(), "curator.log");
  const answer = JSON.stringify({ status: "feedback", prompts: [{ type: "decision", question: gate.id, answer: "approve" }] });
  stubBin(bin, "curator", `echo "$@" >> "${log}"
case "$1" in
  open) echo '{"url":"http://127.0.0.1:9/s","key":"'"$2"'"}' ;;
  poll) echo '${answer}' ;;
esac`);
  const r = engine(["decide"], { cwd: ctx.repo, env: { ...HUMAN, PATH: `${bin}:${BARE_PATH}` } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.match(calls[0], /^open .*intent\.html$/);
  assert.match(calls[1], /^poll /);
  assert.deepEqual(r.json.answered, [gate.id]);
  assert.equal(decisionsOf(ctx).find((d) => d.id === gate.id).answer, "approve");
  assert.match(r.json.next_step, /implement|continue/);
});

test("decide with nothing waiting refuses", () => {
  const ctx = mkRun();
  const r = engine(["decide"], { cwd: ctx.repo, env: HUMAN });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /no pending/);
});
