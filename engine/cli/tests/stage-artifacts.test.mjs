// A stage's required exit artifacts, per engine/stages/CONTRACT.md.
//
// research writes two: research.md and access-report.json. Only the first was
// demanded at `stage end`, so a research pass that skipped the access preflight
// entirely still ended clean, and the gap only surfaced later when plan read
// the file by hand. access-report.json is the first completion criterion
// promoted from prose to a check the engine makes itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { engine, mkRepo, mkRun, writeArtifact, writeJson, readJson, detentHome } from "./helpers.mjs";
import { join } from "node:path";

const PROBE = [{ source: "code/vcs", status: "reachable", criticality: "critical" }];

function runThroughIntake() {
  const repo = mkRepo();
  const { runId, runDir } = mkRun({ repo });
  engine(["stage", "begin", "intake", "--run", runId, "--repo", repo]);
  writeArtifact(runDir, "brief.md");
  engine(["stage", "end", "intake", "--run", runId, "--repo", repo]);
  return { repo, runId, runDir };
}

test("research cannot end with research.md but no access-report.json", () => {
  const { repo, runId, runDir } = runThroughIntake();
  engine(["stage", "begin", "research", "--run", runId, "--repo", repo]);
  writeArtifact(runDir, "research.md");

  const r = engine(["stage", "end", "research", "--run", runId, "--repo", repo]);
  assert.equal(r.code, 2, `expected a contract refusal, got ${r.code}: ${r.stdout}${r.stderr}`);
  assert.match(r.json.reason, /access-report\.json/, "the refusal names the missing artifact");
  assert.equal(
    readJson(join(detentHome(), ".sdlc", runId, "stage-status.json")).stages.research.status,
    "in_progress",
    "a refused end leaves the stage in_progress, not done",
  );
});

test("research ends clean once both artifacts exist", () => {
  const { repo, runId, runDir } = runThroughIntake();
  engine(["stage", "begin", "research", "--run", runId, "--repo", repo]);
  writeArtifact(runDir, "research.md");
  writeJson(join(runDir, "access-report.json"), PROBE);

  const r = engine(["stage", "end", "research", "--run", runId, "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(
    readJson(join(detentHome(), ".sdlc", runId, "stage-status.json")).stages.research.status,
    "done",
  );
});

test("research cannot end with access-report.json but no research.md", () => {
  const { repo, runId, runDir } = runThroughIntake();
  engine(["stage", "begin", "research", "--run", runId, "--repo", repo]);
  writeJson(join(runDir, "access-report.json"), PROBE);

  const r = engine(["stage", "end", "research", "--run", runId, "--repo", repo]);
  assert.equal(r.code, 2, `expected a contract refusal, got ${r.code}`);
  assert.match(r.json.reason, /research\.md/);
});

test("the refusal reports every missing artifact, not just the first", () => {
  const { repo, runId } = runThroughIntake();
  engine(["stage", "begin", "research", "--run", runId, "--repo", repo]);

  const r = engine(["stage", "end", "research", "--run", runId, "--repo", repo]);
  assert.equal(r.code, 2);
  assert.deepEqual(
    [...r.json.missing_artifact].sort(),
    ["access-report.json", "research.md"],
    "missing_artifact lists both so one re-run fixes both",
  );
});

test("stage begin tells you both artifacts to produce", () => {
  const { repo, runId } = runThroughIntake();
  const r = engine(["stage", "begin", "research", "--run", runId, "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.json.next_step, /research\.md/);
  assert.match(r.json.next_step, /access-report\.json/);
});

test("a single-artifact stage still refuses and reports as before", () => {
  const repo = mkRepo();
  const { runId } = mkRun({ repo });
  engine(["stage", "begin", "intake", "--run", runId, "--repo", repo]);

  const r = engine(["stage", "end", "intake", "--run", runId, "--repo", repo]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /brief\.md/);
  assert.deepEqual([...r.json.missing_artifact], ["brief.md"]);
});
