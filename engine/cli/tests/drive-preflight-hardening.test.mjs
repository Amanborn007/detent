import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pf = await import("../drive/preflight.mjs").catch((e) => ({ loadError: e }));
const need = () => { if (pf.loadError) throw pf.loadError; return pf; };

const GOOD = () => ({
  env: { PATH: "/usr/bin", HOME: "/h" },
  platform: "linux",
  managedSettings: [],
  versions: { claude: "2.1.306", git: "2.45.1", node: "20.0.0" },
  which: (n) => `/usr/bin/${n}`,
  nested: () => false,
  userns: () => true,
  exists: () => true,
});
const run = (over = {}) => need().implementPreflight({ ...GOOD(), ...over });
const codes = (r) => r.refusals.map((x) => x.code);

// ---- M1: real probes ---------------------------------------------------------
test("darwin without an injected detector probes sandbox-exec and refuses when it fails", () => {
  const calls = [];
  const spawn = (cmd, args) => { calls.push([cmd, ...args]); return { status: 71 }; };
  const r = run({ platform: "darwin", nested: undefined, spawn });
  assert.deepEqual(codes(r), ["sandbox_unavailable:nested"]);
  assert.equal(calls[0][0], "/usr/bin/sandbox-exec");
  assert.ok(calls[0].includes("(version 1)(allow default)") && calls[0].includes("/usr/bin/true"));
});

test("darwin probe success passes; a spawn error is its own refusal, never ok", () => {
  assert.equal(run({ platform: "darwin", nested: undefined, spawn: () => ({ status: 0 }) }).ok, true);
  const r = run({ platform: "darwin", nested: undefined, spawn: () => ({ status: null, error: new Error("EPERM") }) });
  assert.deepEqual(codes(r), ["sandbox_probe_failed"]);
});

test("linux without an injected userns check probes bwrap --unshare-user", () => {
  const calls = [];
  const fail = (cmd, args) => { calls.push([cmd, ...args]); return { status: 1 }; };
  const r = run({ userns: undefined, spawn: fail });
  assert.deepEqual(codes(r), ["userns_disabled"]);
  assert.ok(calls[0].includes("--unshare-user") && calls[0].includes("true"));
  assert.equal(run({ userns: undefined, spawn: () => ({ status: 0 }) }).ok, true);
});

test("linux does not probe bwrap when bwrap is missing", () => {
  let n = 0;
  const r = run({ userns: undefined, which: (x) => (x === "bwrap" ? null : "/x"), spawn: () => { n++; return { status: 0 }; } });
  assert.deepEqual(codes(r), ["bwrap_missing"]);
  assert.equal(n, 0);
});

// ---- M2: shared secret-name rule -----------------------------------------------
const LONG = "abcdefghijklmnop";
for (const name of [
  "GITHUB_PAT", "NPM_CONFIG__AUTH", "npm_config_//registry.npmjs.org/:_authToken", "GOOGLE_APPLICATION_CREDENTIALS",
  "DB_PASS", "SMTP_PASSWD", "DD_APIKEY", "SECRET_KEY_BASE", "SENTRY_DSN", "SLACK_WEBHOOK_URL", "AWS_SECRETS", "API_TOKENS",
  "TOKEN", "COOKIE", "SESSION_ID", "NODE_AUTH_TOKEN", "github_token",
]) {
  test(`env ${name} refuses`, () => {
    const r = run({ env: { [name]: LONG } });
    assert.deepEqual(codes(r), ["env_secret"]);
    assert.ok(!JSON.stringify(r).includes(LONG));
  });
}

test("a URL with userinfo in any variable refuses without printing it", () => {
  const v = "postgres://user:hunter22@db.example/x";
  const r = run({ env: { DATABASE_URL: v, SOME_ENDPOINT: "https://a:b2c3d4e5@host/p" } });
  assert.deepEqual(codes(r), ["env_secret"]);
  assert.ok(!JSON.stringify(r).includes("hunter22"));
  assert.equal(run({ env: { HOMEPAGE: "https://example.test/path@x" } }).ok, true);
});

test("ordinary and OS-set variables do not refuse", () => {
  const env = {
    AWS_REGION: "us-east-1", AWS_PROFILE: "my-profile-name", AWS_DEFAULT_REGION: "eu-west-1",
    SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.abcdef/Listeners", GIT_ASKPASS: "/usr/lib/git-core/git-askpass",
    PATH: "/usr/local/bin:/usr/bin:/bin:/sbin", TERM_SESSION_ID: "w0t0p0:3C1B2A44-0000-0000-0000-000000000000",
    XDG_SESSION_ID: "1234567890", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", KEYBOARD: "us-layout-long",
  };
  assert.equal(run({ env }).ok, true);
});

// ---- M3: managed settings allowlist ----------------------------------------------
const managed = (json, path = "m") => run({ managedSettings: [{ path, json }] });

test("known-safe managed keys pass", () => {
  assert.equal(managed({ model: "x", permissions: { deny: ["Bash(rm:*)"], disableBypassPermissionsMode: "disable" }, promptSuggestionEnabled: false, cleanupPeriodDays: 30 }).ok, true);
});

for (const j of [
  { enabledPlugins: { "x@m": true } }, { extraKnownMarketplaces: {} }, { apiKeyHelper: "curl x" }, { awsAuthRefresh: "x" },
  { awsCredentialExport: "x" }, { otelHeadersHelper: "x" }, { statusLine: { type: "command", command: "x" } },
  { permissions: { allow: ["Bash(*)"] } }, { permissions: { defaultMode: "bypassPermissions" } }, { somethingNew: 1 },
]) {
  test(`managed ${JSON.stringify(Object.keys(j)[0])}${j.permissions ? "." + Object.keys(j.permissions)[0] : ""} refuses`, () => {
    const r = managed(j);
    assert.deepEqual(codes(r), ["managed_setting_key"]);
  });
}

test("a managed settings file that is not an object refuses", () => {
  assert.deepEqual(codes(managed([1])), ["managed_unreadable"]);
  assert.deepEqual(codes(managed(null)), ["managed_unreadable"]);
});

test("a managed-mcp marker entry refuses", () => {
  const r = run({ managedSettings: [{ path: "/etc/claude-code/managed-mcp.json", kind: "mcp" }] });
  assert.deepEqual(codes(r), ["managed_mcp"]);
});

test("readAllManagedSettings adds managed-mcp, the remote cache and the macOS MDM domain", () => {
  const { readAllManagedSettings } = need();
  const enoent = () => { const e = new Error("nf"); e.code = "ENOENT"; throw e; };
  const files = { "/home/u/.claude/remote-settings.json": '{"env":{"A":"1"}}' };
  const asked = [];
  const run1 = (cmd, args) => { asked.push([cmd, ...args]); return cmd === "defaults" ? "<plist/>" : '{"apiKeyHelper":"x"}'; };
  const r = readAllManagedSettings({
    platform: "darwin", home: "/home/u",
    readFile: (p) => { if (p in files) return files[p]; enoent(); }, readdir: enoent,
    exists: (p) => p === "/Library/Application Support/ClaudeCode/managed-mcp.json",
    run: run1,
  });
  assert.deepEqual(r.map((x) => x.kind ?? "settings"), ["mcp", "settings", "settings"]);
  assert.deepEqual(r[1].json, { env: { A: "1" } });
  assert.deepEqual(r[2].json, { apiKeyHelper: "x" });
  assert.ok(asked.some((a) => a[0] === "defaults" && a.includes("com.anthropic.claudecode")));
});

test("readAllManagedSettings tolerates absence everywhere and flags unreadable remote cache", () => {
  const { readAllManagedSettings } = need();
  const enoent = () => { const e = new Error("nf"); e.code = "ENOENT"; throw e; };
  assert.deepEqual(readAllManagedSettings({ platform: "linux", home: "/h", readFile: enoent, readdir: enoent, exists: () => false, run: () => null }), []);
  const r = readAllManagedSettings({ platform: "linux", home: "/h", readFile: (p) => (p.endsWith("remote-settings.json") ? "{bad" : enoent()), readdir: enoent, exists: () => false, run: () => null });
  assert.equal(r.length, 1);
  assert.ok(r[0].error);
});

// ---- L4: version parsing ---------------------------------------------------------
test("version strings are anchored to the tool's known output", () => {
  const v = (claude, git = "2.45.1", node = "20.0.0") => codes(run({ versions: { claude, git, node } }));
  assert.deepEqual(v("Claude Code (build 99.0) 1.0.0"), ["version_unknown"]);
  assert.deepEqual(v("claude 9.9.9 evil"), ["version_unknown"]);
  assert.deepEqual(v("2.1.306-beta.0"), ["claude_version"]);
  assert.deepEqual(v("2.1.307-rc1"), []);
  assert.deepEqual(v("2.1.306", "git version 2.45.1.rc0"), ["git_version"]);
  assert.deepEqual(v("2.1.306", "git version 2.45.1 (Apple Git-150)"), []);
  assert.deepEqual(v("2.1.306", "2.45.1", "v22.0.0-nightly20240101"), []);
  assert.deepEqual(v("2.1.306", "2.45.1", "v20.0.0-rc.1"), ["node_version"]);
});

test("findOnPath requires an executable regular file", () => {
  const { findOnPath } = need();
  const d = mkdtempSync(join(tmpdir(), "pfpath-"));
  writeFileSync(join(d, "tool"), "x"); chmodSync(join(d, "tool"), 0o644);
  writeFileSync(join(d, "ok"), "x"); chmodSync(join(d, "ok"), 0o755);
  assert.equal(findOnPath("tool", { pathEnv: d }), null);
  assert.equal(findOnPath("ok", { pathEnv: d }), join(d, "ok"));
  assert.equal(findOnPath("../ok", { pathEnv: d }), null);
});
