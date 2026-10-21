// Shared kit for the drive hardening tests: a stub claude that plays a (possibly hostile) child, a stack, a toy repo.
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { engine, mkRun, readJson, writeJson, writeArtifact } from "./helpers.mjs";

export const BARE_PATH = "/usr/bin:/bin";
export const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "drive-hard-")));

// mode.json drives the stub (the child env is scrubbed, so there are no env switches):
//   files / extraFiles   artifact bodies; manifestPatch merges into the manifest; artifactsRaw replaces its artifacts list
//   big                  bytes to put at <outbox>/../../big
export function mkClaudeStub(dir) {
  const bin = join(dir, "claude-stub.mjs");
  writeFileSync(bin, `#!${process.execPath}
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "mode.json"), "utf8"));
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.1.306 (Claude Code)"); process.exit(0); }
const prompt = readFileSync(0, "utf8");
const settings = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1], "utf8"));
const field = (k) => new RegExp("^" + k + ": (.+)$", "m").exec(prompt)[1].trim();
const stage = field("Stage"), inputs = field("Inputs directory"), outbox = field("Outbox directory");
appendFileSync(join(here, "stub.log"), JSON.stringify({ args: argv, cwd: realpathSync(process.cwd()), settings, env: process.env, stage, inputs, outbox }) + "\\n");
const step = JSON.parse(readFileSync(join(inputs, "step.json"), "utf8"));
const FILES = {
  intake: { "brief.md": "# Brief\\n\\n## Goal\\nUsers can X.\\n\\n## Unknowns & open questions\\nnone\\n" },
  research: { "research.md": "# Research\\n\\n## Blast radius\\nnone\\n", "access-report.json": JSON.stringify([{ source: "repo", status: "reachable", criticality: "critical", detail: "ok" }]) },
  plan: { "plan/plan.md": "# Plan\\n\\n## Approach\\nx\\n" },
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sw = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const files = { ...(FILES[stage] || {}), ...(cfg.files || {}) };
for (const [rel, body] of Object.entries(files)) sw(join(outbox, rel), body);
if (cfg.big) writeFileSync(join(outbox, "..", "..", "big"), Buffer.alloc(cfg.big, 97));
const manifest = {
  schema: "detent-drive-outbox-v1", run_id: step.run_id, stage, nonce: step.nonce, status: "complete", summary: "stub done",
  artifacts: cfg.artifactsRaw || Object.entries(files).map(([path, body]) => ({ path, sha256: sha(body) })), decisions: [],
  ...(cfg.manifestPatch || {}),
};
sw(join(outbox, "manifest.json"), JSON.stringify(manifest));
console.log(JSON.stringify([{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, num_turns: 2, permission_denials: [] }]));
`);
  chmodSync(bin, 0o755);
  return bin;
}

export function mkStack(dir) {
  const ticket = join(dir, "ticket.mjs");
  writeFileSync(ticket, `#!${process.execPath}
import { readFileSync } from "node:fs";
const req = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify({ id: req.ticket_ref, title: "t", status: "open", body_excerpt: "b", url: "http://x.invalid/1", next_step: "go" }));
`);
  chmodSync(ticket, 0o755);
  const stack = join(dir, "stack.yaml");
  writeFileSync(stack, `engine_version: "1"\nsockets:\n  ticket:\n    command: "${ticket}"\n    version: "1"\n`);
  return stack;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
export const git = (repo, ...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8", env: GIT_ENV });

export function setup() {
  const ctx = mkRun();
  writeFileSync(join(ctx.repo, "README.md"), "# toy\nhello\n");
  git(ctx.repo, "add", "README.md");
  git(ctx.repo, "commit", "-q", "-m", "add readme");
  const d = scratch();
  return { ...ctx, d, stub: mkClaudeStub(d), stack: mkStack(d), tmp: join(d, "tmp") };
}

export function callsOf(t) {
  const p = join(t.d, "stub.log");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export function drive(t, cfg, extra = [], env = {}) {
  writeFileSync(join(t.d, "mode.json"), JSON.stringify(cfg));
  mkdirSync(t.tmp, { recursive: true });
  const r = engine(["drive", "--run", t.runId, "--repo", t.repo, "--claude-bin", t.stub, "--stack", t.stack, ...extra],
    { env: { PATH: BARE_PATH, TMPDIR: t.tmp, ...env } });
  return { ...r, calls: callsOf(t) };
}

export function throughStage(t, upTo) {
  const sh = (a) => { const r = engine([...a, "--repo", t.repo, "--run", t.runId]); if (r.code !== 0) throw new Error(a.join(" ") + r.stdout); };
  const arts = { intake: () => writeArtifact(t.runDir, "brief.md", "# Brief\n\n## Goal\nUsers can X.\n\n## Unknowns & open questions\nnone\n"),
    research: () => { writeArtifact(t.runDir, "research.md", "# R\n\n## Blast radius\nnone\n"); writeJson(join(t.runDir, "access-report.json"), []); } };
  for (const s of ["intake", "research"]) {
    if (s === upTo) return;
    sh(["stage", "begin", s]); arts[s](); sh(["stage", "end", s]);
  }
}

export { readJson, writeJson, existsSync, readFileSync };
