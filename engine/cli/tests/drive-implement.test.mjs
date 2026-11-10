// drive-implement.test.mjs — `detent drive --implement` end to end against a stub claude that runs scripted
// commands through the real shim shell. The host box, probe and preflight are test doubles (see
// drive-implement-deps.mjs), so these prove orchestration, not the live sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { approvedRun, implDrive, git, readJson, writeJson } from "./drive-kit.mjs";

const ADD = "echo hello > f.txt && git add f.txt && git commit -q -m add-f";
const happy = (over = {}) => ({ impl: { commands: [{ cmd: ADD }], ...over } });
const decisions = (t) => readJson(join(t.runDir, "decisions.json"));
const gateOf = (t, g) => decisions(t).find((d) => d.gate === g);
const last = (t) => readJson(join(t.runDir, "drive-last.json"));
const boxRuns = (r, kind) => r.events.filter((e) => e.ev === "box_run" && e.kind === kind);
const implCalls = (r) => r.calls.filter((c) => c.tools === "Bash");
const branchOid = (t, name) => { const x = git(t.repo, "rev-parse", "--verify", "-q", `refs/heads/${name}`); return x.status === 0 ? x.stdout.trim() : null; };

function assertBoxesGone(r) {
  const made = r.events.filter((e) => e.ev === "box_created");
  assert.ok(made.length > 0, "boxes were created");
  for (const b of made) assert.ok(!existsSync(b.dir), `box ${b.dir} removed`);
}

// ---------------------------------------------------------------- flags and refusals

test("without --implement drive still stops at before_implement, every time, and spawns nothing", () => {
  const t = approvedRun();
  for (let i = 0; i < 2; i++) {
    const r = implDrive(t, happy(), { flags: [] });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.stopped, "before_implement");
    assert.equal(r.calls.length, 0);
  }
});

test("--implement on Linux is refused before any child is spawned", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(), { deps: { platform: "linux" } });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.reason, "implement_platform_unsupported");
  assert.match(r.json.next_step, /macOS/);
  assert.equal(r.calls.length, 0);
});

test("--implement refuses ANTHROPIC_API_KEY and says to use the OAuth login", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(), { env: { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key-0123456789" } });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.reason, "implement_api_key_refused");
  assert.match(r.json.next_step, /ANTHROPIC_API_KEY/);
  assert.match(r.json.next_step, /OAuth|claude login/);
  assert.equal(r.calls.length, 0);
});

test("--implement=value is not --implement", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(), { flags: ["--implement=yes"] });
  assert.notEqual(r.code, 0);
  assert.equal(r.calls.length, 0);
});

test("a setup command in env.json is refused as setup_unsupported", () => {
  const t = approvedRun();
  const p = join(t.runDir, "env.json");
  const env = readJson(p);
  env.commands.setup = "npm ci";
  writeJson(p, env);
  const r = implDrive(t, happy());
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "setup_unsupported");
  assert.equal(r.calls.length, 0);
});

test("--allow-ship is still refused when --implement is given", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(), { flags: ["--implement", "--allow-ship"] });
  assert.equal(r.code, 2);
  assert.match(r.json.reason + r.json.next_step, /ship/);
  assert.equal(r.calls.length, 0);
});

test("a run without a verify command stops with a verify-missing decision and spawns nothing", () => {
  const t = approvedRun({ verify: null });
  const r = implDrive(t, happy());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  const d = gateOf(t, "verify-missing");
  assert.ok(d && d.status === "pending");
  assert.equal(r.calls.length, 0);
});

test("a proposed verify in env.proposed.json is never read as the verify command", () => {
  const t = approvedRun({ verify: null });
  writeJson(join(t.runDir, "env.proposed.json"), { commands: { verify: "touch /tmp/pwned" } });
  const r = implDrive(t, happy());
  assert.ok(gateOf(t, "verify-missing"));
  assert.equal(boxRuns(r, "verify").length, 0);
  assert.equal(r.calls.length, 0);
});

test("a run created with --no-worktree is refused as no_worktree_run", () => {
  const t = approvedRun();
  const p = join(t.runDir, "run.json");
  writeJson(p, { ...readJson(p), worktree: null });
  const r = implDrive(t, happy());
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "no_worktree_run");
  assert.equal(r.calls.length, 0);
});

test("a preflight refusal stops as implement_preflight_failed with the code in drive-last, and spawns nothing", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(), { deps: { preflightRefusals: [{ code: "managed_hooks", detail: "hooks found", next_step: "remove them" }] } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "implement_preflight_failed");
  assert.match(JSON.stringify(last(t)), /managed_hooks/);
  assert.equal(r.calls.length, 0);
});

// ---------------------------------------------------------------- child env, settings, argv

test("the implement child gets the shim as its shell, a call-log write grant, a denied sentinel and no parent secrets", () => {
  const t = approvedRun();
  const secret = "s3cr3t-value-must-not-leak-0123456789";
  const r = implDrive(t, happy(), { env: { MY_DEPLOY_TOKEN: secret } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [c] = implCalls(r);
  assert.match(c.env.CLAUDE_CODE_SHELL, /\/shim\/bin\/bash$/);
  const fs = c.settings.sandbox.filesystem;
  assert.ok(fs.allowWrite.some((p) => p.endsWith("/shim/log/shell-calls.jsonl")));
  assert.ok(fs.denyWrite.some((p) => p.endsWith("/shim/log/sentinel")));
  assert.ok(!JSON.stringify(c).includes(secret), "no secret in env, argv or prompt");
  assert.ok(c.args.includes("--output-format") && c.args[c.args.indexOf("--output-format") + 1] === "stream-json");
  assert.equal(c.tools, "Bash");
});

// ---------------------------------------------------------------- fail-closed checks

const refused = (t, r, code = "sandbox_probe_failed") => {
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, code);
  assert.equal(boxRuns(r, "export").length, 0, "nothing was exported");
  assert.equal(branchOid(t, `detent/${t.runId}`), null, "nothing was imported");
  assertBoxesGone(r);
};

const LINE = (cmd, over = {}) => JSON.stringify({ ev: "call", mode: "shell", ts: 1, ok: true, tokens: { bash_ran: 1 }, names: {}, findings: [], failures: [], inconclusive: [], cmd, cmd_sha256: createHash("sha256").update(cmd).digest("hex"), ...over });

test("an extra shim log line fails closed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ appendLog: [LINE("rm -rf /")] }));
  refused(t, r);
  assert.match(JSON.stringify(last(t)), /count_mismatch/);
});

test("a missing shim log line (a Bash call that skipped the shim) fails closed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ commands: [{ cmd: ADD }, { cmd: "true", skipShim: true }] }));
  refused(t, r);
});

test("reordered shim log lines fail closed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ commands: [{ cmd: ADD }, { cmd: "true" }], reverseLog: true }));
  refused(t, r);
});

test("a -c string that does not contain the tool use's command fails closed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ commands: [{ cmd: ADD, wrap: "echo something else\n" }] }));
  refused(t, r);
});

test("a malformed shim log line fails closed", () => {
  const t = approvedRun();
  refused(t, implDrive(t, happy({ appendLog: ["{not json"] })));
});

test("dangerouslyDisableSandbox true in a tool input fails closed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ commands: [{ cmd: ADD, input: { command: ADD, dangerouslyDisableSandbox: true } }] }));
  refused(t, r);
  assert.match(JSON.stringify(last(t)), /dangerously_disable_sandbox/);
});

test("run_in_background true in a tool input fails closed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ commands: [{ cmd: ADD, input: { command: ADD, run_in_background: true } }] }));
  refused(t, r);
});

test("a non-empty sentinel fails closed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ writeSentinel: true }));
  refused(t, r);
  assert.match(JSON.stringify(last(t)), /sentinel_written/);
});

test("an unsandboxed shim writes the sentinel byte, logs nothing, and the step fails closed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ unsandboxed: true }));
  refused(t, r);
});

test("a probe the shim cannot satisfy fails closed through evaluateSelfProbe", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(), { deps: { probeWant: 2 } });
  refused(t, r);
});

test("a child that ran no Bash at all stops as no_changes and exports nothing", () => {
  const t = approvedRun();
  const r = implDrive(t, { impl: { commands: [] } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "no_changes");
  assert.equal(boxRuns(r, "export").length, 0);
  assert.equal(branchOid(t, `detent/${t.runId}`), null);
  assertBoxesGone(r);
});

test("a child that exits non-zero fails the step and imports nothing", () => {
  const t = approvedRun();
  const r = implDrive(t, happy({ exit: 3 }));
  assert.equal(r.code, 1);
  assert.equal(boxRuns(r, "export").length, 0);
  assert.equal(branchOid(t, `detent/${t.runId}`), null);
});

// ---------------------------------------------------------------- R8 order, bundle, import

test("the happy path exports, checks out, verifies, then imports, and ends in a recheck-review decision", () => {
  const t = approvedRun();
  const r = implDrive(t, happy());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");

  const kinds = r.events.filter((e) => e.ev === "box_run").map((e) => e.kind);
  assert.deepEqual(kinds, ["export", "verify"]);
  const [exp] = boxRuns(r, "export");
  const [ver] = boxRuns(r, "verify");
  assert.notEqual(exp.dir, ver.dir, "a fresh box per command");
  assert.equal(ver.net, "none");
  assert.deepEqual(ver.args, ["-c", "test -f f.txt"]);
  assert.equal(ver.refExists, false, "verify ran before the import");
});

test("verify sees the checked-out tree, then the bundle is imported into detent/<run>", () => {
  const t = approvedRun({ verify: "test \"$(cat f.txt)\" = hello" });
  const r = implDrive(t, happy());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const oid = branchOid(t, `detent/${t.runId}`);
  assert.match(oid, /^[0-9a-f]{40}$/);
  assert.equal(git(t.repo, "show", `${oid}:f.txt`).stdout, "hello\n");
  const v = last(t).implement.verify;
  assert.equal(v.exit_code, 0);
  assert.match(v.log_sha256, /^[0-9a-f]{64}$/);
  assert.equal(last(t).implement.imported, oid);
  const d = gateOf(t, "recheck-review");
  assert.ok(d && d.status === "pending");
  assert.ok(existsSync(join(t.runDir, "recheck.md")));
  assertBoxesGone(r);
});

test("a failing verify command is recorded, not hidden", () => {
  const t = approvedRun({ verify: "test -f nope.txt" });
  const r = implDrive(t, happy());
  assert.equal(last(t).implement.verify.exit_code, 1);
  assert.match(readFileSync(join(t.runDir, "recheck.md"), "utf8"), /verify/i);
});

test("a tampered bundle stops as bundle_rejected and imports nothing", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(), { deps: { tamperBundle: true } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "bundle_rejected");
  assert.equal(boxRuns(r, "verify").length, 0);
  assert.equal(branchOid(t, `detent/${t.runId}`), null);
  assertBoxesGone(r);
});

test("a ref that moved while verify ran is an import_conflict and detent/<run> is left as the other writer set it", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(), { deps: { advanceRefOnVerify: true } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "import_conflict");
  const head = git(t.repo, "rev-parse", "HEAD").stdout.trim();
  assert.equal(branchOid(t, `detent/${t.runId}`), head);
  assertBoxesGone(r);
});

// ---------------------------------------------------------------- decisions and the recheck child

test("a sensitive path raises a ship-blocking decision, and the gate page escapes the path", () => {
  const t = approvedRun();
  const cmd = "mkdir -p .github && echo x > '.github/<img src=x>.js' && echo hello > f.txt && git add -A && git commit -q -m wf";
  const r = implDrive(t, happy({ commands: [{ cmd }] }));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const d = gateOf(t, "sensitive-paths");
  assert.ok(d && d.status === "pending");
  assert.ok(d.blocks.includes("ship"));
  const html = readFileSync(r.json.html, "utf8");
  assert.ok(html.includes("&lt;img src=x&gt;"), "escaped");
  assert.ok(!html.includes("<img src=x>"), "not raw");
});

test("the recheck child is read-only: Read, Glob and Grep, in the inputs dir, with the patch as an input", () => {
  const t = approvedRun();
  const r = implDrive(t, happy());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rc = r.calls.filter((c) => c.tools !== "Bash");
  assert.equal(rc.length, 1);
  assert.equal(rc[0].tools, "Read,Glob,Grep");
  assert.ok(!rc[0].args.includes("--allowedTools") || !/Bash/.test(rc[0].args.join(" ")));
  assert.match(rc[0].cwd, /inputs$/);
  assert.ok(rc[0].files.some((f) => /patch|diff/.test(f)), `inputs: ${rc[0].files}`);
});

test("--implement is per invocation: the next plain drive stops before_implement again", () => {
  const t = approvedRun();
  implDrive(t, happy());
  const r = implDrive(t, happy(), { flags: [] });
  assert.ok(["before_implement", "needs_human"].includes(r.json.stopped), r.stdout);
  assert.equal(implCalls(r).length, 1, "only the first invocation ran the implement child");
});

test("every stop path removes the box dirs", () => {
  const t = approvedRun();
  for (const deps of [{}, { tamperBundle: true }]) {
    const r = implDrive(t, happy(), { deps });
    assertBoxesGone(r);
  }
});
