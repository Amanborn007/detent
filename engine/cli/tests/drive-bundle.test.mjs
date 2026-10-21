// drive-bundle.test.mjs — verified git bundle import for drive. Every fixture is
// built with real git in temp dirs; hostile trees come from mktree/commit-tree
// because porcelain refuses to write them. Modules load dynamically so a missing
// implementation fails each test on its own assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  symlinkSync, linkSync, chmodSync, realpathSync, lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const load = () => import("../drive/bundle.mjs");
const loadSafe = () => import("../drive/gitsafe.mjs");

const ID = { name: "Detent Drive", email: "drive@detent.invalid" };
const BRANCH = "refs/heads/sdlc/run1";
const ZERO = "0".repeat(40);

const FENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: ID.name, GIT_AUTHOR_EMAIL: ID.email,
  GIT_COMMITTER_NAME: ID.name, GIT_COMMITTER_EMAIL: ID.email,
};

function g(cwd, args, { input, env } = {}) {
  const r = spawnSync("git", args, {
    cwd, input, env: { ...FENV, HOME: cwd, ...env }, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function blob(w, content) {
  return g(w, ["hash-object", "-w", "--stdin"], { input: content });
}

// spec: name -> string | {exec} | {symlink} | {gitlink} | {dir}
function buildTree(w, spec) {
  const lines = [];
  for (const [name, v] of Object.entries(spec)) {
    let mode, type, oid;
    if (typeof v === "string") { mode = "100644"; type = "blob"; oid = blob(w, v); }
    else if (v.exec !== undefined) { mode = "100755"; type = "blob"; oid = blob(w, v.exec); }
    else if (v.symlink !== undefined) { mode = "120000"; type = "blob"; oid = blob(w, v.symlink); }
    else if (v.gitlink !== undefined) { mode = "160000"; type = "commit"; oid = v.gitlink; }
    else { mode = "040000"; type = "tree"; oid = buildTree(w, v.dir); }
    lines.push(`${mode} ${type} ${oid}\t${name}`);
  }
  return g(w, ["mktree", "-z", "--missing"], { input: lines.join("\0") + "\0" });
}

const PKG = JSON.stringify(
  { name: "x", version: "1.0.0", scripts: { test: "node t.js" }, dependencies: { a: "1.0.0" } }, null, 2,
) + "\n";
const BASE_SPEC = { "README.md": "hello 2\n", "package.json": PKG, src: { dir: { "a.js": "a\n" } } };

function writeSpec(dir, spec) {
  for (const [name, v] of Object.entries(spec)) {
    if (typeof v === "string") writeFileSync(join(dir, name), v);
    else { mkdirSync(join(dir, name), { recursive: true }); writeSpec(join(dir, name), v.dir); }
  }
}

function mkWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-bundle-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  g(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "-m", "c0"]);
  const c0 = g(repo, ["rev-parse", "HEAD"]);
  writeSpec(repo, BASE_SPEC);
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "-m", "base"]);
  const base = g(repo, ["rev-parse", "HEAD"]);
  g(repo, ["branch", "sdlc/run1"]);
  const work = join(root, "work");
  g(root, ["clone", "-q", "--no-local", repo, work]);
  return { root, repo, work, base, c0, scratch: join(root, "scratch"), n: 0 };
}

function treeOf(w, extra = {}) {
  return buildTree(w.work, { ...BASE_SPEC, ...extra });
}

function commit(w, tree, parents, { env, message = "work\n" } = {}) {
  const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])];
  return g(w.work, args, { input: message, env });
}

// A linear chain of commits, each applying one extra-spec on the base tree.
function chain(w, specs, opts = {}) {
  let parent = w.base;
  for (const extra of specs) parent = commit(w, treeOf(w, extra), [parent], opts);
  return parent;
}

function bundle(w, head, { ref = BRANCH, base = w.base, refs, out } = {}) {
  const file = out || join(w.root, `b${w.n++}.bundle`);
  g(w.work, ["update-ref", ref, head]);
  g(w.work, ["bundle", "create", file, ...(refs || [ref]), `^${base}`]);
  return file;
}

function patchHeader(file, fn) {
  const buf = readFileSync(file);
  const end = buf.indexOf("\n\n") + 2;
  const head = fn(buf.subarray(0, end).toString("latin1"));
  writeFileSync(file, Buffer.concat([Buffer.from(head, "latin1"), buf.subarray(end)]));
}

function V(w, file, over = {}) {
  return load().then(({ verifyBundle }) => verifyBundle({
    bundlePath: file, repo: w.repo, base: w.base, branch: BRANCH, identity: ID,
    scratch: w.scratch, step: `s${w.n++}`, ...over,
  }));
}

function reject(r, code) {
  assert.equal(r.ok, false, `expected reject ${code}, got ok`);
  assert.equal(r.code, code, `expected ${code}, got ${r.code}: ${JSON.stringify(r.detail)}`);
}

function snap(repo) {
  const out = {};
  const walk = (rel) => {
    const abs = join(repo, ".git", rel);
    if (/^(objects|logs)(\/|$)/.test(rel) || /^refs\/(heads\/detent|detent)(\/|$)/.test(rel)) return;
    const st = lstatSync(abs);
    if (st.isDirectory()) for (const e of readdirSync(abs).sort()) walk(`${rel}/${e}`);
    else out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
  };
  for (const top of ["config", "HEAD", "hooks", "refs", "packed-refs", "info", "index"]) {
    if (existsSync(join(repo, ".git", top))) walk(top);
  }
  return out;
}

// ---------------------------------------------------------------- parseBundleHeader

const H = "a".repeat(40);
const B = "b".repeat(40);
const mkHeader = (lines) =>
  Buffer.concat([Buffer.from(lines.join("\n") + "\n\n"), Buffer.from("PACK\0\0\0\u0002")]);
const OPTS = { branch: "refs/heads/sdlc/r", base: B };

test("parseBundleHeader accepts v2 and reports the pack offset", async () => {
  const { parseBundleHeader } = await load();
  const buf = mkHeader(["# v2 git bundle", `-${B} subject`, `${H} refs/heads/sdlc/r`]);
  const r = parseBundleHeader(buf, OPTS);
  assert.equal(r.version, 2);
  assert.deepEqual(r.prerequisites.map((p) => p.oid), [B]);
  assert.deepEqual(r.refs, [{ oid: H, name: "refs/heads/sdlc/r" }]);
  assert.equal(buf.subarray(r.packOffset, r.packOffset + 4).toString(), "PACK");
});

test("parseBundleHeader accepts v3 with the sha1 object-format capability", async () => {
  const { parseBundleHeader } = await load();
  const buf = mkHeader(["# v3 git bundle", "@object-format=sha1", `-${B} s`, `${H} refs/heads/sdlc/r`]);
  const r = parseBundleHeader(buf, OPTS);
  assert.equal(r.version, 3);
  assert.deepEqual(r.capabilities, ["object-format=sha1"]);
});

test("parseBundleHeader rejects @filter and unknown capabilities", async () => {
  const { parseBundleHeader } = await load();
  for (const cap of ["@filter=blob:none", "@weird=1", "@object-format=sha256"]) {
    const buf = mkHeader(["# v3 git bundle", cap, `-${B} s`, `${H} refs/heads/sdlc/r`]);
    assert.throws(() => parseBundleHeader(buf, OPTS), (e) => e.code === "bad_capability", cap);
  }
});

test("parseBundleHeader rejects two refs, a foreign ref and a zero ref oid", async () => {
  const { parseBundleHeader } = await load();
  const two = mkHeader(["# v2 git bundle", `-${B} s`, `${H} refs/heads/sdlc/r`, `${ZERO} refs/heads/main`]);
  assert.throws(() => parseBundleHeader(two, OPTS), (e) => e.code === "extra_ref");
  const other = mkHeader(["# v2 git bundle", `-${B} s`, `${H} refs/heads/other`]);
  assert.throws(() => parseBundleHeader(other, OPTS), (e) => e.code === "wrong_ref");
  const zero = mkHeader(["# v2 git bundle", `-${B} s`, `${ZERO} refs/heads/sdlc/r`]);
  assert.throws(() => parseBundleHeader(zero, OPTS), (e) => e.code === "bad_header");
});

test("parseBundleHeader rejects a prerequisite that is not exactly the base", async () => {
  const { parseBundleHeader } = await load();
  const wrong = mkHeader(["# v2 git bundle", `-${"c".repeat(40)} s`, `${H} refs/heads/sdlc/r`]);
  assert.throws(() => parseBundleHeader(wrong, OPTS), (e) => e.code === "bad_prerequisite");
  const none = mkHeader(["# v2 git bundle", `${H} refs/heads/sdlc/r`]);
  assert.throws(() => parseBundleHeader(none, OPTS), (e) => e.code === "bad_prerequisite");
  const extra = mkHeader(["# v2 git bundle", `-${B} s`, `-${"c".repeat(40)} s`, `${H} refs/heads/sdlc/r`]);
  assert.throws(() => parseBundleHeader(extra, OPTS), (e) => e.code === "bad_prerequisite");
});

test("parseBundleHeader rejects garbage as bad_header", async () => {
  const { parseBundleHeader } = await load();
  for (const buf of [
    Buffer.from("not a bundle\n\nPACK"),
    mkHeader(["# v9 git bundle", `${H} refs/heads/sdlc/r`]),
    mkHeader(["# v2 git bundle", "@object-format=sha1", `-${B} s`, `${H} refs/heads/sdlc/r`]),
    mkHeader(["# v2 git bundle", `-${B} s`, "garbage line", `${H} refs/heads/sdlc/r`]),
    Buffer.from(`# v2 git bundle\n-${B} s\n${H} refs/heads/sdlc/r\n\nNOPE`),
    Buffer.from("# v2 git bundle\n" + "x".repeat(70000)),
  ]) {
    assert.throws(() => parseBundleHeader(buf, OPTS), (e) => e.code === "bad_header");
  }
});

// ---------------------------------------------------------------- verifyBundle

test("verifyBundle accepts two linear commits and reports them", async () => {
  const w = mkWorld();
  const head = chain(w, [
    { src: { dir: { "a.js": "a\n", "b.js": "b\n" } } },
    { src: { dir: { "a.js": "a\n", "b.js": "b\n", "c.js": "c\n" } } },
  ]);
  const file = bundle(w, head);
  const r = await V(w, file);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.head, head);
  assert.equal(r.base, w.base);
  assert.equal(r.commits.length, 2);
  assert.deepEqual([...r.changed].sort(), ["src/b.js", "src/c.js"]);
  assert.equal(r.bundle_sha256, createHash("sha256").update(readFileSync(file)).digest("hex"));
  assert.notEqual(r.copy, file);
  assert.ok(existsSync(r.copy) && existsSync(r.quarantine));
});

test("verifyBundle rejects a merge commit", async () => {
  const w = mkWorld();
  const c1 = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.base]);
  const s = commit(w, treeOf(w, { "y.txt": "1\n" }), [w.base]);
  const m = commit(w, treeOf(w, { "x.txt": "1\n", "y.txt": "1\n" }), [c1, s]);
  reject(await V(w, bundle(w, m)), "merge_commit");
});

test("verifyBundle rejects a chain not parented on the base (not_linear)", async () => {
  const w = mkWorld();
  const x = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.c0]);
  const file = bundle(w, x, { base: w.c0 });
  patchHeader(file, (h) => h.replace(`-${w.c0}`, `-${w.base}`));
  reject(await V(w, file), "not_linear");
});

test("verifyBundle rejects 51 commits", async () => {
  const w = mkWorld();
  const tree = treeOf(w, { "x.txt": "1\n" });
  let p = w.base;
  for (let i = 0; i < 51; i++) p = commit(w, tree, [p], { message: `c${i}\n` });
  reject(await V(w, bundle(w, p)), "too_many_commits");
});

test("verifyBundle rejects a foreign author", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.base], { env: { GIT_AUTHOR_EMAIL: "evil@example.invalid" } });
  reject(await V(w, bundle(w, c)), "foreign_author");
});

test("verifyBundle rejects a gpgsig header", async () => {
  const w = mkWorld();
  const tree = treeOf(w, { "x.txt": "1\n" });
  const who = `${ID.name} <${ID.email}> 1700000000 +0000`;
  const raw = `tree ${tree}\nparent ${w.base}\nauthor ${who}\ncommitter ${who}\n` +
    "gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nmsg\n";
  const c = g(w.work, ["hash-object", "-t", "commit", "--literally", "-w", "--stdin"], { input: raw });
  reject(await V(w, bundle(w, c)), "bad_commit_header");
});

test("verifyBundle rejects an oversized commit message", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.base], { message: "m".repeat(200) + "\n" });
  reject(await V(w, bundle(w, c), { caps: { msgBytes: 100 } }), "bad_message");
});

test("verifyBundle rejects a gitlink", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { sub: { gitlink: "c".repeat(40) } }), [w.base]);
  reject(await V(w, bundle(w, c)), "gitlink");
});

test("verifyBundle rejects .gitmodules at any depth", async () => {
  const w = mkWorld();
  const mod = '[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x\n';
  const c = commit(w, treeOf(w, { deep: { dir: { ".gitmodules": mod } } }), [w.base]);
  reject(await V(w, bundle(w, c)), "gitlink");
});

test("verifyBundle rejects absolute and escaping symlinks", async () => {
  for (const target of ["/etc/passwd", "../../outside", "a/../b", "C:\\x", "a\\b"]) {
    const w = mkWorld();
    const c = commit(w, treeOf(w, { lnk: { symlink: target } }), [w.base]);
    reject(await V(w, bundle(w, c)), "bad_symlink");
  }
});

test("verifyBundle rejects relative symlinks that reach a .git component", async () => {
  const targets = [".git/hooks", ".GIT/hooks", "x/.Git", ".g\u200cit/hooks", "GIT~1/hooks", ".git./hooks"];
  for (const target of targets) {
    const w = mkWorld();
    const c = commit(w, treeOf(w, { a: { symlink: target } }), [w.base]);
    reject(await V(w, bundle(w, c)), "bad_symlink");
  }
});

test("verifyBundle lets strict fsck reject a .GIT/config path", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { ".GIT": { dir: { config: "[core]\n" } } }), [w.base]);
  const file = bundle(w, c);
  const strict = spawnSync("git", ["fsck", "--strict", "--no-dangling"], { cwd: w.work, env: { ...FENV, HOME: w.work } });
  assert.notEqual(strict.status, 0, "fixture must be something strict fsck rejects");
  const r = await V(w, file);
  reject(r, "fsck_failed");
  assert.equal(r.detail.stage, "fsck");
});

test("verifyBundle rejects case-folded and NFC/NFD path collisions", async () => {
  const cases = [
    { src: { dir: { "Foo.js": "1\n", "foo.js": "2\n" } } },
    { src: { dir: { "\u00e9.txt": "1\n", "e\u0301.txt": "2\n" } } },
  ];
  for (const extra of cases) {
    const w = mkWorld();
    const c = commit(w, treeOf(w, extra), [w.base]);
    reject(await V(w, bundle(w, c)), "path_collision");
  }
});

test("verifyBundle rejects an oversized blob and an oversized total", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { "big.bin": "x".repeat(2000) }), [w.base]);
  reject(await V(w, bundle(w, c), { caps: { blobBytes: 1000 } }), "blob_too_large");
  const w2 = mkWorld();
  const c2 = commit(w2, treeOf(w2, { "a.bin": "a".repeat(1000), "b.bin": "b".repeat(1000) }), [w2.base]);
  reject(await V(w2, bundle(w2, c2), { caps: { blobBytes: 1200, newBlobTotal: 1500 } }), "bundle_too_large");
});

test("verifyBundle rejects a bundle over the byte cap", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.base]);
  reject(await V(w, bundle(w, c), { caps: { bundleBytes: 100 } }), "oversize");
});

test("verifyBundle rejects extra refs, a foreign ref, a wrong base and a deletion line", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.base]);
  g(w.work, ["update-ref", "refs/heads/other", c]);
  reject(await V(w, bundle(w, c, { refs: [BRANCH, "refs/heads/other"] })), "extra_ref");
  reject(await V(w, bundle(w, c, { ref: "refs/heads/other", refs: ["refs/heads/other"] })), "wrong_ref");
  reject(await V(w, bundle(w, c, { base: w.c0 })), "bad_prerequisite");
  const del = bundle(w, c);
  patchHeader(del, (h) => h.replace(/\n\n$/, `\n${ZERO} refs/heads/main\n\n`));
  reject(await V(w, del), "extra_ref");
});

test("verifyBundle refuses a symlinked bundle path and a hardlinked bundle", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.base]);
  const file = bundle(w, c);
  const sym = join(w.root, "sym.bundle");
  symlinkSync(file, sym);
  reject(await V(w, sym), "bad_bundle_file");
  linkSync(file, join(w.root, "hard.bundle"));
  reject(await V(w, file), "bad_bundle_file");
});

test("verifyBundle uses the private copy when the bundle is swapped afterwards", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.base]);
  const file = bundle(w, c);
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const r = await V(w, file, { _afterCopy: () => writeFileSync(file, "garbage") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bundle_sha256, sha);
  assert.equal(createHash("sha256").update(readFileSync(r.copy)).digest("hex"), sha);
});

test("verifyBundle reports a stalled git as git_timeout", async () => {
  const w = mkWorld();
  const c = commit(w, treeOf(w, { "x.txt": "1\n" }), [w.base]);
  const file = bundle(w, c);
  const fake = join(w.root, "slowgit");
  writeFileSync(fake, '#!/bin/sh\ncase "$1" in --version) echo "git version 2.50.0";; *) exec sleep 30;; esac\n');
  chmodSync(fake, 0o755);
  const t0 = Date.now();
  const r = await V(w, file, { gitOpts: { gitBin: fake, timeoutMs: 400 } });
  reject(r, "git_timeout");
  assert.ok(Date.now() - t0 < 15000);
});

test("verifyBundle classifies a happy path and flags sensitive paths", async () => {
  const w = mkWorld();
  const head = chain(w, [{
    ".github": { dir: { workflows: { dir: { "ci.yml": "on: push\n" } } } },
    sub: { dir: { ".gitattributes": "* text=auto\n" } },
    lnk: { symlink: "README.md" },
    "mise.toml": "[tools]\n",
    ".yarn": { dir: { "x.cjs": "1\n" } },
    "run.sh": { exec: "#!/bin/sh\n" },
    "plain.js": "ok\n",
  }]);
  const r = await V(w, bundle(w, head));
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const p of [".github/workflows/ci.yml", "sub/.gitattributes", "lnk", "mise.toml", ".yarn/x.cjs", "run.sh"]) {
    assert.ok(r.sensitive.includes(p), `${p} should be sensitive: ${r.sensitive}`);
  }
  assert.ok(!r.sensitive.includes("plain.js"));
  assert.equal(r.shipBlocking, true);
  const lnk = r.sensitiveDetail.find((d) => d.path === "lnk");
  assert.ok(lnk.reasons.includes("symlink"));
});

test("verifyBundle: a plain change is not sensitive and does not block shipping", async () => {
  const w = mkWorld();
  const r = await V(w, bundle(w, chain(w, [{ src: { dir: { "a.js": "a\n", "b.js": "b\n" } } }])));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.sensitive, []);
  assert.equal(r.shipBlocking, false);
});

test("verifyBundle: package.json scripts, packageManager and deps are sensitive, version is not", async () => {
  const mutate = (fn) => JSON.stringify(fn(JSON.parse(PKG)), null, 2) + "\n";
  const cases = [
    [(p) => ({ ...p, scripts: { test: "node evil.js" } }), true],
    [(p) => ({ ...p, packageManager: "yarn@4.0.0" }), true],
    [(p) => ({ ...p, dependencies: { a: "2.0.0" } }), true],
    [(p) => ({ ...p, version: "1.0.1" }), false],
  ];
  for (const [fn, expected] of cases) {
    const w = mkWorld();
    const r = await V(w, bundle(w, chain(w, [{ "package.json": mutate(fn) }])));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.sensitive.includes("package.json"), expected, mutate(fn));
  }
});

test("verifyBundle: lockfile changes are sensitive", async () => {
  const w = mkWorld();
  const r = await V(w, bundle(w, chain(w, [{ "yarn.lock": "x\n", "package-lock.json": "{}\n" }])));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([...r.sensitive].sort(), ["package-lock.json", "yarn.lock"]);
});

test("SENSITIVE_PATTERNS covers the advisory list", async () => {
  const { SENSITIVE_PATTERNS } = await load();
  const hit = (p) => SENSITIVE_PATTERNS.some((x) => x.re.test(p));
  for (const p of [
    "a/b/.gitattributes", ".github/workflows/x.yml", ".gitlab-ci.yml", ".circleci/config.yml",
    ".yarn/releases/y.cjs", "mise.toml", ".mise.toml", ".tool-versions", "lefthook.yml",
    "Taskfile.yml", "flake.nix", "devbox.json", ".husky/pre-commit", ".pre-commit-config.yaml",
    "package-lock.json", "yarn.lock", ".claude/settings.json", ".envrc", "Makefile", "build.rs",
  ]) assert.ok(hit(p), p);
  for (const p of ["src/index.js", "README.md", "docs/guide.md"]) assert.ok(!hit(p), p);
});

// ---------------------------------------------------------------- importBundle

async function verified(w, head, over = {}) {
  const r = await V(w, bundle(w, head, over.bundle), over.verify);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

function imp(w, v, over = {}) {
  return load().then(({ importBundle }) => importBundle({
    verified: v, repo: w.repo, runId: "run1", expectOld: null, ...over,
  }));
}

test("importBundle creates detent/<run> at the verified head", async () => {
  const w = mkWorld();
  const head = chain(w, [{ "x.txt": "1\n" }]);
  const r = await imp(w, await verified(w, head));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.head, head);
  assert.equal(g(w.repo, ["rev-parse", "refs/heads/detent/run1"]), head);
  g(w.repo, ["cat-file", "-e", head]);
  assert.equal(g(w.repo, ["for-each-ref", "refs/detent"]), "");
});

test("importBundle fast-forwards a second import with CAS", async () => {
  const w = mkWorld();
  const h1 = chain(w, [{ "x.txt": "1\n" }]);
  assert.equal((await imp(w, await verified(w, h1))).ok, true);
  const h2 = commit(w, treeOf(w, { "x.txt": "2\n" }), [h1]);
  const v2 = await V(w, bundle(w, h2, { base: h1 }), { base: h1 });
  assert.equal(v2.ok, true, JSON.stringify(v2));
  const r = await imp(w, v2, { expectOld: h1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(g(w.repo, ["rev-parse", "refs/heads/detent/run1"]), h2);
});

test("importBundle gives import_conflict when the branch moved or already exists", async () => {
  const w = mkWorld();
  const h1 = chain(w, [{ "x.txt": "1\n" }]);
  assert.equal((await imp(w, await verified(w, h1))).ok, true);
  const h2 = commit(w, treeOf(w, { "x.txt": "2\n" }), [h1]);
  const v2 = await V(w, bundle(w, h2, { base: h1 }), { base: h1 });
  g(w.repo, ["update-ref", "refs/heads/detent/run1", w.base]);
  reject(await imp(w, v2, { expectOld: h1 }), "import_conflict");
  assert.equal(g(w.repo, ["rev-parse", "refs/heads/detent/run1"]), w.base);
  reject(await imp(w, v2, { expectOld: null }), "import_conflict");
});

test("importBundle leaves config, hooks, other refs and the worktree byte-identical", async () => {
  const w = mkWorld();
  mkdirSync(join(w.repo, ".git", "hooks"), { recursive: true });
  writeFileSync(join(w.repo, ".git", "hooks", "post-merge"), "#!/bin/sh\ntouch HOOK_RAN\n");
  chmodSync(join(w.repo, ".git", "hooks", "post-merge"), 0o755);
  const head = chain(w, [{ "x.txt": "1\n" }]);
  const v = await verified(w, head);
  const before = snap(w.repo);
  const r = await imp(w, v);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(snap(w.repo), before);
  assert.equal(g(w.repo, ["status", "--porcelain"]), "");
  assert.ok(!existsSync(join(w.repo, "HOOK_RAN")));
  assert.equal(g(w.repo, ["rev-parse", "refs/heads/sdlc/run1"]), w.base);
});

test("verify and import never run push, checkout or merge", async () => {
  const { setGitSpy } = await loadSafe();
  const calls = [];
  setGitSpy((c) => calls.push(c.argv));
  try {
    const w = mkWorld();
    const head = chain(w, [{ "x.txt": "1\n" }]);
    assert.equal((await imp(w, await verified(w, head))).ok, true);
  } finally {
    setGitSpy(null);
  }
  assert.ok(calls.length > 5, "spy saw git calls");
  const subs = new Set(["push", "checkout", "merge", "pull", "switch", "reset", "restore", "rebase"]);
  for (const argv of calls) {
    assert.ok(!argv.some((a) => subs.has(a)), argv.join(" "));
    assert.ok(argv.includes("core.hooksPath=/dev/null"), "safe config on every call");
  }
});

test("importBundle gives a clear error when a branch named exactly detent exists", async () => {
  const w = mkWorld();
  g(w.repo, ["branch", "detent"]);
  const v = await verified(w, chain(w, [{ "x.txt": "1\n" }]));
  const r = await imp(w, v);
  reject(r, "ref_conflict");
  assert.match(String(r.detail), /detent/);
  assert.equal(g(w.repo, ["for-each-ref", "refs/heads/detent/"]), "");
});

test("importBundle rejects unsafe run ids", async () => {
  const w = mkWorld();
  const v = await verified(w, chain(w, [{ "x.txt": "1\n" }]));
  for (const runId of ["../x", "a b", "x.lock", "-x", "a..b", "", "a/b", "a\nb", "x~1", "a:b", "@"]) {
    reject(await imp(w, v, { runId }), "bad_run_id");
  }
  assert.equal(g(w.repo, ["for-each-ref", "refs/heads/detent"]), "");
});

// ---------------------------------------------------------------- makeWorkClone

test("makeWorkClone makes an isolated clone and ignores hostile source config", async () => {
  const { makeWorkClone } = await load();
  const w = mkWorld();
  g(w.repo, ["branch", "detent/run1", w.base]);
  const canary = join(w.root, "canary");
  const script = join(w.root, "fsm.sh");
  writeFileSync(script, `#!/bin/sh\ntouch ${canary}\n`);
  chmodSync(script, 0o755);
  g(w.repo, ["config", "core.fsmonitor", script]);
  g(w.repo, ["config", "core.hooksPath", join(w.root, "evilhooks")]);
  const dest = join(w.root, "clone");
  const r = makeWorkClone({
    repo: w.repo, sourceRef: "refs/heads/detent/run1", dest, identity: ID, maxTreeBytes: 1e6,
  });
  assert.equal(r.base_sha, w.base);
  assert.equal(r.branch, "sdlc/run1");
  assert.equal(g(dest, ["rev-parse", "--abbrev-ref", "HEAD"]), "sdlc/run1");
  assert.equal(g(dest, ["remote"]), "");
  assert.equal(g(dest, ["config", "user.email"]), ID.email);
  assert.ok(!existsSync(join(dest, ".git", "objects", "info", "alternates")));
  const hooks = join(dest, ".git", "hooks");
  assert.deepEqual(existsSync(hooks) ? readdirSync(hooks) : [], []);
  assert.ok(!existsSync(canary), "fsmonitor canary must not fire during clone");
  const { git } = await loadSafe();
  git(["status", "--porcelain"], { repo: w.repo });
  assert.ok(!existsSync(canary), "gitsafe overrides a hostile fsmonitor");
});

test("makeWorkClone refuses a tree over the size cap", async () => {
  const { makeWorkClone } = await load();
  const w = mkWorld();
  assert.throws(
    () => makeWorkClone({ repo: w.repo, sourceRef: BRANCH, dest: join(w.root, "c2"), identity: ID, maxTreeBytes: 5 }),
    (e) => e.code === "clone_failed",
  );
  assert.ok(!existsSync(join(w.root, "c2")));
});

// ---------------------------------------------------------------- bundleExportArgv, diffForRecheck

test("bundleExportArgv is a plain argv with safe config and no push", async () => {
  const { bundleExportArgv } = await load();
  const w = mkWorld();
  const argv = bundleExportArgv({ work: w.work, branch: BRANCH, base: w.base, out: join(w.root, "out.bundle") });
  assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === "string"));
  assert.deepEqual(argv.slice(0, 2), ["-C", w.work]);
  assert.ok(argv.includes("core.hooksPath=/dev/null") && argv.includes("core.fsmonitor=false"));
  const i = argv.indexOf("bundle");
  assert.deepEqual(argv.slice(i, i + 2), ["bundle", "create"]);
  assert.deepEqual(argv.slice(-2), [BRANCH, `^${w.base}`]);
  assert.ok(!argv.includes("push"));
  assert.throws(() => bundleExportArgv({ work: w.work, branch: BRANCH, base: "--output=x", out: "/o" }));
  assert.throws(() => bundleExportArgv({ work: w.work, branch: "-x", base: w.base, out: "/o" }));
});

test("diffForRecheck returns the patch and log, and flags truncation", async () => {
  const { diffForRecheck } = await load();
  const w = mkWorld();
  const head = chain(w, [{ "x.txt": "one\n" }, { "x.txt": "one\n", "y.txt": "two\n" }]);
  assert.equal((await imp(w, await verified(w, head))).ok, true);
  const r = diffForRecheck({ repo: w.repo, base: w.base, head, cap: 1e6 });
  assert.equal(r.truncated, false);
  assert.match(r.patch, /\+one/);
  assert.match(r.patch, /\+two/);
  assert.equal(r.log.length, 2);
  const t = diffForRecheck({ repo: w.repo, base: w.base, head, cap: 20 });
  assert.equal(t.truncated, true);
  assert.ok(Buffer.byteLength(t.patch) <= 20);
});

// ---------------------------------------------------------------- gitsafe

function fakeGit(dir, version, body = "exit 0") {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "fakegit");
  writeFileSync(f, `#!/bin/sh\ncase "$1" in --version) echo "git version ${version}";; *) ${body};; esac\n`);
  chmodSync(f, 0o755);
  return f;
}

test("gitsafe refuses a git older than 2.45.1 and accepts 2.45.1 and Apple builds", async () => {
  const { git } = await loadSafe();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gitsafe-")));
  const old = fakeGit(join(root, "old"), "2.45.0");
  assert.throws(() => git(["status"], { gitBin: old }), (e) => e.code === "git_too_old" && /2\.45\.1/.test(e.message));
  const edge = fakeGit(join(root, "edge"), "2.45.1");
  assert.equal(git(["status"], { gitBin: edge }).status, 0);
  const apple = fakeGit(join(root, "apple"), "2.50.1 (Apple Git-155)");
  assert.equal(git(["status"], { gitBin: apple }).status, 0);
  const junk = fakeGit(join(root, "junk"), "banana");
  assert.throws(() => git(["status"], { gitBin: junk }), (e) => e.code === "git_unavailable");
});

test("gitsafe times out a stalled git and throws git_timeout", async () => {
  const { git } = await loadSafe();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gitsafe-")));
  const slow = fakeGit(root, "2.50.0", "exec sleep 30");
  const t0 = Date.now();
  assert.throws(() => git(["status"], { gitBin: slow, timeoutMs: 300 }), (e) => e.code === "git_timeout");
  assert.ok(Date.now() - t0 < 10000);
});

test("gitsafe runs without a shell, with a scrubbed env, and refuses forbidden subcommands", async () => {
  const { git } = await loadSafe();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gitsafe-")));
  const out = join(root, "argv.txt");
  const rec = fakeGit(root, "2.50.0", `env > ${out}.env; printf '%s\\n' "$@" > ${out}`);
  git(["log", "$(touch " + join(root, "pwn") + ")", ";touch", join(root, "pwn2")], { gitBin: rec });
  assert.ok(!existsSync(join(root, "pwn")) && !existsSync(join(root, "pwn2")), "no shell expansion");
  const argv = readFileSync(out, "utf8");
  for (const c of [
    "core.hooksPath=/dev/null", "core.attributesFile=/dev/null", "core.fsmonitor=false",
    "log.showSignature=false", "gpg.program=/usr/bin/false", "protocol.allow=never",
  ]) assert.ok(argv.includes(c), c);
  assert.ok(!argv.includes("protocol.file.allow=always"), "file protocol only on request");
  const env = readFileSync(`${out}.env`, "utf8");
  for (const e of ["GIT_ATTR_NOSYSTEM=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0"]) {
    assert.ok(env.includes(e), e);
  }
  assert.ok(!/^(SSH_AUTH_SOCK|GH_TOKEN|ANTHROPIC_API_KEY)=/m.test(env));
  git(["fetch"], { gitBin: rec, allowFile: true });
  assert.ok(readFileSync(out, "utf8").includes("protocol.file.allow=always"));
  for (const sub of ["push", "checkout", "merge", "pull", "switch", "reset", "rebase"]) {
    assert.throws(() => git([sub], { gitBin: rec }), (e) => e.code === "git_forbidden", sub);
  }
  assert.throws(() => git(["-c", "core.hooksPath=/x", "status"], { gitBin: rec }), (e) => e.code === "git_forbidden");
});
