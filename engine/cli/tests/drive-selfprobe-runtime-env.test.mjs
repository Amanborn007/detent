// Claude Code 2.1.306 injects some secret-shaped names into every sandboxed Bash env: the proxy
// credential (CLOUDSDK_PROXY_PASSWORD, equal to the HTTP_PROXY password), git safe.directory entries
// (GIT_CONFIG_KEY_n/VALUE_n/COUNT) and session ids. They are exempt by exact name and always reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const load = () => import("../drive/selfprobe.mjs");
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "selfprobe-renv-")));
const OPTS = { platform: "darwin", clone: "/work/clone", drivePid: 1, denyTargets: [], canaries: [], writeAllowed: [], writeDenied: [], toolchain: [], envAllow: ["PATH", "HOME"] };

const RUNTIME = {
  PATH: "/usr/bin:/bin", HOME: "/home/x",
  CLAUDE_CODE_SESSION_ID: "11111111-2222", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ATTENDED: "0",
  GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/a", GIT_CONFIG_KEY_1: "safe.directory", GIT_CONFIG_VALUE_1: "/a/*",
  HTTP_PROXY: "http://srt.abc:PROXYTOK@localhost:5000", CLOUDSDK_PROXY_PASSWORD: "PROXYTOK",
};

async function runEnv(extra = {}, opts = OPTS) {
  const m = await load();
  const p = m.buildSelfProbe(opts);
  const r = spawnSync("/bin/sh", ["-c", p.envScript], { encoding: "utf8", env: { ...RUNTIME, ...extra } });
  return { m, p, out: r.stdout, tokens: m.parseTokens(r.stdout), names: m.parseNames(r.stdout) };
}

test("the probe exposes the env checks and the new expectations", async () => {
  const m = await load();
  const p = m.buildSelfProbe(OPTS);
  assert.ok(p.envScript.includes("cloudsdk_pw_matches_proxy"));
  assert.equal(p.expect.cloudsdk_pw_matches_proxy.k, "rc0");
  assert.equal(p.expect.git_config_keys_other.k, "zero");
  assert.ok(p.script.includes("claude_uid_tmp_writable"));
  assert.ok(p.script.includes(p.envScript.split("\n").filter((l) => l.startsWith("N="))[0]));
});

test("claude's runtime env passes, with the exempt names listed and no value printed", async () => {
  const { tokens, names, out } = await runEnv();
  assert.equal(tokens.env_secret_names, 0);
  assert.equal(tokens.env_extra_names, 0);
  assert.equal(tokens.cloudsdk_pw_matches_proxy, 0);
  assert.equal(tokens.git_config_keys_other, 0);
  assert.deepEqual(names.claude_runtime_env.sort(), ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLOUDSDK_PROXY_PASSWORD", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_VALUE_1"]);
  assert.ok(!out.includes("PROXYTOK"));
});

test("a CLOUDSDK_PROXY_PASSWORD that is not the proxy's own credential fails", async () => {
  const { tokens, m, p } = await runEnv({ CLOUDSDK_PROXY_PASSWORD: "something-else" });
  assert.notEqual(tokens.cloudsdk_pw_matches_proxy, 0);
  const ev = m.evaluateTokens(tokens, p.expect, {});
  assert.ok(ev.failures.some((f) => /cloudsdk_pw_matches_proxy/.test(f)));
});

test("a GIT_CONFIG_KEY that is not safe.directory fails", async () => {
  const { tokens } = await runEnv({ GIT_CONFIG_KEY_1: "http.extraheader" });
  assert.equal(tokens.git_config_keys_other, 1);
});

test("a real secret-shaped name still counts, is named, and its value never appears", async () => {
  const { tokens, names, out } = await runEnv({ MY_API_TOKEN: "hunter2hunter2" });
  assert.equal(tokens.env_secret_names, 1);
  assert.deepEqual(names.env_secret_names, ["MY_API_TOKEN"]);
  assert.ok(!out.includes("hunter2"));
});

test("other GIT_CONFIG_* names are not exempt", async () => {
  const { tokens, names } = await runEnv({ GIT_CONFIG_KEY_X: "a" });
  assert.equal(tokens.env_secret_names, 1);
  assert.deepEqual(names.env_secret_names, ["GIT_CONFIG_KEY_X"]);
});

async function shimWith(m, script, expect) {
  const root = tmp();
  const inst = m.installShim(join(root, "shim"), { validate: { readDeny: [], writeAllow: [], writeDenyRequired: [] }, probe: { script, expect, controls: {} }, shell: { realShell: "/bin/sh" } });
  chmodSync(inst.sentinelPath, 0o400);
  return inst;
}

test("the shell path records the runtime-env and per-uid tmp findings", async () => {
  const m = await load();
  const uid = process.getuid();
  const inst = await shimWith(m, `echo bash_ran=1; echo claude_uid_tmp_writable=0; echo '@names claude_runtime_env CLAUDE_CODE_SESSION_ID,CLOUDSDK_PROXY_PASSWORD'`, { bash_ran: { k: "eq", v: 1 } });
  const r = spawnSync(inst.shellPath, ["-c", "true"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const rep = m.readShimReport(inst.dir, { mode: "shell" });
  assert.deepEqual(rep.findings.sort(), [`claude_added_write:/private/tmp/claude-${uid}`, "claude_runtime_env:CLAUDE_CODE_SESSION_ID", "claude_runtime_env:CLOUDSDK_PROXY_PASSWORD"]);
  assert.deepEqual(m.evaluateSelfProbe({ ...rep, toolUses: 1, platform: "darwin" }).findings.sort(), rep.findings.sort());
  assert.match(readFileSync(inst.callLogPath, "utf8"), /claude_runtime_env:CLAUDE_CODE_SESSION_ID/);
  m.uninstallShim(inst.dir);
});

test("names outside the exempt set are never turned into findings", async () => {
  const m = await load();
  const inst = await shimWith(m, `echo bash_ran=1; echo '@names claude_runtime_env AWS_SECRET_ACCESS_KEY'`, { bash_ran: { k: "eq", v: 1 } });
  spawnSync(inst.shellPath, ["-c", "true"], { encoding: "utf8" });
  assert.deepEqual(m.readShimReport(inst.dir, { mode: "shell" }).findings, []);
  m.uninstallShim(inst.dir);
});

test("an absent per-uid tmp dir is not a finding", async () => {
  const m = await load();
  const inst = await shimWith(m, `echo bash_ran=1; echo claude_uid_tmp_writable=2`, { bash_ran: { k: "eq", v: 1 } });
  spawnSync(inst.shellPath, ["-c", "true"], { encoding: "utf8" });
  assert.deepEqual(m.readShimReport(inst.dir, { mode: "shell" }).findings, []);
  m.uninstallShim(inst.dir);
});
