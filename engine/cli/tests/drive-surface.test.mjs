// drive-surface.test.mjs — everything around `detent drive` that is not the engine
// itself: umbrella routing, the in-session skill, the experimental notices, CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkRun, readJson } from "./helpers.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DETENT = join(REPO, "engine", "cli", "detent.mjs");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

test("detent help lists drive", () => {
  const r = spawnSync(process.execPath, [DETENT, "help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /detent drive/);
  assert.match(r.stdout, /experimental/i);
});

test("detent drive routes to the engine and runs a stub child end to end", () => {
  const ctx = mkRun();
  const dir = mkdtempSync(join(tmpdir(), "drive-route-"));
  const stub = join(dir, "claude-stub.mjs");
  writeFileSync(stub, `#!${process.execPath}
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const prompt = readFileSync(0, "utf8");
const f = (k) => new RegExp("^" + k + ": (.+)$", "m").exec(prompt)[1].trim();
const run = (...a) => spawnSync(process.execPath, [f("Engine"), ...a, "--run", f("Run id")], { encoding: "utf8" });
run("stage", "begin", "intake");
writeFileSync(join(f("Run dir"), "brief.md"), "# brief\\n");
run("stage", "end", "intake");
console.log(JSON.stringify([{ type: "result", is_error: false, result: "ok", total_cost_usd: 0.02, num_turns: 2 }]));
`);
  chmodSync(stub, 0o755);
  const r = spawnSync(process.execPath, [DETENT, "drive", "--run", ctx.runId, "--repo", ctx.repo, "--claude-bin", stub, "--max-steps", "1"], {
    encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin", DETENT_ROOT: ctx.home },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const json = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(json.stopped, "max_steps");
  assert.equal(json.total_cost_usd, 0.02);
  assert.equal(readJson(join(ctx.runDir, "stage-status.json")).stages.intake.status, "done");
});

test("the drive skill exists, matches the other skills' frontmatter and tells Claude to run in the background", () => {
  const p = join(REPO, "skills", "drive", "SKILL.md");
  assert.ok(existsSync(p), "skills/drive/SKILL.md");
  const text = readFileSync(p, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fm, "frontmatter");
  assert.match(fm[1], /^name: drive$/m);
  assert.match(fm[1], /^description:/m);
  assert.match(fm[1], /^allowed-tools:/m);
  assert.match(text, /run_in_background/);
  assert.match(text, /never.{0,40}foreground/i);
  assert.match(text, /detent drive --run/);
  assert.match(text, /curator open/);
  assert.match(text, /detent gate collect/);
  assert.match(text, /needs_human/);
  assert.match(text, /stopped/);
  assert.match(text, /10 min/);
});

test("engine README, GUIDE and REFERENCE carry the experimental notice with the trust warning", () => {
  for (const rel of ["engine/cli/README.md", "GUIDE.md", "docs/REFERENCE.md"]) {
    const t = read(rel);
    const i = t.search(/drive[^\n]*experimental|experimental[^\n]*drive/i);
    assert.ok(i >= 0, `${rel}: no experimental drive notice`);
    for (const w of ["macOS", "Linux", "--budget", "--setting-sources project", "only drive repos you trust"]) {
      assert.ok(t.includes(w), `${rel}: notice lacks '${w}'`);
    }
  }
});

test("the test workflow runs on ubuntu and macOS", () => {
  const y = read(".github/workflows/test.yml");
  assert.match(y, /matrix:/);
  assert.match(y, /os:\s*\[\s*ubuntu-latest\s*,\s*macos-latest\s*\]/);
  assert.match(y, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
});
