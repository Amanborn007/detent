// drive-implement-cshape.test.mjs — the -c strings real claude 2.1.x hands the shim shell, measured with a
// logging CLAUDE_CODE_SHELL (fixture: drive-implement-cshape.fixture.json). Two setup calls precede the
// first tool call, and every Bash tool use arrives as `... && eval '<command, single-quoted>' ...`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const FX = JSON.parse(readFileSync(new URL("./drive-implement-cshape.fixture.json", import.meta.url), "utf8"));
const load = () => import("../drive/implement.mjs");
const probe = () => import("../drive/selfprobe.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const call = (cmd, over = {}) => JSON.stringify({ ev: "call", mode: "shell", ts: 1, ok: true, tokens: {}, names: {}, findings: [], failures: [], inconclusive: [], cmd, cmd_sha256: sha(cmd), ...over });
const setup = (kind, over = {}) => JSON.stringify({ ev: "setup", kind, ts: 1, ...over });
const bash = (...cmds) => cmds.map((command, i) => ({ id: `t${i}`, command }));
const SNAPSHOT_SCRIPT = `${FX.setup.snapshotHead}\n  echo more\n${FX.setup.snapshotTail}`;

// ---------------------------------------------------------------- the eval-quoted command

test("each real -c string matches its own tool-use command, including quotes and a heredoc", async () => {
  const { checkShimCalls } = await load();
  for (const s of FX.samples) {
    const r = checkShimCalls({ callLog: `${call(s.wrapped)}\n`, bash: bash(s.command) });
    assert.deepEqual(r.problems, [], s.command);
  }
});

test("all three real calls in one log match in order", async () => {
  const { checkShimCalls } = await load();
  const r = checkShimCalls({ callLog: `${FX.samples.map((s) => call(s.wrapped)).join("\n")}\n`, bash: bash(...FX.samples.map((s) => s.command)) });
  assert.deepEqual(r.problems, []);
  assert.equal(r.calls.length, 3);
});

test("a real -c string is not matched by a different command, a prefix, a suffix, or an unescaped quote", async () => {
  const { checkShimCalls } = await load();
  const [quoted, printf] = FX.samples;
  const wrong = [
    [printf.wrapped, "ls -d /tmp"],
    [printf.wrapped, "printf '%s\\n' $HOME"],
    [printf.wrapped, "echo hi && printf '%s\\n' $HOME && ls -d /tmp"],
    [printf.wrapped, "rm -rf /"],
    [quoted.wrapped, "echo \"its a test\" | tr a-z A-Z"],
    [quoted.wrapped, quoted.command.replace("tr a-z A-Z", "tr a-z A-Z; id")],
  ];
  for (const [wrapped, command] of wrong) {
    const r = checkShimCalls({ callLog: `${call(wrapped)}\n`, bash: bash(command) });
    assert.ok(r.problems.some((p) => /^command_not_in_cmd/.test(p)), command);
  }
});

test("a command that only appears in the setup prefix, not inside the eval, is refused", async () => {
  const { checkShimCalls } = await load();
  const r = checkShimCalls({ callLog: `${call(FX.samples[1].wrapped)}\n`, bash: bash("shopt -u extglob") });
  assert.ok(r.problems.some((p) => /^command_not_in_cmd/.test(p)));
});

// ---------------------------------------------------------------- setup lines in the call log

test("setup lines before the first call are not tool calls and do not break the count", async () => {
  const { checkShimCalls } = await load();
  const s = FX.samples[0];
  const r = checkShimCalls({ callLog: `${setup("env")}\n${setup("snapshot")}\n${call(s.wrapped)}\n`, bash: bash(s.command) });
  assert.deepEqual(r.problems, []);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.setup, ["env", "snapshot"]);
});

test("setup lines do not hide a missing or extra call", async () => {
  const { checkShimCalls } = await load();
  const s = FX.samples[0];
  const r = checkShimCalls({ callLog: `${setup("env")}\n${setup("snapshot")}\n${call(s.wrapped)}\n`, bash: bash(s.command, "pwd") });
  assert.ok(r.problems.some((p) => /^count_mismatch/.test(p)));
});

test("a setup line after a call is refused", async () => {
  const { checkShimCalls } = await load();
  const s = FX.samples[0];
  const r = checkShimCalls({ callLog: `${setup("env")}\n${call(s.wrapped)}\n${setup("snapshot")}\n`, bash: bash(s.command) });
  assert.ok(r.problems.some((p) => /^setup_after_call/.test(p)), r.problems.join("|"));
});

test("a repeated setup kind and an unknown setup kind are refused", async () => {
  const { checkShimCalls } = await load();
  const dup = checkShimCalls({ callLog: `${setup("env")}\n${setup("env")}\n`, bash: [] });
  assert.ok(dup.problems.some((p) => /^setup_duplicate/.test(p)), dup.problems.join("|"));
  const bad = checkShimCalls({ callLog: `${setup("rm")}\n`, bash: [] });
  assert.ok(bad.problems.some((p) => /^bad_setup/.test(p)), bad.problems.join("|"));
});

test("no setup lines at all is fine", async () => {
  const { checkShimCalls } = await load();
  const s = FX.samples[2];
  const r = checkShimCalls({ callLog: `${call(s.wrapped)}\n`, bash: bash(s.command) });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.setup, []);
});

// ---------------------------------------------------------------- shell.cjs

async function shimShell({ sandboxed, expect = { bash_ran: { k: "eq", v: 1 } } }) {
  const m = await probe();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "impl-cshape-")));
  const inst = m.installShim(join(root, "shim"), {
    validate: { readDeny: [], writeAllow: [], writeDenyRequired: [] },
    probe: { script: "echo bash_ran=1", expect, controls: {} },
    shell: { realShell: "/bin/bash", canaryPort: 1, canarySocket: "/tmp/none.sock" },
  });
  if (sandboxed) chmodSync(inst.sentinelPath, 0o400);
  const run = (...argv) => spawnSync(inst.shellPath, argv, { encoding: "utf8" });
  const logLines = () => readFileSync(inst.callLogPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { m, root, inst, run, logLines };
}

test("`-c env` runs, is logged as a setup line, and does not touch the sentinel, sandboxed or not", async () => {
  for (const sandboxed of [true, false]) {
    const { inst, run, logLines, m } = await shimShell({ sandboxed });
    const r = run("-c", "env");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^PATH=/m);
    assert.equal(statSync(inst.sentinelPath).size, 0, `sandboxed=${sandboxed}`);
    const lines = logLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ev, "setup");
    assert.equal(lines[0].kind, "env");
    assert.equal(m.readShimReport(inst.dir, { mode: "shell" }).calls, 0);
  }
});

test("`-c -l <snapshot script>` runs, is logged as a snapshot setup line, and leaves the sentinel empty", async () => {
  const { root, inst, run, logLines } = await shimShell({ sandboxed: false });
  const snap = join(root, "snap.sh");
  const script = `SNAPSHOT_FILE=${snap}\n      source /dev/null < /dev/null\n      echo "# Snapshot file" >| "$SNAPSHOT_FILE"\n      echo done >> "$SNAPSHOT_FILE"\n`;
  const r = run("-c", "-l", script);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(snap));
  assert.equal(statSync(inst.sentinelPath).size, 0);
  assert.deepEqual(logLines().map((l) => [l.ev, l.kind]), [["setup", "snapshot"]]);
});

test("the real captured snapshot head and tail are recognised as the snapshot shape", async () => {
  const { inst, run, logLines } = await shimShell({ sandboxed: true });
  // Not executed against the real home: the shape check is what is under test, so the script's own body is inert.
  const script = SNAPSHOT_SCRIPT.replace(/source "[^"]*"/, "true").replace(/^SNAPSHOT_FILE=.*$/m, `SNAPSHOT_FILE=${join(inst.dir, "..", "s.sh")}`);
  const r = run("-c", "-l", script);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(logLines()[0].kind, "snapshot");
});

test("a setup shape after the first tool call is refused and not logged as setup", async () => {
  const { inst, run, logLines } = await shimShell({ sandboxed: true });
  assert.equal(run("-c", "export TMPDIR=/x\necho one\n").status, 0);
  const r = run("-c", "env");
  assert.equal(r.status, 97);
  assert.match(r.stderr, /DETENT_SELFPROBE_REFUSED/);
  assert.doesNotMatch(r.stdout, /^PATH=/m);
  assert.deepEqual(logLines().map((l) => l.ev), ["call"]);
  assert.equal(statSync(inst.sentinelPath).size, 0);
});

test("a setup kind cannot run twice", async () => {
  const { run } = await shimShell({ sandboxed: true });
  assert.equal(run("-c", "env").status, 0);
  const r = run("-c", "env");
  assert.equal(r.status, 97);
  assert.match(r.stderr, /DETENT_SELFPROBE_REFUSED/);
});

test("a command dressed up as a setup call is a normal call: sentinel written when unsandboxed, probed and logged as a call when sandboxed", async () => {
  const disguises = [
    ["-c", "env; id"],
    ["-c", "env", "extra"],
    ["-c", "-l", "echo hi"],
    ["-c", "-l", "SNAPSHOT_FILE=/x\necho hi"],
    ["-c", "-l", `${SNAPSHOT_SCRIPT}\nid`.replace(/^/, "id\n")],
    ["-c", "-l", "echo hi", "SNAPSHOT_FILE=/x"],
  ];
  for (const argv of disguises) {
    const un = await shimShell({ sandboxed: false });
    un.run(...argv);
    assert.ok(statSync(un.inst.sentinelPath).size >= 1, `unsandboxed ${JSON.stringify(argv).slice(0, 40)}`);
    const sb = await shimShell({ sandboxed: true });
    sb.run(...argv);
    const lines = sb.logLines();
    assert.ok(lines.length >= 1 && lines.every((l) => l.ev === "call"), `sandboxed ${JSON.stringify(argv).slice(0, 40)}`);
  }
});
