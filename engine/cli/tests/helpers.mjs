// Shared test helpers for the engine CLI test suite. Zero dependencies.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "engine.mjs");
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// Run state is centralized under DETENT_ROOT/.sdlc. Each test's
// first mkRepo() creates a fresh home; engine() injects it as DETENT_ROOT so
// tests never touch the real detent clone.
let HOME = null;
export function detentHome() { return HOME; }

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/** Run the engine CLI; returns {code, json, stdout, stderr}. json = last stdout line parsed. */
export function engine(args, opts = {}) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...(HOME ? { DETENT_ROOT: HOME } : {}), ...(opts.env || {}) },
  });
  let json = null;
  const out = (r.stdout || "").trim();
  if (out) {
    const last = out.split("\n").pop();
    try { json = JSON.parse(last); } catch { /* leave null; tests assert */ }
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** Make a scratch work repo (git-init'd, one commit so the default run
 *  worktree can be created) and a fresh centralized home for this test. */
export function mkRepo() {
  HOME = mkdtempSync(join(tmpdir(), "detent-home-"));
  const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
    { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  return dir;
}

/** Create a run and drive it to the given stage boundary. Returns {repo, home, runId, runDir}. */
export function mkRun(opts = {}) {
  const repo = opts.repo || mkRepo();
  const r = engine(["run", "new", "--ticket", opts.ticket || "octo/repo#1",
    "--slug", opts.slug || "fix-it", "--repo", repo]);
  if (r.code !== 0) throw new Error("mkRun failed: " + r.stdout + r.stderr);
  const runId = r.json.run_id;
  const runDir = join(HOME, ".sdlc", runId);
  return { repo, home: HOME, runId, runDir };
}

export function writeArtifact(runDir, rel, content = "# artifact\n") {
  const p = join(runDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
export function writeJson(p, obj) { writeFileSync(p, JSON.stringify(obj, null, 2) + "\n"); }

/** Drive intake+research to done with artifacts (legal path). */
export function throughResearch(ctx) {
  const { repo, runId, runDir } = ctx;
  const required = { intake: ["brief.md"], research: ["research.md", "access-report.json"] };
  for (const stage of ["intake", "research"]) {
    let r = engine(["stage", "begin", stage, "--repo", repo, "--run", runId]);
    if (r.code !== 0) throw new Error(`begin ${stage} failed: ` + r.stdout);
    for (const a of required[stage]) {
      if (a.endsWith(".json")) writeJson(join(runDir, a), []);
      else writeArtifact(runDir, a);
    }
    r = engine(["stage", "end", stage, "--repo", repo, "--run", runId]);
    if (r.code !== 0) throw new Error(`end ${stage} failed: ` + r.stdout);
  }
}

export function eventsOf(runDir) {
  const p = join(runDir, "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
