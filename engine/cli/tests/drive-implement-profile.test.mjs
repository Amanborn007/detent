// drive-implement-profile.test.mjs — the sandbox settings, argv and env that
// `detent drive --implement` hands to the claude child. Pure functions only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const load = () => import("../drive/implement-profile.mjs");

function mkHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "impl-home-")));
  const node = join(home, ".nvm/versions/node/v20.1.0");
  mkdirSync(join(node, "bin"), { recursive: true });
  mkdirSync(join(node, "lib"), { recursive: true });
  mkdirSync(join(home, ".cargo/bin"), { recursive: true });
  mkdirSync(join(home, ".rustup/toolchains/stable-x/bin"), { recursive: true });
  mkdirSync(join(home, ".rustup/toolchains/stable-x/lib"), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  return { home, node };
}

function mkCtx(over = {}) {
  const { home, node } = mkHome();
  const sroot = join(home, "S");
  const step = join(sroot, "1");
  return {
    home, node, sroot,
    clone: join(step, "clone"),
    inputs: join(step, "inputs"),
    outbox: join(step, "outbox"),
    tmp: join(step, "tmp"),
    claudeTmp: join(step, "claude-tmp"),
    settingsPath: join(step, "settings.json"),
    platform: "darwin",
    path: [join(node, "bin"), join(home, ".cargo/bin"), "/usr/bin", "/bin"],
    model: "claude-sonnet-5-5", maxBudgetUsd: 2.5, maxTurns: 40,
    ...over,
  };
}

test("detectToolchainRoots re-allows only bin/lib of PATH entries under HOME", async () => {
  const { detectToolchainRoots } = await load();
  const { home, node } = mkHome();
  const roots = detectToolchainRoots(home, { path: [join(node, "bin"), join(home, ".cargo/bin"), "/usr/bin"] });
  assert.ok(roots.includes(join(node, "bin")));
  assert.ok(roots.includes(join(node, "lib")));
  assert.ok(roots.includes(join(home, ".cargo/bin")));
  assert.ok(roots.includes(join(home, ".rustup/toolchains/stable-x/bin")));
  assert.ok(!roots.includes(join(home, ".local/bin")), "not on PATH, so not needed");
  assert.ok(!roots.includes(home));
  assert.ok(!roots.includes(join(home, ".nvm")));
  assert.ok(roots.every((r) => r.startsWith(home + "/")));
});

test("HOME is denied for reads and only toolchain roots are re-allowed", async () => {
  const { buildImplementSettings } = await load();
  const ctx = mkCtx();
  const fs = buildImplementSettings(ctx).sandbox.filesystem;
  assert.ok(fs.denyRead.includes(ctx.home));
  assert.ok(fs.allowRead.includes(join(ctx.node, "bin")));
  assert.ok(fs.allowRead.includes(ctx.clone));
  assert.ok(fs.allowRead.includes(ctx.outbox));
  assert.ok(fs.allowRead.includes(ctx.tmp));
  assert.ok(!fs.allowRead.includes(ctx.claudeTmp), "claude's own tmp stays unreadable");
  assert.ok(!fs.allowRead.includes(ctx.home));
  assert.ok(fs.denyRead.includes(ctx.sroot), "other steps are denied");
});

test("every deny has a /System/Volumes/Data twin on macOS", async () => {
  const { buildImplementSettings } = await load();
  const fs = buildImplementSettings(mkCtx()).sandbox.filesystem;
  for (const list of [fs.denyRead, fs.denyWrite]) {
    for (const p of list.filter((x) => !x.startsWith("/System/Volumes/Data"))) {
      assert.ok(list.includes("/System/Volumes/Data" + p), `no twin for ${p}`);
    }
  }
});

test("no Data twins off macOS", async () => {
  const { buildImplementSettings } = await load();
  const fs = buildImplementSettings(mkCtx({ platform: "linux" })).sandbox.filesystem;
  assert.ok(fs.denyRead.every((p) => !p.startsWith("/System/Volumes/Data")));
});

test("/tmp/claude is denied for read and write, both spellings", async () => {
  const { buildImplementSettings } = await load();
  const fs = buildImplementSettings(mkCtx()).sandbox.filesystem;
  for (const p of ["/tmp/claude", "/private/tmp/claude"]) {
    assert.ok(fs.denyRead.includes(p), `denyRead ${p}`);
    assert.ok(fs.denyWrite.includes(p), `denyWrite ${p}`);
  }
});

test("git indirection files in the clone are write-denied", async () => {
  const { buildImplementSettings } = await load();
  const ctx = mkCtx();
  const w = buildImplementSettings(ctx).sandbox.filesystem.denyWrite;
  for (const f of ["commondir", "config.worktree", "objects/info/alternates", "info/attributes", "config", "hooks"]) {
    assert.ok(w.includes(`${ctx.clone}/.git/${f}`), f);
  }
});

test("network is closed and the sandbox is a hard gate", async () => {
  const { buildImplementSettings } = await load();
  const s = buildImplementSettings(mkCtx());
  assert.deepEqual(s.sandbox.network.allowedDomains, []);
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(s.sandbox.excludedCommands, []);
  assert.ok(!s.sandbox.enableWeakerNestedSandbox && !s.sandbox.enableWeakerNetworkIsolation);
  assert.ok(!("allowLocalBinding" in s.sandbox.network));
  assert.ok(!("allowUnixSockets" in s.sandbox.network));
  assert.deepEqual(s.permissions.allow, ["Bash"]);
  assert.equal(s.permissions.defaultMode, "dontAsk");
  assert.equal(s.disableAllHooks, true);
});

test("claude's tmp is not writable by the child", async () => {
  const { buildImplementSettings } = await load();
  const ctx = mkCtx();
  const fs = buildImplementSettings(ctx).sandbox.filesystem;
  assert.ok(!fs.allowWrite.includes(ctx.claudeTmp));
  assert.deepEqual([...fs.allowWrite].sort(), [ctx.clone, ctx.outbox, ctx.tmp].sort());
});

test("the generated settings validate", async () => {
  const { buildImplementSettings, validateImplementSettings } = await load();
  const ctx = mkCtx();
  validateImplementSettings(buildImplementSettings(ctx), ctx);
});

test("validateImplementSettings refuses each forbidden key or value", async () => {
  const { buildImplementSettings, validateImplementSettings } = await load();
  const ctx = mkCtx();
  const mut = (f) => { const s = structuredClone(buildImplementSettings(ctx)); f(s); return s; };
  const bad = {
    allowLocalBinding: (s) => { s.sandbox.network.allowLocalBinding = true; },
    allowUnixSockets: (s) => { s.sandbox.network.allowUnixSockets = ["/x"]; },
    allowAllUnixSockets: (s) => { s.sandbox.network.allowAllUnixSockets = true; },
    allowMachLookup: (s) => { s.sandbox.network.allowMachLookup = ["a"]; },
    allowAppleEvents: (s) => { s.sandbox.allowAppleEvents = true; },
    ignoreViolations: (s) => { s.sandbox.ignoreViolations = { "*": ["/"] }; },
    helperKey: (s) => { s.apiKeyHelper = "x"; },
    env: (s) => { s.env = { A: "1" }; },
    hooks: (s) => { s.hooks = {}; },
    statusLine: (s) => { s.statusLine = {}; },
    additionalDirectories: (s) => { s.permissions.additionalDirectories = ["/"]; },
    allowedDomains: (s) => { s.sandbox.network.allowedDomains = ["example.com"]; },
    httpProxyPort: (s) => { s.sandbox.network.httpProxyPort = 1; },
    failIfUnavailable: (s) => { s.sandbox.failIfUnavailable = false; },
    allowUnsandboxed: (s) => { s.sandbox.allowUnsandboxedCommands = true; },
    excluded: (s) => { s.sandbox.excludedCommands = ["git"]; },
    weakerNested: (s) => { s.sandbox.enableWeakerNestedSandbox = true; },
    weakerNet: (s) => { s.sandbox.enableWeakerNetworkIsolation = true; },
    disabled: (s) => { s.sandbox.enabled = false; },
    extraAllow: (s) => { s.permissions.allow.push("Read"); },
    allowWrite: (s) => { s.sandbox.filesystem.allowWrite.push(ctx.home); },
    dropTmpDeny: (s) => { s.sandbox.filesystem.denyWrite = s.sandbox.filesystem.denyWrite.filter((p) => p !== "/tmp/claude"); },
    dropCommondir: (s) => { s.sandbox.filesystem.denyWrite = s.sandbox.filesystem.denyWrite.filter((p) => !p.endsWith("/.git/commondir")); },
    dropReadTmp: (s) => { s.sandbox.filesystem.denyRead = s.sandbox.filesystem.denyRead.filter((p) => p !== "/private/tmp/claude"); },
    hooksOn: (s) => { s.disableAllHooks = false; },
  };
  for (const [name, f] of Object.entries(bad)) {
    assert.throws(() => validateImplementSettings(mut(f), ctx), Error, name);
  }
  assert.throws(() => validateImplementSettings(mut((s) => { s.sandbox.filesystem.allowWrite.push(ctx.claudeTmp); }), ctx), /claude/i);
  assert.throws(() => validateImplementSettings(mut((s) => { s.sandbox.filesystem.denyRead = s.sandbox.filesystem.denyRead.filter((p) => p !== ctx.home); }), ctx), /home/i);
});

test("argv is restricted, Bash-only and carries no secret", async () => {
  const { buildImplementArgs } = await load();
  const ctx = mkCtx();
  const a = buildImplementArgs(ctx);
  assert.ok(a.includes("-p") && a.includes("--restricted"));
  assert.equal(a[a.indexOf("--tools") + 1], "Bash");
  assert.equal(a[a.indexOf("--allowedTools") + 1], "Bash");
  assert.equal(a[a.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(a[a.indexOf("--settings") + 1], ctx.settingsPath);
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(a[a.indexOf("--max-budget-usd") + 1], "2.5");
  assert.equal(a[a.indexOf("--max-turns") + 1], "40");
  assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
  assert.ok(a.includes("--verbose"));
  assert.equal(a[a.indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.ok(!a.includes("--dangerously-skip-permissions") && !a.includes("--add-dir"));
});

test("buildImplementArgs refuses bad budget, turns, model and relative settings path", async () => {
  const { buildImplementArgs } = await load();
  for (const over of [
    { maxBudgetUsd: 0 }, { maxBudgetUsd: NaN }, { maxTurns: 0 }, { maxTurns: 1.5 },
    { model: "--x" }, { model: "" }, { settingsPath: "settings.json" },
  ]) {
    assert.throws(() => buildImplementArgs(mkCtx(over)), Error, JSON.stringify(over));
  }
});

test("env is an allowlist: no parent secret passes", async () => {
  const { buildImplementEnv } = await load();
  const ctx = mkCtx();
  const parent = {
    PATH: `${ctx.path.join(":")}:relative/bin:.:`, HOME: "/ignored", USER: "u", LANG: "en_US.UTF-8", LC_ALL: "C",
    GITHUB_TOKEN: "ghp_xxxxxxxxxxxx", GH_TOKEN: "x", AWS_ACCESS_KEY_ID: "AKIAxxxxxxxx", AWS_SECRET_ACCESS_KEY: "s",
    ANTHROPIC_API_KEY: "sk-ant-xxxxxxxx", NPM_TOKEN: "t", DB_SECRET: "s", STRIPE_KEY: "k",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", BASH_ENV: "/etc/x", SSH_AUTH_SOCK: "/s", HTTPS_PROXY: "http://p",
    CURATOR_SECRET: "s", ZDOTDIR: "/z",
  };
  const env = buildImplementEnv(parent, ctx);
  for (const k of Object.keys(env)) {
    assert.ok(!/TOKEN|SECRET|KEY|PASS|CRED|AUTH|COOKIE|SESSION|^OTEL_|^AWS_|^ANTHROPIC_|^GH|BASH_ENV|PROXY|^CURATOR/.test(k), `leaked ${k}`);
  }
  assert.equal(env.HOME, ctx.home);
  assert.equal(env.USER, "u");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.TERM, "dumb");
  assert.equal(env.SHELL, "/bin/sh");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.TMPDIR, ctx.tmp);
  assert.equal(env.CLAUDE_CODE_TMPDIR, ctx.claudeTmp);
  assert.notEqual(env.TMPDIR, env.CLAUDE_CODE_TMPDIR);
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.DISABLE_TELEMETRY, "1");
  assert.ok(env.PATH.split(":").every((p) => p.startsWith("/") && p.length > 1));
  assert.ok(!env.PATH.includes("relative"));
});

test("buildImplementEnv refuses a PATH entry under the step root and shared tmp dirs", async () => {
  const { buildImplementEnv } = await load();
  const ctx = mkCtx();
  assert.throws(() => buildImplementEnv({ PATH: `${ctx.sroot}/bin:/usr/bin` }, ctx), /PATH/);
  assert.throws(() => buildImplementEnv({ PATH: "/tmp/claude/bin:/usr/bin" }, ctx), /PATH/);
  assert.throws(() => buildImplementEnv({ PATH: "" }, ctx), /PATH/);
});

test("buildImplementEnv refuses shared or nested tmp dirs", async () => {
  const { buildImplementEnv } = await load();
  const ctx = mkCtx();
  assert.throws(() => buildImplementEnv({ PATH: "/usr/bin" }, { ...ctx, claudeTmp: ctx.tmp }), /tmp/i);
  assert.throws(() => buildImplementEnv({ PATH: "/usr/bin" }, { ...ctx, claudeTmp: join(ctx.tmp, "c") }), /tmp/i);
});

test("validateManagedSettings refuses sandbox, env entries and hooks", async () => {
  const { validateManagedSettings } = await load();
  assert.doesNotThrow(() => validateManagedSettings({}));
  assert.doesNotThrow(() => validateManagedSettings({ env: {}, permissions: { deny: ["X"] } }));
  assert.throws(() => validateManagedSettings({ sandbox: { enabled: true } }), /sandbox/);
  assert.throws(() => validateManagedSettings({ env: { OTEL_LOG_USER_PROMPTS: "1" } }), /env/);
  assert.throws(() => validateManagedSettings({ hooks: { PreToolUse: [{}] } }), /hooks/);
  assert.throws(() => validateManagedSettings(null), /managed/i);
  try { validateManagedSettings({ sandbox: {}, env: { A: "1" }, hooks: { X: [] } }); assert.fail("no throw"); }
  catch (e) { assert.match(e.message, /sandbox/); assert.match(e.message, /env/); assert.match(e.message, /hooks/); }
});

test("implementDenyRead covers detent-owned dirs passed in ctx.extraDeny", async () => {
  const { implementDenyRead } = await load();
  const ctx = mkCtx({ extraDeny: ["/Users/someone/detent", "/Users/someone/.curator"] });
  const d = implementDenyRead(ctx);
  assert.ok(d.includes("/Users/someone/detent") && d.includes("/System/Volumes/Data/Users/someone/detent"));
  assert.ok(d.includes("/System/Volumes/Data/Users/someone/.curator"));
});

test("validateImplementSettings pins the remaining sandbox switches", async () => {
  const { buildImplementSettings, validateImplementSettings } = await load();
  const ctx = mkCtx();
  const base = buildImplementSettings(ctx);
  assert.equal(base.sandbox.allowAppleEvents, false);
  assert.equal(base.disableAllHooks, true);
  assert.equal(base.enableAllProjectMcpServers, false);
  const mut = (f) => { const s = structuredClone(base); f(s); return s; };
  const bad = {
    machLookup: (s) => { s.sandbox.network.allowMachLookup = ["com.apple.x"]; },
    machLookupEmpty: (s) => { s.sandbox.network.allowMachLookup = []; },
    appleEventsTrue: (s) => { s.sandbox.allowAppleEvents = true; },
    appleEventsMissing: (s) => { delete s.sandbox.allowAppleEvents; },
    ignoreViolationsEmpty: (s) => { s.sandbox.ignoreViolations = {}; },
    nestedNsTrue: (s) => { s.sandbox.allowNestedUserNamespaces = true; },
    allUnixSockets: (s) => { s.sandbox.network.allowAllUnixSockets = true; },
    httpProxyZero: (s) => { s.sandbox.network.httpProxyPort = 0; },
    socksProxy: (s) => { s.sandbox.network.socksProxyPort = 1080; },
    autoAllowFalse: (s) => { s.sandbox.autoAllowBashIfSandboxed = false; },
    strictMissing: (s) => { delete s.sandbox.network.strictAllowlist; },
    strictFalse: (s) => { s.sandbox.network.strictAllowlist = false; },
    mcpServersOn: (s) => { s.enableAllProjectMcpServers = true; },
    mcpServersMissing: (s) => { delete s.enableAllProjectMcpServers; },
  };
  for (const [name, f] of Object.entries(bad)) {
    assert.throws(() => validateImplementSettings(mut(f), ctx), Error, name);
  }
  validateImplementSettings(mut((s) => { s.sandbox.allowNestedUserNamespaces = false; }), ctx);
});
