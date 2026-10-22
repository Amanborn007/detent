// drive-implement-profile-review.test.mjs — findings from the security review
// of the implement profile (H1, H2, M1, M2, M4, L1, L3, L4).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const load = () => import("../drive/implement-profile.mjs");
const { createClaudeTmp, removeClaudeTmp } = await load();
const madeTmps = [];
const freshClaudeTmp = () => { const d = createClaudeTmp(); madeTmps.push(d); return d; };
after(() => { for (const d of madeTmps) removeClaudeTmp(d); });
const mk = (...p) => { mkdirSync(join(...p), { recursive: true }); return join(...p); };

function mkCtx(over = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "impl-rv-")));
  const sroot = join(home, "S");
  const step = join(sroot, "1");
  return {
    home, sroot,
    clone: join(step, "clone"), inputs: join(step, "inputs"), outbox: join(step, "outbox"),
    tmp: join(step, "tmp"), claudeTmp: freshClaudeTmp(),
    settingsPath: join(step, "settings.json"),
    platform: "darwin", uid: 501, userTmp: "/private/var/folders/zz/T",
    path: ["/usr/bin"], model: "m", maxBudgetUsd: 1, maxTurns: 5,
    ...over,
  };
}

test("H1: HOME, its alias spellings and arbitrary repo bin dirs never reach allowRead", async () => {
  const { buildImplementSettings, validateImplementSettings } = await load();
  const ctx = mkCtx();
  mk(ctx.home, "bin"); mk(ctx.home, "code/repo/bin"); mk(ctx.home, "code/repo/lib");
  const c = { ...ctx, path: [ctx.home + "/", ctx.home + "/bin/..", join(ctx.home, "code/repo/bin"), ctx.home + "/.", "/usr/bin"] };
  const s = buildImplementSettings(c);
  const ar = s.sandbox.filesystem.allowRead;
  for (const bad of [c.home, c.home + "/", join(c.home, "bin"), join(c.home, "code/repo/bin"), join(c.home, "code/repo/lib"), join(c.home, "code")]) {
    assert.ok(!ar.includes(bad), `allowRead has ${bad}`);
  }
  validateImplementSettings(s, c);
});

test("H1: a symlink PATH entry that resolves to HOME is ignored", async () => {
  const { detectToolchainRoots } = await load();
  const ctx = mkCtx();
  const link = join(ctx.home, "lnk");
  symlinkSync(ctx.home, link);
  assert.deepEqual(detectToolchainRoots(ctx.home, { path: [link] }), []);
});

test("H1: only known toolchain layouts are re-allowed", async () => {
  const { detectToolchainRoots } = await load();
  const { home } = mkCtx();
  const want = [
    mk(home, ".sdkman/candidates/java/17.0.1/bin"), mk(home, ".sdkman/candidates/java/17.0.1/lib"),
    mk(home, "go/bin"),
    mk(home, ".pyenv/versions/3.12.1/bin"), mk(home, ".pyenv/versions/3.12.1/lib"),
    mk(home, ".local/share/mise/installs/node/20.1.0/bin"), mk(home, ".local/share/mise/installs/node/20.1.0/lib"),
  ];
  const never = [mk(home, ".local/bin"), mk(home, "Library/foo/bin"), mk(home, ".claude/bin"), mk(home, ".nvm/bin"), mk(home, "go/pkg/bin")];
  const roots = detectToolchainRoots(home, { path: [...want.filter((p) => p.endsWith("/bin")), ...never] });
  for (const w of want) assert.ok(roots.includes(w), w);
  for (const n of never) assert.ok(!roots.includes(n), n);
});

test("H1: toolchains inside an excluded dir are skipped", async () => {
  const { detectToolchainRoots } = await load();
  const { home } = mkCtx();
  mk(home, ".cargo/bin");
  const roots = detectToolchainRoots(home, { path: [join(home, ".cargo/bin")], exclude: [join(home, ".cargo")] });
  assert.deepEqual(roots, []);
});

test("H1: the validator refuses a hostile allowRead", async () => {
  const { buildImplementSettings, validateImplementSettings } = await load();
  const ctx = mkCtx();
  const mut = (f) => { const s = structuredClone(buildImplementSettings(ctx)); f(s); return s; };
  const adds = {
    root: "/", home: ctx.home, parentOfHome: dirname(ctx.home), sroot: ctx.sroot,
    parentOfSroot: dirname(ctx.sroot), userTmp: ctx.userTmp, tmpClaude: "/tmp/claude",
    twin: "/System/Volumes/Data" + ctx.home,
  };
  for (const [name, p] of Object.entries(adds)) {
    assert.throws(() => validateImplementSettings(mut((s) => { s.sandbox.filesystem.allowRead.push(p); }), ctx), Error, name);
  }
});

test("M4: validateImplementSettings requires ctx", async () => {
  const { buildImplementSettings, validateImplementSettings } = await load();
  assert.throws(() => validateImplementSettings(buildImplementSettings(mkCtx())), /ctx/);
});

test("H2: managed permissions.allow and unknown permission keys are refused", async () => {
  const { validateManagedSettings } = await load();
  assert.throws(() => validateManagedSettings({ permissions: { allow: ["WebFetch(domain:github.com)"] } }), /permissions/);
  assert.throws(() => validateManagedSettings({ permissions: { defaultMode: "acceptEdits" } }), /permissions/);
  assert.throws(() => validateManagedSettings({ permissions: { additionalDirectories: ["/"] } }), /permissions/);
  assert.doesNotThrow(() => validateManagedSettings({ permissions: { deny: ["A"], ask: ["B"], disableBypassPermissionsMode: "disable" } }));
});

// User-approved rewrite of the frozen M1 test: claudeTmp moved from the step root to a short dir
// directly under /tmp, so claude's <CLAUDE_CODE_TMPDIR>/claude-<uid> fits the AF_UNIX path limit.
test("M1: claudeTmp must be a fresh private dir directly under /tmp", async () => {
  const { buildImplementEnv } = await load();
  const ctx = mkCtx();
  const env = (over) => buildImplementEnv({ PATH: "/usr/bin", USER: "u" },{ ...ctx, ...over });
  for (const bad of ["/tmp", "/private/tmp", ctx.userTmp, tmpdir(), ctx.sroot, dirname(ctx.sroot), ctx.home, "relative", join(ctx.sroot, "ok"), "/tmp/claude-x", "/tmp/claude", "/tmp/a/b"]) {
    assert.throws(() => env({ claudeTmp: bad }), Error, bad);
  }
  assert.throws(() => env({ claudeTmp: "/tmp" }), /claudeTmp/);
  assert.equal(env({ claudeTmp: ctx.claudeTmp }).CLAUDE_CODE_TMPDIR, ctx.claudeTmp);
  const open = freshClaudeTmp(); chmodSync(open, 0o755);
  assert.throws(() => env({ claudeTmp: open }), /0700/);
  const full = freshClaudeTmp(); writeFileSync(join(full, "x"), "");
  assert.throws(() => env({ claudeTmp: full }), /empty|fresh/);
  const sym = join("/tmp", `dt-${randomBytes(3).toString("hex")}`);
  symlinkSync(ctx.home, sym);
  try { assert.throws(() => env({ claudeTmp: sym }), /real directory/); } finally { rmSync(sym, { force: true }); }
});

test("M1: the validator also refuses a bad claudeTmp", async () => {
  const { buildImplementSettings, validateImplementSettings } = await load();
  const ctx = mkCtx();
  const s = buildImplementSettings(ctx);
  assert.throws(() => validateImplementSettings(s, { ...ctx, claudeTmp: "/tmp" }), /claudeTmp/);
});

test("M2: the per-uid claude tmp dirs and the user's TMPDIR are denied for read", async () => {
  const { buildImplementSettings, validateImplementSettings } = await load();
  const ctx = mkCtx();
  const s = buildImplementSettings(ctx);
  const d = s.sandbox.filesystem.denyRead;
  for (const p of ["/tmp/claude-501", "/private/tmp/claude-501", ctx.userTmp]) {
    assert.ok(d.includes(p), p);
    assert.ok(d.includes("/System/Volumes/Data" + p), "twin " + p);
  }
  for (const p of ["/tmp/claude-501", ctx.userTmp]) {
    assert.throws(() => validateImplementSettings({
      ...s, sandbox: { ...s.sandbox, filesystem: { ...s.sandbox.filesystem, denyRead: d.filter((x) => x !== p) } },
    }, ctx), Error, p);
  }
  for (const a of s.sandbox.filesystem.allowRead.filter((x) => x.includes("/S/"))) assert.ok(a.startsWith(ctx.sroot + "/"));
});

test("L1/L3/L4: shell, chrome and CLAUDE.md loading are pinned", async () => {
  const { buildImplementEnv, buildImplementArgs } = await load();
  const ctx = mkCtx();
  const env = buildImplementEnv({ PATH: "/usr/bin", USER: "u" },ctx);
  assert.equal(env.CLAUDE_CODE_SHELL, "/bin/bash");
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  assert.ok(buildImplementArgs(ctx).includes("--no-chrome"));
});

test("auth: the child gets the real HOME as given and loads no user, project or local settings", async () => {
  const { buildImplementEnv, buildImplementArgs } = await load();
  const ctx = mkCtx();
  assert.equal(buildImplementEnv({ PATH: "/usr/bin", USER: "u", HOME: "/elsewhere" }, ctx).HOME, ctx.home);
  const a = buildImplementArgs(ctx);
  assert.equal(a[a.indexOf("--setting-sources") + 1], "");
});
