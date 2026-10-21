// infer-run.test.mjs — --run is optional: exact id, then ticket key, then a
// non-date substring, then the newest unfinished run for the cwd repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { engine, mkRun, readJson, writeJson, detentHome } from "./helpers.mjs";

function second(ctx, slug, ticket = "octo/repo#1") {
  const r = engine(["run", "new", "--ticket", ticket, "--slug", slug, "--repo", ctx.repo]);
  assert.equal(r.code, 0, r.stdout);
  return r.json.run_id;
}

function age(runId, iso) {
  const p = join(detentHome(), ".sdlc", runId, "run.json");
  const j = readJson(p);
  j.created_at = iso;
  writeJson(p, j);
}

function finish(runId) {
  const p = join(detentHome(), ".sdlc", runId, "stage-status.json");
  const j = readJson(p);
  for (const s of Object.keys(j.stages)) j.stages[s] = { status: "done" };
  writeJson(p, j);
}

test("exact run id wins even when it is a substring of another run", () => {
  const a = mkRun({ slug: "fix-it" });
  const b = second(a, "fix-it-2");
  const r = engine(["next", "--run", a.runId], { cwd: a.repo });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.run_id, a.runId);
  assert.notEqual(a.runId, b);
});

test("a ticket key (slug form or owner/repo#N) resolves a unique run", () => {
  const a = mkRun({ slug: "fix-it" });
  for (const ref of ["octo-repo-1", "octo/repo#1"]) {
    const r = engine(["next", "--run", ref], { cwd: a.repo });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.run_id, a.runId);
  }
});

test("a ticket key shared by two runs is ambiguous and lists candidates", () => {
  const a = mkRun({ slug: "one" });
  const b = second(a, "two");
  const r = engine(["next", "--run", "octo-repo-1"], { cwd: a.repo });
  assert.equal(r.code, 2);
  assert.deepEqual(r.json.runs.sort(), [a.runId, b].sort());
});

test("a unique substring resolves, a date-only string never does", () => {
  const a = mkRun({ slug: "needle-slug" });
  const ok = engine(["next", "--run", "needle"], { cwd: a.repo });
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.json.run_id, a.runId);
  const date = a.runId.slice(0, 10);
  const bad = engine(["next", "--run", date], { cwd: a.repo });
  assert.equal(bad.code, 2);
  assert.match(bad.json.reason, /no run/);
});

test("a bare prefix of a run id does not match", () => {
  const a = mkRun({ slug: "fix-it" });
  const r = engine(["next", "--run", a.runId.slice(0, 16)], { cwd: a.repo });
  assert.equal(r.code, 2);
});

test("without --run the newest unfinished run for the cwd repo is used", () => {
  const a = mkRun({ slug: "old" });
  const b = second(a, "new");
  age(a.runId, "2026-01-01T00:00:00Z");
  const r = engine(["next"], { cwd: a.repo });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.run_id, b);
});

test("finished runs are skipped when inferring, and all-finished refuses", () => {
  const a = mkRun({ slug: "old" });
  const b = second(a, "new");
  age(a.runId, "2026-01-01T00:00:00Z");
  finish(b);
  const r = engine(["next"], { cwd: a.repo });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.run_id, a.runId);
  finish(a.runId);
  const none = engine(["next"], { cwd: a.repo });
  assert.equal(none.code, 2);
});

test("every run-taking command infers the run from cwd", () => {
  const a = mkRun({ slug: "fix-it" });
  const cwd = a.repo;
  const cases = [
    ["stage", "begin", "intake"],
    ["step", "looking around"],
    ["env", "--verify", "node --test"],
    ["attempt", "--none"],
    ["decide-why", "--decision", "D-001", "--option", "x", "--why", "y"],
    ["bench"],
    ["handoff", "--stage", "intake", "--force"],
    ["gate", "collect"],
  ];
  for (const args of cases) {
    const r = engine(args, { cwd });
    assert.ok(!/requires (--run|a run id)/.test(r.json?.reason || ""), `${args.join(" ")}: ${r.stdout}`);
    assert.ok(!/ambiguous|no runs for/.test(r.json?.reason || ""), `${args.join(" ")}: ${r.stdout}`);
  }
  const live = engine(["live"], { cwd });
  assert.equal(live.code, 0, live.stdout);
});
