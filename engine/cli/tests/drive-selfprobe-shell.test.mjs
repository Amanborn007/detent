// Unit tests for the shell-shim gate: Claude Code runs `<shell> -c <cmd>` inside sandbox-exec and
// takes the shell from CLAUDE_CODE_SHELL, so a shim shell sees every sandboxed command from inside.
// "Sandboxed" is simulated by making the shim's sentinel file unwritable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const load = () => import("../drive/selfprobe.mjs");
const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "selfprobe-shell-")));
const VALIDATE = { readDeny: [], writeAllow: [], writeDenyRequired: [] };

function setup(m, { probe, canaryPort = 4321, canarySocket = "/tmp/none.sock", sandboxed = true } = {}) {
  const root = tmp();
  const dir = join(root, "shim");
  const inst = m.installShim(dir, {
    validate: VALIDATE,
    probe: probe ?? { script: "echo bash_ran=1", expect: { bash_ran: { k: "eq", v: 1 } }, controls: {} },
    shell: { realShell: "/bin/sh", canaryPort, canarySocket },
  });
  if (sandboxed) chmodSync(inst.sentinelPath, 0o400);
  return { root, dir, inst };
}

const run = (ctx, cmd, input) => spawnSync(ctx.inst.shellPath, ["-c", cmd], { encoding: "utf8", input });

test("installShim also installs a read-only shim shell named bash, with a call log and a sentinel", async () => {
  const m = await load();
  const ctx = setup(m);
  assert.match(ctx.inst.shellPath, /\/bash$/);
  assert.equal(statSync(ctx.inst.shellPath).mode & 0o222, 0);
  assert.ok(readFileSync(ctx.inst.shellPath, "utf8").startsWith(`#!${process.execPath}`));
  assert.ok(existsSync(ctx.inst.callLogPath));
  assert.ok(existsSync(ctx.inst.sentinelPath));
  assert.notEqual(ctx.inst.callLogPath, ctx.inst.sentinelPath);
  m.uninstallShim(ctx.dir);
});

test("the shell shim never reads configuration from the environment", async () => {
  const src = readFileSync(join(HERE, "..", "drive", "sandbox-shim", "shell.cjs"), "utf8");
  assert.ok(!/process\.env/.test(src));
});

test("a shell that can write the sentinel is not sandboxed: it passes through and is not counted", async () => {
  const m = await load();
  const ctx = setup(m, { sandboxed: false });
  const r = run(ctx, "echo plain; exit 2");
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "plain");
  assert.equal(m.readShimReport(ctx.dir, { mode: "shell" }).calls, 0);
  m.uninstallShim(ctx.dir);
});

test("a sandboxed call runs the probe, logs it, then runs the real command with its exit status", async () => {
  const m = await load();
  const ctx = setup(m);
  const r = run(ctx, "echo real; exit 4");
  assert.equal(r.status, 4);
  assert.equal(r.stdout.trim(), "real");
  const rep = m.readShimReport(ctx.dir, { mode: "shell" });
  assert.equal(rep.captured, true);
  assert.equal(rep.calls, 1);
  assert.equal(rep.refused, 0);
  assert.deepEqual(rep.tokens, { bash_ran: 1 });
  m.uninstallShim(ctx.dir);
});

test("stdin reaches the real command", async () => {
  const m = await load();
  const ctx = setup(m);
  assert.equal(run(ctx, "cat", "piped\n").stdout, "piped\n");
  m.uninstallShim(ctx.dir);
});

test("a failing probe refuses with the marker, does not run the command and is logged", async () => {
  const m = await load();
  const victim = tmp();
  const ctx = setup(m, { probe: { script: `ls -- ${victim} >/dev/null 2>&1; echo read_deny_0=$?`, expect: { read_deny_0: { k: "rcNot0" } }, controls: {} } });
  const r = run(ctx, `touch ${join(victim, "ran")}`);
  assert.equal(r.status, 97);
  assert.match(r.stderr, /DETENT_SELFPROBE_REFUSED.*read_deny_0/s);
  assert.equal(existsSync(join(victim, "ran")), false);
  const rep = m.readShimReport(ctx.dir, { mode: "shell" });
  assert.equal(rep.refused, 1);
  assert.ok(rep.callFailures.some((f) => /read_deny_0/.test(f)));
  const ev = m.evaluateSelfProbe({ ...rep, toolUses: 1, platform: "darwin" });
  assert.equal(ev.ok, false);
  m.uninstallShim(ctx.dir);
});

test("the probe runs on every sandboxed call and gets the canary port and socket as arguments", async () => {
  const m = await load();
  const witness = join(tmp(), "w");
  const ctx = setup(m, { canaryPort: 4321, canarySocket: "/tmp/c.sock", probe: { script: `echo x >> ${witness}; echo canary_port=$1; [ "$2" = /tmp/c.sock ]; echo sock_ok=$?`, expect: { canary_port: { k: "eq", v: 4321 }, sock_ok: { k: "rc0" } }, controls: {} } });
  assert.equal(run(ctx, "true").status, 0);
  assert.equal(run(ctx, "true").status, 0);
  assert.equal(readFileSync(witness, "utf8").trim().split("\n").length, 2);
  assert.equal(m.readShimReport(ctx.dir, { mode: "shell" }).calls, 2);
  m.uninstallShim(ctx.dir);
});

test("a sandboxed shim that cannot append to its call log refuses loudly", async () => {
  const m = await load();
  const ctx = setup(m);
  chmodSync(ctx.inst.callLogPath, 0o400);
  const r = run(ctx, "echo should-not-run");
  assert.equal(r.status, 97);
  assert.match(r.stderr, /DETENT_SELFPROBE_REFUSED.*call log/s);
  assert.ok(!r.stdout.includes("should-not-run"));
  m.uninstallShim(ctx.dir);
});

test("a call count that differs from the Bash tool_use count discards the step in shell mode too", async () => {
  const m = await load();
  const ctx = setup(m);
  run(ctx, "true");
  const rep = m.readShimReport(ctx.dir, { mode: "shell" });
  const ev = m.evaluateSelfProbe({ ...rep, toolUses: 2, platform: "darwin" });
  assert.equal(ev.discard, true);
  assert.equal(m.evaluateSelfProbe({ ...rep, toolUses: 1, platform: "darwin" }).ok, true);
  m.uninstallShim(ctx.dir);
});

test("the probe's git commit check writes only objects, so concurrent commands cannot race it", async () => {
  const m = await load();
  const { script } = m.buildSelfProbe({ platform: "darwin", clone: "/work/clone", drivePid: 1, denyTargets: [], canaries: [], writeAllowed: [], writeDenied: [], toolchain: [] });
  assert.ok(script.includes("git commit-tree"));
  assert.ok(!script.includes("reset --soft"));
});
