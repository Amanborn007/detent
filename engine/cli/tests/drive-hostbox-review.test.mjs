import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSeatbeltProfile, sbplString } from "../drive/seatbelt.mjs";
import { runInHostbox, buildHostboxEnv } from "../drive/hostbox.mjs";

const BOX = realpathSync(mkdtempSync(join(tmpdir(), "hostbox-review-")));
const HOME = "/Users/u";
const PARENT = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
const base = () => ({ scratch: BOX, home: HOME, loopbackPort: null, toolchainRoots: [] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const RUN = (o = {}) => runInHostbox({
  platform: "linux", box: BOX, cmd: "/usr/bin/true", args: [], cwd: BOX, net: "none", timeoutMs: 5000,
  parentEnv: PARENT, which: (n) => `/usr/bin/${n}`, kill: () => {}, ...o,
});
const DARWIN = { platform: "darwin", home: HOME, toolchainRoots: [], developerDir: "/Library/Developer/CommandLineTools" };
const finishChild = (child, code = 0, signal = null) => {
  child.stdout.end(); child.stderr.end();
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
};

// H1a
test("the profile denies setsid and setpgid as its last rule so no allow can reopen them", () => {
  const p = buildSeatbeltProfile(base()).trimEnd().split("\n");
  assert.equal(p.at(-1), "(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))");
});

// H2
test("the user temp dir and both claude-<uid> dirs are denied, and the box under TMPDIR stays readable", () => {
  const tmp = "/var/folders/ab/xyz/T";
  const box = `${tmp}/hostbox-1`;
  const p = buildSeatbeltProfile({ ...base(), scratch: box, userTmp: tmp, uid: 502 });
  const deny = (d) => p.indexOf(`(deny file-read* (subpath "${d}"))`);
  for (const d of [tmp, "/tmp/claude-502", "/private/tmp/claude-502"]) assert.ok(deny(d) >= 0, d);
  assert.ok(p.indexOf(`(allow file-read* (subpath "${box}"))`) > deny(tmp));
  assert.ok(p.includes(`(allow file-write* (subpath "${box}")`));
});

test("by default the realpath of os.tmpdir() and this uid's claude dirs are denied", () => {
  const p = buildSeatbeltProfile(base());
  for (const d of [realpathSync(tmpdir()), `/tmp/claude-${process.getuid()}`, `/private/tmp/claude-${process.getuid()}`]) {
    assert.ok(p.includes(`(deny file-read* (subpath "${d}"))`), d);
  }
});

// M1
test("pipe data arriving after the post-exit timer settled is ignored and the pipes are destroyed", async () => {
  const spawn = fakeSpawn();
  const keepAlive = setTimeout(() => {}, 3000);
  const p = RUN({ spawn });
  const { child } = spawn.calls[0];
  child.stdout.write("early");
  child.emit("exit", 0, null);
  const r = await p;
  assert.equal(r.stdout, "early");
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.doesNotThrow(() => child.stdout.emit("data", Buffer.from("late")));
  clearTimeout(keepAlive);
});

// M3
test("a readOnly entry inside the box is refused before anything is spawned", async () => {
  for (const o of [{}, DARWIN]) {
    const spawn = fakeSpawn();
    await assert.rejects(RUN({ spawn, ...o, readOnly: [join(BOX, "work")] }), (e) => e.code === "hostbox_bad_argument");
    await assert.rejects(RUN({ spawn, ...o, readOnly: [BOX] }), (e) => e.code === "hostbox_bad_argument");
    assert.equal(spawn.calls.length, 0);
  }
});

// L1
test("a child that exits before the timeout is never timedOut and gets no later kill", async () => {
  const kills = [];
  const spawn = fakeSpawn();
  const p = RUN({ spawn, kill: (pid, sig) => kills.push([pid, sig]), timeoutMs: 60 });
  const { child } = spawn.calls[0];
  child.emit("exit", 0, null);
  await sleep(200);
  finishChild(child);
  const r = await p;
  assert.equal(r.timedOut, false);
  assert.deepEqual(kills, []);
});

test("on darwin an early exit is followed by no SIGTERM or second group kill", async () => {
  const kills = [];
  const spawn = fakeSpawn();
  const p = RUN({ spawn, ...DARWIN, kill: (pid, sig) => kills.push([pid, sig]), timeoutMs: 60 });
  const { child } = spawn.calls[0];
  child.emit("exit", 0, null);
  await sleep(200);
  finishChild(child);
  const r = await p;
  assert.equal(r.timedOut, false);
  assert.deepEqual(kills, [[-424242, "SIGKILL"]]);
});

// L2
test("exit 71 with sandbox_apply is a normal result when stdout came first", async () => {
  const spawn = fakeSpawn();
  const p = RUN({ spawn, ...DARWIN });
  const { child } = spawn.calls[0];
  child.stdout.write("built 3 files\n");
  child.stderr.write("sandbox_apply: tool mentions it\n");
  await sleep(20);
  finishChild(child, 71);
  assert.equal((await p).code, 71);
});

test("exit 71 with sandbox_apply after a long run is a normal result", async () => {
  const spawn = fakeSpawn();
  const p = RUN({ spawn, ...DARWIN });
  const { child } = spawn.calls[0];
  child.stderr.write("sandbox_apply: Operation not permitted\n");
  await sleep(1150);
  finishChild(child, 71);
  assert.equal((await p).code, 71);
});

// L3
test("profile paths reject every control character, DEL, quote and backslash", () => {
  for (const c of ["\t", "\x1b", "\x7f", "\x01", '"', "\\"]) {
    assert.throws(() => sbplString(`/a${c}b`), /not allowed/, JSON.stringify(c));
  }
  assert.throws(() => buildSeatbeltProfile({ ...base(), readOnly: ["/a\tb"] }), /not allowed/);
});

test("a readOnly entry that is HOME or an ancestor of it is refused", async () => {
  const spawn = fakeSpawn();
  for (const ro of [HOME, "/Users"]) {
    await assert.rejects(RUN({ spawn, ...DARWIN, readOnly: [ro] }), (e) => e.code === "hostbox_bad_argument", ro);
  }
  assert.equal(spawn.calls.length, 0);
  const spawn2 = fakeSpawn();
  const p = RUN({ spawn: spawn2, ...DARWIN, readOnly: [`${HOME}/clone`] });
  setImmediate(() => finishChild(spawn2.calls[0].child));
  await p;
});

test("a PATH entry that is a symlink into the box is refused, a missing entry is kept", () => {
  const link = join(mkdtempSync(join(tmpdir(), "hostbox-link-")), "bin");
  mkdirSync(join(BOX, "evil-bin"), { recursive: true });
  symlinkSync(join(BOX, "evil-bin"), link);
  const env = (path) => buildHostboxEnv({ platform: "linux", box: BOX, parentEnv: PARENT, path });
  assert.throws(() => env(`${link}:/usr/bin`), (e) => e.code === "hostbox_path_in_box");
  assert.equal(env("/nonexistent-detent-dir:/usr/bin").PATH, "/nonexistent-detent-dir:/usr/bin");
});
