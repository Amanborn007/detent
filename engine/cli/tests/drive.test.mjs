// drive.test.mjs — `engine drive`: one headless `claude -p` child per stage.
// Stubs only: no network, no real claude, no real curator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engine, mkRun, writeArtifact, readJson, writeJson, throughResearch, eventsOf } from "./helpers.mjs";

const CURATOR_CLI = join(fileURLToPath(import.meta.url), "..", "..", "..", "curator", "cli.mjs");
// No real curator or claude may leak in from the developer's PATH.
const BARE_PATH = "/usr/bin:/bin";

function scratch() { return mkdtempSync(join(tmpdir(), "drive-test-")); }

/** A stub `claude`: logs argv/cwd/prompt/settings/env, then acts per STUB_MODE. */
function mkClaudeStub(dir) {
  const bin = join(dir, "claude-stub.mjs");
  writeFileSync(bin, `#!${process.execPath}
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
const prompt = readFileSync(0, "utf8");
const argv = process.argv.slice(2);
const si = argv.indexOf("--settings");
const settings = si >= 0 && existsSync(argv[si + 1]) ? JSON.parse(readFileSync(argv[si + 1], "utf8")) : null;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("GIT_CONFIG")));
appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: argv, cwd: process.cwd(), prompt, settings, gitEnv }) + "\\n");
const field = (k) => new RegExp("^" + k + ": (.+)$", "m").exec(prompt)[1].trim();
const stage = /engine\\/stages\\/(\\w+)\\/SKILL\\.md/.exec(prompt)[1];
const runId = field("Run id"), runDir = field("Run dir"), eng = field("Engine");
const eng_ = (...a) => spawnSync(process.execPath, [eng, ...a, "--run", runId], { encoding: "utf8" });
const ARTIFACTS = { intake: ["brief.md"], research: ["research.md", "access-report.json"], plan: ["plan/plan.md"] };
const mode = process.env.STUB_MODE;
const cost = process.env.STUB_COST === undefined ? 0.01 : Number(process.env.STUB_COST);
const done = () => {
  console.log(JSON.stringify([{ type: "system", subtype: "init" },
    { type: "result", is_error: false, result: "ok", total_cost_usd: cost, num_turns: 3 }]));
  process.exit(0);
};
const dpath = join(runDir, "decisions.json");
const decisions = () => (existsSync(dpath) ? JSON.parse(readFileSync(dpath, "utf8")) : []);
const advance = () => {
  eng_("stage", "begin", stage);
  for (const a of ARTIFACTS[stage] || []) {
    mkdirSync(dirname(join(runDir, a)), { recursive: true });
    writeFileSync(join(runDir, a), a.endsWith(".json") ? "[]" : stage === "plan" ? "# plan <b>bold</b>\\n" : "# artifact\\n");
  }
};
if (process.env.STUB_PUSH_URLS) {
  const results = [];
  for (const url of JSON.parse(process.env.STUB_PUSH_URLS)) {
    const r = spawnSync("git", ["push", url, "HEAD:refs/heads/pwned"], { encoding: "utf8" });
    results.push({ url, status: r.status, stderr: r.stderr });
  }
  writeFileSync(process.env.STUB_PUSH_OUT, JSON.stringify(results));
}
if (mode === "advance" || mode === "plan-noend") {
  advance();
  if (!(mode === "plan-noend" && stage === "plan")) eng_("stage", "end", stage);
  done();
}
if (mode === "decision") {
  eng_("stage", "begin", stage);
  writeFileSync(dpath, JSON.stringify([...decisions(), { id: "D-010", raised_by: stage, blocks: ["implement"],
    question: "Reuse or rewrite?", options: ["reuse", "rewrite"], status: "pending" }]));
  done();
}
if (mode === "tamper-answer" || mode === "tamper-skip") {
  advance();
  const ds = decisions();
  ds[0].status = mode === "tamper-answer" ? "answered" : "skipped";
  if (mode === "tamper-answer") Object.assign(ds[0], { answer: "approve", answered_by: "human" });
  writeFileSync(dpath, JSON.stringify(ds));
  done();
}
if (mode === "tamper-edit") {
  advance();
  const ds = decisions();
  ds[0].options = [...ds[0].options, "ship-it"];
  writeFileSync(dpath, JSON.stringify(ds));
  done();
}
if (mode === "tamper-remove") {
  advance();
  writeFileSync(dpath, JSON.stringify(decisions().slice(1)));
  done();
}
if (mode === "nocost") {
  advance();
  console.log(JSON.stringify({ type: "result", is_error: false, result: "ok" }));
  process.exit(0);
}
if (mode === "noop") done();
if (mode === "grandchild") {
  const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  writeFileSync(process.env.STUB_PIDFILE, String(g.pid));
  setTimeout(() => {}, 60000);
}
if (mode === "sleep") setTimeout(() => {}, 60000);
else if (mode === "exit3") { console.error("boom from stub"); process.exit(3); }
else if (mode === "is_error") { console.log(JSON.stringify({ type: "result", is_error: true, result: "model refused" })); process.exit(0); }
`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A stub `curator` on its own PATH dir: records calls, `open` prints a url, `drain` prints STUB_DRAIN. */
function mkCuratorStub(dir) {
  const bin = join(dir, "curator");
  writeFileSync(bin, `#!/bin/sh
echo "$@" >> "$CURATOR_LOG"
case "$1" in
  open) echo '{"url":"http://127.0.0.1:9/s/abc","key":"'"$2"'"}' ;;
  drain) printf '%s\\n' "$STUB_DRAIN" ;;
esac
`);
  chmodSync(bin, 0o755);
  return bin;
}

function drive(ctx, stub, mode, extra = [], env = {}) {
  const d = scratch();
  const log = join(d, "stub.log");
  const r = engine(["drive", "--run", ctx.runId, "--claude-bin", stub, ...extra], {
    env: { PATH: BARE_PATH, STUB_MODE: mode, STUB_LOG: log, ...env },
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { ...r, calls };
}

function approvePlanGate(ctx) {
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() }
    : d));
}

function toStage(ctx, target) {
  throughResearch(ctx);
  const sh = (a) => assert.equal(engine([...a, "--repo", ctx.repo, "--run", ctx.runId]).code, 0, a.join(" "));
  engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  approvePlanGate(ctx);
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  for (const s of ["implement", "recheck", "ship"]) {
    if (s === target) return;
    sh(["stage", "begin", s]);
    if (s === "recheck") writeArtifact(ctx.runDir, "recheck.md", "# recheck\n");
    sh(["stage", "end", s, ...(s === "implement" ? ["--tdd-exempt", "test fixture"] : [])]);
  }
}

const settingsOf = (call) => call.settings;
const allowOf = (call) => settingsOf(call).permissions.allow;

// ---------------------------------------------------------------------------
// Ported behaviour
// ---------------------------------------------------------------------------

test("drive advances intake -> research with a stub claude and stops at max_steps", () => {
  const ctx = mkRun();
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "advance", ["--max-steps", "2"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "max_steps");
  assert.equal(r.calls.length, 2);
  const st = readJson(join(ctx.runDir, "stage-status.json")).stages;
  assert.equal(st.intake.status, "done");
  assert.equal(st.research.status, "done");
  assert.ok(existsSync(join(ctx.runDir, "brief.md")));
  assert.ok(!existsSync(join(ctx.runDir, "drive.lock")), "lock removed on exit");
  assert.ok(eventsOf(ctx.runDir).some((e) => e.event === "drive_step"), "steps logged to events.jsonl");
  assert.match(r.calls[0].prompt, /engine\/stages\/intake\/SKILL\.md/);
  assert.match(r.calls[0].prompt, /Never push or open PRs/);
});

test("drive stops needs_human at the plan intent gate; html passes curator check", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "advance");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  const gate = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.gate === "intent");
  assert.deepEqual(r.json.decisions, [gate.id]);
  assert.match(r.json.html, new RegExp(`${ctx.runId}-intent\\.html$`), "gate page is named by gate");
  const html = readFileSync(r.json.html, "utf8");
  assert.ok(html.includes(`data-plan-question="${gate.id}"`));
  assert.ok(html.includes('data-plan-option="approve"') && html.includes('data-plan-option="revise"'));
  assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"), "plan.md is escaped, preformatted text");
  assert.ok(html.includes("prefers-color-scheme"));
  const chk = spawnSync(process.execPath, [CURATOR_CLI, "check", r.json.html], { encoding: "utf8" });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  assert.match(r.json.next_step, /engine drive --run/);
});

test("drive raises the plan intent gate itself when the child leaves plan.md unended", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "plan-noend");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  const gate = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.gate === "intent");
  assert.ok(gate && gate.status === "pending");
  assert.equal(readJson(join(ctx.runDir, "stage-status.json")).stages.plan.status, "blocked");
  assert.equal(eventsOf(ctx.runDir).filter((e) => e.event === "gate_raised").length, 1);
});

test("drive runs `curator open` when curator is on PATH and reports the url", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  const stub = mkClaudeStub(scratch());
  const cdir = scratch();
  mkCuratorStub(cdir);
  const clog = join(cdir, "curator.log");
  const r = drive(ctx, stub, "advance", [], {
    PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: clog, STUB_DRAIN: '{"status":"idle","sessions":0,"drained":0}',
  });
  assert.equal(r.json.stopped, "needs_human", r.stdout);
  assert.equal(r.json.url, "http://127.0.0.1:9/s/abc");
  assert.match(readFileSync(clog, "utf8"), new RegExp(`open ${r.json.html.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
});

function atPlanGate() {
  const ctx = mkRun();
  throughResearch(ctx);
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "advance");
  assert.equal(r.json.stopped, "needs_human");
  const gate = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.gate === "intent");
  return { ctx, stub, gate, html: r.json.html };
}

test("drive resumes after an answer collected from curator", () => {
  const { ctx, stub, gate, html } = atPlanGate();
  const cdir = scratch();
  mkCuratorStub(cdir);
  const drain = JSON.stringify({ key: realpathSync(html), status: "feedback",
    prompts: [{ type: "decision", question: gate.id, answer: "approve" }] });
  const r = drive(ctx, stub, "advance", ["--max-steps", "1"], {
    PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: join(cdir, "log"), STUB_DRAIN: drain,
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(readJson(join(ctx.runDir, "stage-status.json")).stages.plan.status, "done");
});

test("a child that files a pending decision counts as progress; next turn stops needs_human", () => {
  const ctx = mkRun();
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "decision");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  assert.deepEqual(r.json.decisions, ["D-010"]);
  assert.equal(r.calls.length, 1);
  assert.ok(readFileSync(r.json.html, "utf8").includes('data-plan-question="D-010"'));
});

test("a child that changes nothing fails no_progress", () => {
  const ctx = mkRun();
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "noop");
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.reason, "no_progress");
  assert.equal(r.json.stage, "intake");
});

test("a child that outlives --child-timeout-sec is killed and drive fails loudly", () => {
  const ctx = mkRun();
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "sleep", ["--child-timeout-sec", "1"]);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.reason, "child_timeout");
  assert.ok(!existsSync(join(ctx.runDir, "drive.lock")));
});

test("a timed-out child's descendants die with it (process-group kill)", async () => {
  const ctx = mkRun();
  const stub = mkClaudeStub(scratch());
  const pidFile = join(scratch(), "grandchild.pid");
  const r = drive(ctx, stub, "grandchild", ["--child-timeout-sec", "1"], { STUB_PIDFILE: pidFile });
  assert.equal(r.json.reason, "child_timeout", r.stdout);
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  for (let i = 0; i < 30 && alive(); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(!alive(), `grandchild ${pid} survived the kill`);
});

test("a non-zero child exit fails with the stderr tail", () => {
  const ctx = mkRun();
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "exit3");
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.reason, "child_failed");
  assert.match(r.json.stderr_tail, /boom from stub/);
});

test("a child JSON result with is_error fails loudly", () => {
  const ctx = mkRun();
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "is_error");
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.reason, "child_error");
  assert.match(r.json.detail, /model refused/);
});

test("drive stops before ship without --allow-ship, and runs it with the flag", () => {
  const ctx = mkRun();
  toStage(ctx, "ship");
  const stub = mkClaudeStub(scratch());
  let r = drive(ctx, stub, "advance");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "before_ship");
  assert.equal(r.calls.length, 0);
  r = drive(ctx, stub, "advance", ["--allow-ship", "--max-steps", "1"]);
  assert.equal(r.calls.length, 1);
  assert.equal(readJson(join(ctx.runDir, "stage-status.json")).stages.ship.status, "done");
  assert.ok(r.calls[0].args.includes("Bash(git push*)"), "push stays denied with --allow-ship");
});

test("drive refuses while another live pid holds drive.lock", () => {
  const ctx = mkRun();
  writeFileSync(join(ctx.runDir, "drive.lock"), String(process.pid));
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "advance");
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.reason, /drive\.lock/);
  assert.equal(r.calls.length, 0);
  assert.ok(existsSync(join(ctx.runDir, "drive.lock")), "a refused drive must not delete the holder's lock");
});

test("drive replaces a stale lock from a dead pid", () => {
  const ctx = mkRun();
  writeFileSync(join(ctx.runDir, "drive.lock"), "2147483646");
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "advance", ["--max-steps", "1"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(join(ctx.runDir, "drive.lock")));
});

test("drive on a complete run reports done", () => {
  const ctx = mkRun();
  const p = join(ctx.runDir, "stage-status.json");
  const s = readJson(p);
  for (const k of Object.keys(s.stages)) s.stages[k] = { status: "done" };
  writeJson(p, s);
  const r = drive(ctx, mkClaudeStub(scratch()), "advance");
  assert.equal(r.code, 0);
  assert.equal(r.json.done, true);
});

test("drive refuses a bad --max-steps", () => {
  const ctx = mkRun();
  const r = drive(ctx, mkClaudeStub(scratch()), "advance", ["--max-steps", "0"]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /--max-steps must be a positive integer/);
});

// ---------------------------------------------------------------------------
// Hardening 1: scoped permission profile instead of a blanket Bash grant
// ---------------------------------------------------------------------------

test("children get --settings with a scoped allow list; never a blanket Bash or --allowedTools", () => {
  const ctx = mkRun();
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "advance", ["--max-steps", "1"]);
  assert.equal(r.calls.length, 1, r.stdout + r.stderr);
  const { args } = r.calls[0];
  for (const f of ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--setting-sources", "project", "--settings"]) {
    assert.ok(args.includes(f), "missing " + f);
  }
  assert.ok(!args.includes("--allowedTools") && !args.includes("--allowed-tools"), "no CLI allow list");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  const allow = allowOf(r.calls[0]);
  for (const t of ["Read", "Edit", "Write", "Glob", "Grep"]) assert.ok(allow.includes(t), "missing " + t);
  assert.ok(!allow.includes("Bash") && !allow.includes("Bash(*)"), "no blanket Bash");
  assert.ok(allow.every((a) => !/bypass|dangerously/i.test(a)));
  const eng = /^Engine: (.+)$/m.exec(r.calls[0].prompt)[1].trim();
  assert.ok(allow.includes(`Bash(node ${eng} *)`), "engine prefix is allowed by absolute path");
  for (const g of ["git status", "git diff", "git log", "git show"]) {
    assert.ok(allow.some((a) => a.startsWith(`Bash(${g}`)), "missing " + g);
  }
  assert.ok(!allow.some((a) => /git (add|commit|push)/.test(a)), "early stages may not add or commit");
  assert.notEqual(settingsOf(r.calls[0]).permissions.defaultMode ?? "dontAsk", "bypassPermissions");
  assert.ok(args.includes("--add-dir") && args[args.indexOf("--add-dir") + 1] === ctx.runDir, "child may write the run dir");
});

test("the implement child additionally gets git add and git commit, never push; cwd is the run worktree", () => {
  const ctx = mkRun();
  toStage(ctx, "implement");
  const stub = mkClaudeStub(scratch());
  const r = drive(ctx, stub, "advance", ["--max-steps", "1"]);
  assert.equal(r.calls.length, 1, r.stdout + r.stderr);
  const { args, cwd } = r.calls[0];
  const allow = allowOf(r.calls[0]);
  assert.ok(allow.some((a) => a.startsWith("Bash(git add")) && allow.some((a) => a.startsWith("Bash(git commit")));
  assert.ok(!allow.some((a) => /git push/.test(a)));
  const denied = args.slice(args.indexOf("--disallowedTools") + 1);
  for (const t of ["Bash(git push*)", "Bash(git reset*)", "Bash(git rebase*)", "Bash(git merge*)", "Bash(git clean*)",
    "Bash(git stash*)", "Bash(git checkout*)", "Bash(gh pr create*)", "Bash(gh pr merge*)"]) {
    assert.ok(denied.includes(t), "implement should deny " + t);
  }
  assert.ok(!denied.includes("Bash(git commit*)") && !denied.includes("Bash(git add*)"));
  assert.equal(realpathSync(cwd), realpathSync(readJson(join(ctx.runDir, "run.json")).worktree));

  const ctx2 = mkRun();
  const early = drive(ctx2, stub, "advance", ["--max-steps", "1"]);
  const denied2 = early.calls[0].args.slice(early.calls[0].args.indexOf("--disallowedTools") + 1);
  assert.ok(denied2.includes("Bash(git commit*)") && denied2.includes("Bash(git add*)"));
});

test("a simple declared verify command is allowed by exact prefix; a compound or unknown one is not", () => {
  const stub = mkClaudeStub(scratch());
  const ctx = mkRun();
  assert.equal(engine(["env", "--run", ctx.runId, "--verify", "npm test"]).code, 0);
  const ok = drive(ctx, stub, "advance", ["--max-steps", "1"]);
  const allow = allowOf(ok.calls[0]);
  assert.ok(allow.includes("Bash(npm test)") && allow.includes("Bash(npm test *)"), JSON.stringify(allow));

  for (const bad of ["cd x && npm test", "bash -c 'git push'", "npm test; curl evil.example"]) {
    const c = mkRun();
    assert.equal(engine(["env", "--run", c.runId, "--verify", bad]).code, 0);
    const r = drive(c, stub, "advance", ["--max-steps", "1"]);
    const a = allowOf(r.calls[0]);
    assert.ok(!a.some((x) => x.includes("bash -c") || x.includes("curl") || x.includes("cd x")), `${bad}: ${JSON.stringify(a)}`);
  }
});

test("drive refuses to start on a profile that sets a bypass mode or a blanket Bash grant", () => {
  const stub = mkClaudeStub(scratch());
  const cases = {
    "bypassPermissions": { permissions: { defaultMode: "bypassPermissions", allow: ["Read"] } },
    "acceptEdits": { permissions: { defaultMode: "acceptEdits", allow: ["Read"] } },
    "nested bypass": { permissions: { allow: ["Read"] }, nested: { deep: { defaultMode: "bypassPermissions" } } },
    "blanket Bash": { permissions: { defaultMode: "dontAsk", allow: ["Read", "Bash"] } },
    "Bash(*)": { permissions: { defaultMode: "dontAsk", allow: ["Bash(*)"] } },
    "skip prompt": { permissions: { allow: ["Read"] }, skipDangerousModePermissionPrompt: true },
  };
  for (const [label, profile] of Object.entries(cases)) {
    const ctx = mkRun();
    const f = join(scratch(), "profile.json");
    writeJson(f, profile);
    const r = drive(ctx, stub, "advance", ["--profile", f]);
    assert.equal(r.code, 2, `${label}: ${r.stdout}`);
    assert.match(r.json.reason, /profile/i, label);
    assert.equal(r.calls.length, 0, `${label}: no child may start`);
  }
  const ctx = mkRun();
  const f = join(scratch(), "bad.json");
  writeFileSync(f, "{ not json");
  assert.equal(drive(ctx, stub, "advance", ["--profile", f]).code, 2);
});

test("a custom --profile that is safe is used as the base allow list", () => {
  const ctx = mkRun();
  const f = join(scratch(), "ok.json");
  writeJson(f, { permissions: { allow: ["Read", "Grep"], deny: [] } });
  const r = drive(ctx, mkClaudeStub(scratch()), "advance", ["--profile", f, "--max-steps", "1"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const allow = allowOf(r.calls[0]);
  assert.ok(allow.includes("Grep") && !allow.includes("Write"), JSON.stringify(allow));
});

// ---------------------------------------------------------------------------
// Hardening 2: push is blocked by env, whatever the command spelling
// ---------------------------------------------------------------------------

test("children carry GIT_CONFIG_* pushInsteadOf for every transport", () => {
  const ctx = mkRun();
  const r = drive(ctx, mkClaudeStub(scratch()), "advance", ["--max-steps", "1"]);
  const env = r.calls[0].gitEnv;
  const n = Number(env.GIT_CONFIG_COUNT);
  assert.ok(n >= 3);
  const pairs = [];
  for (let i = 0; i < n; i++) pairs.push([env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  for (const prefix of ["https://", "git@", "ssh://", "file://"]) {
    assert.ok(pairs.some(([k, v]) => k === "url.no-push://.pushInsteadOf" && v === prefix), "missing " + prefix);
  }
});

test("a child's git push fails over every transport, including a local bare remote", () => {
  const ctx = mkRun();
  const root = scratch();
  const bare = join(root, "remote.git");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", bare]).status, 0);
  const worktree = readJson(join(ctx.runDir, "run.json")).worktree;
  // Control: without the env a push to the same bare repo succeeds, so the failure below is the env's doing.
  const control = spawnSync("git", ["-C", worktree, "push", bare, "HEAD:refs/heads/control"], { encoding: "utf8" });
  assert.equal(control.status, 0, control.stderr);
  const urls = [bare, `file://${bare}`, "https://example.invalid/a.git", "git@example.invalid:a.git", "ssh://example.invalid/a.git"];
  const out = join(root, "push.json");
  const r = drive(ctx, mkClaudeStub(scratch()), "advance", ["--max-steps", "1"],
    { STUB_PUSH_URLS: JSON.stringify(urls), STUB_PUSH_OUT: out });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const results = readJson(out);
  assert.equal(results.length, urls.length);
  for (const x of results) {
    assert.notEqual(x.status, 0, `push to ${x.url} must fail`);
    assert.match(x.stderr, /no-push/, `${x.url}: ${x.stderr}`);
  }
  const refs = spawnSync("git", ["-C", bare, "show-ref"], { encoding: "utf8" }).stdout;
  assert.ok(!refs.includes("pwned"), refs);
});

// ---------------------------------------------------------------------------
// Hardening 3: a child may only append new pending decisions
// ---------------------------------------------------------------------------

function seedDecision(ctx, extra = {}) {
  writeJson(join(ctx.runDir, "decisions.json"), [{
    id: "D-001", raised_by: "engine", blocks: ["implement"], question: "Proceed?",
    options: ["approve", "revise"], status: "pending", ...extra,
  }]);
}

test("a child that answers a pending decision stops drive with child_answered_decision", () => {
  for (const mode of ["tamper-answer", "tamper-skip"]) {
    const ctx = mkRun();
    seedDecision(ctx);
    const r = drive(ctx, mkClaudeStub(scratch()), mode);
    assert.equal(r.code, 1, `${mode}: ${r.stdout}`);
    assert.equal(r.json.stopped, "child_answered_decision", mode);
    assert.equal(r.json.ok, false);
    assert.match(r.json.detail, /D-001/);
    assert.equal(r.calls.length, 1);
  }
});

test("a child that edits a gate decision, or deletes a decision, is also caught", () => {
  for (const mode of ["tamper-edit", "tamper-remove"]) {
    const ctx = mkRun();
    seedDecision(ctx, { gate: "intent" });
    const r = drive(ctx, mkClaudeStub(scratch()), mode);
    assert.equal(r.code, 1, `${mode}: ${r.stdout}`);
    assert.equal(r.json.stopped, "child_answered_decision", mode);
    assert.ok(eventsOf(ctx.runDir).some((e) => e.event === "drive_stopped" && e.reason === "child_answered_decision"), mode);
  }
});

test("a child may append a new pending decision beside an existing one", () => {
  const ctx = mkRun();
  seedDecision(ctx);
  const r = drive(ctx, mkClaudeStub(scratch()), "decision");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  assert.deepEqual(readJson(join(ctx.runDir, "decisions.json")).map((d) => d.id), ["D-001", "D-010"]);
});

// ---------------------------------------------------------------------------
// Hardening 4: cost accounting, --model, --budget
// ---------------------------------------------------------------------------

test("each child's total_cost_usd and num_turns land in events.jsonl and the summary", () => {
  const ctx = mkRun();
  const r = drive(ctx, mkClaudeStub(scratch()), "advance", ["--max-steps", "2"], { STUB_COST: "0.25" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "max_steps");
  assert.equal(r.json.total_cost_usd, 0.5);
  assert.equal(r.json.total_turns, 6);
  const done = eventsOf(ctx.runDir).filter((e) => e.event === "drive_child_done");
  assert.equal(done.length, 2);
  assert.deepEqual(done.map((e) => [e.step, e.stage, e.total_cost_usd, e.num_turns]),
    [[1, "intake", 0.25, 3], [2, "research", 0.25, 3]]);
});

test("a result without total_cost_usd fails loudly instead of defaulting to zero", () => {
  const ctx = mkRun();
  const r = drive(ctx, mkClaudeStub(scratch()), "nocost");
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.reason, "child_no_cost");
});

test("drive stops with `budget` once cumulative cost reaches --budget", () => {
  const ctx = mkRun();
  const r = drive(ctx, mkClaudeStub(scratch()), "advance", ["--budget", "3", "--max-steps", "6"], { STUB_COST: "2" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "budget");
  assert.equal(r.calls.length, 2, "step 1 costs 2 < 3, step 2 reaches 4 >= 3");
  assert.equal(r.json.total_cost_usd, 4);
  assert.equal(r.json.budget_usd, 3);
  assert.ok(eventsOf(ctx.runDir).some((e) => e.event === "drive_stopped" && e.reason === "budget"));
  assert.ok(!existsSync(join(ctx.runDir, "drive.lock")));
});

test("the default budget is 5 USD", () => {
  const ctx = mkRun();
  const r = drive(ctx, mkClaudeStub(scratch()), "advance", ["--max-steps", "6"], { STUB_COST: "3" });
  assert.equal(r.json.stopped, "budget", r.stdout);
  assert.equal(r.json.budget_usd, 5);
  assert.equal(r.calls.length, 2);
});

test("drive refuses a bad --budget", () => {
  for (const bad of ["0", "-1", "abc"]) {
    const ctx = mkRun();
    const r = drive(ctx, mkClaudeStub(scratch()), "advance", ["--budget", bad]);
    assert.equal(r.code, 2, bad);
    assert.match(r.json.reason, /--budget must be a positive number/, bad);
    assert.equal(r.calls.length, 0);
  }
});

test("--model defaults to a pinned Sonnet id and can be overridden", () => {
  const stub = mkClaudeStub(scratch());
  const a = drive(mkRun(), stub, "advance", ["--max-steps", "1"]);
  const def = a.calls[0].args[a.calls[0].args.indexOf("--model") + 1];
  assert.match(def, /^claude-sonnet-[\w-]+$/, "a pinned id, not an alias");
  const b = drive(mkRun(), stub, "advance", ["--max-steps", "1", "--model", "claude-opus-5-5"]);
  assert.equal(b.calls[0].args[b.calls[0].args.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(drive(mkRun(), stub, "advance", ["--model"]).code, 2);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("engine help documents drive, without the unported readiness survey command", () => {
  const r = engine(["help"]);
  assert.ok("drive" in r.json.usage);
  const text = r.json.usage.drive;
  for (const w of ["--budget", "--model", "--allow-ship", "--max-steps", "experimental"]) assert.ok(text.includes(w), "help lacks " + w);
  assert.ok(!("ready" in r.json.usage));
});
