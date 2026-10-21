// drive/drive: contained `detent drive` for intake -> research -> plan.
// One headless claude child per stage, run --restricted with no Bash and an allowlisted env. The child proposes
// everything in an outbox; drive validates it and is the only writer of run state. The engine's internals come in as E.
"use strict";

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, chmodSync, rmSync, renameSync,
  realpathSync, cpSync, unlinkSync, copyFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readOutbox, validateDecisions, secretScan } from "./outbox.mjs";
import { createStateTracker } from "./integrity.mjs";
import {
  validateDriveProfile, buildChildSettings, buildChildArgs, buildChildEnv, versionAtLeast, MIN_CLAUDE_VERSION,
} from "./profile.mjs";

const DRIVEN_STAGES = ["intake", "research", "plan"];
const STAGE_OUTPUTS = {
  intake: ["brief.md"],
  research: ["research.md", "access-report.json"],
  plan: ["plan/plan.md"],
};
const REQUIRED_HEADINGS = {
  "brief.md": ["## Goal", "## Unknowns & open questions"],
  "research.md": ["## Blast radius"],
};
const DEFAULT_MODEL = "claude-sonnet-5-5";
const DEFAULT_BUDGET_USD = 5;
const BUDGET_FLOOR_USD = 0.1;
const MAX_REPO_ARCHIVE_BYTES = 200 * 1024 * 1024;
const INTENT_NOTE = "intent check: skipped in drive mode";

const ST = {
  runDir: null, runId: null, activeChild: null, stepDir: null, outbox: null, step: 0, keyFile: null, lockFile: null,
  tracker: null, stopping: false, sroot: null, last: {},
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const round = (n) => Number(n.toFixed(6));

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// Inputs are made read-only, so cleanup has to restore write bits before it can unlink.
function forceRemove(p) {
  if (!existsSync(p)) return;
  const walk = (d) => {
    let st;
    try { st = lstatSync(d); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      chmodSync(d, 0o700);
      for (const e of readdirSync(d)) walk(join(d, e));
    }
  };
  walk(p);
  rmSync(p, { recursive: true, force: true });
}

function lockedDown(p) {
  const walk = (d) => {
    const st = lstatSync(d);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of readdirSync(d)) walk(join(d, e));
      chmodSync(d, 0o555);
    } else {
      chmodSync(d, st.mode & 0o555);
    }
  };
  walk(p);
}

function killGroup(sig = "SIGKILL") {
  const c = ST.activeChild;
  if (!c || !c.pid) return;
  try { process.kill(-c.pid, sig); } catch (e) { if (e.code !== "ESRCH") throw e; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function cleanupSync() {
  killGroup("SIGKILL");
  try { if (ST.lockFile && readFileSync(ST.lockFile, "utf8") === String(process.pid)) rmSync(ST.lockFile); } catch { /* lock already gone */ }
  try { if (ST.keyFile) rmSync(ST.keyFile, { force: true }); } catch { /* key file already gone */ }
  try { if (ST.stepDir) forceRemove(ST.stepDir); } catch { /* step dir already gone */ }
}

function acquireLock(E, runDir) {
  const p = join(runDir, "drive.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(p, String(process.pid), { flag: "wx" });
      ST.lockFile = p;
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = parseInt(readFileSync(p, "utf8"), 10);
      if (pidAlive(held)) E.refuse(`another drive holds ${p} (pid ${held})`, `wait for it to stop, or kill pid ${held} and re-run`);
      process.stderr.write(`drive: removing stale ${p} (pid ${held} is not running)\n`);
      rmSync(p);
    }
  }
  throw new Error(`could not acquire ${p}`);
}

function positiveFlag(E, flags, name, dflt, integer) {
  if (flags[name] === undefined) return dflt;
  const n = Number(flags[name]);
  if (flags[name] === true || !Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    E.refuse(`--${name} must be a positive ${integer ? "integer" : "number"}`, `detent drive --run <id> --${name} <n>`);
  }
  return n;
}

function loadBase(E, flags) {
  const custom = flags.profile;
  if (custom === true) E.refuse("--profile requires a path", "detent drive --run <id> --profile <file>");
  const file = custom ? resolve(String(custom)) : join(dirname(E.engineFile), "profiles", "drive.json");
  if (!existsSync(file)) E.refuse(`drive profile not found: ${file}`, "pass an existing --profile <file>");
  let base;
  try { base = JSON.parse(readFileSync(file, "utf8")); } catch (e) { E.refuse(`drive profile ${file}: not valid JSON (${e.message})`, "fix the profile"); }
  try { validateDriveProfile(base, file); } catch (e) { E.refuse(e.message, "fix the profile (or drop --profile); drive never runs a child with Bash, a bypass mode, or a broad grant"); }
  return base;
}

// ---------------------------------------------------------------------------
// stack.yaml: resolved once, hashed, refused if it changes (the target repo never chooses socket commands).
// ---------------------------------------------------------------------------

function resolveStack(E, flags, needed) {
  const path = flags.stack && flags.stack !== true ? resolve(String(flags.stack)) : join(E.detentRoot(), "stack.yaml");
  if (!existsSync(path)) {
    if (needed) E.refuse(`no stack.yaml at ${path}: drive reads the ticket through the ticket socket declared there`, "create it (detent setup) or pass --stack <path>");
    return null;
  }
  const text = readFileSync(path);
  let doc;
  try { doc = E.parseYamlSubset(text.toString("utf8"), path); } catch (e) { E.refuse(`failed to parse ${path}: ${e.message}`, "keep stack.yaml to the shapes in engine/stack.example.yaml"); }
  if (!doc || typeof doc.sockets !== "object" || doc.sockets === null) E.refuse(`${path} has no 'sockets:' map`, "see engine/stack.example.yaml");
  return { path, doc, sha: sha256(text) };
}

function assertStackUnchanged(E, stack) {
  if (!stack) return;
  const now = existsSync(stack.path) ? sha256(readFileSync(stack.path)) : "missing";
  if (now !== stack.sha) {
    E.refuse(`stack.yaml changed since drive started (${stack.path})`, "drive resolves the stack once and refuses a changed one; review the change and re-run");
  }
}

function fetchTicket(E, stack, ref) {
  const entry = stack.doc.sockets.ticket;
  if (!entry || !entry.command) E.refuse(`sockets.ticket in ${stack.path} has no exec 'command'`, "declare an exec ticket provider, see engine/sockets/ticket.md");
  assertStackUnchanged(E, stack);
  const r = E.runExec(entry, { ticket_ref: ref }, stack.path, "ticket");
  assertStackUnchanged(E, stack);
  return r;
}

function runKnowledge(E, stack, query, ticketId) {
  const entry = stack && stack.doc.sockets.knowledge;
  if (!entry) return { note: "no knowledge socket is declared in stack.yaml", providers_succeeded: [], warnings: [], blocked: [], results: [] };
  const providers = Array.isArray(entry.providers) ? entry.providers : [entry];
  const merge = entry.merge || {};
  const succeeded = [];
  const warnings = [];
  const blocked = [];
  const collected = [];
  for (const p of providers) {
    const name = p.name || p.command || "unnamed";
    if (p.kind === "skill" || p.kind === "mcp_tool") {
      blocked.push({ provider: name, kind: p.kind, reason: "skill and MCP providers cannot be reached from a contained drive child" });
      continue;
    }
    if (!p.command) { warnings.push(`provider '${name}' has no exec command; skipped`); continue; }
    assertStackUnchanged(E, stack);
    const r = E.runExec(p, { query, ticket_id: ticketId }, stack.path, name);
    assertStackUnchanged(E, stack);
    if (!r.ok) { warnings.push(`provider '${name}' failed (exit ${r.code})`); continue; }
    succeeded.push(name);
    for (const res of r.response.results || []) collected.push({ ...res, provider: name });
  }
  const bySource = new Map();
  for (const res of collected) {
    if ((res.confidence ?? 0) < (merge.min_confidence ?? 0)) continue;
    const prev = bySource.get(res.source);
    if (!prev || (res.confidence ?? 0) > (prev.confidence ?? 0)) bySource.set(res.source, res);
  }
  const results = [...bySource.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, merge.max_results ?? 25);
  return { providers_succeeded: succeeded, warnings, blocked, results };
}

// ---------------------------------------------------------------------------
// Inputs: everything the child may read, prepared by drive.
// ---------------------------------------------------------------------------

const HARD_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

function hardenedGit(args, repo, extra = {}) {
  return spawnSync("git", ["-C", repo, ...HARD_GIT, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    ...extra,
  });
}

function removeSymlinks(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) unlinkSync(p);
    else if (e.isDirectory()) removeSymlinks(p);
  }
}

function exportRepo(E, ctx, repo, dest) {
  const tar = `${dest}.tar`;
  const a = hardenedGit(["archive", "--format=tar", "-o", tar, "HEAD"], repo);
  if (a.status !== 0) stopFail(E, ctx, "repo_export_failed", "the work repo needs at least one commit", { detail: a.stderr });
  if (statSync(tar).size > MAX_REPO_ARCHIVE_BYTES) stopFail(E, ctx, "repo_too_large", "the repo export exceeds the 200 MB cap");
  mkdirSync(dest, { recursive: true });
  const x = spawnSync("tar", ["-xf", tar, "-C", dest], { encoding: "utf8" });
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
  rmSync(tar);
  removeSymlinks(dest);
}

function section(text, heading) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return "";
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (/^#{1,2} /.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

function prepareInputs(E, ctx, stage, stepN) {
  const { runDir, runId, repo, stack } = ctx;
  const stepDir = join(ST.sroot, "steps", String(stepN));
  forceRemove(stepDir);
  const dirs = { cwd: join(stepDir, "cwd"), inputs: join(stepDir, "inputs"), outbox: join(stepDir, "outbox"), tmp: join(ST.sroot, "tmp", String(stepN)) };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  ST.stepDir = stepDir;
  ST.outbox = dirs.outbox;
  const nonce = randomBytes(16).toString("hex");
  const put = (name, data) => writeFileSync(join(dirs.inputs, name), data);
  const copyIf = (src, name) => { if (existsSync(src)) copyFileSync(src, join(dirs.inputs, name)); };
  const stagesDir = join(dirname(E.engineFile), "..", "stages");
  put("SKILL.md", readFileSync(join(stagesDir, stage, "SKILL.md")));
  put("DRIVEN.md", readFileSync(join(stagesDir, "DRIVEN.md")));
  put("step.json", JSON.stringify({
    schema: "detent-drive-step-v1", run_id: runId, stage, step: stepN, nonce,
    outputs: STAGE_OUTPUTS[stage],
    required_headings: Object.fromEntries(STAGE_OUTPUTS[stage].filter((f) => REQUIRED_HEADINGS[f]).map((f) => [f, REQUIRED_HEADINGS[f]])),
  }, null, 2));
  const run = E.readJson(join(runDir, "run.json"));
  put("run.json", JSON.stringify({ run_id: runId, ticket_ref: run.ticket_ref, created_at: run.created_at }, null, 2));
  put("decisions.json", JSON.stringify(E.loadDecisions(runDir), null, 2));
  copyIf(join(runDir, "env.json"), "env.json");

  const log = hardenedGit(["log", "-n", "50", "--stat", "--no-ext-diff", "--no-textconv"], repo);
  if (log.status !== 0) stopFail(E, ctx, "git_log_failed", "the work repo needs at least one commit", { detail: log.stderr });
  put("git-log.txt", log.stdout);
  exportRepo(E, ctx, repo, join(dirs.inputs, "repo"));

  if (stage === "intake") {
    const t = fetchTicket(E, stack, run.ticket_ref);
    if (!t.ok) stopFail(E, ctx, "ticket_fetch_failed", "fix the ticket provider in stack.yaml, then re-run", { stage, detail: t.stderr });
    put("ticket.json", JSON.stringify(t.response, null, 2));
  }
  if (stage !== "intake") copyIf(join(runDir, "brief.md"), "brief.md");
  if (stage === "research") {
    const brief = readFileSync(join(runDir, "brief.md"), "utf8");
    const query = section(brief, "## Goal").split("\n")[0] || String(run.ticket_ref);
    put("knowledge.json", JSON.stringify(runKnowledge(E, stack, query, String(run.ticket_ref)), null, 2));
  }
  if (stage === "plan") {
    copyIf(join(runDir, "research.md"), "research.md");
    copyIf(join(runDir, "access-report.json"), "access-report.json");
  }
  lockedDown(dirs.inputs);
  chmodSync(dirs.cwd, 0o555);
  return { ...dirs, nonce, stepDir };
}

// ---------------------------------------------------------------------------
// Running the child
// ---------------------------------------------------------------------------

function runChild(bin, args, { cwd, input, timeoutMs, env }) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    ST.activeChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      killGroup("SIGKILL");
      resolveP({ code, signal, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); settled = true; rejectP(e); });
    // Descendants can keep the pipes open, so the group dies the moment the child itself exits.
    child.on("exit", (code, signal) => {
      killGroup("SIGKILL");
      setTimeout(() => finish(code, signal), 1000).unref();
    });
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function parseResult(stdout) {
  let v;
  try { v = JSON.parse(stdout.trim()); } catch { return { bad: "child stdout is not JSON" }; }
  if (Array.isArray(v)) v = [...v].reverse().find((e) => e && e.type === "result");
  if (!v || typeof v !== "object") return { bad: "child JSON has no result object" };
  return { result: v };
}

function claudeVersion(claudeBin, env) {
  const r = spawnSync(claudeBin, ["--version"], { encoding: "utf8", env, timeout: 30000 });
  if (r.error) return { error: r.error.message };
  return { text: (r.stdout || "").trim() };
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

function makeTracker(E, ctx) {
  const { runDir, runId, stack } = ctx;
  const cliDir = dirname(E.engineFile);
  const plansDir = join(E.detentRoot(), ".plans");
  const pages = new Set([join(plansDir, `${runId}-intent.html`)]);
  if (existsSync(plansDir)) {
    for (const f of readdirSync(plansDir)) if (f.startsWith(`${runId}-`) && f.endsWith(".html")) pages.add(join(plansDir, f));
  }
  const cli = readdirSync(cliDir).filter((f) => f.endsWith(".mjs")).map((f) => join(cliDir, f));
  const files = [...pages, ...cli, ...(stack ? [stack.path] : [])];
  return createStateTracker({
    files,
    dirs: [runDir, join(cliDir, "..", "stages"), join(cliDir, "drive")],
    exclude: [join(runDir, ".drive"), join(runDir, "drive.lock"), join(runDir, "worktree"), join(runDir, "drive-last.json")],
  });
}

function quarantine(runDir, stepN) {
  if (!ST.outbox || !existsSync(ST.outbox) || readdirSync(ST.outbox).length === 0) return null;
  const dest = join(runDir, ".drive", "quarantine", `${Date.now()}-${stepN}`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(ST.outbox, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

// ---------------------------------------------------------------------------
// Gate pages
// ---------------------------------------------------------------------------

function accessPanel(E, runDir) {
  const p = join(runDir, "access-report.json");
  if (!existsSync(p)) return "";
  let rows;
  try { rows = JSON.parse(readFileSync(p, "utf8")); } catch { return ""; }
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const esc = E.escapeHtml;
  const body = rows.map((r) => `<tr><td>${esc(r.source)}</td><td>${esc(r.status)}</td><td>${esc(r.criticality)}</td><td>${esc(r.detail || r.blocked_reason || "")}</td></tr>`).join("\n");
  return `<h2>Access &amp; data completeness</h2>\n<table><tr><th>source</th><th>status</th><th>criticality</th><th>detail</th></tr>\n${body}\n</table>`;
}

function envPanel(E, runDir) {
  const p = join(runDir, "env.json");
  if (!existsSync(p)) return "";
  let env;
  try { env = JSON.parse(readFileSync(p, "utf8")); } catch { return ""; }
  const cmds = Object.entries(env.commands || {});
  if (cmds.length === 0) return "";
  return `<h2>Proposed commands (not run by drive)</h2>\n<pre>${cmds.map(([k, v]) => E.escapeHtml(`${k}: ${v}`)).join("\n")}</pre>`;
}

function stopForHuman(E, ctx, stage, blockers, collectError) {
  const { runId, runDir } = ctx;
  const noteHtml = `<p class="sub">${E.escapeHtml(INTENT_NOTE)}</p>\n${accessPanel(E, runDir)}\n${envPanel(E, runDir)}`;
  const html = E.renderGateArtifact({ runId, runDir }, {
    name: blockers[0].gate || blockers[0].id, stage, decisions: blockers, noteHtml,
  });
  let url;
  const curator = E.curatorOnPath();
  if (curator) {
    const r = spawnSync(curator, ["open", html], { encoding: "utf8", timeout: 30000 });
    if (r.status === 0) {
      try { url = JSON.parse(r.stdout.trim().split("\n").pop()).url; } catch { /* the page still exists on disk */ }
    } else {
      process.stderr.write("drive: curator open failed (non-fatal); the gate page is on disk\n");
    }
  }
  const ids = blockers.map((d) => d.id);
  return stopOk(E, ctx, "needs_human", {
    stage, decisions: ids, html, ...(url ? { url } : {}), ...(collectError ? { collect_error: true } : {}),
    next_step: `answer in curator${url ? ` (${url})` : ` (open ${html})`}, then run: detent drive --run ${runId}`,
  });
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

function spendOf(ctx) {
  return { total_cost_usd: round(ctx.spent), total_turns: ctx.turns, budget_usd: ctx.budget };
}

function writeLast(ctx, reason, detail = {}) {
  const row = { at: new Date().toISOString(), reason, step: ST.step, ...ST.last, ...detail };
  writeAtomic(join(ctx.runDir, "drive-last.json"), JSON.stringify(row, null, 2) + "\n");
}

function stopOk(E, ctx, stopped, fields) {
  writeLast(ctx, stopped);
  E.appendEvent(ctx.runDir, { event: "drive_stopped", reason: stopped, stage: fields.stage || null, ...spendOf(ctx) });
  return E.out({ ok: true, run_id: ctx.runId, stopped, steps: ctx.steps, ...spendOf(ctx), last: join(ctx.runDir, "drive-last.json"), ...fields });
}

function stopFail(E, ctx, reason, next_step, { stage, detail, extra } = {}) {
  writeLast(ctx, reason, { detail: detail ?? null, ...(extra || {}) });
  E.appendEvent(ctx.runDir, { event: "drive_stopped", reason, stage: stage || null, ...spendOf(ctx) });
  return E.out({ ok: false, reason, next_step, stage: stage || null, ...spendOf(ctx), last: join(ctx.runDir, "drive-last.json") }, 1);
}

// ---------------------------------------------------------------------------
// What next (slice A: never past plan)
// ---------------------------------------------------------------------------

function nextAction(E, status, decisions, runDir) {
  const stage = E.STAGES.find((s) => !["done", "skipped"].includes(status.stages[s].status));
  if (!stage) return { action: "done", stage: null };
  const blockers = E.pendingBlockers(decisions, stage);
  if (blockers.length) return { action: "needs_human", stage, blockers };
  const entry = status.stages[stage];
  if (entry.status === "blocked") {
    const pending = decisions.filter((d) => (entry.blocked_on || []).includes(d.id) && d.status === "pending");
    if (pending.length) return { action: "needs_human", stage, blockers: pending };
  }
  if (!DRIVEN_STAGES.includes(stage)) return { action: "before_implement", stage };
  const own = decisions.filter((d) => d.status === "pending" && d.raised_by === stage);
  if (own.length) return { action: "needs_human", stage, blockers: own };
  const gateDef = E.STAGE_END_GATES[stage];
  const complete = STAGE_OUTPUTS[stage].every((a) => existsSync(join(runDir, a)));
  if (gateDef && complete && entry.status !== "pending") {
    const gate = decisions.find((d) => d.gate === gateDef.name);
    if (!gate) return { action: "end_stage", stage };
    if (gate.status === "pending") return { action: "needs_human", stage, blockers: [gate] };
    if (gate.answer === "revise") return { action: "plan_revise", stage };
    return { action: "end_stage", stage };
  }
  return { action: "spawn", stage };
}

// ---------------------------------------------------------------------------
// Applying a validated outbox
// ---------------------------------------------------------------------------

function validAccessReport(buf) {
  let rows;
  try { rows = JSON.parse(buf.toString("utf8")); } catch { return "access-report.json is not JSON"; }
  if (!Array.isArray(rows)) return "access-report.json is not an array";
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.source !== "string" || !["reachable", "blocked", "partial"].includes(r.status)) {
      return "access-report.json has a record without a source or a valid status";
    }
  }
  return null;
}

function applyOutbox(E, ctx, stage, ro, normalized) {
  const { runDir } = ctx;
  for (const [rel, buf] of ro.files) {
    let data = buf;
    if (rel === "plan/plan.md") {
      data = Buffer.concat([buf, Buffer.from(`\n\n## Intent check\n\n${INTENT_NOTE}. A human reviews the plan against the brief at the gate.\n`)]);
    }
    writeAtomic(join(runDir, rel), data);
  }
  const decisions = E.loadDecisions(runDir);
  const raised = [];
  for (const d of normalized) {
    const rec = {
      id: E.nextDecisionId(decisions), raised_by: stage, blocks: d.blocks, question: d.question, options: d.options,
      cause: d.cause, ...(d.context !== undefined ? { context: d.context } : {}), ...(d.kind ? { kind: d.kind } : {}),
      ...(d.source ? { source: d.source } : {}), status: "pending",
    };
    decisions.push(rec);
    raised.push(rec.id);
  }
  if (stage === "plan" && ro.files.has("plan/plan.md") && existsSync(join(runDir, "access-report.json"))) {
    const rows = JSON.parse(readFileSync(join(runDir, "access-report.json"), "utf8"));
    for (const r of rows.filter((x) => x.criticality === "critical" && x.status === "blocked")) {
      if (decisions.some((d) => d.kind === "access-degraded" && d.source === r.source && d.status === "pending")) continue;
      decisions.push({
        id: E.nextDecisionId(decisions), raised_by: "plan", kind: "access-degraded", blocks: ["implement"], source: r.source,
        question: `CRITICAL source '${r.source}' is BLOCKED (${r.blocked_reason || "no reason recorded"}). Enable: ${r.enable_action || "none recorded"}. How to proceed?`,
        options: ["retry — now reachable", "offline copy at path: <free-text>", "proceed degraded (accept degraded confidence)"],
        cause: "external", status: "pending",
      });
    }
  }
  E.saveDecisions(runDir, decisions);
  const m = ro.manifest;
  if (m.env) {
    const envPath = join(runDir, "env.json");
    const cur = existsSync(envPath) ? JSON.parse(readFileSync(envPath, "utf8")) : { commands: {}, gotchas: [] };
    cur.commands = { ...(cur.commands || {}), ...(m.env.commands || {}) };
    cur.gotchas = [...new Set([...(cur.gotchas || []), ...(m.env.gotchas || [])])];
    writeAtomic(envPath, JSON.stringify(cur, null, 2) + "\n");
  }
  for (const a of m.attempts || []) {
    const row = { ts: E.nowIso(), stage, approach: a.approach, outcome: a.outcome, ...(a.evidence ? { evidence: a.evidence } : {}) };
    writeFileSync(join(runDir, "attempts.jsonl"), JSON.stringify(row) + "\n", { flag: "a" });
  }
  for (const s of m.steps || []) E.appendEvent(runDir, { event: "step", stage, kind: "tool", label: String(s.label), status: "done" });
  E.appendEvent(runDir, { event: "drive_applied", stage, status: m.status, artifacts: [...ro.files.keys()], decisions: raised });
  return raised;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function cmdDrive(flags, E) {
  if (flags["allow-ship"] !== undefined) {
    E.refuse("--allow-ship is not supported: drive never runs the ship stage", "run implement and ship yourself, interactively, after reviewing the run");
  }
  const repoArg = E.repoOf(flags);
  const { runId, runDir } = E.findRun(repoArg, flags);
  const run = E.readJson(join(runDir, "run.json"));
  const repo = run.repo || repoArg;
  const maxSteps = positiveFlag(E, flags, "max-steps", 12, true);
  const timeoutSec = positiveFlag(E, flags, "child-timeout-sec", 3600, false);
  const budget = positiveFlag(E, flags, "budget", DEFAULT_BUDGET_USD, false);
  if (flags.model === true) E.refuse("--model requires a model id", "detent drive --run <id> --model <id>");
  const model = flags.model || DEFAULT_MODEL;
  if (flags["claude-bin"] === true) E.refuse("--claude-bin requires a path", "detent drive --run <id> --claude-bin <path>");
  const claudeBin = flags["claude-bin"] || process.env.ENGINE_CLAUDE_BIN || "claude";
  const base = loadBase(E, flags);
  const maxTurns = base.drive && base.drive.maxTurns ? base.drive.maxTurns : {};

  const status0 = E.loadStatus(runDir);
  const intakeOpen = !["done", "skipped"].includes(status0.stages.intake.status);
  const stack = resolveStack(E, flags, intakeOpen);

  ST.sroot = join(realpathSync(tmpdir()), "detent-drive", runId);
  mkdirSync(join(ST.sroot, "tmp"), { recursive: true, mode: 0o700 });
  const sandboxTop = dirname(ST.sroot);
  const probe = buildChildEnv(process.env, { tmpdir: join(ST.sroot, "tmp"), sandboxRoot: sandboxTop });
  const ver = claudeVersion(claudeBin, probe.env);
  if (ver.error) E.refuse(`cannot run ${claudeBin}: ${ver.error}`, "install claude or pass --claude-bin / ENGINE_CLAUDE_BIN");
  if (!versionAtLeast(ver.text)) {
    E.refuse(`claude ${JSON.stringify(ver.text)} is older than ${MIN_CLAUDE_VERSION}; drive needs --restricted`, "upgrade Claude Code");
  }

  acquireLock(E, runDir);
  ST.runDir = runDir;
  ST.runId = runId;
  process.on("exit", cleanupSync);
  const ctx = { E, runId, runDir, repo, stack, budget, spent: 0, turns: 0, steps: 0 };

  const onSignal = (sig, code) => async () => {
    if (ST.stopping) { cleanupSync(); process.exit(code); }
    ST.stopping = true;
    killGroup("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    let tampered = false;
    try { tampered = !(ST.tracker && ST.tracker.verify().ok); } catch { tampered = true; }
    let q = null;
    try { q = quarantine(runDir, ST.step); } catch (e) { process.stderr.write(`drive: quarantine failed: ${e.message}\n`); }
    E.appendEvent(runDir, { event: "drive_stopped", reason: "signal", signal: sig, tampered, quarantined: Boolean(q), ...spendOf(ctx) });
    writeLast(ctx, "signal", { signal: sig, tampered });
    process.exit(code);
  };
  process.on("SIGINT", onSignal("SIGINT", 130));
  process.on("SIGTERM", onSignal("SIGTERM", 143));
  process.on("SIGHUP", onSignal("SIGHUP", 129));
  process.on("uncaughtException", (e) => {
    process.stderr.write(`drive: uncaught exception: ${e.stack}\n`);
    try { E.appendEvent(runDir, { event: "drive_stopped", reason: "exception" }); } catch { /* run dir unwritable */ }
    process.exit(1);
  });

  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (apiKey) {
    ST.keyFile = join(runDir, ".drive", "key");
    mkdirSync(dirname(ST.keyFile), { recursive: true });
  }

  // Curator answers are collected only here, before any child exists.
  let collectError = false;
  if (E.loadDecisions(runDir).some((d) => d.status === "pending")) {
    try {
      const d = E.drainCuratorFor(runId, runDir);
      if (d.items.length) E.collectResult(runId, runDir, d.items);
    } catch (e) {
      collectError = true;
      process.stderr.write(`drive: collecting curator feedback failed (continuing): ${e.message}\n`);
    }
  }

  for (;;) {
    const decisions = E.loadDecisions(runDir);
    E.syncGateAnsweredEvents(runDir, decisions);
    const status = E.loadStatus(runDir);
    const next = nextAction(E, status, decisions, runDir);
    if (next.action === "done") return stopOk(E, ctx, "done", { stage: null, next_step: "all stages are done" });
    if (next.action === "needs_human") return stopForHuman(E, ctx, next.stage, next.blockers, collectError);
    if (next.action === "before_implement") {
      return stopOk(E, ctx, "before_implement", {
        stage: next.stage,
        next_step: `the plan is approved. Run the implement stage and then the ship stage yourself, interactively, after reviewing the run: drive does not implement or ship (run ${runId})`,
      });
    }
    if (next.action === "plan_revise") {
      return stopOk(E, ctx, "plan_revise", {
        stage: next.stage,
        next_step: "the plan gate answer was revise: edit plan/plan.md by hand or start a new run; drive has no re-plan loop yet",
      });
    }
    const stage = next.stage;
    if (next.action === "end_stage") {
      const r = E.endStage(stage, repo, runId, runDir, null);
      if (!r.ok) {
        if (r.refusal.extra && r.refusal.extra.gate) continue;
        return stopFail(E, ctx, "stage_end_refused", "inspect the run", { stage, detail: r.refusal.reason });
      }
      continue;
    }

    // action === "spawn"
    if (ctx.steps >= maxSteps) {
      return stopOk(E, ctx, "max_steps", { stage, next_step: `detent drive --run ${runId} to continue` });
    }
    const remaining = budget - ctx.spent;
    if (remaining < BUDGET_FLOOR_USD) {
      return stopOk(E, ctx, "budget", {
        stage, next_step: `spent ${round(ctx.spent)} of ${budget} USD; raise it and continue: detent drive --run ${runId} --budget <usd>`,
      });
    }
    if (["pending", "blocked"].includes(status.stages[stage].status)) {
      const b = E.beginStage(stage, repo, runId, runDir);
      if (!b.ok) return stopFail(E, ctx, "stage_begin_refused", "inspect the run", { stage, detail: b.refusal.reason });
    }

    ctx.steps++;
    ST.step = ctx.steps;
    ST.last = { stage };
    const io = prepareInputs(E, ctx, stage, ctx.steps);
    const settingsFile = join(runDir, ".drive", `settings-${ctx.steps}.json`);
    if (apiKey) writeFileSync(ST.keyFile, apiKey, { mode: 0o600 });
    const settings = buildChildSettings(base, { inputs: io.inputs, outbox: io.outbox, apiKeyFile: apiKey ? ST.keyFile : null });
    writeAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    const { env, literals } = buildChildEnv(process.env, { tmpdir: io.tmp, sandboxRoot: sandboxTop });
    const args = buildChildArgs({
      model, settingsFile, inputs: io.inputs, outbox: io.outbox, maxBudgetUsd: Number(remaining.toFixed(4)),
      maxTurns: maxTurns[stage] || 30, bare: Boolean(apiKey),
    });
    const prompt = [
      `Stage: ${stage}`,
      `Run id: ${runId}`,
      `Inputs directory: ${io.inputs}`,
      `Outbox directory: ${io.outbox}`,
      "",
      `Read ${join(io.inputs, "DRIVEN.md")} first, then ${join(io.inputs, "SKILL.md")}, then the other files in the inputs directory.`,
      "DRIVEN.md overrides every engine, curator and gh step in the skill. Write only into the outbox directory.",
      `Finish by writing ${join(io.outbox, "manifest.json")} as DRIVEN.md describes.`,
    ].join("\n");

    E.appendEvent(runDir, { event: "drive_step", step: ctx.steps, stage, model });
    ST.tracker = makeTracker(E, ctx);
    ST.tracker.snapshot();

    let child;
    try {
      child = await runChild(claudeBin, args, { cwd: io.cwd, input: prompt, timeoutMs: timeoutSec * 1000, env });
    } catch (e) {
      return stopFail(E, ctx, "claude_spawn_failed", "install claude or pass --claude-bin / ENGINE_CLAUDE_BIN", { stage, detail: `${claudeBin}: ${e.message}` });
    }
    ST.activeChild = null;
    if (ST.stopping) await new Promise(() => {}); // the signal handler owns the exit
    if (ST.keyFile) rmSync(ST.keyFile, { force: true });

    let verdict;
    try { verdict = ST.tracker.verify(); } catch (e) { verdict = { ok: false, changed: [e.message] }; }
    const tail = child.stderr.trim().slice(-800);
    const parsed = parseResult(child.stdout);
    const result = parsed.result;
    const cost = result && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0 ? result.total_cost_usd : null;
    const turns = result && Number.isInteger(result.num_turns) ? result.num_turns : 0;
    if (cost !== null) { ctx.spent += cost; ctx.turns += turns; }
    ST.last = {
      stage, result: result ? String(result.result ?? "") : null, stderr_tail: tail, subtype: result ? result.subtype ?? null : null,
      permission_denials: result && Array.isArray(result.permission_denials) ? result.permission_denials : [],
      cost_usd: cost, exit_code: child.code,
    };
    if (cost !== null) E.appendEvent(runDir, { event: "drive_child_done", step: ctx.steps, stage, total_cost_usd: cost, num_turns: turns });

    const quarantineAndFail = (reason, next_step, detail, extra) => {
      quarantine(runDir, ctx.steps);
      return stopFail(E, ctx, reason, next_step, { stage, detail, extra });
    };
    if (!verdict.ok) {
      return quarantineAndFail("state_tampered",
        "a child changed state it must never touch: inspect the run, the stack file and ~/.plans, then restore by hand; nothing was restored for you",
        `changed: ${verdict.changed.join(", ")}`);
    }
    if (child.timedOut) return stopFail(E, ctx, "child_timeout", "raise --child-timeout-sec or inspect the stage", { stage, detail: `exceeded ${timeoutSec}s` });
    if (child.code !== 0) return stopFail(E, ctx, "child_failed", "read drive-last.json, fix, then re-run drive", { stage, detail: `exit ${child.code} ${child.signal || ""}` });
    if (parsed.bad) return stopFail(E, ctx, "child_bad_output", "the child must print the --output-format json result", { stage, detail: parsed.bad });
    if (result.subtype === "error_max_budget_usd") {
      if (cost === null) return stopFail(E, ctx, "child_no_cost", "the result lacks total_cost_usd, so the budget cannot be enforced", { stage });
      return stopOk(E, ctx, "budget", {
        stage, next_step: `spent ${round(ctx.spent)} of ${budget} USD; raise it and continue: detent drive --run ${runId} --budget <usd>`,
      });
    }
    if (result.subtype === "error_max_turns") return stopFail(E, ctx, "child_max_turns", "the stage ran out of turns; inspect drive-last.json", { stage });
    if (result.is_error === true || String(result.subtype || "").startsWith("error")) {
      return stopFail(E, ctx, "child_error", "read drive-last.json, fix, then re-run drive", { stage, detail: `subtype ${result.subtype}` });
    }
    if (cost === null) return stopFail(E, ctx, "child_no_cost", "the child result lacks total_cost_usd/num_turns, so --budget cannot be enforced; check the claude version", { stage });

    const ro = readOutbox(io.outbox, {
      runId, stage, nonce: io.nonce, allowedArtifacts: STAGE_OUTPUTS[stage], requiredHeadings: REQUIRED_HEADINGS,
    });
    if (!ro.ok) {
      return quarantineAndFail("outbox_rejected", "the child's outbox failed validation and was quarantined; see drive-last.json", `${ro.reason}: ${ro.detail}`, { code: ro.reason });
    }
    const hit = secretScan([...ro.files.values(), JSON.stringify(ro.manifest)], literals);
    if (hit.hit) return quarantineAndFail("secret_detected", "a secret-shaped string was in the outbox; it was quarantined and not applied", `pattern ${hit.pattern}`);
    if (ro.manifest.status === "partial" || ro.manifest.status === "blocked") {
      return stopFail(E, ctx, ro.manifest.status === "blocked" ? "child_blocked" : "child_partial", "read drive-last.json, then re-run drive", { stage, detail: ro.manifest.summary });
    }
    if (ro.files.has("access-report.json")) {
      const why = validAccessReport(ro.files.get("access-report.json"));
      if (why) return quarantineAndFail("outbox_rejected", "access-report.json is malformed; quarantined", why, { code: "bad_access_report" });
    }
    if (ro.files.has("plan/plan.md") && /^## Intent check/m.test(ro.files.get("plan/plan.md").toString("utf8"))) {
      return quarantineAndFail("outbox_rejected", "plan.md must not write its own Intent check section; quarantined", "plan.md has ## Intent check", { code: "intent_check_written" });
    }
    const nd = validateDecisions(ro.manifest.decisions, { stage, stages: E.STAGES });
    if (!nd.ok) return quarantineAndFail("outbox_rejected", "decisions failed validation; quarantined", `${nd.reason}: ${nd.detail}`, { code: nd.reason });

    applyOutbox(E, ctx, stage, ro, nd.decisions);
    forceRemove(io.stepDir);
    ST.stepDir = null;
    if (ro.manifest.status === "complete") {
      const r = E.endStage(stage, repo, runId, runDir, null);
      if (!r.ok && !(r.refusal.extra && r.refusal.extra.gate)) {
        return stopFail(E, ctx, "stage_end_refused", "inspect the run; the outbox was applied", { stage, detail: r.refusal.reason });
      }
    }
  }
}
