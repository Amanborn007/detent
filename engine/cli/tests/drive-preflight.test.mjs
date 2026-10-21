import { test } from "node:test";
import assert from "node:assert/strict";

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
const codes = (r) => r.refusals.map((x) => x.code);
const run = (over = {}) => need().implementPreflight({ ...GOOD(), ...over });

test("clean linux box passes", () => {
  assert.deepEqual(run(), { ok: true, refusals: [] });
});

test("clean macos box passes", () => {
  assert.equal(run({ platform: "darwin", which: () => null }).ok, true);
});

test("every refusal has a code, a detail and a one-line next_step", () => {
  const r = run({ env: { GH_TOKEN: "ghp_0123456789" }, which: () => null });
  assert.equal(r.ok, false);
  for (const x of r.refusals) {
    assert.ok(x.code && x.detail && x.next_step, JSON.stringify(x));
    assert.doesNotMatch(x.next_step, /\n/);
  }
});

for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "ANTHROPIC_API_KEY", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_ACCESS_KEY_ID","MY_SERVICE_TOKEN", "DB_SECRET", "STRIPE_KEY", "ADMIN_PASSWORD", "PASSWORD_FILE_X"]) {
  test(`secret-looking env ${name} refuses without printing the value`, () => {
    const value = "sup3r-s3cret-value";
    const r = run({ env: { [name]: value } });
    assert.deepEqual(codes(r), ["env_secret"]);
    const text = JSON.stringify(r);
    assert.ok(text.includes(name));
    assert.ok(!text.includes(value));
  });
}

test("short or empty secret-shaped values and ordinary names do not refuse", () => {
  assert.equal(run({ env: { GH_TOKEN: "", NPM_TOKEN: "short", EDITOR: "vim", KEYBOARD: "us-layout-long", TERM: "xterm-256color" } }).ok, true);
});

test("non-credential AWS variables do not refuse", () => {
  assert.equal(run({ env: { AWS_REGION: "us-east-1", AWS_PROFILE: "default-profile", AWS_DEFAULT_REGION: "eu-west-1" } }).ok, true);
});

test("managed sandbox key refuses", () => {
  const r = run({ managedSettings: [{ path: "/etc/claude-code/managed-settings.json", json: { sandbox: { enabled: true } } }] });
  assert.deepEqual(codes(r), ["managed_sandbox"]);
});

test("managed env refuses, lists names only", () => {
  const r = run({ managedSettings: [{ path: "p", json: { env: { BASH_ENV: "/x/hostile.sh", OTEL_LOG_TOOL_CONTENT: "1" } } }] });
  assert.deepEqual(codes(r), ["managed_env"]);
  const text = JSON.stringify(r);
  assert.ok(text.includes("BASH_ENV") && text.includes("OTEL_LOG_TOOL_CONTENT"));
  assert.ok(!text.includes("hostile.sh"));
});

test("managed hooks refuse", () => {
  const r = run({ managedSettings: [{ path: "p", json: { hooks: { PreToolUse: [] } } }] });
  assert.deepEqual(codes(r), ["managed_hooks"]);
});

test("empty managed env and hooks objects do not refuse", () => {
  assert.equal(run({ managedSettings: [{ path: "p", json: { env: {}, hooks: {}, model: "x" } }] }).ok, true);
});

test("unparseable managed settings refuse", () => {
  const r = run({ managedSettings: [{ path: "p", error: "Unexpected token" }] });
  assert.deepEqual(codes(r), ["managed_unreadable"]);
});

test("linux without bwrap, socat or userns refuses per cause", () => {
  assert.deepEqual(codes(run({ which: (n) => (n === "bwrap" ? null : "/x") })), ["bwrap_missing"]);
  assert.deepEqual(codes(run({ which: (n) => (n === "socat" ? null : "/x") })), ["socat_missing"]);
  assert.deepEqual(codes(run({ userns: () => false })), ["userns_disabled"]);
});

test("macos without sandbox-exec refuses; linux does not need it", () => {
  assert.deepEqual(codes(run({ platform: "darwin", exists: () => false })), ["sandbox_exec_missing"]);
  assert.equal(run({ exists: () => false }).ok, true);
});

test("unsupported platform refuses", () => {
  assert.deepEqual(codes(run({ platform: "win32" })), ["unsupported_platform"]);
});

test("version floors", () => {
  assert.deepEqual(codes(run({ versions: { claude: "2.1.305", git: "2.45.1", node: "20.1.0" } })), ["claude_version"]);
  assert.deepEqual(codes(run({ versions: { claude: "2.1.306", git: "2.45.0", node: "20.1.0" } })), ["git_version"]);
  assert.deepEqual(codes(run({ versions: { claude: "2.1.306", git: "2.45.1", node: "18.19.0" } })), ["node_version"]);
  assert.equal(run({ versions: { claude: "2.2.0 (Claude Code)", git: "git version 2.46.0", node: "v22.1.0" } }).ok, true);
  assert.deepEqual(codes(run({ versions: { claude: "2.10.0", git: "2.100.0", node: "20.0.0" } })), []);
});

test("missing or garbled versions refuse as unknown", () => {
  const r = run({ versions: { claude: null, git: "banana", node: "20.0.0" } });
  assert.deepEqual(codes(r), ["version_unknown", "version_unknown"]);
});

test("nested sandbox refuses with sandbox_unavailable:nested", () => {
  assert.deepEqual(codes(run({ nested: () => true })), ["sandbox_unavailable:nested"]);
  assert.deepEqual(codes(run({ nested: () => ({ nested: true, detail: "running under bwrap" }) })), ["sandbox_unavailable:nested"]);
});

test("multiple problems are all reported", () => {
  const r = run({ env: { GH_TOKEN: "ghp_0123456789" }, nested: () => true, platform: "darwin", exists: () => false });
  assert.deepEqual(codes(r).sort(), ["env_secret", "sandbox_exec_missing", "sandbox_unavailable:nested"]);
});

test("readManagedSettings reads the platform path and the .d dir in order", () => {
  const { readManagedSettings } = need();
  const files = {
    "/etc/claude-code/managed-settings.json": '{"a":1}',
    "/etc/claude-code/managed-settings.d/20-b.json": '{"b":2}',
    "/etc/claude-code/managed-settings.d/10-a.json": "{bad",
  };
  const r = readManagedSettings({
    platform: "linux",
    readFile: (p) => { if (!(p in files)) { const e = new Error("nf"); e.code = "ENOENT"; throw e; } return files[p]; },
    readdir: () => ["20-b.json", "10-a.json", "notes.txt"],
  });
  assert.deepEqual(r.map((x) => x.path), [
    "/etc/claude-code/managed-settings.json",
    "/etc/claude-code/managed-settings.d/10-a.json",
    "/etc/claude-code/managed-settings.d/20-b.json",
  ]);
  assert.ok(r[1].error && !r[1].json);
  assert.deepEqual(r[2].json, { b: 2 });
});

test("readManagedSettings uses the macOS path and tolerates absence", () => {
  const { readManagedSettings } = need();
  const seen = [];
  const enoent = () => { const e = new Error("nf"); e.code = "ENOENT"; throw e; };
  const r = readManagedSettings({ platform: "darwin", readFile: (p) => { seen.push(p); enoent(); }, readdir: enoent });
  assert.deepEqual(r, []);
  assert.deepEqual(seen, ["/Library/Application Support/ClaudeCode/managed-settings.json"]);
});

test("readManagedSettings surfaces non-ENOENT read errors", () => {
  const { readManagedSettings } = need();
  const r = readManagedSettings({ platform: "linux", readFile: () => { const e = new Error("denied"); e.code = "EACCES"; throw e; }, readdir: () => [] });
  assert.equal(r.length, 1);
  assert.ok(r[0].error);
});

test("detectVersions parses tool output through the injected runner", () => {
  const { detectVersions } = need();
  const out = { claude: "2.1.306 (Claude Code)\n", git: "git version 2.45.1\n" };
  const v = detectVersions({ run: (cmd) => out[cmd] ?? null, nodeVersion: "v20.20.2" });
  assert.deepEqual(v, { claude: "2.1.306 (Claude Code)", git: "git version 2.45.1", node: "v20.20.2" });
});
