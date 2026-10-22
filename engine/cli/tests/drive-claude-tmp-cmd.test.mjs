// drive-claude-tmp-cmd.test.mjs — in shell mode claude runs `<shell> -c "<prefix with export TMPDIR=...>; <cmd>"`,
// so the shim's own $TMPDIR is the pre-export one. The shim shell reads the assignment out of the
// command string instead, and fails loudly when it cannot find or parse one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const sp = await import("../drive/selfprobe.mjs");

test("tmpdirFromCommand reads the unconditional export TMPDIR assignment, in each quoting", () => {
  const v = (cmd) => sp.tmpdirFromCommand(cmd);
  assert.deepEqual(v("export TMPDIR='/tmp/dt-abc123/claude-502'; echo hi"), { value: "/tmp/dt-abc123/claude-502" });
  assert.deepEqual(v('export TMPDIR="/tmp/dt-abc123/claude-502" && ls'), { value: "/tmp/dt-abc123/claude-502" });
  assert.deepEqual(v("export TMPDIR=/tmp/dt-abc123/claude-502; ls"), { value: "/tmp/dt-abc123/claude-502" });
  assert.deepEqual(v("true && export TMPDIR=/tmp/dt-abc123/claude-502\nls"), { value: "/tmp/dt-abc123/claude-502" });
});

test("tmpdirFromCommand takes the last unconditional assignment and ignores the conditional fallback", () => {
  assert.deepEqual(sp.tmpdirFromCommand("export TMPDIR=/a; export TMPDIR=/b; ls"), { value: "/b" });
  assert.deepEqual(sp.tmpdirFromCommand('{ [ -n "${TMPDIR:-}" ] || export TMPDIR=/x; }; export TMPDIR=/y; ls'), { value: "/y" });
});

test("tmpdirFromCommand reports claude_tmpdir_unset_in_cmd when there is no unconditional assignment", () => {
  for (const cmd of ["echo hi", "TMPDIR=/a ls", 'echo "export TMPDIR=/a"', '{ [ -n "${TMPDIR:-}" ] || export TMPDIR=/x; }; ls', undefined]) {
    assert.equal(sp.tmpdirFromCommand(cmd).reason, "claude_tmpdir_unset_in_cmd", String(cmd));
  }
});

test("tmpdirFromCommand does not guess at a value that needs the shell to expand", () => {
  for (const cmd of ["export TMPDIR=$HOME/x; ls", "export TMPDIR=`pwd`; ls", "export TMPDIR=$(pwd); ls", "export TMPDIR=; ls"]) {
    assert.equal(sp.tmpdirFromCommand(cmd).reason, "claude_tmpdir_unparseable_in_cmd", cmd);
  }
});

test("a failing claude_tmpdir_matches check names the observed and expected paths", () => {
  const p = sp.buildSelfProbe({ platform: "darwin", clone: "/work/clone", drivePid: 1, claudeTmp: "/tmp/dt-abc123" });
  const line = p.script.split("\n").find((l) => l.includes("claude_tmpdir_matches"));
  const r = spawnSync("/bin/sh", ["-c", `r() { echo "$1=$2"; }\n${line}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", TMPDIR: "/private/tmp/elsewhere" } });
  const details = sp.parseDetails(r.stdout);
  assert.match(details.claude_tmpdir_matches, /TMPDIR=\/private\/tmp\/elsewhere/);
  assert.match(details.claude_tmpdir_matches, /expected=/);
  const ev = sp.evaluateTokens(sp.parseTokens(r.stdout), p.expect, {}, { details });
  assert.match(ev.failures.find((f) => f.startsWith("claude_tmpdir_matches")), /elsewhere/);
});

const root0 = process.getuid() === 0;

test("the shim shell checks the TMPDIR assigned in the command string, not its own", { skip: root0 && "root ignores the chmod that fakes the sandbox" }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "claude-tmp-cmd-")));
  const claudeTmp = join(base, "t");
  mkdirSync(join(claudeTmp, `claude-${process.getuid()}`), { recursive: true });
  const p = sp.buildSelfProbe({ platform: "darwin", clone: "/work/clone", drivePid: 1, claudeTmp });
  const script = p.script.split("\n").filter((l) => l.startsWith("r() ") || l.includes("claude_tmpdir_matches")).join("\n");
  const inst = sp.installShim(join(base, "shim"), { validate: { readDeny: [], writeAllow: [], writeDenyRequired: [] }, probe: { script, expect: { claude_tmpdir_matches: p.expect.claude_tmpdir_matches }, controls: {} }, shell: { realShell: "/bin/sh" } });
  chmodSync(inst.sentinelPath, 0o400);
  const run = (cmd) => spawnSync(inst.shellPath, ["-c", cmd], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", TMPDIR: "/private/tmp/pre-export" } });
  try {
    const ok = run(`export TMPDIR='${join(claudeTmp, `claude-${process.getuid()}`)}'; echo ran`);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ran/);
    const bad = run("export TMPDIR='/private/tmp/elsewhere'; echo ran");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /claude_tmpdir_matches/);
    assert.match(bad.stderr, /elsewhere/);
    assert.ok(!bad.stdout.includes("ran"));
    const none = run("echo ran");
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /claude_tmpdir_unset_in_cmd/);
    assert.match(readFileSync(inst.callLogPath, "utf8"), /claude_tmpdir_unset_in_cmd/);
  } finally { sp.uninstallShim(inst.dir); rmSync(base, { recursive: true, force: true }); }
});
