// drive-implement-shim.test.mjs — the S1/S3 edits that `drive --implement` needs: the shim shell is the
// child's CLAUDE_CODE_SHELL, its call log is the one extra writable file, the sentinel is denied for
// writes, an unsandboxed shim leaves a mark, and every logged call carries the command it received.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const prof = () => import("../drive/implement-profile.mjs");
const probe = () => import("../drive/selfprobe.mjs");
const { createClaudeTmp, removeClaudeTmp } = await prof();
const madeTmps = [];
after(() => { for (const d of madeTmps) removeClaudeTmp(d); });

function mkCtx(over = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "impl-shim-home-")));
  const node = join(home, ".nvm/versions/node/v20.1.0");
  mkdirSync(join(node, "bin"), { recursive: true });
  mkdirSync(join(node, "lib"), { recursive: true });
  const sroot = join(home, "S");
  const step = join(sroot, "1");
  const claudeTmp = createClaudeTmp();
  madeTmps.push(claudeTmp);
  return {
    home, sroot,
    clone: join(step, "clone"), inputs: join(step, "inputs"), outbox: join(step, "outbox"), tmp: join(step, "tmp"),
    shimDir: join(step, "shim"), callLog: join(step, "shim", "log", "shell-calls.jsonl"), sentinel: join(step, "shim", "log", "sentinel"),
    shell: join(step, "shim", "bin", "bash"),
    claudeTmp, settingsPath: join(step, "settings.json"), platform: "darwin",
    path: [join(node, "bin"), "/usr/bin", "/bin"], model: "claude-sonnet-5-5", maxBudgetUsd: 2.5, maxTurns: 40,
    ...over,
  };
}

test("CLAUDE_CODE_SHELL is the shim shell when ctx.shell is given", async () => {
  const { buildImplementEnv } = await prof();
  const ctx = mkCtx();
  assert.equal(buildImplementEnv({ PATH: "/usr/bin", USER: "u" }, ctx).CLAUDE_CODE_SHELL, ctx.shell);
});

test("a relative ctx.shell is refused", async () => {
  const { buildImplementEnv } = await prof();
  assert.throws(() => buildImplementEnv({ PATH: "/usr/bin", USER: "u" }, mkCtx({ shell: "bash" })), /shell/);
});

test("allowWrite is exactly clone, outbox, tmp and the call log when ctx.callLog is given", async () => {
  const { buildImplementSettings, validateImplementSettings } = await prof();
  const ctx = mkCtx();
  const s = buildImplementSettings(ctx);
  assert.deepEqual([...s.sandbox.filesystem.allowWrite].sort(), [ctx.clone, ctx.outbox, ctx.tmp, ctx.callLog].sort());
  validateImplementSettings(s, ctx);
});

test("the validator refuses any allowWrite entry beyond the four, and a missing call log", async () => {
  const { buildImplementSettings, validateImplementSettings } = await prof();
  const ctx = mkCtx();
  const mut = (f) => { const s = structuredClone(buildImplementSettings(ctx)); f(s); return s; };
  const bad = {
    extra_dir: (s) => s.sandbox.filesystem.allowWrite.push(join(ctx.sroot, "other")),
    sentinel: (s) => s.sandbox.filesystem.allowWrite.push(ctx.sentinel),
    log_dir: (s) => s.sandbox.filesystem.allowWrite.push(join(ctx.shimDir, "log")),
    swapped_log: (s) => { s.sandbox.filesystem.allowWrite = s.sandbox.filesystem.allowWrite.map((p) => (p === ctx.callLog ? join(ctx.shimDir, "log", "other.jsonl") : p)); },
    dropped_log: (s) => { s.sandbox.filesystem.allowWrite = s.sandbox.filesystem.allowWrite.filter((p) => p !== ctx.callLog); },
  };
  for (const [name, f] of Object.entries(bad)) assert.throws(() => validateImplementSettings(mut(f), ctx), Error, name);
});

test("without ctx.callLog allowWrite stays the three dirs, so the old contract holds", async () => {
  const { buildImplementSettings, validateImplementSettings } = await prof();
  const ctx = mkCtx({ callLog: undefined, sentinel: undefined, shimDir: undefined, shell: undefined });
  const s = buildImplementSettings(ctx);
  assert.deepEqual([...s.sandbox.filesystem.allowWrite].sort(), [ctx.clone, ctx.outbox, ctx.tmp].sort());
  validateImplementSettings(s, ctx);
  s.sandbox.filesystem.allowWrite.push("/x/y");
  assert.throws(() => validateImplementSettings(s, ctx), Error);
});

test("the sentinel is denied for writes, with its twin, and the validator refuses settings that do not deny it", async () => {
  const { buildImplementSettings, validateImplementSettings } = await prof();
  const ctx = mkCtx();
  const s = buildImplementSettings(ctx);
  const dw = s.sandbox.filesystem.denyWrite;
  assert.ok(dw.includes(ctx.sentinel));
  assert.ok(dw.includes(`/System/Volumes/Data${ctx.sentinel}`));
  for (const drop of [ctx.sentinel, `/System/Volumes/Data${ctx.sentinel}`]) {
    const t = structuredClone(s);
    t.sandbox.filesystem.denyWrite = dw.filter((p) => p !== drop);
    assert.throws(() => validateImplementSettings(t, ctx), /sentinel|twin/i, drop);
  }
});

test("the shim dir is readable by the child, and the validator still refuses a read-all of the step root", async () => {
  const { buildImplementSettings, validateImplementSettings } = await prof();
  const ctx = mkCtx();
  const s = buildImplementSettings(ctx);
  assert.ok(s.sandbox.filesystem.allowRead.includes(ctx.shimDir));
  const t = structuredClone(s);
  t.sandbox.filesystem.allowRead.push(ctx.sroot);
  assert.throws(() => validateImplementSettings(t, ctx), Error);
});

// ---------------------------------------------------------------- shell.cjs

function shimShell({ sandboxed }) {
  return probe().then((m) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "impl-shim-")));
    const inst = m.installShim(join(root, "shim"), {
      validate: { readDeny: [], writeAllow: [], writeDenyRequired: [] },
      probe: { script: "echo bash_ran=1", expect: { bash_ran: { k: "eq", v: 1 } }, controls: {} },
      shell: { realShell: "/bin/sh", canaryPort: 1, canarySocket: "/tmp/none.sock" },
    });
    if (sandboxed) chmodSync(inst.sentinelPath, 0o400);
    return { m, root, inst, run: (cmd) => spawnSync(inst.shellPath, ["-c", cmd], { encoding: "utf8" }) };
  });
}

test("a shim shell that can write its sentinel is unsandboxed: it leaves one byte there and logs nothing", async () => {
  const { m, inst, run } = await shimShell({ sandboxed: false });
  const r = run("echo plain");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "plain");
  assert.equal(statSync(inst.sentinelPath).size, 1);
  assert.equal(readFileSync(inst.callLogPath, "utf8"), "");
  assert.equal(m.readShimReport(inst.dir, { mode: "shell" }).calls, 0);
  run("echo again");
  assert.equal(statSync(inst.sentinelPath).size, 2);
});

test("a sandboxed shim leaves the sentinel empty", async () => {
  const { inst, run } = await shimShell({ sandboxed: true });
  assert.equal(run("true").status, 0);
  assert.equal(statSync(inst.sentinelPath).size, 0);
});

test("a sandboxed call logs the -c string it received and its sha256", async () => {
  const { inst, run } = await shimShell({ sandboxed: true });
  const cmd = "export TMPDIR=/x\ncat <<'EOF'\nline 1\nEOF\n";
  assert.equal(run(cmd).status, 0);
  const lines = readFileSync(inst.callLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].mode, "shell");
  assert.equal(lines[0].ev, "call");
  assert.equal(lines[0].cmd, cmd);
  assert.equal(lines[0].cmd_sha256, createHash("sha256").update(cmd).digest("hex"));
});

test("a refused call is logged with its command too", async () => {
  const m = await probe();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "impl-shim-")));
  const inst = m.installShim(join(root, "shim"), {
    validate: { readDeny: [], writeAllow: [], writeDenyRequired: [] },
    probe: { script: "echo bash_ran=1", expect: { bash_ran: { k: "eq", v: 2 } }, controls: {} },
    shell: { realShell: "/bin/sh", canaryPort: 1, canarySocket: "/tmp/none.sock" },
  });
  chmodSync(inst.sentinelPath, 0o400);
  const r = spawnSync(inst.shellPath, ["-c", "echo nope"], { encoding: "utf8" });
  assert.equal(r.status, 97);
  const line = JSON.parse(readFileSync(inst.callLogPath, "utf8").trim());
  assert.equal(line.ok, false);
  assert.equal(line.cmd, "echo nope");
});

test("a shim shell run without -c refuses instead of guessing a command", async () => {
  const { inst } = await shimShell({ sandboxed: true });
  const r = spawnSync(inst.shellPath, ["echo", "hi"], { encoding: "utf8" });
  assert.equal(r.status, 97);
  assert.match(r.stderr, /DETENT_SELFPROBE_REFUSED/);
});
