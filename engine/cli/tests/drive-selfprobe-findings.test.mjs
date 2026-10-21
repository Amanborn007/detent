// Behaviour added after the first live runs: env-name reporting (names only) and Claude's own per-uid tmp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const load = () => import("../drive/selfprobe.mjs");
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "selfprobe-find-")));

const profile = (extraWrite = []) => [
  "(version 1)", '(deny default (with message "T"))', "(allow process-exec)",
  "(allow file-read*)",
  "(deny file-read*", '  (subpath "/Users/t/.ssh")', '  (with message "T"))',
  "(allow file-write*", ...["/dev/null", "/tmp/claude", "/private/tmp/claude", "/work/clone", ...extraWrite].map((p) => `  (subpath "${p}")`), '  (with message "T"))',
  "(deny file-write*", '  (subpath "/tmp/claude")', '  (with message "T"))',
].join("\n") + "\n";

const VALIDATE = { readDeny: ["/Users/t/.ssh"], writeAllow: ["/work/clone"], writeDenyRequired: ["/tmp/claude"] };

test("claude's own per-uid tmp dir is allowed but reported as a finding", async () => {
  const m = await load();
  const r = m.validateCapturedProfile(profile(["/private/tmp/claude-502", "/tmp/claude-502"]), VALIDATE);
  assert.equal(r.ok, true, r.violations.join(","));
  assert.deepEqual(r.findings.sort(), ["claude_added_write:/private/tmp/claude-502", "claude_added_write:/tmp/claude-502"]);
});

test("a different tmp dir is still a violation and a clean profile has no findings", async () => {
  const m = await load();
  assert.equal(m.validateCapturedProfile(profile(["/private/tmp/other"]), VALIDATE).ok, false);
  assert.equal(m.validateCapturedProfile(profile(["/private/tmp/claude-502-evil"]), VALIDATE).ok, false);
  assert.deepEqual(m.validateCapturedProfile(profile(), VALIDATE).findings, []);
});

test("the env shim records the finding and the evaluation surfaces it", async () => {
  const m = await load();
  const root = tmp();
  const fake = join(root, "sbx");
  writeFileSync(fake, '#!/bin/sh\n[ "$1" = "-p" ] && shift 2\nexec "$@"\n', { mode: 0o755 });
  const inst = m.installShim(join(root, "shim"), { validate: VALIDATE, probe: { script: "echo bash_ran=1", expect: { bash_ran: { k: "eq", v: 1 } }, controls: {} }, sandboxExec: fake });
  const r = spawnSync(join(inst.binDir, "env"), [fake, "-p", profile(["/private/tmp/claude-502"]), "/bin/sh", "-c", "echo ok"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const rep = m.readShimReport(inst.dir);
  assert.deepEqual(rep.findings, ["claude_added_write:/private/tmp/claude-502"]);
  const ev = m.evaluateSelfProbe({ ...rep, toolUses: 1, platform: "darwin" });
  assert.equal(ev.ok, true);
  assert.deepEqual(ev.findings, ["claude_added_write:/private/tmp/claude-502"]);
  m.uninstallShim(inst.dir);
});

test("a failed name check lists the matching names and never a value", async () => {
  const m = await load();
  const names = m.parseNames("env_secret_names=2\n@names env_secret_names FOO_TOKEN,BAR_KEY\n@names env_extra_names A=secretvalue,OK_NAME\n");
  assert.deepEqual(names.env_secret_names, ["FOO_TOKEN", "BAR_KEY"]);
  assert.deepEqual(names.env_extra_names, ["OK_NAME"]);
  const ev = m.evaluateTokens({ env_secret_names: 2 }, { env_secret_names: { k: "zero" } }, {}, { names });
  assert.match(ev.failures[0], /FOO_TOKEN,BAR_KEY/);
  assert.ok(!ev.failures.join(" ").includes("secretvalue"));
});

test("the probe prints the names behind env_secret_names and env_extra_names", async () => {
  const m = await load();
  const { script } = m.buildSelfProbe({ platform: "darwin", clone: "/work/clone", drivePid: 1, denyTargets: [], canaries: [], writeAllowed: [], writeDenied: [], toolchain: [], envAllow: ["PATH"] });
  assert.ok(script.includes("@names env_secret_names"));
  assert.ok(script.includes("@names env_extra_names"));
  assert.ok(/cut -d= -f1/.test(script));
});

test("the shim shell refusal and call log carry the names", async () => {
  const m = await load();
  const root = tmp();
  const inst = m.installShim(join(root, "shim"), {
    validate: VALIDATE,
    probe: { script: "echo env_secret_names=1; echo '@names env_secret_names SOME_TOKEN'", expect: { env_secret_names: { k: "zero" } }, controls: {} },
    shell: { realShell: "/bin/sh" },
  });
  chmodSync(inst.sentinelPath, 0o400);
  const r = spawnSync(inst.shellPath, ["-c", "echo no"], { encoding: "utf8" });
  assert.equal(r.status, 97);
  assert.match(r.stderr, /SOME_TOKEN/);
  assert.match(readFileSync(inst.callLogPath, "utf8"), /SOME_TOKEN/);
  m.uninstallShim(inst.dir);
});
