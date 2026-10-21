// Unit tests for the model-free self-probe gate: the captured-profile validator,
// the probe script and its evaluation, and the `env` shim run against a fake
// sandbox-exec (real Seatbelt cannot nest, so the live test covers the real one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const load = () => import("../drive/selfprobe.mjs");
const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "selfprobe-")));

const HOME = "/Users/tester";
const TAG = "CMD64_ZWNobyBoaQ==_END_abc123_SBX";

function fixtureProfile({ tag = TAG, ports = [51000, 51001], extra = [], dropDeny = [], writeAllow = ["/work/clone", "/work/outbox", "/work/tmp"], readDeny = [`${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.claude`] } = {}) {
  const net = ports.flatMap((p) => [
    `(allow network-bind (local ip "localhost:${p}"))`,
    `(allow network-inbound (local ip "localhost:${p}"))`,
    `(allow network-outbound (remote ip "localhost:${p}"))`,
  ]);
  const denyRead = readDeny.filter((p) => !dropDeny.includes(p));
  const lines = [
    "(version 1)", `(deny default (with message "${tag}"))`, "", `; LogTag: ${tag}`,
    "(allow process-exec)", "(allow process-fork)", "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))", "(allow mach-priv-task-port (target same-sandbox))",
    "(allow user-preference-read)",
    "(allow mach-lookup", '  (global-name "com.apple.logd")', '  (global-name "com.apple.fonts")',
    '  (global-name "com.apple.securityd.xpc")', '  (global-name "com.apple.coreservices.launchservicesd")', ")",
    "(allow ipc-posix-shm)", "(allow ipc-posix-sem)",
    "(allow iokit-open", '  (iokit-registry-entry-class "IOSurfaceRootUserClient")', ")", "(allow iokit-get-properties)",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "(allow sysctl-read", '  (sysctl-name "hw.ncpu")', '  (sysctl-name-prefix "hw.optional.arm")', ")",
    "(allow sysctl-write", '  (sysctl-name "kern.tcsm_enable")', ")",
    "(allow distributed-notification-post)", '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
    '(allow file-ioctl (literal "/dev/null"))',
    "(allow file-ioctl file-read-data file-write-data", "  (require-all", '    (literal "/dev/null")', "    (vnode-type CHARACTER-DEVICE)", "  )", ")",
    "; Network", ...net,
    "; File read", "(allow file-read*)",
    "(deny file-read*", ...denyRead.map((p) => `  (subpath "${p}")`), `  (with message "${tag}"))`,
    "(allow file-read-metadata", "  (vnode-type DIRECTORY))",
    "; File write",
    "(allow file-write*", ...["/dev/stdout", "/dev/null", "/dev/tty", "/tmp/claude", "/private/tmp/claude", ...writeAllow].map((p) => `  (subpath "${p}")`), `  (with message "${tag}"))`,
    "(deny file-write*", '  (subpath "/work/clone/.git/config")', '  (regex "^(.*/)?\\\\.git/commondir$")', '  (subpath "/tmp/claude")', '  (subpath "/work/clone/.git/objects/info/alternates")', `  (with message "${tag}"))`,
    ...extra,
  ];
  return lines.join("\n") + "\n";
}

const VALIDATE = {
  home: HOME,
  readDeny: [`${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.claude`],
  writeAllow: ["/work/clone", "/work/outbox", "/work/tmp"],
  writeDenyRequired: ["/work/clone/.git/config", "**/.git/commondir", "/tmp/claude", "/work/clone/.git/objects/info/alternates"],
};

// ---- static validation of a captured profile ----

test("a profile shaped like Claude Code 2.1.306's passes validation", async () => {
  const m = await load();
  const r = m.validateCapturedProfile(fixtureProfile(), VALIDATE);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ports, [51000, 51001]);
});

for (const [name, extra, code] of [
  ["open network", ["(allow network*)"], /network/],
  ["wildcard loopback bind", ['(allow network-bind (local ip "*:*"))'], /network/],
  ["a third loopback port", ['(allow network-outbound (remote ip "localhost:51002"))'], /ports/],
  ["an AF_UNIX allow", ["(allow system-socket (socket-domain AF_UNIX))"], /unix|system-socket/],
  ["a unix socket path", ['(allow network-outbound (remote unix-socket (path-regex #"^/")))'], /network|unix/],
  ["an unknown mach name", ['(allow mach-lookup (global-name "com.apple.example.evil"))'], /mach/],
  ["Launch Services open", ["(allow lsopen)"], /lsopen|unknown/],
  ["apple events", ["(allow appleevent-send)"], /appleevent|unknown/],
  ["allow default", ["(allow default)"], /default/],
  ["a write allow outside the expected set", ['(allow file-write* (subpath "/Users/tester/Documents"))'], /write/],
  ["a read re-allow of a denied path", [`(allow file-read* (subpath "${HOME}/.ssh"))`], /read/],
  ["a pty allow", ["(allow pseudo-tty)"], /pty|unknown/],
]) {
  test(`validation refuses ${name}`, async () => {
    const m = await load();
    const r = m.validateCapturedProfile(fixtureProfile({ extra }), VALIDATE);
    assert.equal(r.ok, false);
    assert.match(r.violations.join(" "), code);
  });
}

test("validation refuses a profile missing a required read deny or write deny", async () => {
  const m = await load();
  const a = m.validateCapturedProfile(fixtureProfile({ dropDeny: [`${HOME}/.aws`] }), VALIDATE);
  assert.equal(a.ok, false);
  assert.match(a.violations.join(" "), /deny_read_missing.*\.aws/);
  const b = m.validateCapturedProfile(fixtureProfile(), { ...VALIDATE, writeDenyRequired: [...VALIDATE.writeDenyRequired, "/private/tmp/claude"] });
  assert.equal(b.ok, false);
  assert.match(b.violations.join(" "), /deny_write_missing.*\/private\/tmp\/claude/);
});

test("validation refuses text that does not parse", async () => {
  const m = await load();
  const r = m.validateCapturedProfile('(version 1)\n(allow file-read* (subpath "/x")', VALIDATE);
  assert.equal(r.ok, false);
  assert.match(r.violations.join(" "), /unparseable/);
});

test("the profile hash ignores the per-command log tag and nothing else", async () => {
  const m = await load();
  const a = m.profileHash(fixtureProfile({ tag: "CMD64_YQ==_END_aaaaaa_SBX" }));
  const b = m.profileHash(fixtureProfile({ tag: "CMD64_Yg==_END_bbbbbb_SBX" }));
  assert.equal(a, b);
  assert.notEqual(a, m.profileHash(fixtureProfile({ ports: [51000, 51009] })));
  assert.notEqual(a, m.profileHash(fixtureProfile({ extra: ["(allow lsopen)"] })));
});

// ---- the probe script and its evaluation ----

const PROBE_OPTS = () => ({
  platform: "darwin",
  clone: "/work/clone",
  drivePid: 4242,
  denyTargets: [`${HOME}/.ssh`, `${HOME}/.claude`],
  canaries: [{ path: `${HOME}/.ssh/canary`, nonce: "NONCE-ONE", volPath: "/.vol/16777234/99" }],
  writeAllowed: ["/work/outbox", "/work/tmp"],
  writeDenied: [HOME, "/tmp/claude", "/private/tmp/claude"],
  toolchain: ["node", "git"],
  envAllow: ["PATH", "HOME"],
});

test("buildSelfProbe covers the sandbox-escape checks ported from the harness", async () => {
  const m = await load();
  const { script, expect, controlScript } = m.buildSelfProbe(PROBE_OPTS());
  for (const needle of ["/.vol/16777234/99", "ln -- ", "launchctl submit", "defaults write", "open -g", "mdfind", "http://[::1]:", "--noproxy", "/dev/tcp/127.0.0.1", "nc -U", "git commit", ".git/commondir", "objects/info/alternates", "git config", "security find-generic-password", "/System/Volumes/Data"]) {
    assert.ok(script.includes(needle), `script should contain ${needle}`);
  }
  assert.ok(controlScript.includes("security find-generic-password"));
  assert.equal(expect.bash_ran.k, "eq");
  assert.equal(expect.keychain.control, "keychain_rc");
  assert.equal(expect.git_commit.k, "rc0");
  assert.equal(expect.git_config_write.k, "rcNot0");
  assert.equal(expect.tool_node.k, "sameAsControl");
  assert.equal(expect.read_canary_0.k, "zero");
});

test("buildSelfProbe throws on a platform it has no probe for", async () => {
  const m = await load();
  assert.throws(() => m.buildSelfProbe({ ...PROBE_OPTS(), platform: "linux" }), /selfprobe.*linux/);
});

test("expectation keys are token-safe and the script prints each one through r()", async () => {
  const m = await load();
  const { script, expect } = m.buildSelfProbe(PROBE_OPTS());
  for (const key of Object.keys(expect)) {
    assert.match(key, /^[a-z0-9_]+$/);
    assert.ok(script.includes(`r ${key} `), `script should print ${key}`);
  }
});

function passingReport(m) {
  const { expect, controls } = (() => {
    const p = m.buildSelfProbe(PROBE_OPTS());
    return { expect: p.expect, controls: { keychain_rc: 0, tool_node_rc: 0, tool_git_rc: 0 } };
  })();
  const tokens = {};
  for (const [key, e] of Object.entries(expect)) {
    if (e.k === "eq") tokens[key] = e.v;
    else if (e.k === "rc0") tokens[key] = 0;
    else if (e.k === "rcNot0") tokens[key] = 1;
    else if (e.k === "zero") tokens[key] = 0;
    else if (e.k === "ge1") tokens[key] = 1;
    else if (e.k === "sameAsControl") tokens[key] = controls[e.control];
  }
  for (const [key, e] of Object.entries(expect)) if (e.requires) tokens[e.requires.key] = e.requires.min;
  return { platform: "darwin", captured: true, violations: [], tokens, expect, controls, canaryHits: 0, calls: 2, toolUses: 2 };
}

test("a fully passing report evaluates ok", async () => {
  const m = await load();
  const r = m.evaluateSelfProbe(passingReport(m));
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.inconclusive, []);
  assert.equal(r.ok, true);
  assert.equal(r.discard, false);
});

test("a missing token is inconclusive and refuses the step", async () => {
  const m = await load();
  const rep = passingReport(m);
  delete rep.tokens.git_commit;
  const r = m.evaluateSelfProbe(rep);
  assert.equal(r.ok, false);
  assert.ok(r.inconclusive.some((x) => /git_commit/.test(x)));
});

test("rc=0 on a read-deny target is a failure", async () => {
  const m = await load();
  const rep = passingReport(m);
  rep.tokens.read_deny_0 = 0;
  const r = m.evaluateSelfProbe(rep);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((x) => /read_deny_0/.test(x)));
});

test("a canary listener hit fails even when every curl exit code was non-zero", async () => {
  const m = await load();
  const rep = passingReport(m);
  rep.canaryHits = 1;
  const r = m.evaluateSelfProbe(rep);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((x) => /canary_listener/.test(x)));
});

test("secret-shaped env names fail", async () => {
  const m = await load();
  const rep = passingReport(m);
  rep.tokens.env_secret_names = 2;
  assert.equal(m.evaluateSelfProbe(rep).ok, false);
});

test("the keychain check is inconclusive when the unsandboxed baseline did not find the item", async () => {
  const m = await load();
  const rep = passingReport(m);
  rep.controls.keychain_rc = 44;
  const r = m.evaluateSelfProbe(rep);
  assert.equal(r.ok, false);
  assert.ok(r.inconclusive.some((x) => /keychain/.test(x)));
  assert.deepEqual(r.failures, []);
});

test("a toolchain command must exit the same as it does unsandboxed", async () => {
  const m = await load();
  const rep = passingReport(m);
  rep.tokens.tool_node = 127;
  const r = m.evaluateSelfProbe(rep);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((x) => /tool_node/.test(x)));
});

test("a bash call count that differs from the tool_use count discards the step", async () => {
  const m = await load();
  const rep = { ...passingReport(m), calls: 1, toolUses: 2 };
  const r = m.evaluateSelfProbe(rep);
  assert.equal(r.ok, false);
  assert.equal(r.discard, true);
  assert.ok(r.failures.some((x) => /call_count/.test(x)));
});

test("static violations or a refused call fail the report", async () => {
  const m = await load();
  assert.equal(m.evaluateSelfProbe({ ...passingReport(m), violations: ["network_open"] }).ok, false);
  assert.equal(m.evaluateSelfProbe({ ...passingReport(m), hashMismatches: 1 }).ok, false);
});

test("a step with no Bash call and no capture is ok but says so", async () => {
  const m = await load();
  const r = m.evaluateSelfProbe({ platform: "darwin", captured: false, calls: 0, toolUses: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.noBash, true);
});

test("Bash tool uses without any captured profile fail", async () => {
  const m = await load();
  const r = m.evaluateSelfProbe({ platform: "darwin", captured: false, calls: 0, toolUses: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.discard, true);
});

test("macOS procargs visibility is reported as a known limit, not a failure", async () => {
  const m = await load();
  const r = m.evaluateSelfProbe(passingReport(m));
  assert.ok(r.knownLimits.some((x) => /KERN_PROCARGS2|procargs/i.test(x)));
});

// ---- canary listener ----

test("the canary listener counts every connection it receives", async () => {
  const m = await load();
  const l = await m.startCanaryListener();
  try {
    assert.ok(l.port > 0);
    assert.equal(l.hits(), 0);
    await new Promise((res) => { const s = net.connect(l.port, "127.0.0.1", () => { s.end(); res(); }); });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(l.hits(), 1);
  } finally {
    await l.close();
  }
});

// ---- the shim, against a fake sandbox-exec ----

function setup(m, { probe, validate = VALIDATE, sandboxExecBody } = {}) {
  const root = tmp();
  const fake = join(root, "fake-sandbox-exec");
  writeFileSync(fake, sandboxExecBody ?? '#!/bin/sh\n[ "$1" = "-p" ] && shift 2\nexec "$@"\n', { mode: 0o755 });
  const dir = join(root, "shim");
  const inst = m.installShim(dir, {
    validate,
    probe: probe ?? { script: "echo bash_ran=1", expect: { bash_ran: { k: "eq", v: 1 } }, controls: {} },
    sandboxExec: fake,
  });
  return { root, fake, dir, inst };
}

function wrapped(ctx, { profile = fixtureProfile(), cmd = "echo ran", envArgs = ["-u", "SOMETHING", "FOO=bar"] } = {}) {
  return spawnSync(join(ctx.inst.binDir, "env"), [...envArgs, ctx.fake, "-p", profile, "/bin/sh", "-c", cmd], { encoding: "utf8" });
}

test("installShim writes a read-only `env` shim, a read-only config and a log dir", async () => {
  const m = await load();
  const ctx = setup(m);
  assert.ok(existsSync(join(ctx.inst.binDir, "env")));
  assert.equal(statSync(join(ctx.inst.binDir, "env")).mode & 0o222, 0);
  assert.equal(statSync(ctx.inst.configPath).mode & 0o222, 0);
  assert.ok(readFileSync(join(ctx.inst.binDir, "env"), "utf8").startsWith(`#!${process.execPath}`));
  m.uninstallShim(ctx.dir);
});

test("the shim never reads configuration from the environment", async () => {
  const m = await load();
  const src = readFileSync(join(HERE, "..", "drive", "sandbox-shim", "shim.cjs"), "utf8");
  assert.ok(!/process\.env/.test(src), "shim.cjs must not consult process.env for its own settings");
  assert.ok(m);
});

test("the first sandboxed call is validated, probed, and then the real command runs", async () => {
  const m = await load();
  const ctx = setup(m);
  const r = wrapped(ctx, { cmd: "echo real-output; exit 3" });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /real-output/);
  const rep = m.readShimReport(ctx.dir);
  assert.equal(rep.captured, true);
  assert.equal(rep.ok, true);
  assert.equal(rep.calls, 1);
  assert.deepEqual(rep.tokens, { bash_ran: 1 });
  m.uninstallShim(ctx.dir);
});

test("a failing replayed probe refuses the command with a marker and does not run it", async () => {
  const m = await load();
  const victim = tmp();
  const ctx = setup(m, { probe: { script: `ls -- ${victim} >/dev/null 2>&1; echo read_deny_0=$?`, expect: { read_deny_0: { k: "rcNot0" } }, controls: {} } });
  const marker = join(victim, "ran");
  const r = wrapped(ctx, { cmd: `touch ${marker}` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DETENT_SELFPROBE_REFUSED/);
  assert.equal(existsSync(marker), false);
  const rep = m.readShimReport(ctx.dir);
  assert.equal(rep.ok, false);
  const second = wrapped(ctx, { cmd: `touch ${marker}` });
  assert.match(second.stderr, /DETENT_SELFPROBE_REFUSED/);
  assert.equal(existsSync(marker), false);
  assert.equal(m.readShimReport(ctx.dir).calls, 2);
  m.uninstallShim(ctx.dir);
});

test("a weakened profile is refused before any replay", async () => {
  const m = await load();
  const witness = join(tmp(), "replayed");
  const ctx = setup(m, { probe: { script: `touch ${witness}; echo bash_ran=1`, expect: { bash_ran: { k: "eq", v: 1 } }, controls: {} } });
  const r = wrapped(ctx, { profile: fixtureProfile({ extra: ["(allow network*)"] }) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DETENT_SELFPROBE_REFUSED.*network/s);
  assert.equal(existsSync(witness), false);
  assert.match(m.readShimReport(ctx.dir).violations.join(" "), /network/);
  m.uninstallShim(ctx.dir);
});

test("later commands pass when only the log tag changed and are refused when the profile changed", async () => {
  const m = await load();
  const ctx = setup(m);
  assert.equal(wrapped(ctx, { profile: fixtureProfile({ tag: "CMD64_YQ==_END_aaaaaa_SBX" }) }).status, 0);
  assert.equal(wrapped(ctx, { profile: fixtureProfile({ tag: "CMD64_Yg==_END_bbbbbb_SBX" }) }).status, 0);
  const bad = wrapped(ctx, { profile: fixtureProfile({ ports: [51000, 51009] }) });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /DETENT_SELFPROBE_REFUSED.*changed/s);
  const rep = m.readShimReport(ctx.dir);
  assert.equal(rep.calls, 3);
  assert.equal(rep.hashMismatches, 1);
  m.uninstallShim(ctx.dir);
});

test("a call that is not a sandbox wrapper passes straight through and is not counted", async () => {
  const m = await load();
  const ctx = setup(m);
  const r = spawnSync(join(ctx.inst.binDir, "env"), ["FOO=1", "/bin/sh", "-c", 'echo "$FOO"'], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "1");
  assert.equal(m.readShimReport(ctx.dir).calls, 0);
  m.uninstallShim(ctx.dir);
});

test("a shim that cannot write its log is running inside a sandbox and passes through uncounted", async () => {
  const m = await load();
  const ctx = setup(m);
  chmodSync(ctx.inst.logDir, 0o500);
  try {
    const r = wrapped(ctx, { cmd: "echo inner" });
    assert.equal(r.stdout.trim(), "inner");
    assert.equal(r.status, 0);
  } finally {
    chmodSync(ctx.inst.logDir, 0o700);
  }
  assert.equal(m.readShimReport(ctx.dir).calls, 0);
  m.uninstallShim(ctx.dir);
});

test("the replay gets the captured env assignments and stdin/stdout pass through to the real command", async () => {
  const m = await load();
  const ctx = setup(m, { probe: { script: 'echo bash_ran=1; [ "$FOO" = bar ]; echo foo_seen=$?', expect: { bash_ran: { k: "eq", v: 1 }, foo_seen: { k: "rc0" } }, controls: {} } });
  const r = spawnSync(join(ctx.inst.binDir, "env"), ["-u", "SOMETHING", "FOO=bar", ctx.fake, "-p", fixtureProfile(), "/bin/sh", "-c", "cat; echo $FOO"], { input: "piped\n", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "piped\nbar\n");
  assert.equal(m.readShimReport(ctx.dir).ok, true);
  m.uninstallShim(ctx.dir);
});

test("a replayed probe that touches the canary listener fails the capture", async () => {
  const m = await load();
  const ctx = setup(m, { probe: { script: 'echo bash_ran=1; /bin/sh -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null; bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null; true', expect: { bash_ran: { k: "eq", v: 1 } }, controls: {} } });
  const r = wrapped(ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DETENT_SELFPROBE_REFUSED.*canary/s);
  assert.ok(m.readShimReport(ctx.dir).canaryHits >= 1);
  m.uninstallShim(ctx.dir);
});
