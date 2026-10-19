// engine/cli/tests/advisor.test.mjs — CLI seam for `engine advisor consult`.
// Recommend-only guard lives at the CLI + schema (engine/routing/routing.mjs);
// this test pins the regression tripwire: a consult must never mutate
// decisions.json or stage-status.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engine, mkRun, detentHome, eventsOf } from "./helpers.mjs";

// Run state is centralized under a fresh scratch DETENT_ROOT per test
// (helpers.mjs's mkRun); that scratch home has no engine/routing/routing.json
// of its own (unlike the real detent clone), so each test seeds the same
// committed config shape into it — mirroring how engine/eval/test's
// integration test seeds a scratch evals/config.yaml.
function seedRoutingConfig(home) {
  const dir = join(home, "engine", "routing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "routing.json"), JSON.stringify({
    schema: "detent-routing-v1",
    tiers: { strong: ["fable", "opus"], fast: ["sonnet"], light: ["haiku"] },
    escalation: {
      on_block: "consult-strong-advisor",
      authority: "recommend-only",
      promotion: { requires: "paired cost+quality ledger lines", min_paired_ledger_lines: 10 },
    },
  }));
}

function snapshot(runDir) {
  const decisionsPath = join(runDir, "decisions.json");
  const statusPath = join(runDir, "stage-status.json");
  return {
    decisions: existsSync(decisionsPath) ? readFileSync(decisionsPath, "utf8") : null,
    status: existsSync(statusPath) ? readFileSync(statusPath, "utf8") : null,
  };
}

test("advisor consult appends exactly one advisor_consult event", () => {
  const ctx = mkRun();
  seedRoutingConfig(detentHome());
  const before = eventsOf(ctx.runDir).length;
  const r = engine(["advisor", "consult", "--run", ctx.runId, "--repo", ctx.repo,
    "--trigger", "intent", "--model", "fable"]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.authority, "recommend-only");
  const events = eventsOf(ctx.runDir);
  const consults = events.filter((e) => e.event === "advisor_consult");
  assert.equal(events.length, before + 1);
  assert.equal(consults.length, 1);
  assert.equal(consults[0].model, "fable");
  assert.equal(consults[0].tier, "strong");
  assert.equal(consults[0].trigger, "intent");
  assert.equal(consults[0].authority, "recommend-only");
  assert.ok(!("id" in consults[0]), "id is reserved for external_request correlation");
  assert.ok(existsSync(join(ctx.runDir, "advisor")), "advisor dir created");
});

test("advisor consult refuses a fast-tier --model", () => {
  const ctx = mkRun();
  seedRoutingConfig(detentHome());
  const r = engine(["advisor", "consult", "--run", ctx.runId, "--repo", ctx.repo,
    "--trigger", "intent", "--model", "sonnet"]);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /strong tier/);
  assert.equal(eventsOf(ctx.runDir).filter((e) => e.event === "advisor_consult").length, 0);
});

test("advisor consult refuses --apply / --answer / --unblock (recommend-only guard at the seam)", () => {
  for (const flag of ["apply", "answer", "unblock"]) {
    const ctx = mkRun();
    seedRoutingConfig(detentHome());
    const r = engine(["advisor", "consult", "--run", ctx.runId, "--repo", ctx.repo,
      "--trigger", "intent", "--model", "fable", `--${flag}`]);
    assert.equal(r.code, 2, `--${flag} should refuse: ${r.stdout}`);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /recommend-only/);
    assert.equal(eventsOf(ctx.runDir).filter((e) => e.event === "advisor_consult").length, 0);
  }
});

test("decisions.json and stage-status.json are byte-identical before and after a consult", () => {
  const ctx = mkRun();
  seedRoutingConfig(detentHome());
  const before = snapshot(ctx.runDir);
  assert.ok(before.decisions !== null, "decisions.json exists at run creation");
  assert.ok(before.status !== null, "stage-status.json exists at run creation");
  const r = engine(["advisor", "consult", "--run", ctx.runId, "--repo", ctx.repo,
    "--trigger", "stage:plan", "--model", "opus"]);
  assert.equal(r.code, 0, r.stdout);
  const after = snapshot(ctx.runDir);
  assert.equal(after.decisions, before.decisions, "decisions.json must be untouched");
  assert.equal(after.status, before.status, "stage-status.json must be untouched");
});

test("advisor consult requires --trigger", () => {
  const ctx = mkRun();
  seedRoutingConfig(detentHome());
  const r = engine(["advisor", "consult", "--run", ctx.runId, "--repo", ctx.repo, "--model", "fable"]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /--trigger/);
});

test("advisor consult requires --run", () => {
  const ctx = mkRun();
  seedRoutingConfig(detentHome());
  const r = engine(["advisor", "consult", "--repo", ctx.repo, "--trigger", "intent", "--model", "fable"]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /--run/);
});
