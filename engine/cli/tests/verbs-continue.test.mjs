// verbs-continue.test.mjs — `continue` runs exactly one drive step, or hands the stage to this session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { engine, mkRun } from "./helpers.mjs";
import { HUMAN, BARE_PATH } from "./verbs-helpers.mjs";
import { setup } from "./drive-kit.mjs";

test("under Claude Code, continue spawns nothing and names the stage skill and run", () => {
  const ctx = mkRun();
  const r = engine(["continue"], { cwd: ctx.repo, env: { ...HUMAN, CLAUDECODE: "1", PATH: BARE_PATH } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.run_id, ctx.runId);
  assert.equal(r.json.ticket, "octo/repo#1");
  assert.equal(r.json.stage, "intake");
  assert.match(r.json.skill, /stages\/intake\/SKILL\.md$/);
  assert.ok(existsSync(r.json.skill));
  assert.match(r.json.next_step, /SKILL\.md/);
});

test("continue --yes prints the budget first and drives exactly one step", () => {
  const ctx = setup();
  writeFileSync(join(ctx.d, "mode.json"), "{}");
  mkdirSync(ctx.tmp, { recursive: true });
  const r = engine(["continue", "--yes", "--claude-bin", ctx.stub, "--stack", ctx.stack],
    { cwd: ctx.repo, env: { ...HUMAN, PATH: BARE_PATH, TMPDIR: ctx.tmp } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /budget/i);
  assert.match(r.stderr, new RegExp(ctx.runId));
  assert.equal(r.json.steps, 1);
  assert.equal(r.json.stopped, "max_steps");
});

test("continue without --yes and without a terminal refuses", () => {
  const ctx = mkRun();
  const r = engine(["continue"], { cwd: ctx.repo, env: { ...HUMAN, PATH: BARE_PATH } });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.next_step, /--yes/);
});

test("after one step, continue points at detent continue, not detent drive", () => {
  const ctx = setup();
  writeFileSync(join(ctx.d, "mode.json"), "{}");
  mkdirSync(ctx.tmp, { recursive: true });
  const r = engine(["continue", "--yes", "--claude-bin", ctx.stub, "--stack", ctx.stack],
    { cwd: ctx.repo, env: { ...HUMAN, PATH: BARE_PATH, TMPDIR: ctx.tmp } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.json.next_step, /^detent continue/);
  assert.doesNotMatch(r.json.next_step, /drive/);
});
