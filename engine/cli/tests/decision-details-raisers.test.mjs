import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson, eventsOf } from "./helpers.mjs";
import { setup, drive, throughStage } from "./drive-kit.mjs";
import { buildGatePage } from "../gate-page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const BARE_PATH = "/usr/bin:/bin";
const STAGES = ["intake", "research", "plan", "implement", "recheck", "ship", "respond"];
const STAGE_ARTIFACTS = { intake: ["brief.md"], research: ["research.md", "access-report.json"], plan: ["plan/plan.md"], recheck: ["recheck.md"] };

const ACCESS_KEYS = ["retry — now reachable", "offline copy at path: <free-text>", "proceed degraded (accept degraded confidence)"];

test("gate open refuses a decision whose options include a non-string", () => {
  const ctx = mkRun({ ticket: "octo/repo#7" });
  writeArtifact(ctx.runDir, "brief.md", "# Brief\n\n## Goal\nG.\n");
  writeJson(join(ctx.runDir, "decisions.json"), [{ id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which one?", status: "pending", options: ["a", { key: "b", label: "B" }] }]);
  const cdir = mkdtempSync(join(tmpdir(), "raisers-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", "D-001", "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: BARE_PATH, TEST_CLONE: cdir, CURATOR_NO_BROWSER: "1" } });
  assert.notEqual(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /D-001.*non-string option/);
});

test("the access-degraded module exports the three option keys byte for byte, with details and no recommendation", async () => {
  const m = await import("../drive/access-degraded.mjs");
  assert.deepEqual(m.ACCESS_DEGRADED_OPTIONS, ACCESS_KEYS);
  assert.deepEqual(Object.keys(m.ACCESS_DEGRADED_DETAILS), ACCESS_KEYS);
  for (const k of ACCESS_KEYS) for (const f of ["label", "consequence", "then"]) assert.ok(m.ACCESS_DEGRADED_DETAILS[k][f].length > 0, `${k}.${f}`);
  assert.ok(m.ACCESS_DEGRADED_NO_RECOMMENDATION.split(/\s+/).length >= 5);
});

test("the proceed-degraded key is the string the engine compares answers against", async () => {
  const m = await import("../drive/access-degraded.mjs");
  const src = readFileSync(join(HERE, "..", "engine.mjs"), "utf8");
  assert.equal(/const PROCEED_DEGRADED_ANSWER = "([^"]+)";/.exec(src)[1], m.ACCESS_DEGRADED_OPTIONS[2]);
});

test("stages/plan/SKILL.md quotes exactly the module's option keys", async () => {
  const m = await import("../drive/access-degraded.mjs");
  const skill = readFileSync(join(REPO, "engine", "stages", "plan", "SKILL.md"), "utf8");
  const line = skill.split("\n").find((l) => l.includes('"kind": "access-degraded"'));
  const listed = /"options": (\[.*?\])\}/.exec(line)[1];
  assert.deepEqual(JSON.parse(listed), m.ACCESS_DEGRADED_OPTIONS);
});

test("drive files the access-degraded decision with option_details and no_recommendation, never recommended", () => {
  const t = setup();
  throughStage(t, "plan");
  writeJson(join(t.runDir, "access-report.json"), [{ source: "jira", binding: "ticket", needed_for: "brief", status: "blocked", criticality: "critical", detail: "x", blocked_reason: "vpn is down", enable_action: "connect the vpn" }]);
  const r = drive(t, {});
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const d = readJson(join(t.runDir, "decisions.json")).find((x) => x.kind === "access-degraded");
  assert.ok(d, "an access-degraded decision is filed");
  assert.deepEqual(d.options, ACCESS_KEYS);
  assert.deepEqual(Object.keys(d.option_details), ACCESS_KEYS);
  assert.equal(typeof d.no_recommendation, "string");
  assert.ok(!("recommended" in d));
});

test("a drive-stopped page lists answered decisions so their ids raise no C8 warning", () => {
  const t = setup();
  writeJson(join(t.runDir, "decisions.json"), [{ id: "D-001", raised_by: "intake", blocks: ["plan"], question: "Capped or infinite?", options: ["capped", "infinite"], cause: "judgment", status: "answered", answer: "capped", answered_by: "human", answered_at: "2026-01-01T00:00:00Z" }]);
  const decision = { key: "u1", question: "Does the brief still hold now that D-001 is answered?", cause: "judgment", blocks: ["plan"], options: ["yes", "no"] };
  const r = drive(t, { manifestPatch: { status: "needs_human", decisions: [decision] } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  assert.match(readFileSync(r.json.html, "utf8"), /Already answered/);
  assert.deepEqual(eventsOf(t.runDir).filter((e) => e.event === "warning" && e.check === "C8"), []);
});

const page = (decision, opts = {}) => buildGatePage({ runId: "r1", runDir: mkdtempSync(join(tmpdir(), "raisers-run-")) },
  { name: decision.id, stage: "plan", decisions: [decision], earlier: [] }, { stages: STAGES, stageArtifacts: STAGE_ARTIFACTS, ...opts });
