// Shared fixtures for the friendly-verb tests. Stubs only: no network, no real claude or curator.
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { engine, writeArtifact, throughResearch, readJson } from "./helpers.mjs";

/** Env that makes a test look like a human at a plain terminal, whatever runs the suite. */
export const HUMAN = { CLAUDECODE: "", DETENT_DRIVE_CHILD: "", DETENT_FORCE_TTY: "" };
export const BARE_PATH = "/usr/bin:/bin";

export function scratch() { return mkdtempSync(join(tmpdir(), "verbs-test-")); }

export function stubBin(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

export function setOrigin(repo, url) {
  const r = spawnSync("git", ["-C", repo, "remote", "add", "origin", url], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** Drive a run to the point where the intent gate is raised and pending. Returns the gate decision. */
export function toIntentGate(ctx) {
  throughResearch(ctx);
  const a = ["--repo", ctx.repo, "--run", ctx.runId];
  engine(["stage", "begin", "plan", ...a]);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  engine(["stage", "end", "plan", ...a]);
  return readJson(join(ctx.runDir, "decisions.json")).find((d) => d.gate === "intent");
}

export const decisionsOf = (ctx) => readJson(join(ctx.runDir, "decisions.json"));
export const eventsText = (ctx) => (existsSync(join(ctx.runDir, "events.jsonl")) ? readFileSync(join(ctx.runDir, "events.jsonl"), "utf8") : "");
