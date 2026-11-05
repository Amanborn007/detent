import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sb from "../drive/seatbelt.mjs";
import * as hb from "../drive/hostbox.mjs";

const pf = await import("../drive/preflight.mjs");
const gs = await import("../drive/gitsafe.mjs");
const shim = await import("../drive/probes/seatbelt-deny-default.mjs");

const BOX = realpathSync(mkdtempSync(join(tmpdir(), "hostbox-unit-")));
const HOME = "/Users/u";
const base = () => ({ scratch: BOX, home: HOME, loopbackPort: null, toolchainRoots: [] });
const denies = (p, path) => p.includes(`(deny file-read* (subpath "${path}"))`);

test("the probes file is a shim over the promoted seatbelt module", () => {
  const s = sb;
  assert.equal(shim.buildProbeProfile, s.buildProbeProfile);
  assert.equal(shim.defaultDenyRead, s.defaultDenyRead);
  assert.equal(shim.XCODE_SELECT_LINK, s.XCODE_SELECT_LINK);
  assert.equal(shim.OMITTED_MACH, s.OMITTED_MACH);
});

test("profile is deny-default with the three xcode allows and no lsd or coreservices names", () => {
  const p = sb.buildSeatbeltProfile(base());
  assert.match(p, /\(deny default/);
  assert.ok(p.includes('(allow file-read* (subpath "/private/var/db/xcode_select_link"))'));
  assert.ok(p.includes('(allow file-read* (subpath "/Library/Preferences/com.apple.dt.Xcode.plist"))'));
  assert.ok(p.includes('(sysctl-name "kern.iossupportversion")'));
  assert.ok(p.includes("(deny lsopen)"));
  assert.ok(p.includes("(deny appleevent-send)"));
  assert.ok(!/\(global-name "com\.apple\.(coreservices|lsd|securityd|SecurityServer)/.test(p));
});

test("HOME and the shared claude tmps are denied, not just the named credential dirs", () => {
  const p = sb.buildSeatbeltProfile(base());
  for (const d of [HOME, "/tmp/claude", "/private/tmp/claude", `${HOME}/.ssh`]) assert.ok(denies(p, d), d);
});

test("readOnly and toolchain roots are re-allowed after the HOME deny, in that order", () => {
  const p = sb.buildSeatbeltProfile({ ...base(), readOnly: [`${HOME}/clone`], toolchainRoots: [`${HOME}/.nvm/versions/node/v20/bin`] });
  const deny = p.indexOf(`(deny file-read* (subpath "${HOME}"))`);
  for (const d of [`${HOME}/clone`, `${HOME}/.nvm/versions/node/v20/bin`]) {
    const allow = p.indexOf(`(allow file-read* (subpath "${d}"))`);
    assert.ok(allow > deny && deny >= 0, d);
  }
});

test("the box dir itself stays readable even when it sits under HOME", () => {
  const box = `${HOME}/work/box`;
  const p = sb.buildSeatbeltProfile({ ...base(), scratch: box });
  assert.ok(p.indexOf(`(allow file-read* (subpath "${box}"))`) > p.indexOf(`(deny file-read* (subpath "${HOME}"))`));
});

test("a null loopbackPort emits no network line and a port emits exactly one", () => {
  const s = sb;
  assert.ok(!s.buildSeatbeltProfile(base()).includes("network-outbound"));
  const p = s.buildSeatbeltProfile({ ...base(), loopbackPort: 3128 });
  assert.equal(p.split("\n").filter((l) => l.includes("network-outbound")).length, 1);
  assert.ok(p.includes('(allow network-outbound (remote ip "localhost:3128"))'));
});

test("buildProbeProfile still refuses an out-of-range port, and undefined is not null", () => {
  const s = sb;
  assert.throws(() => s.buildProbeProfile({ scratch: BOX, loopbackPort: 0 }), /loopbackPort/);
  assert.throws(() => s.buildProbeProfile({ scratch: BOX }), /loopbackPort/);
});

test("the only write root is the box and a writable entry outside it throws", () => {
  const s = sb;
  const p = s.buildSeatbeltProfile({ ...base(), writable: [join(BOX, "work"), join(BOX, "out")] });
  assert.equal(p.split("\n").filter((l) => l.startsWith("(allow file-write*")).length, 4);
  for (const w of [join(BOX, "work"), join(BOX, "out"), join(BOX, "home"), join(BOX, "tmp")]) assert.ok(p.includes(`(allow file-write* (subpath "${w}")`), w);
  assert.ok(!p.includes(`(allow file-write* (subpath "${BOX}")`));
  assert.throws(() => s.buildSeatbeltProfile({ ...base(), writable: ["/etc"] }), /outside the box/);
  assert.throws(() => s.buildSeatbeltProfile({ ...base(), writable: [BOX + "/../x"] }), /not normalized|outside the box/);
});

test("unsafe seatbelt input throws instead of being escaped silently", () => {
  const s = sb;
  assert.throws(() => s.buildSeatbeltProfile({ ...base(), readOnly: ["relative"] }), /absolute/);
  assert.throws(() => s.buildSeatbeltProfile({ ...base(), home: "relative" }), /absolute/);
});

const BW = () => ({ roBinds: ["/opt/tool"], rwBinds: [BOX], net: "none", cwd: BOX, cmd: "/usr/bin/true", args: ["a"] });

test("bwrap argv unshares everything, dies with the parent and starts a new session", () => {
  const a = hb.bwrapArgv(BW());
  for (const f of ["--unshare-all", "--die-with-parent", "--new-session"]) assert.ok(a.includes(f), f);
  assert.ok(!a.includes("--share-net"));
});

test("bwrap argv mounts a fresh /tmp, proc and dev, and no HOME", () => {
  const a = hb.bwrapArgv(BW());
  const at = (flag, v) => a.some((x, i) => x === flag && a[i + 1] === v);
  assert.ok(at("--tmpfs", "/tmp"));
  assert.ok(at("--proc", "/proc"));
  assert.ok(at("--dev", "/dev"));
  assert.ok(at("--ro-bind", "/usr"));
  assert.ok(!a.some((x) => x === process.env.HOME || (process.env.HOME && x.startsWith(process.env.HOME + "/"))));
});

test("bwrap argv binds the box read-write and the extras read-only, then -- before the command", () => {
  const a = hb.bwrapArgv(BW());
  const has = (flag, p) => a.some((x, i) => x === flag && a[i + 1] === p && a[i + 2] === p);
  assert.ok(has("--bind", BOX));
  assert.ok(has("--ro-bind", "/opt/tool"));
  const dd = a.indexOf("--");
  assert.ok(dd > 0);
  assert.deepEqual(a.slice(dd), ["--", "/usr/bin/true", "a"]);
  assert.ok(a.some((x, i) => x === "--chdir" && a[i + 1] === BOX && i < dd));
});

test("bwrap argv refuses a relative command, relative binds and any net but none", () => {
  const h = hb;
  assert.throws(() => h.bwrapArgv({ ...BW(), cmd: "true" }), (e) => e.code === "hostbox_bad_argument");
  assert.throws(() => h.bwrapArgv({ ...BW(), roBinds: ["rel"] }), (e) => e.code === "hostbox_bad_argument");
  assert.throws(() => h.bwrapArgv({ ...BW(), net: { socket: "/x" } }), (e) => e.code === "setup_egress_unsupported");
});

const SPAWN_SYNC = (r) => () => r;

test("detectNested reads sandbox_apply from sandbox-exec stderr", () => {
  const { detectNested } = hb;
  const nested = detectNested({ platform: "darwin", spawn: SPAWN_SYNC({ status: 71, stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n" }) });
  assert.equal(nested.nested, true);
  assert.ok(nested.detail);
  assert.deepEqual(Object.keys(nested).sort(), ["detail", "nested"]);
  assert.equal(detectNested({ platform: "darwin", spawn: SPAWN_SYNC({ status: 0, stderr: "" }) }).nested, false);
});

test("detectNested never maps an exit code alone to nested", () => {
  const { detectNested } = hb;
  assert.throws(() => detectNested({ platform: "darwin", spawn: SPAWN_SYNC({ status: 71, stderr: "usage error" }) }), (e) => e.code === "sandbox_probe_failed");
  assert.throws(() => detectNested({ platform: "darwin", spawn: SPAWN_SYNC({ error: new Error("ENOENT") }) }), (e) => e.code === "sandbox_probe_failed");
});

test("detectNested has no separate linux signal and spawns nothing there", () => {
  let n = 0;
  const r = hb.detectNested({ platform: "linux", spawn: () => { n++; return { status: 0 }; } });
  assert.equal(r.nested, false);
  assert.equal(n, 0);
});

test("detectNested output is accepted as preflight's nested param", () => {
  const { detectNested } = hb;
  const pre = (spawn) => pf.implementPreflight({
    env: { PATH: "/usr/bin" }, platform: "darwin", managedSettings: [],
    versions: { claude: "2.1.306", git: "2.45.1", node: "20.0.0" }, which: () => null, exists: () => true,
    nested: () => detectNested({ platform: "darwin", spawn }),
  });
  assert.equal(pre(SPAWN_SYNC({ status: 0, stderr: "" })).ok, true);
  const r = pre(SPAWN_SYNC({ status: 71, stderr: "sandbox_apply: Operation not permitted" }));
  assert.deepEqual(r.refusals.map((x) => x.code), ["sandbox_unavailable:nested"]);
});

const PARENT = { PATH: "/usr/bin:/bin", HOME: "/Users/real", USER: "real", LANG: "en_US.UTF-8", LC_CTYPE: "UTF-8", GITHUB_TOKEN: "ghp_x", SSH_AUTH_SOCK: "/s", AWS_SECRET_ACCESS_KEY: "k", AWS_PROFILE: "p", GH_TOKEN: "t" };
const ENV = (o = {}) => hb.buildHostboxEnv({ platform: "linux", box: BOX, parentEnv: PARENT, ...o });

test("child env is built from an allowlist, never the parent env", () => {
  const e = ENV();
  for (const k of ["GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "GH_TOKEN", "USER", "LOGNAME"]) assert.ok(!(k in e), k);
  assert.equal(e.HOME, join(BOX, "home"));
  assert.equal(e.TMPDIR, join(BOX, "tmp"));
  assert.equal(e.TERM, "dumb");
  assert.equal(e.SHELL, "/bin/sh");
  assert.equal(e.LANG, "en_US.UTF-8");
  assert.equal(e.LC_CTYPE, "UTF-8");
  assert.equal(e.PATH, "/usr/bin:/bin");
  assert.equal(e.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(e.GIT_TERMINAL_PROMPT, "0");
  assert.ok(!("HTTPS_PROXY" in e));
});

test("a PATH entry inside the box or a relative-only PATH throws", () => {
  const h = hb;
  assert.throws(() => ENV({ path: `/usr/bin:${BOX}/node_modules/.bin` }), (e) => e.code === "hostbox_path_in_box");
  assert.throws(() => ENV({ path: "bin:." }), (e) => e.code === "hostbox_path_empty");
  assert.equal(h.buildHostboxEnv({ platform: "linux", box: BOX, parentEnv: PARENT, path: "/a:rel:/b" }).PATH, "/a:/b");
});

test("a secret-named extra throws and an unlisted extra throws", () => {
  assert.throws(() => ENV({ extra: { NPM_TOKEN: "x" } }), (e) => e.code === "hostbox_env_secret");
  assert.throws(() => ENV({ extra: { AWS_SECRET_ACCESS_KEY: "x" } }), (e) => e.code === "hostbox_env_secret");
  assert.throws(() => ENV({ extra: { FOO: "x" } }), (e) => e.code === "hostbox_env_forbidden");
  assert.equal(ENV({ extra: { CI: "1", GIT_AUTHOR_NAME: "a" } }).GIT_AUTHOR_NAME, "a");
});

test("setup env adds the proxy and npm cache vars, and a caller cannot set them", () => {
  const e = hb.buildHostboxEnv({ platform: "darwin", box: BOX, parentEnv: PARENT, net: { port: 3128 }, developerDir: "/Library/Developer/CommandLineTools" });
  assert.equal(e.HTTPS_PROXY, "http://127.0.0.1:3128");
  assert.equal(e.https_proxy, "http://127.0.0.1:3128");
  assert.equal(e.NO_PROXY, "");
  assert.equal(e.npm_config_cache, join(BOX, "cache"));
  assert.equal(e.npm_config_userconfig, "/dev/null");
  assert.throws(() => hb.buildHostboxEnv({ platform: "darwin", box: BOX, parentEnv: PARENT, net: { port: 3128 }, developerDir: "/x", extra: { HTTPS_PROXY: "http://evil" } }), (er) => er.code === "hostbox_env_forbidden");
});

test("DEVELOPER_DIR is set on darwin only", () => {
  const h = hb;
  assert.equal(h.buildHostboxEnv({ platform: "darwin", box: BOX, parentEnv: PARENT, developerDir: "/Library/Developer/CommandLineTools" }).DEVELOPER_DIR, "/Library/Developer/CommandLineTools");
  assert.ok(!("DEVELOPER_DIR" in ENV()));
});

test("gitsafe exports hardEnv and resolveGit for the host box", () => {
  assert.equal(typeof gs.hardEnv, "function");
  assert.equal(typeof gs.resolveGit, "function");
  assert.equal(gs.hardEnv().GIT_CONFIG_NOSYSTEM, "1");
  assert.ok(gs.resolveGit().startsWith("/"));
});

function fakeSpawn() {
  const calls = [];
  const spawn = (bin, argv, opts) => {
    const c = new EventEmitter();
    c.pid = 424242;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    calls.push({ bin, argv, opts, child: c });
    return c;
  };
  spawn.calls = calls;
  return spawn;
}

const RUN = (o = {}) => hb.runInHostbox({
  platform: "linux", box: BOX, cmd: "/usr/bin/true", args: [], cwd: BOX, net: "none", timeoutMs: 5000,
  parentEnv: PARENT, which: (n) => `/usr/bin/${n}`, kill: () => {}, ...o,
});
const DARWIN = { platform: "darwin", home: HOME, toolchainRoots: [], developerDir: "/Library/Developer/CommandLineTools" };
const exitWith = (spawn, { out = "", err = "", code = 0, signal = null } = {}) => setImmediate(() => {
  const { child } = spawn.calls[0];
  if (out) child.stdout.write(out);
  if (err) child.stderr.write(err);
  child.stdout.end(); child.stderr.end();
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
});

test("a missing bwrap throws and nothing is spawned unboxed", async () => {
  const spawn = fakeSpawn();
  await assert.rejects(RUN({ spawn, which: () => null }), (e) => e.code === "bwrap_missing");
  assert.equal(spawn.calls.length, 0);
});

test("linux with net other than none throws setup_egress_unsupported and spawns nothing", async () => {
  const spawn = fakeSpawn();
  await assert.rejects(RUN({ spawn, net: { socket: "/x.sock" } }), (e) => e.code === "setup_egress_unsupported");
  assert.equal(spawn.calls.length, 0);
});

test("linux runs bwrap detached with an allowlisted env and ignored stdin", async () => {
  const spawn = fakeSpawn();
  const p = RUN({ spawn });
  exitWith(spawn, { out: "hi" });
  const r = await p;
  const c = spawn.calls[0];
  assert.equal(c.bin, "/usr/bin/bwrap");
  assert.ok(c.argv.includes("--unshare-all"));
  assert.equal(c.opts.detached, true);
  assert.deepEqual(c.opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(c.opts.shell, undefined);
  for (const k of ["GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY", "GH_TOKEN"]) assert.ok(!(k in c.opts.env), k);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "hi");
  assert.equal(r.timedOut, false);
});

test("darwin runs sandbox-exec with the generated profile and absolute command", async () => {
  const spawn = fakeSpawn();
  const p = RUN({ spawn, ...DARWIN, cmd: "/usr/bin/git", args: ["status"] });
  exitWith(spawn);
  await p;
  const c = spawn.calls[0];
  assert.equal(c.bin, "/usr/bin/sandbox-exec");
  assert.equal(c.argv[0], "-p");
  assert.match(c.argv[1], /\(deny default/);
  assert.ok(!c.argv[1].includes("network-outbound"));
  assert.deepEqual(c.argv.slice(2), ["/usr/bin/git", "status"]);
});

test("darwin with a proxy port opens exactly that port", async () => {
  const spawn = fakeSpawn();
  const p = RUN({ spawn, ...DARWIN, net: { port: 4567 } });
  exitWith(spawn);
  await p;
  assert.ok(spawn.calls[0].argv[1].includes('"localhost:4567"'));
  assert.equal(spawn.calls[0].opts.env.HTTPS_PROXY, "http://127.0.0.1:4567");
});

test("a writable outside the box, a relative cmd, an unknown platform and an unknown net all throw", async () => {
  const spawn = fakeSpawn();
  await assert.rejects(RUN({ spawn, writable: ["/etc"] }), (e) => e.code === "hostbox_writable_outside_box");
  await assert.rejects(RUN({ spawn, cmd: "true" }), (e) => e.code === "hostbox_bad_argument");
  await assert.rejects(RUN({ spawn, platform: "win32" }), (e) => e.code === "hostbox_unsupported_platform");
  await assert.rejects(RUN({ spawn, ...DARWIN, net: "open" }), (e) => e.code === "hostbox_bad_argument");
  assert.equal(spawn.calls.length, 0);
});

test("a secret-named extra env throws before anything is spawned", async () => {
  const spawn = fakeSpawn();
  await assert.rejects(RUN({ spawn, env: { GITHUB_TOKEN: "x" } }), (e) => e.code === "hostbox_env_secret");
  assert.equal(spawn.calls.length, 0);
});

test("exit 71 is nested only when stderr carries sandbox_apply", async () => {
  let spawn = fakeSpawn();
  let p = RUN({ spawn, ...DARWIN });
  exitWith(spawn, { err: "sandbox-exec: sandbox_apply: Operation not permitted\n", code: 71 });
  await assert.rejects(p, (e) => e.code === "sandbox_unavailable:nested");
  spawn = fakeSpawn();
  p = RUN({ spawn, ...DARWIN });
  exitWith(spawn, { err: "tool failed\n", code: 71 });
  assert.equal((await p).code, 71);
});

test("stdout and stderr are capped at 1 MiB with head, tail, a flag and a hash of the full stream", async () => {
  const { createHash } = await import("node:crypto");
  const spawn = fakeSpawn();
  const p = RUN({ spawn });
  const { child } = spawn.calls[0];
  const chunk = Buffer.alloc(64 * 1024, "a");
  const full = createHash("sha256");
  setImmediate(() => {
    for (let i = 0; i < 48; i++) {
      const c = Buffer.from(chunk);
      c.write(String(i).padStart(4, "0"));
      full.update(c);
      child.stdout.write(c);
    }
    child.stdout.write("TAILMARK");
    full.update("TAILMARK");
    child.stdout.end(); child.stderr.end();
    child.emit("exit", 0, null); child.emit("close", 0, null);
  });
  const r = await p;
  assert.equal(r.truncated.stdout, true);
  assert.equal(r.truncated.stderr, false);
  assert.ok(Buffer.byteLength(r.stdout) < 1024 * 1024 + 512);
  assert.ok(r.stdout.startsWith("0000"));
  assert.ok(r.stdout.endsWith("TAILMARK"));
  assert.equal(r.sha256.stdout, full.digest("hex"));
  assert.equal(r.bytes.stdout, 48 * 64 * 1024 + 8);
});

test("a timeout kills bwrap's own pid on linux and the process group on darwin", async () => {
  const kills = [];
  const kill = (pid, sig) => kills.push([pid, sig]);
  let spawn = fakeSpawn();
  let p = RUN({ spawn, kill, timeoutMs: 20 });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(kills.some(([pid, sig]) => pid === 424242 && sig === "SIGKILL"));
  assert.ok(kills.every(([pid]) => pid > 0));
  const { child } = spawn.calls[0];
  child.stdout.end(); child.stderr.end();
  child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
  assert.equal((await p).timedOut, true);

  kills.length = 0;
  spawn = fakeSpawn();
  p = RUN({ spawn, kill, timeoutMs: 20, ...DARWIN });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(kills.some(([pid]) => pid === -424242));
  const d = spawn.calls[0].child;
  d.stdout.end(); d.stderr.end();
  d.emit("exit", null, "SIGKILL"); d.emit("close", null, "SIGKILL");
  assert.equal((await p).timedOut, true);
});
