// drive/implement: the `detent drive --implement` step. One Bash-capable claude child works in a throwaway clone
// inside Claude Code's own sandbox; its work leaves as a git bundle that is checked, verified in a box and only
// then imported into refs/heads/detent/<run>. Orchestration is verified by tests; the live sandbox is not.
"use strict";

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { git, gitOk, resolveGit, testHooksEnabled } from "./gitsafe.mjs";
import {
  BundleReject, bundleExportArgv, diffForRecheck, importBundle, isDotGitName, makeWorkClone, verifyBundle,
} from "./bundle.mjs";
import { implementPreflight } from "./preflight.mjs";
import { createBox as realCreateBox } from "./hostbox.mjs";
import {
  buildImplementArgs, buildImplementEnv, buildImplementSettings, createClaudeTmp, implementPathEntries, removeClaudeTmp,
  validateImplementSettings,
} from "./implement-profile.mjs";
import {
  buildSelfProbe, collectControls, evaluateSelfProbe, installShim, readShimReport, startCanaryListener, uninstallShim,
} from "./selfprobe.mjs";
import { buildChildEnv, buildChildSettings } from "./profile.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const IDENTITY = Object.freeze({ name: "detent implement", email: "implement@detent.invalid" });
const BASH_KEYS = new Set(["command", "description", "timeout"]);
const LOG_TAIL = 8 * 1024;
const RECHECK_TEXT_CAP = 64 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// ---------------------------------------------------------------- flags and deps

export function checkImplementFlags({ platform, env }) {
  if (platform !== "darwin") {
    return { reason: "implement_platform_unsupported", next_step: "--implement runs only on macOS: the sandbox that contains its child has no Linux counterpart yet" };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      reason: "implement_api_key_refused",
      next_step: "--implement uses your Claude OAuth login and refuses ANTHROPIC_API_KEY, because a key in the environment can reach the sandboxed child: unset ANTHROPIC_API_KEY (env -u ANTHROPIC_API_KEY detent drive ...) and run claude login",
    };
  }
  return null;
}

async function realMakeProbe({ ctx, settings, runDir }) {
  const fsx = settings.sandbox.filesystem;
  const nonce = `DENIED-${randomBytes(8).toString("hex")}`;
  const canaryDir = join(ctx.stepDir, "canary");
  mkdirSync(canaryDir, { mode: 0o700 });
  const canaryPath = join(canaryDir, "canary");
  writeFileSync(canaryPath, `${nonce}\n`, { mode: 0o600 });
  const st = statSync(canaryPath);
  const denyTargets = fsx.denyRead.filter((p) => !p.startsWith("/System/Volumes/Data") && existsSync(p));
  const probe = buildSelfProbe({
    platform: "darwin", clone: ctx.clone, drivePid: process.pid, denyTargets,
    canaries: [{ path: canaryPath, nonce, volPath: `/.vol/${st.dev}/${st.ino}` }],
    writeAllowed: [ctx.outbox, ctx.tmp], writeDenied: [ctx.home, runDir, "/tmp/claude", "/private/tmp/claude"],
    toolchain: ["node", "git"], claudeTmp: ctx.claudeTmp, denyClaudeUidTmp: true,
  });
  const controls = collectControls(probe.controlScript);
  // The step dir can be too deep for a sockaddr_un path, so the canary socket lives directly under /tmp.
  const canary = await startCanaryListener({ socketPath: join("/tmp", `dtc-${randomBytes(4).toString("hex")}.sock`) });
  return {
    exps: {
      validate: { home: ctx.home, readDeny: fsx.denyRead, writeAllow: [ctx.clone, ctx.outbox, ctx.tmp], writeDenyRequired: [join(ctx.clone, ".git", "config"), ...fsx.denyWrite] },
      probe: { script: probe.script, expect: probe.expect, controls },
      shell: { realShell: "/bin/bash", canaryPort: canary.port, canarySocket: canary.socketPath },
    },
    finish: async () => {
      await new Promise((r) => setTimeout(r, 200));
      const canaryHits = canary.hits();
      await canary.close();
      return { canaryHits };
    },
  };
}

export async function loadImplementDeps(env = process.env) {
  const real = { platform: process.platform, preflight: implementPreflight, createBox: realCreateBox, makeProbe: realMakeProbe };
  const mod = env.DETENT_IMPLEMENT_TEST_DEPS;
  if (!mod) return real;
  if (!testHooksEnabled()) throw new Error("DETENT_IMPLEMENT_TEST_DEPS is only honoured under node --test");
  const cfgPath = env.DETENT_IMPLEMENT_TEST_CFG;
  if (!cfgPath) throw new Error("DETENT_IMPLEMENT_TEST_DEPS needs DETENT_IMPLEMENT_TEST_CFG");
  const m = await import(pathToFileURL(mod).href);
  return { ...real, ...m.default(JSON.parse(readFileSync(cfgPath, "utf8"))) };
}

// ---------------------------------------------------------------- fail-closed checks

export function parseImplementTranscript(stdout) {
  const problems = [];
  const bash = [];
  let result = null;
  let resultSeen = false;
  for (const raw of String(stdout).split("\n")) {
    if (!raw.trim()) continue;
    let o;
    try { o = JSON.parse(raw); } catch { problems.push(`bad_line: ${raw.slice(0, 80)}`); continue; }
    if (o === null || typeof o !== "object" || Array.isArray(o)) { problems.push(`bad_line: ${raw.slice(0, 80)}`); continue; }
    if (resultSeen) problems.push("result_not_last: a line follows the result line");
    if (o.type === "result") {
      if (result) problems.push("multiple_results");
      result = o;
      resultSeen = true;
      continue;
    }
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content) {
      if (!b || b.type !== "tool_use") continue;
      if (b.name !== "Bash") { problems.push(`non_bash_tool: ${String(b.name)}`); continue; }
      const input = b.input;
      if (input === null || typeof input !== "object" || Array.isArray(input)) { problems.push(`bash_key: input of ${b.id} is not an object`); continue; }
      for (const [k, v] of Object.entries(input)) {
        if (BASH_KEYS.has(k)) continue;
        if (k === "dangerouslyDisableSandbox") { if (v) problems.push(`dangerously_disable_sandbox: ${b.id}`); continue; }
        if (k === "run_in_background") { if (v) problems.push(`run_in_background: ${b.id}`); continue; }
        problems.push(`bash_key: ${k} in ${b.id}`);
      }
      if (typeof input.command !== "string") { problems.push(`command_not_string: ${b.id}`); continue; }
      bash.push({ id: b.id, command: input.command });
    }
  }
  return { bash, problems, result };
}

// A verbatim match that does not start or end in the middle of a word, so `ls` is not found inside `else`.
function containsCommand(cmd, command) {
  if (!command) return false;
  const word = /\w/;
  for (let at = cmd.indexOf(command); at >= 0; at = cmd.indexOf(command, at + 1)) {
    const before = cmd[at - 1];
    const after = cmd[at + command.length];
    if (!(before && word.test(before) && word.test(command[0])) && !(after && word.test(after) && word.test(command.at(-1)))) return true;
  }
  return false;
}

export function checkShimCalls({ callLog, bash }) {
  const problems = [];
  const calls = [];
  for (const raw of String(callLog).split("\n")) {
    if (!raw.trim()) continue;
    let o;
    try { o = JSON.parse(raw); } catch { problems.push(`bad_log_line: ${raw.slice(0, 80)}`); continue; }
    if (o === null || typeof o !== "object" || Array.isArray(o) || o.ev !== "call" || typeof o.cmd !== "string" || typeof o.cmd_sha256 !== "string") {
      problems.push(`bad_call_shape: ${raw.slice(0, 80)}`);
      continue;
    }
    if (o.mode !== "shell") { problems.push(`bad_mode: ${String(o.mode)}`); continue; }
    calls.push(o);
  }
  if (calls.length !== bash.length) problems.push(`count_mismatch: the shim logged ${calls.length} call(s) for ${bash.length} Bash tool use(s)`);
  calls.slice(0, bash.length).forEach((c, i) => {
    if (!containsCommand(c.cmd, bash[i].command)) problems.push(`command_not_in_cmd: log line ${i + 1} does not contain the command of tool use ${bash[i].id}`);
    if (sha256(c.cmd) !== c.cmd_sha256) problems.push(`hash_mismatch: log line ${i + 1}`);
  });
  return { problems, calls };
}

export function checkSentinel(path) {
  let st;
  try { st = lstatSync(path); } catch { return [`sentinel_missing: ${path}`]; }
  if (!st.isFile()) return [`sentinel_missing: ${path} is not a regular file`];
  if (st.size > 0) return [`sentinel_written: ${st.size} byte(s); a shim ran outside the sandbox`];
  return [];
}

// ---------------------------------------------------------------- git helpers

function refOid(repo, ref) {
  const r = git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { repo });
  if (r.status !== 0) return null;
  const oid = r.stdout.toString().trim();
  return OID.test(oid) ? oid : null;
}

function safeRelPath(p) {
  if (!p || p.startsWith("/") || p.includes("\0")) return false;
  return p.split("/").every((s) => s && s !== "." && s !== ".." && !isDotGitName(s));
}

// ls-tree plus cat-file reads blobs as stored, so no filter or attribute applies; gitsafe has no checkout.
function checkoutQuarantine({ quarantine, head, dest }) {
  const ls = gitOk(["ls-tree", "-r", "-z", "--full-tree", head], { gitDir: quarantine }).toString("latin1");
  const files = [];
  const skipped = [];
  for (const rec of ls.split("\0")) {
    if (!rec) continue;
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(rec);
    if (!m) throw new Error(`checkout: unreadable tree entry ${JSON.stringify(rec)}`);
    const [, mode, type, sha, rawPath] = m;
    const path = Buffer.from(rawPath, "latin1").toString("utf8");
    if (!safeRelPath(path)) throw new Error(`checkout: unsafe path ${JSON.stringify(path)}`);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) { skipped.push({ path, mode, type }); continue; }
    files.push({ path, mode, sha });
  }
  if (files.length) {
    const cat = git(["cat-file", "--batch"], { gitDir: quarantine, input: `${files.map((f) => f.sha).join("\n")}\n` });
    if (cat.status !== 0) throw new Error(`checkout: git cat-file failed: ${cat.stderr.toString().slice(0, 200)}`);
    const buf = cat.stdout;
    let off = 0;
    for (const f of files) {
      const nl = buf.indexOf(10, off);
      const h = buf.subarray(off, nl).toString("utf8").split(" ");
      if (h[1] !== "blob") throw new Error(`checkout: cat-file returned ${h[1]} for ${f.path}`);
      const size = Number(h[2]);
      const target = join(dest, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf.subarray(nl + 1, nl + 1 + size), { mode: f.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
      off = nl + 1 + size + 1;
    }
  }
  return { files: files.length, skipped };
}

// ---------------------------------------------------------------- decisions and the recheck document

function raise(E, runDir, spec) {
  const decisions = E.loadDecisions(runDir);
  const open = decisions.find((d) => d.gate === spec.gate && d.status === "pending");
  if (open) return open;
  const rec = { id: E.nextDecisionId(decisions), raised_by: "implement", status: "pending", ...spec };
  decisions.push(rec);
  E.saveDecisions(runDir, decisions);
  E.appendEvent(runDir, { event: "gate_raised", stage: "implement", gate: spec.gate, decision_id: rec.id });
  return rec;
}

const tail = (s) => String(s ?? "").slice(-LOG_TAIL);

function parseJsonResult(stdout) {
  let v;
  try { v = JSON.parse(String(stdout).trim()); } catch { return null; }
  if (Array.isArray(v)) v = [...v].reverse().find((e) => e && e.type === "result");
  return v && typeof v === "object" ? v : null;
}

function recheckMarkdown({ runId, head, verify, verifyCmd, sensitive, commits, truncated, skipped, recheck }) {
  const L = [`# Recheck of the implement step for ${runId}`, "", `Written by drive. The step was imported into detent/${runId} at ${head}.`, "", "## Verification", ""];
  L.push(`- verify command: \`${verifyCmd.replaceAll("`", "'")}\``);
  L.push(`- exit code: ${verify.exit_code}${verify.timed_out ? " (timed out)" : ""}`);
  L.push(`- log sha256: ${verify.log_sha256}`, "", "```", tail(verify.stdout_tail + verify.stderr_tail).replaceAll("```", "'''"), "```", "");
  L.push("## Sensitive paths", "", sensitive.length ? sensitive.map((p) => `- \`${p.replaceAll("`", "'")}\``).join("\n") : "none", "");
  L.push("## Commits", "", commits.length ? commits.map((c) => `- ${c.sha.slice(0, 12)} ${c.subject}`).join("\n") : "none", "");
  if (truncated) L.push("The patch given to the recheck child was truncated at its cap.", "");
  if (skipped.length) L.push(`Checkout skipped ${skipped.length} symlink or submodule entr${skipped.length === 1 ? "y" : "ies"} before verify ran.`, "");
  L.push("## Fresh-context comparison with the approved plan", "");
  L.push(recheck.ran ? recheck.text : `The recheck child did not run: ${recheck.reason}. Review the diff against the plan yourself.`, "");
  return L.join("\n");
}

// ---------------------------------------------------------------- the step

// H is drive's side of the contract (built in drive.mjs). The return value is an outcome that drive turns into a stop:
// {kind:"fail", reason, next_step, detail, extra} | {kind:"ok", stopped, fields} | {kind:"human", blockers, extra}.
export async function runImplementStep(H) {
  const { E, ctx, deps } = H;
  const { runId, runDir, repo } = ctx;
  const fail = (reason, next_step, detail, extra) => ({ kind: "fail", reason, next_step, detail, extra });
  const rerun = `detent drive --run ${runId} --implement`;

  const pre = deps.preflight({ env: process.env, platform: deps.platform });
  if (!pre.ok) {
    return fail("implement_preflight_failed", `fix the refusals in drive-last.json, then re-run: ${rerun}`, pre.refusals.map((r) => `${r.code}: ${r.detail}`).join("; "), { preflight: pre.refusals });
  }
  const run = E.readJson(join(runDir, "run.json"));
  if (!run.worktree) return fail("no_worktree_run", "this run was created with --no-worktree, so there is no sdlc branch for --implement to start from: create a run without --no-worktree");
  let envJson = {};
  if (existsSync(join(runDir, "env.json"))) {
    try { envJson = E.readJson(join(runDir, "env.json")); } catch (e) { return fail("env_invalid", "fix or delete env.json, then re-run", e.message); }
  }
  const cmds = envJson.commands && typeof envJson.commands === "object" ? envJson.commands : {};
  if (cmds.setup) return fail("setup_unsupported", "--implement does not run setup commands yet: remove commands.setup from env.json or run implement yourself", String(cmds.setup));
  const ship = E.loadDecisions(runDir).filter((d) => d.status === "pending" && Array.isArray(d.blocks) && d.blocks.includes("ship"));
  if (ship.length) return { kind: "human", blockers: ship };
  const verifyCmd = cmds.verify;
  if (typeof verifyCmd !== "string" || !verifyCmd.trim()) {
    const d = raise(E, runDir, {
      gate: "verify-missing", blocks: ["implement"], cause: "data",
      question: `Run ${runId} has no verify command, so drive cannot check the implement step. Record one with engine env --run ${runId} --verify "<command>" (a command proposed by a child in env.proposed.json is never used), then answer.`,
      options: ["recorded - run implement", "skip implement for now"],
    });
    return { kind: "human", blockers: [d] };
  }

  const srcDetent = `refs/heads/detent/${runId}`;
  const expectOld = refOid(repo, srcDetent);
  const sourceRef = expectOld ? srcDetent : `refs/heads/sdlc/${runId}`;
  if (!expectOld && !refOid(repo, sourceRef)) return fail("source_ref_missing", "the run's sdlc branch is gone: recreate it or start a new run", sourceRef);

  const stepRoot = join(H.sroot, "steps", `impl-${H.stepN}`);
  mkdirSync(stepRoot, { recursive: true, mode: 0o700 });
  const stepDir = realpathSync(stepRoot);
  const ictx = {
    home: realpathSync(homedir()), sroot: H.sroot, stepDir, platform: deps.platform, uid: process.getuid(),
    clone: join(stepDir, "clone"), inputs: join(stepDir, "inputs"), outbox: join(stepDir, "outbox"), tmp: join(stepDir, "tmp"),
    shimDir: join(stepDir, "shim"), settingsPath: join(stepDir, "settings.json"),
    path: implementPathEntries(process.env.PATH), model: H.model,
  };
  ictx.callLog = join(ictx.shimDir, "log", "shell-calls.jsonl");
  ictx.sentinel = join(ictx.shimDir, "log", "sentinel");
  ictx.shell = join(ictx.shimDir, "bin", "bash");
  ictx.maxBudgetUsd = Number(((ctx.budget - ctx.spent) * 0.85).toFixed(4));
  ictx.maxTurns = H.maxTurns.implement || 60;
  const boxParent = join(stepDir, "boxes");
  for (const d of [ictx.inputs, ictx.outbox, ictx.tmp, boxParent]) mkdirSync(d, { mode: 0o700 });

  let claudeTmp = null;
  let shimUp = false;
  try {
    claudeTmp = createClaudeTmp();
    ictx.claudeTmp = claudeTmp;
    const { base_sha: base, branch } = makeWorkClone({ repo, sourceRef, dest: ictx.clone, identity: IDENTITY });
    const bundleBranch = `refs/heads/${branch}`;
    const exportBox = deps.createBox({ parent: boxParent });

    const settings = buildImplementSettings(ictx);
    validateImplementSettings(settings, ictx);
    const probe = await deps.makeProbe({ ctx: ictx, settings, runDir });
    const inst = installShim(ictx.shimDir, probe.exps);
    shimUp = true;
    if (inst.callLogPath !== ictx.callLog || inst.sentinelPath !== ictx.sentinel || inst.shellPath !== ictx.shell) {
      throw new Error(`shim paths differ from the profile: ${inst.callLogPath} ${inst.sentinelPath} ${inst.shellPath}`);
    }
    writeFileSync(ictx.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

    const stages = join(dirname(H.engineFile), "..", "stages");
    const put = (name, data) => writeFileSync(join(ictx.inputs, name), data);
    put("DRIVEN-IMPLEMENT.md", readFileSync(join(stages, "implement", "DRIVEN-IMPLEMENT.md")));
    put("step.json", JSON.stringify({ schema: "detent-drive-implement-step-v1", run_id: runId, step: H.stepN, base, verify: verifyCmd }, null, 2));
    put("decisions.json", JSON.stringify(E.loadDecisions(runDir), null, 2));
    for (const [src, name] of [["plan/plan.md", "plan.md"], ["brief.md", "brief.md"], ["research.md", "research.md"], ["env.json", "env.json"]]) {
      if (existsSync(join(runDir, src))) copyFileSync(join(runDir, src), join(ictx.inputs, name));
    }
    H.lockedDown(ictx.inputs);

    const prompt = [
      "Stage: implement", `Run id: ${runId}`, `Inputs directory: ${ictx.inputs}`, `Working directory (your git clone): ${ictx.clone}`,
      "",
      `Read ${join(ictx.inputs, "DRIVEN-IMPLEMENT.md")} first with cat, then plan.md and the other files in the inputs directory.`,
      "You only have the Bash tool. Make one tool call at a time and commit your work in the clone.",
    ].join("\n");
    const env = buildImplementEnv(process.env, ictx);
    const args = buildImplementArgs(ictx);

    E.appendEvent(runDir, { event: "implement_started", step: H.stepN, base, source_ref: sourceRef });
    H.setLast({ stage: "implement", implement: { base, source_ref: sourceRef } });
    const tracker = H.makeTracker();
    tracker.snapshot();
    let child;
    try {
      child = await H.runChild(H.claudeBin, args, { cwd: ictx.clone, input: prompt, timeoutMs: H.timeoutSec * 1000, env });
    } catch (e) {
      return fail("claude_spawn_failed", "install claude or pass --claude-bin / ENGINE_CLAUDE_BIN", `${H.claudeBin}: ${e.message}`);
    }
    const transcriptDir = join(runDir, ".drive");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, `implement-${H.stepN}.transcript.jsonl`), child.stdout.slice(-4 * 1024 * 1024));
    const sandboxReport = await probe.finish();

    let verdict;
    try { verdict = tracker.verify(); } catch (e) { verdict = { ok: false, changed: [e.message] }; }
    const T = parseImplementTranscript(child.stdout);
    const cost = T.result && Number.isFinite(T.result.total_cost_usd) && T.result.total_cost_usd >= 0 ? T.result.total_cost_usd : null;
    if (cost !== null) H.addSpend(cost, Number.isInteger(T.result.num_turns) ? T.result.num_turns : 0);
    H.setLast({ stderr_tail: tail(child.stderr), cost_usd: cost, exit_code: child.code, subtype: T.result?.subtype ?? null });
    if (!verdict.ok) return fail("state_tampered", "a child changed state it must never touch: inspect the run, the stack file and ~/.plans, then restore by hand; nothing was restored for you", `changed: ${verdict.changed.join(", ")}`);
    if (child.timedOut) return fail("child_timeout", "raise --child-timeout-sec or inspect the stage", `exceeded ${H.timeoutSec}s`);
    if (child.code !== 0) return fail("child_failed", "read drive-last.json, fix, then re-run", `exit ${child.code} ${child.signal || ""}`);
    if (!T.result) return fail("child_bad_output", "the child must print the stream-json result line", "no result line");
    if (cost === null) return fail("child_no_cost", "the child result lacks total_cost_usd, so --budget cannot be enforced; check the claude version");

    const problems = [...T.problems];
    const callLog = existsSync(inst.callLogPath) ? readFileSync(inst.callLogPath, "utf8") : "";
    problems.push(...checkShimCalls({ callLog, bash: T.bash }).problems, ...checkSentinel(inst.sentinelPath));
    let evaluation = { failures: [], inconclusive: [], discard: false, noBash: false };
    try {
      const report = { ...readShimReport(inst.dir, { mode: "shell" }), canaryHits: sandboxReport.canaryHits, toolUses: T.bash.length, platform: deps.platform, stderr: child.stderr };
      evaluation = evaluateSelfProbe(report);
    } catch (e) {
      problems.push(`shim_report_unreadable: ${e.message}`);
    }
    problems.push(...evaluation.failures.map((f) => `selfprobe: ${f}`), ...evaluation.inconclusive.map((f) => `selfprobe_inconclusive: ${f}`));
    if (evaluation.discard) problems.push("selfprobe: the step is to be discarded");
    if (problems.length) {
      return fail("sandbox_probe_failed", "the implement child's sandbox could not be vouched for, so the step was discarded and nothing was imported: read drive-last.json, then re-run", problems.join("; "), { problems });
    }
    if (evaluation.noBash) return { kind: "ok", stopped: "no_changes", fields: { stage: "implement", next_step: "the implement child ran no commands, so nothing changed: read drive-last.json and the plan, then re-run" } };
    const st = T.result.subtype;
    if (st === "error_max_budget_usd") return { kind: "ok", stopped: "budget", fields: { stage: "implement", next_step: `the implement child ran out of budget and nothing was imported: raise it and re-run: ${rerun} --budget <usd>` } };
    if (st === "error_max_turns") return fail("child_max_turns", "the implement child ran out of turns and nothing was imported; inspect drive-last.json");
    if (T.result.is_error === true || String(st || "").startsWith("error")) return fail("child_error", "read drive-last.json, fix, then re-run", `subtype ${st}`);

    return await bundleAndVerify({ H, ictx, boxParent, exportBox, base, bundleBranch, expectOld, verifyCmd, run, rerun, fail });
  } finally {
    if (shimUp) uninstallShim(ictx.shimDir);
    H.forceRemove(stepDir);
    if (claudeTmp) removeClaudeTmp(claudeTmp);
  }
}

async function bundleAndVerify({ H, ictx, boxParent, exportBox, base, bundleBranch, expectOld, verifyCmd, run, rerun, fail }) {
  const { E, ctx, deps } = H;
  const { runId, runDir, repo } = ctx;
  const newBox = () => deps.createBox({ parent: boxParent });
  const boxOpts = { net: "none", platform: deps.platform };

  const bundlePath = join(exportBox.dir, "out", "step.bundle");
  const ex = await exportBox.run({
    ...boxOpts, cmd: resolveGit(), args: bundleExportArgv({ work: ictx.clone, branch: bundleBranch, base, out: bundlePath }),
    readOnly: [ictx.clone], writable: [join(exportBox.dir, "out")], timeoutMs: 120_000,
  });
  if (ex.timedOut || ex.code !== 0) {
    if (/empty bundle/i.test(ex.stderr)) return { kind: "ok", stopped: "no_changes", fields: { stage: "implement", next_step: "the implement child made no commits, so nothing changed: read drive-last.json and the plan, then re-run" } };
    return fail("bundle_export_failed", "the export of the child's commits failed; nothing was imported", `exit ${ex.code}${ex.timedOut ? " (timed out)" : ""}: ${tail(ex.stderr)}`);
  }

  let verified;
  try {
    verified = verifyBundle({ bundlePath, repo, base, branch: bundleBranch, identity: IDENTITY, scratch: join(ictx.stepDir, "scratch"), step: `s${H.stepN}` });
  } catch (e) {
    if (e instanceof BundleReject) return fail("bundle_rejected", "the child's bundle failed verification and nothing was imported", `${e.code}: ${JSON.stringify(e.detail)}`, { code: e.code });
    throw e;
  }
  if (!verified.ok) return fail("bundle_rejected", "the child's bundle failed verification and nothing was imported", `${verified.code}: ${JSON.stringify(verified.detail)}`, { code: verified.code });

  const verifyBox = newBox();
  let checkout;
  try { checkout = checkoutQuarantine({ quarantine: verified.quarantine, head: verified.head, dest: join(verifyBox.dir, "work") }); } catch (e) {
    return fail("checkout_failed", "the verified tree could not be checked out for the verify run; nothing was imported", e.message);
  }
  const vr = await verifyBox.run({ ...boxOpts, cmd: "/bin/sh", args: ["-c", verifyCmd], timeoutMs: Math.min(H.timeoutSec * 1000, 15 * 60_000) });
  const verify = {
    exit_code: vr.code, signal: vr.signal ?? null, timed_out: Boolean(vr.timedOut), log_sha256: sha256(`${vr.sha256.stdout}\n${vr.sha256.stderr}`),
    stdout_tail: tail(vr.stdout), stderr_tail: tail(vr.stderr),
  };

  const imp = importBundle({ verified, repo, runId, expectOld });
  if (!imp.ok) {
    return fail(imp.code === "import_conflict" ? "import_conflict" : "import_failed", `detent/${runId} was not changed by drive: check it, then re-run`, `${imp.code}: ${imp.detail}`, { code: imp.code });
  }
  E.appendEvent(runDir, { event: "implement_imported", step: H.stepN, head: imp.head, verify_exit_code: verify.exit_code, sensitive: verified.sensitive.length });
  const stepInfo = {
    base, imported: imp.head, ref: imp.ref, bundle_sha256: verified.bundle_sha256, sensitive: verified.sensitive,
    verify: { exit_code: verify.exit_code, timed_out: verify.timed_out, log_sha256: verify.log_sha256 }, checkout: { files: checkout.files, skipped: checkout.skipped },
  };
  H.setLast({ implement: stepInfo });

  const rbase = typeof run.base_sha === "string" && OID.test(run.base_sha) ? run.base_sha : base;
  const diff = diffForRecheck({ repo, base: rbase, head: imp.head, cap: 256 * 1024 });
  const recheck = await runRecheck({ H, ictx, diff, verify, verifyCmd, head: imp.head, sensitive: verified.sensitive });
  stepInfo.recheck = { ran: recheck.ran, reason: recheck.reason ?? null };
  H.setLast({ implement: stepInfo });
  const md = recheckMarkdown({ runId, head: imp.head, verify, verifyCmd, sensitive: verified.sensitive, commits: diff.log, truncated: diff.truncated, skipped: checkout.skipped, recheck });
  writeFileSync(join(runDir, "recheck.md"), md);
  E.appendEvent(runDir, { event: "implement_rechecked", step: H.stepN, ran: recheck.ran });

  const blockers = [];
  if (verified.sensitive.length) {
    blockers.push(raise(E, runDir, {
      gate: "sensitive-paths", blocks: ["ship"], cause: "judgment",
      question: `The implement step changed ${verified.sensitive.length} sensitive path(s) in detent/${runId}. Review them in the diff before anything ships.`,
      context: verified.sensitiveDetail.map((d) => `${d.path} (${d.reasons.join(", ")})`).join("; "),
      options: ["reviewed - acceptable", "not acceptable - do not ship this change"],
    }));
  }
  blockers.push(raise(E, runDir, {
    gate: "recheck-review", blocks: ["ship"], cause: "judgment",
    question: `The implement step imported ${diff.log.length} commit(s) into detent/${runId} at ${imp.head.slice(0, 12)}; verify exited ${verify.exit_code}. Review recheck.md and the diff against the plan, then run ship yourself.`,
    options: ["reviewed - matches the plan", "drift - route back to plan or implement"],
  }));
  return {
    kind: "human", blockers,
    extra: { imported: imp.head, ref: imp.ref, verify_exit_code: verify.exit_code, recheck_ran: recheck.ran, next_step: `imported ${diff.log.length} commit(s) into ${imp.ref}: review recheck.md and the gate page, answer the decision(s), then run ship yourself (${rerun} runs the implement step again)` },
  };
}

async function runRecheck({ H, ictx, diff, verify, verifyCmd, head, sensitive }) {
  const { E, ctx } = H;
  const { runId, runDir } = ctx;
  const remaining = ctx.budget - ctx.spent;
  if (remaining < 0.05) return { ran: false, reason: "no budget left for the recheck child" };
  const root = join(ictx.stepDir, "recheck");
  const d = { inputs: join(root, "inputs"), outbox: join(root, "outbox"), tmp: join(root, "tmp") };
  for (const p of Object.values(d)) mkdirSync(p, { recursive: true, mode: 0o700 });
  const stages = join(dirname(H.engineFile), "..", "stages");
  const put = (name, data) => writeFileSync(join(d.inputs, name), data);
  put("DRIVEN-IMPLEMENT.md", readFileSync(join(stages, "implement", "DRIVEN-IMPLEMENT.md")));
  put("patch.diff", diff.patch);
  put("commits.json", JSON.stringify(diff.log, null, 2));
  put("verify.json", JSON.stringify({ command: verifyCmd, exit_code: verify.exit_code, timed_out: verify.timed_out, log_sha256: verify.log_sha256, stdout_tail: verify.stdout_tail, stderr_tail: verify.stderr_tail }, null, 2));
  put("step.json", JSON.stringify({ schema: "detent-drive-recheck-step-v1", run_id: runId, head, sensitive, patch_truncated: diff.truncated }, null, 2));
  for (const [src, name] of [["plan/plan.md", "plan.md"], ["brief.md", "brief.md"]]) {
    if (existsSync(join(runDir, src))) copyFileSync(join(runDir, src), join(d.inputs, name));
  }
  put("decisions.json", JSON.stringify(E.loadDecisions(runDir), null, 2));
  H.lockedDown(d.inputs);
  const settingsFile = join(root, "settings.json");
  writeFileSync(settingsFile, `${JSON.stringify(buildChildSettings(H.base, { inputs: d.inputs, outbox: d.outbox, apiKeyFile: null, curatorStateDir: H.curatorStateDir }), null, 2)}\n`);
  const { env } = buildChildEnv(process.env, { tmpdir: d.tmp, sandboxRoot: H.sandboxTop });
  const args = [
    "-p", "--restricted", "--tools", "Read,Glob,Grep", "--output-format", "json", "--model", H.model,
    "--permission-mode", "dontAsk", "--settings", settingsFile, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--add-dir", d.inputs, "--max-budget-usd", String(Number(remaining.toFixed(4))), "--max-turns", String(H.maxTurns.recheck || 20),
  ];
  const prompt = [
    "Stage: recheck", `Run id: ${runId}`, `Inputs directory: ${d.inputs}`, "",
    `Read ${join(d.inputs, "DRIVEN-IMPLEMENT.md")} (its Recheck step section) first, then patch.diff, plan.md and the other inputs.`,
    "Reply with the recheck as markdown text. You cannot write files.",
  ].join("\n");
  let child;
  try { child = await H.runChild(H.claudeBin, args, { cwd: d.inputs, input: prompt, timeoutMs: H.timeoutSec * 1000, env }); } catch (e) {
    return { ran: false, reason: `could not start ${H.claudeBin}: ${e.message}` };
  }
  const result = parseJsonResult(child.stdout);
  if (result && Number.isFinite(result.total_cost_usd)) H.addSpend(result.total_cost_usd, Number.isInteger(result.num_turns) ? result.num_turns : 0);
  if (child.timedOut) return { ran: false, reason: "the recheck child timed out" };
  if (child.code !== 0) return { ran: false, reason: `the recheck child exited ${child.code}` };
  if (!result || result.is_error === true || String(result.subtype || "").startsWith("error")) return { ran: false, reason: `the recheck child ended with ${result ? result.subtype : "no result"}` };
  return { ran: true, text: String(result.result ?? "").slice(0, RECHECK_TEXT_CAP) };
}
