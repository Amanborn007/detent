// Shared kit for the drive hardening tests: a stub claude that plays a (possibly hostile) child, a stack, a toy repo.
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { ENGINE, engine, mkRun, mkCuratorClone, readJson, writeJson, writeArtifact, detentHome, curatorStateDir } from "./helpers.mjs";

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

/** A clone of the engine whose bundled curator is a stub: gate pages are "opened" without a browser or a daemon. */
function stubCuratorDir(t) {
  if (!t.curatorDir) {
    t.curatorDir = scratch();
    mkCuratorClone(t.curatorDir, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "open") console.log(JSON.stringify({ url: "http://127.0.0.1:9/s/stub", key: a[1] }));
`);
  }
  return t.curatorDir;
}

export function drive(t, cfg, extra = [], env = {}) {
  writeFileSync(join(t.d, "mode.json"), JSON.stringify(cfg));
  mkdirSync(t.tmp, { recursive: true });
  const r = engine(["drive", "--run", t.runId, "--repo", t.repo, "--claude-bin", t.stub, "--stack", t.stack, ...extra],
    { env: { PATH: BARE_PATH, TMPDIR: t.tmp, TEST_CLONE: stubCuratorDir(t), ...env } });
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

// Stub claude for the implement and recheck children: runs mode.json `impl.commands` through the shim shell and prints stream-json.
// Other impl keys: unsandboxed, writeSentinel, appendLog, reverseLog, subtype, cost, exit; per command: input, wrap, skipShim.
export function mkImplementStub(dir) {
  const bin = join(dir, "claude-impl-stub.mjs");
  writeFileSync(bin, `#!${process.execPath}
import { readFileSync, appendFileSync, writeFileSync, readdirSync, realpathSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "mode.json"), "utf8"));
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.1.306 (Claude Code)"); process.exit(0); }
const prompt = readFileSync(0, "utf8");
const settings = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1], "utf8"));
const tools = argv[argv.indexOf("--tools") + 1];
const cwd = realpathSync(process.cwd());
appendFileSync(join(here, "impl-stub.log"), JSON.stringify({ args: argv, cwd, env: process.env, settings, prompt, tools, files: tools === "Bash" ? [] : readdirSync(cwd) }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (tools !== "Bash") {
  if ((cfg.recheck || {}).killParent) process.kill(process.ppid, "SIGKILL");
  console.log(JSON.stringify([{ type: "result", subtype: "success", is_error: false, result: (cfg.recheck || {}).text ?? "recheck ok", total_cost_usd: 0.01, num_turns: 1, permission_denials: [] }]));
  process.exit(0);
}
const impl = cfg.impl || {};
const shell = process.env.CLAUDE_CODE_SHELL;
const shimRoot = dirname(dirname(shell));
const sentinel = join(shimRoot, "log", "sentinel");
const callLog = join(shimRoot, "log", "shell-calls.jsonl");
if (impl.writeSentinel) appendFileSync(sentinel, "x");
if (!impl.unsandboxed) chmodSync(sentinel, 0o400);
out({ type: "system", subtype: "init", tools: ["Bash"] });
(impl.commands || []).forEach((c, i) => {
  const id = "toolu_" + i;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: c.input ?? { command: c.cmd } }] } });
  if (!c.skipShim) spawnSync(shell, ["-c", c.wrap ?? ("export TMPDIR='" + process.env.TMPDIR + "'\\n" + c.cmd + "\\n")], { cwd, env: process.env, stdio: "pipe" });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
});
for (const l of impl.appendLog || []) appendFileSync(callLog, l + "\\n");
if (impl.reverseLog) writeFileSync(callLog, readFileSync(callLog, "utf8").trim().split("\\n").reverse().join("\\n") + "\\n");
out({ type: "result", subtype: impl.subtype || "success", is_error: false, result: "implemented", total_cost_usd: impl.cost ?? 0.02, num_turns: 3, permission_denials: [] });
process.exit(impl.exit ?? 0);
`);
  chmodSync(bin, 0o755);
  return bin;
}

export const IMPL_DEPS = join(dirname(fileURLToPath(import.meta.url)), "drive-implement-deps.mjs");

const jsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
export const implLog = (t) => jsonl(join(t.d, "impl-stub.log"));
export const implEvents = (t) => jsonl(join(t.d, "impl-events.jsonl"));

// A run with the plan gate approved and a verify command recorded the way a human would, with engine env --verify.
export function approvedRun({ verify = "test -f f.txt" } = {}) {
  const t = setup();
  t.implStub = mkImplementStub(t.d);
  const r = drive(t, {});
  if (r.code !== 0) throw new Error(`drive to the plan gate failed: ${r.stdout}${r.stderr}`);
  const p = join(t.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => (d.gate === "intent" ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() } : d)));
  git(t.repo, "config", "user.name", "Impl Tester");
  git(t.repo, "config", "user.email", "t@example.invalid");
  if (verify) {
    const e = engine(["env", "--run", t.runId, "--repo", t.repo, "--verify", verify]);
    if (e.code !== 0) throw new Error(`engine env failed: ${e.stdout}${e.stderr}`);
  }
  return t;
}

// drive --implement against the implement stub, with the test-only deps module: fake host box, trivial probe, no real preflight.
export function implDrive(t, cfg, { flags = ["--implement"], deps = {}, env = {}, useDeps = true } = {}) {
  writeFileSync(join(t.d, "mode.json"), JSON.stringify(cfg));
  const depsCfg = join(t.d, "impl-deps.json");
  writeFileSync(depsCfg, JSON.stringify({ eventsFile: join(t.d, "impl-events.jsonl"), repo: t.repo, runId: t.runId, ...deps }));
  mkdirSync(t.tmp, { recursive: true });
  const r = engine(["drive", "--run", t.runId, "--repo", t.repo, "--claude-bin", t.implStub, "--stack", t.stack, ...flags], {
    env: {
      PATH: BARE_PATH, TMPDIR: t.tmp, USER: "tester", TEST_CLONE: stubCuratorDir(t),
      ...(useDeps ? { DETENT_IMPLEMENT_TEST_DEPS: IMPL_DEPS, DETENT_IMPLEMENT_TEST_CFG: depsCfg } : {}), ...env,
    },
  });
  return { ...r, calls: implLog(t), events: implEvents(t) };
}

// implDrive without waiting: returns the live child so a test can signal it, plus a promise of {code, signal, stdout, stderr}.
export function implDriveAsync(t, cfg, { flags = ["--implement"], deps = {} } = {}) {
  writeFileSync(join(t.d, "mode.json"), JSON.stringify(cfg));
  const depsCfg = join(t.d, "impl-deps.json");
  writeFileSync(depsCfg, JSON.stringify({ eventsFile: join(t.d, "impl-events.jsonl"), repo: t.repo, runId: t.runId, ...deps }));
  mkdirSync(t.tmp, { recursive: true });
  const env = {
    ...process.env, DETENT_ROOT: detentHome(), CURATOR_NO_BROWSER: "1", CURATOR_STATE_DIR: curatorStateDir(),
    PATH: BARE_PATH, TMPDIR: t.tmp, USER: "tester", DETENT_IMPLEMENT_TEST_DEPS: IMPL_DEPS, DETENT_IMPLEMENT_TEST_CFG: depsCfg,
  };
  const child = spawn(process.execPath, [ENGINE, "drive", "--run", t.runId, "--repo", t.repo, "--claude-bin", t.implStub, "--stack", t.stack, ...flags], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const done = new Promise((res) => child.on("close", (code, signal) => res({ code, signal, stdout, stderr })));
  return { child, done };
}
