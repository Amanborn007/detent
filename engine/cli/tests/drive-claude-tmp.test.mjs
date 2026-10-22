// drive-claude-tmp.test.mjs — claude's per-uid tmp dir must stay out of the shared /tmp/claude-<uid>.
// Claude only honours CLAUDE_CODE_TMPDIR when <dir>/claude-<uid> is at most 44 bytes (AF_UNIX), so
// drive hands it a short dir directly under /tmp and denies the shared per-uid dirs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const m = await import("../drive/implement-profile.mjs");
const sp = await import("../drive/selfprobe.mjs");
const made = [];
const fresh = () => { const d = m.createClaudeTmp(); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function mkCtx(over = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "impl-ct-")));
  const step = join(home, "S", "1");
  return {
    home, sroot: join(home, "S"), clone: join(step, "clone"), inputs: join(step, "inputs"),
    outbox: join(step, "outbox"), tmp: join(step, "tmp"), claudeTmp: fresh(),
    settingsPath: join(step, "settings.json"), platform: "darwin", uid: 501,
    userTmp: "/private/var/folders/zz/T", path: ["/usr/bin"], model: "m", maxBudgetUsd: 1, maxTurns: 5, ...over,
  };
}
const env = (ctx) => m.buildImplementEnv({ PATH: "/usr/bin", USER: "u" }, ctx);

test("createClaudeTmp makes a fresh 0700 dir /tmp/dt-<6 hex> owned by us", () => {
  const a = fresh(), b = fresh();
  assert.match(a, /^\/tmp\/dt-[0-9a-f]{6}$/);
  assert.notEqual(a, b);
  const st = lstatSync(a);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  assert.equal(st.mode & 0o777, 0o700);
  assert.equal(st.uid, process.getuid());
});

test("removeClaudeTmp deletes the dir and its contents, and refuses anything that is not a drive dir", () => {
  const d = m.createClaudeTmp();
  writeFileSync(join(d, "x"), "");
  m.removeClaudeTmp(d);
  assert.equal(existsSync(d), false);
  for (const bad of ["/tmp", "/tmp/other", "/tmp/dt-zzzzzz", "/etc", "/tmp/dt-abcdef/x", "relative"]) {
    assert.throws(() => m.removeClaudeTmp(bad), /claudeTmp/, bad);
  }
});

test("withClaudeTmp cleans up after success and after a throw, and rethrows", async () => {
  let seen;
  assert.equal(await m.withClaudeTmp(async (d) => { seen = d; assert.ok(existsSync(d)); return 7; }), 7);
  assert.equal(existsSync(seen), false);
  await assert.rejects(m.withClaudeTmp(async (d) => { seen = d; throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(seen), false);
});

test("claude's own <claudeTmp>/claude-<uid> fits 44 bytes for every uid up to 10 digits", () => {
  const d = fresh();
  for (const uid of [0, 5, 501, 12345, 99999, 4294967294]) {
    assert.ok(Buffer.byteLength(join(d, `claude-${uid}`)) <= 44, `uid ${uid}`);
    assert.equal(env(mkCtx({ uid, claudeTmp: d })).CLAUDE_CODE_TMPDIR, d);
  }
});

test("a 5-digit uid is accepted explicitly", () => {
  const d = fresh();
  assert.equal(Buffer.byteLength(join(d, "claude-12345")), d.length + 1 + "claude-12345".length);
  assert.ok(Buffer.byteLength(join(d, "claude-12345")) <= 44);
  assert.equal(env(mkCtx({ uid: 12345, claudeTmp: d })).CLAUDE_CODE_TMPDIR, d);
});

test("the 44-byte bound is exact: 44 passes, 45 fails with a clear error", () => {
  const uid = 501;
  const mk = (len) => { const d = join("/tmp", "d".repeat(len)); mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700); made.push(d); return d; };
  const ok = mk(28);
  assert.equal(Buffer.byteLength(join(ok, `claude-${uid}`)), 44);
  assert.equal(env(mkCtx({ uid, claudeTmp: ok })).CLAUDE_CODE_TMPDIR, ok);
  const long = mk(29);
  assert.throws(() => env(mkCtx({ uid, claudeTmp: long })), /44/);
});

test("claudeTmp must be directly under /tmp, outside the step root and not claude's own dirs", () => {
  const ctx = mkCtx();
  for (const bad of [join(ctx.sroot, "x"), "/tmp/claude-501", "/tmp/claudeish", "/private/tmp/dt-abcdef", "/tmp/a/dt-abcdef"]) {
    assert.throws(() => env({ ...ctx, claudeTmp: bad }), /claudeTmp/, bad);
  }
});

test("denyWrite blocks claude's shared per-uid tmp dirs, with the darwin data-volume twins", () => {
  const ctx = mkCtx();
  const dw = m.buildImplementSettings(ctx).sandbox.filesystem.denyWrite;
  for (const p of ["/tmp/claude-501", "/private/tmp/claude-501"]) {
    assert.ok(dw.includes(p), p);
    assert.ok(dw.includes(`/System/Volumes/Data${p}`), `twin of ${p}`);
  }
});

test("denyRead already covers the per-uid dirs", () => {
  const dr = m.buildImplementSettings(mkCtx()).sandbox.filesystem.denyRead;
  for (const p of ["/tmp/claude-501", "/private/tmp/claude-501", "/System/Volumes/Data/tmp/claude-501"]) assert.ok(dr.includes(p), p);
});

test("the validator requires every per-uid denyWrite entry", () => {
  const ctx = mkCtx();
  for (const p of ["/tmp/claude-501", "/private/tmp/claude-501", "/System/Volumes/Data/tmp/claude-501", "/System/Volumes/Data/private/tmp/claude-501"]) {
    const s = m.buildImplementSettings(ctx);
    s.sandbox.filesystem.denyWrite = s.sandbox.filesystem.denyWrite.filter((x) => x !== p);
    assert.throws(() => m.validateImplementSettings(s, ctx), new RegExp(`denyWrite must include ${p}`), p);
  }
  m.validateImplementSettings(m.buildImplementSettings(ctx), ctx);
});

const PROBE = { platform: "darwin", clone: "/work/clone", drivePid: 1 };

test("buildSelfProbe is unchanged unless told drive denies the per-uid dir", () => {
  const p = sp.buildSelfProbe(PROBE);
  assert.equal(p.expect.claude_uid_tmp_writable, undefined);
  assert.equal(p.expect.claude_tmpdir_matches, undefined);
});

test("denyClaudeUidTmp turns a successful write to the per-uid dir into a failure", () => {
  const p = sp.buildSelfProbe({ ...PROBE, denyClaudeUidTmp: true });
  const exp = { claude_uid_tmp_writable: p.expect.claude_uid_tmp_writable };
  assert.equal(exp.claude_uid_tmp_writable.k, "rcNot0");
  assert.match(sp.evaluateTokens({ claude_uid_tmp_writable: 0 }, exp, {}).failures.join("\n"), /claude_uid_tmp_writable/);
  for (const rc of [1, 2]) assert.deepEqual(sp.evaluateTokens({ claude_uid_tmp_writable: rc }, exp, {}).failures, []);
});

test("claudeTmp adds a realpath check of $TMPDIR against <claudeTmp>/claude-<uid>", () => {
  const p = sp.buildSelfProbe({ ...PROBE, claudeTmp: "/tmp/dt-abc123" });
  assert.equal(p.expect.claude_tmpdir_matches.k, "rc0");
  assert.ok(p.script.includes("/tmp/dt-abc123/claude-"));
  const exp = { claude_tmpdir_matches: p.expect.claude_tmpdir_matches };
  assert.match(sp.evaluateTokens({ claude_tmpdir_matches: 1 }, exp, {}).failures.join(""), /claude_tmpdir_matches/);
});

test("the $TMPDIR check passes only when it resolves to <claudeTmp>/claude-<uid>", () => {
  const d = fresh();
  const want = join(d, `claude-${process.getuid()}`);
  mkdirSync(want, { mode: 0o700 });
  const p = sp.buildSelfProbe({ ...PROBE, claudeTmp: d });
  const line = p.script.split("\n").find((l) => l.includes("claude_tmpdir_matches"));
  const run = (tmp) => spawnSync("/bin/sh", ["-c", `r() { echo "$1=$2"; }\n${line}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", TMPDIR: tmp } }).stdout.trim();
  assert.equal(run(want), "claude_tmpdir_matches=0");
  assert.notEqual(run(`/tmp/claude-${process.getuid()}`), "claude_tmpdir_matches=0");
  assert.notEqual(run(""), "claude_tmpdir_matches=0");
});

test("claude's stderr fallback warning fails the self-probe", () => {
  const base = { captured: true, calls: 1, toolUses: 1, tokens: {}, expect: {}, platform: "darwin" };
  assert.deepEqual(sp.evaluateSelfProbe({ ...base, stderr: "all fine" }).failures, []);
  for (const err of ["tmp dir falls back to /tmp/claude-502", "path too long for AF_UNIX socket"]) {
    const r = sp.evaluateSelfProbe({ ...base, stderr: err });
    assert.equal(r.ok, false);
    assert.match(r.failures.join("\n"), /claude_tmp_fallback/);
  }
});
