// bundle.mjs — clone for the sandboxed child and verified bundle import back.
// The child's bundle is untrusted: it is copied out, parsed in JS, fetched into a
// private quarantine, fsck'd and tree-checked before any object reaches the user repo.
import {
  openSync, closeSync, fstatSync, readSync, writeSync, mkdirSync, existsSync, rmSync,
  readFileSync, constants,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { git, gitOk, GitError, HARD_GIT } from "./gitsafe.mjs";

const MB = 1024 * 1024;
export const DEFAULT_CAPS = Object.freeze({
  bundleBytes: 50 * MB, commits: 50, blobBytes: 10 * MB, newBlobTotal: 100 * MB,
  msgBytes: 8 * 1024, changedPaths: 20_000,
});

export class BundleReject extends Error {
  constructor(code, detail) {
    super(`${code}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.name = "BundleReject";
    this.code = code;
    this.detail = detail;
  }
}

const IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const QUARANTINE_REF = "refs/detent/incoming";

function dropTrailing(n) {
  return n.replace(/[ .]+$/, "");
}

// .git in any spelling the OS may fold onto it: case, HFS-ignorable code points,
// NTFS trailing dots/spaces, alternate data streams and the GIT~1 short name.
export function isDotGitName(name) {
  const n = dropTrailing(dropTrailing(name.replace(IGNORABLE, "").toLowerCase()).split(":")[0]);
  return n === ".git" || /^git~\d+$/.test(n);
}

function isGitmodulesName(name) {
  const n = dropTrailing(dropTrailing(name.replace(IGNORABLE, "").toLowerCase()).split(":")[0]);
  return n === ".gitmodules" || /^gitmod~\d+$/.test(n);
}

function foldName(name) {
  return name.replace(IGNORABLE, "").normalize("NFD").toUpperCase().toLowerCase();
}

const oidRe = (fmt) => (fmt === "sha256" ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/);

// ---------------------------------------------------------------- header

export function parseBundleHeader(buf, opts = {}) {
  const { branch, base, objectFormat = "sha1" } = opts;
  const oid = oidRe(objectFormat);
  const limit = Math.min(buf.length, 64 * 1024);
  const lines = [];
  let pos = 0;
  let packOffset = -1;
  while (pos < limit) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0 || nl >= limit) break;
    const line = buf.toString("utf8", pos, nl);
    pos = nl + 1;
    if (line === "") { packOffset = pos; break; }
    lines.push(line);
  }
  if (packOffset < 0) throw new BundleReject("bad_header", "no blank line ending the header within 64 KiB");
  if (buf.toString("latin1", packOffset, packOffset + 4) !== "PACK") {
    throw new BundleReject("bad_header", "pack data does not follow the header");
  }
  const m = /^# v([23]) git bundle$/.exec(lines[0] || "");
  if (!m) throw new BundleReject("bad_header", `unknown signature ${JSON.stringify(lines[0])}`);
  const version = Number(m[1]);
  let i = 1;
  const capabilities = [];
  if (version === 3) {
    for (; i < lines.length && lines[i].startsWith("@"); i++) {
      const cap = lines[i].slice(1);
      if (cap !== `object-format=${objectFormat}` || capabilities.length) {
        throw new BundleReject("bad_capability", cap);
      }
      capabilities.push(cap);
    }
  }
  const prerequisites = [];
  for (; i < lines.length && lines[i].startsWith("-"); i++) {
    const p = /^-([0-9a-f]+)(?: (.*))?$/.exec(lines[i]);
    if (!p || !oid.test(p[1])) throw new BundleReject("bad_header", `bad prerequisite line ${JSON.stringify(lines[i])}`);
    prerequisites.push({ oid: p[1], comment: p[2] || "" });
  }
  const refs = [];
  for (; i < lines.length; i++) {
    const r = /^([0-9a-f]+) (\S.*)$/.exec(lines[i]);
    if (!r || !oid.test(r[1])) throw new BundleReject("bad_header", `bad line ${JSON.stringify(lines[i].slice(0, 80))}`);
    refs.push({ oid: r[1], name: r[2] });
  }
  if (refs.length === 0) throw new BundleReject("bad_header", "no ref");
  if (refs.length > 1) throw new BundleReject("extra_ref", refs.map((r) => r.name));
  if (/^0+$/.test(refs[0].oid)) throw new BundleReject("bad_header", "ref points at the null oid");
  if (branch !== undefined && refs[0].name !== branch) throw new BundleReject("wrong_ref", refs[0].name);
  if (base !== undefined && (prerequisites.length !== 1 || prerequisites[0].oid !== base)) {
    throw new BundleReject("bad_prerequisite", prerequisites.map((p) => p.oid));
  }
  return { version, capabilities, prerequisites, refs, packOffset };
}

// ---------------------------------------------------------------- sensitive paths

const re = (s) => new RegExp(s, "i");
export const SENSITIVE_PATTERNS = Object.freeze([
  { id: "gitattributes", re: re("(^|/)\\.gitattributes$") },
  { id: "lfsconfig", re: re("(^|/)\\.lfsconfig$") },
  {
    id: "ci",
    re: re("^(\\.github|\\.gitlab|\\.circleci|\\.buildkite|\\.woodpecker|\\.drone)(/|$)|" +
      "(^|/)(\\.gitlab-ci\\.yml|\\.travis\\.yml|Jenkinsfile|azure-pipelines\\.ya?ml|bitbucket-pipelines\\.yml|" +
      "appveyor\\.yml|cloudbuild\\.ya?ml|\\.drone\\.yml)$"),
  },
  {
    id: "hooks",
    re: re("(^|/)(\\.githooks|\\.husky|\\.git-hooks)(/|$)|" +
      "(^|/)(\\.pre-commit-config\\.yaml|\\.?lefthook(-local)?\\.ya?ml)$"),
  },
  { id: "yarn-dir", re: re("(^|/)\\.yarn(/|$)") },
  { id: "mise", re: re("(^|/)\\.?mise(\\.[\\w-]+)?\\.toml$|(^|/)\\.config/mise(/|$)") },
  { id: "tool-versions", re: re("(^|/)\\.tool-versions$") },
  { id: "taskfile", re: re("(^|/)Taskfile(\\.[\\w-]+)?\\.ya?ml$") },
  { id: "nix-devbox", re: re("(^|/)(flake\\.nix|flake\\.lock|devbox\\.json|devbox\\.lock)$") },
  { id: "agent-config", re: re("(^|/)(\\.claude|\\.vscode|\\.idea|\\.devcontainer)(/|$)|(^|/)(\\.mcp\\.json|CLAUDE\\.md|AGENTS\\.md)$") },
  { id: "env", re: re("(^|/)\\.env(\\..*)?$|(^|/)\\.envrc$") },
  { id: "package-manager-config", re: re("(^|/)(\\.npmrc|\\.yarnrc(\\.yml)?|\\.pnpmfile\\.cjs|\\.bundle/config)$|(^|/)\\.cargo(/|$)") },
  { id: "build-scripts", re: re("(^|/)(Makefile|GNUmakefile|justfile|setup\\.py|setup\\.cfg|pyproject\\.toml|tox\\.ini|Cargo\\.toml|build\\.rs|pom\\.xml|gradlew|Gemfile)$|\\.gradle(\\.kts)?$|(^|/)gradle/wrapper(/|$)|\\.mk$") },
  {
    id: "lockfile-or-dependency-spec",
    re: re("(^|/)(package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|Cargo\\.lock|go\\.sum|go\\.mod|" +
      "poetry\\.lock|uv\\.lock|Pipfile(\\.lock)?|Gemfile\\.lock|composer\\.(json|lock)|gradle\\.lockfile|requirements[^/]*\\.txt)$"),
  },
]);

const PKG_SENSITIVE_KEYS = [
  "scripts", "packageManager", "dependencies", "devDependencies", "optionalDependencies",
  "peerDependencies", "bundledDependencies", "bundleDependencies", "overrides", "resolutions",
  "workspaces", "bin", "main", "exports", "imports", "engines", "config", "publishConfig",
];

function pkgChanged(oldBuf, newBuf) {
  const parse = (b) => {
    if (!b) return {};
    try {
      const v = JSON.parse(b.toString("utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const a = parse(oldBuf);
  const b = parse(newBuf);
  if (a === null || b === null) return ["unparseable"];
  return PKG_SENSITIVE_KEYS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

// ---------------------------------------------------------------- git readers

const utf8 = new TextDecoder("utf-8", { fatal: true });

function parseBatch(buf, count) {
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    const nl = buf.indexOf(10, p);
    if (nl < 0) throw new BundleReject("fsck_failed", { stage: "read", error: "truncated cat-file output" });
    const line = buf.toString("latin1", p, nl);
    p = nl + 1;
    if (line.endsWith(" missing")) { out.push({ missing: true, spec: line.slice(0, -8) }); continue; }
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(line);
    if (!m) throw new BundleReject("fsck_failed", { stage: "read", error: `bad cat-file line ${line}` });
    const size = Number(m[3]);
    out.push({ oid: m[1], type: m[2], size, body: buf.subarray(p, p + size) });
    p += size + 1;
  }
  return out;
}

function parseCheck(buf, count) {
  const lines = buf.toString("latin1").split("\n").slice(0, count);
  return lines.map((l) => {
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(l);
    return m ? { oid: m[1], type: m[2], size: Number(m[3]) } : { missing: true, spec: l };
  });
}

function parseTree(body, rawLen) {
  const entries = [];
  let p = 0;
  while (p < body.length) {
    const sp = body.indexOf(32, p);
    const nul = body.indexOf(0, sp);
    if (sp < 0 || nul < 0) throw new BundleReject("fsck_failed", { stage: "read", error: "malformed tree" });
    let name;
    try { name = utf8.decode(body.subarray(sp + 1, nul)); } catch { name = null; }
    entries.push({ mode: body.toString("latin1", p, sp), name });
    p = nul + 1 + rawLen;
  }
  return entries;
}

function rawDiff(G, Q, a, b) {
  const out = G(["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", a, b], { gitDir: Q });
  const tok = [];
  let p = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0) { tok.push(out.subarray(p, i)); p = i + 1; }
  }
  const entries = [];
  for (let i = 0; i + 1 < tok.length; i += 2) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(tok[i].toString("latin1"));
    if (!m) throw new BundleReject("fsck_failed", { stage: "read", error: "unparseable diff-tree record" });
    let path;
    try { path = utf8.decode(tok[i + 1]); } catch { throw new BundleReject("bad_path", "path is not valid UTF-8"); }
    entries.push({ srcMode: m[1], dstMode: m[2], srcOid: m[3], dstOid: m[4], status: m[5], path });
  }
  return entries;
}

function checkPath(path) {
  if (path.startsWith("/") || path.endsWith("/")) throw new BundleReject("bad_path", path);
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new BundleReject("bad_path", `control or backslash in ${JSON.stringify(path)}`);
  for (const c of path.split("/")) {
    if (c === "" || c === "." || c === ".." || isDotGitName(c)) throw new BundleReject("bad_path", path);
  }
}

function checkSymlinkTarget(path, target) {
  const bad = (why) => new BundleReject("bad_symlink", `${path} -> ${JSON.stringify(target)}: ${why}`);
  if (target === "" || target.length > 4096) throw bad("empty or too long");
  if (/[\u0000-\u001f\u007f\\]/.test(target)) throw bad("control or backslash");
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) throw bad("absolute");
  for (const c of target.split("/")) {
    // A `..` can escape through a directory symlink, so none is accepted.
    if (c === "..") throw bad("parent segment");
    if (isDotGitName(c)) throw bad(".git component");
  }
}

// ---------------------------------------------------------------- verify

function copyOut(src, dest, maxBytes) {
  let fd;
  try {
    fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    throw new BundleReject("bad_bundle_file", `${e.code}: cannot open bundle without following links`);
  }
  let out;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new BundleReject("bad_bundle_file", "not a regular single-link file");
    if (st.size > maxBytes) throw new BundleReject("oversize", `${st.size} > ${maxBytes}`);
    out = openSync(dest, "wx", 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(MB);
    let total = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new BundleReject("oversize", `grew past ${maxBytes}`);
      hash.update(chunk.subarray(0, n));
      writeSync(out, chunk, 0, n);
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
    if (out !== undefined) closeSync(out);
  }
}

export function verifyBundle(args) {
  const {
    bundlePath, repo, base, branch, identity, scratch, step = "step", gitOpts = {}, _afterCopy,
  } = args;
  const caps = { ...DEFAULT_CAPS, ...(args.caps || {}) };
  const G = (a, o = {}) => gitOk(a, { ...gitOpts, ...o });
  const R = (a, o = {}) => git(a, { ...gitOpts, ...o });
  let copy;
  let Q;
  try {
    if (!isAbsolute(scratch || "") || !/^[A-Za-z0-9._-]+$/.test(step)) {
      throw new TypeError("scratch must be absolute and step a plain token");
    }
    if (!identity || typeof identity.email !== "string" || !identity.email) throw new TypeError("identity.email required");
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(branch || "") || branch.includes("..")) {
      throw new BundleReject("wrong_ref", `unsafe branch ${branch}`);
    }
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    copy = join(scratch, `${step}.bundle`);
    const sha = copyOut(bundlePath, copy, caps.bundleBytes);
    if (_afterCopy) _afterCopy();

    const fmt = G(["rev-parse", "--show-object-format"], { repo }).toString().trim();
    if (!oidRe(fmt).test(base)) throw new TypeError("base must be a full oid");
    const header = parseBundleHeader(readFileSync(copy).subarray(0, 64 * 1024), { branch, base, objectFormat: fmt });
    const headOid = header.refs[0].oid;
    if (headOid === base) throw new BundleReject("no_commits", "bundle head equals base");

    Q = join(scratch, `${step}.git`);
    G(["init", "--bare", "--quiet", "--template=", Q]);
    const objDir = G(["rev-parse", "--path-format=absolute", "--git-path", "objects"], { repo }).toString().trim();
    mkdirSync(join(Q, "objects", "info"), { recursive: true });
    writeAlternates(join(Q, "objects", "info", "alternates"), objDir);

    const v = R(["bundle", "verify", copy], { gitDir: Q });
    if (v.status !== 0) throw new BundleReject("bad_prerequisite", { stage: "bundle-verify", output: v.stderr.toString() });
    // index-pack --strict runs fsck over exactly the new objects; a whole-store fsck would walk the user repo too.
    const pack = readFileSync(copy).subarray(header.packOffset);
    const ck = R(["index-pack", "--stdin", "--fix-thin", "--strict"], { gitDir: Q, input: pack, timeoutMs: 5 * 60_000 });
    if (ck.status !== 0) {
      throw new BundleReject("fsck_failed", { stage: "fsck", output: (ck.stderr.toString() + ck.stdout.toString()).slice(0, 4000) });
    }
    const ur = R(["update-ref", QUARANTINE_REF, headOid], { gitDir: Q });
    if (ur.status !== 0) throw new BundleReject("bad_header", { stage: "ref", output: ur.stderr.toString() });
    const head = G(["rev-parse", "--verify", `${QUARANTINE_REF}^{commit}`], { gitDir: Q }).toString().trim();
    if (head !== headOid) throw new BundleReject("bad_header", "fetched head differs from the header");

    const result = inspect({ G, Q, base, head, identity, caps, fmt });
    return { ok: true, step, head, base, bundle_sha256: sha, copy, quarantine: Q, ...result };
  } catch (e) {
    if (Q) rmSync(Q, { recursive: true, force: true });
    if (e instanceof BundleReject) return { ok: false, code: e.code, detail: e.detail, copy };
    if (e instanceof GitError && (e.code === "git_timeout" || e.code === "git_unavailable" || e.code === "git_too_old")) {
      return { ok: false, code: e.code, detail: e.message, copy };
    }
    throw e;
  }
}

function writeAlternates(file, objDir) {
  if (/[\n\0]/.test(objDir)) throw new TypeError("object dir contains a newline");
  const fd = openSync(file, "wx", 0o600);
  try { writeSync(fd, `${objDir}\n`); } finally { closeSync(fd); }
}

function inspect({ G, Q, base, head, identity, caps, fmt }) {
  const rawLen = fmt === "sha256" ? 32 : 20;

  const list = G(["rev-list", "--parents", "--reverse", `--max-count=${caps.commits + 1}`, `${base}..${QUARANTINE_REF}`], { gitDir: Q })
    .toString().split("\n").filter(Boolean).map((l) => l.split(" "));
  if (list.length > caps.commits) throw new BundleReject("too_many_commits", `more than ${caps.commits}`);
  if (list.some((c) => c.length > 2)) throw new BundleReject("merge_commit", list.find((c) => c.length > 2)[0]);
  let prev = base;
  for (const [sha, parent] of list) {
    if (parent !== prev) throw new BundleReject("not_linear", `${sha} has parent ${parent || "none"}, expected ${prev}`);
    prev = sha;
  }
  const anc = git(["merge-base", "--is-ancestor", base, QUARANTINE_REF], { gitDir: Q });
  if (anc.status !== 0 || prev !== head) throw new BundleReject("not_linear", "base is not an ancestor of the head");
  const shas = list.map((c) => c[0]);

  const commits = shas.length
    ? parseBatch(G(["cat-file", "--batch"], { gitDir: Q, input: `${shas.join("\n")}\n` }), shas.length)
    : [];
  const summary = commits.map((c, i) => checkCommit(shas[i], c.body, identity, caps));

  const blobs = new Map();
  let changedCount = 0;
  let parent = base;
  for (const sha of shas) {
    const diff = rawDiff(G, Q, parent, sha);
    changedCount += diff.length;
    if (changedCount > caps.changedPaths) throw new BundleReject("bundle_too_large", `more than ${caps.changedPaths} changed paths`);
    const symlinks = [];
    for (const e of diff) {
      if (e.dstMode === "000000") continue;
      const base_ = e.path.split("/").pop();
      if (e.dstMode === "160000" || isGitmodulesName(base_)) throw new BundleReject("gitlink", e.path);
      checkPath(e.path);
      if (e.dstMode === "120000") symlinks.push(e);
      else if (e.dstMode !== "100644" && e.dstMode !== "100755" && e.dstMode !== "040000") {
        throw new BundleReject("bad_path", `${e.path} has unsupported mode ${e.dstMode}`);
      }
      if (e.dstMode !== "040000") blobs.set(e.dstOid, e.path);
    }
    checkSymlinks(G, Q, symlinks);
    checkCollisions(G, Q, sha, diff, rawLen);
    parent = sha;
  }
  checkBlobSizes(G, Q, blobs, caps);

  const net = rawDiff(G, Q, base, head);
  const { sensitive, sensitiveDetail } = classify(G, Q, net);
  return {
    commits: summary,
    changed: net.map((e) => e.path),
    sensitive, sensitiveDetail, shipBlocking: sensitive.length > 0,
  };
}

function checkCommit(sha, body, identity, caps) {
  const cut = body.indexOf("\n\n");
  const head = (cut < 0 ? body : body.subarray(0, cut)).toString("latin1");
  const msg = cut < 0 ? Buffer.alloc(0) : body.subarray(cut + 2);
  const keys = [];
  const authors = {};
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) throw new BundleReject("bad_commit_header", `${sha}: continuation line`);
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? "" : line.slice(sp + 1);
    keys.push(key);
    if (key === "author" || key === "committer") authors[key] = val;
    if (key === "encoding" && val !== "UTF-8") throw new BundleReject("bad_commit_header", `${sha}: encoding ${val}`);
  }
  if (!/^tree( parent)*( author)( committer)( encoding)?$/.test(keys.join(" "))) {
    throw new BundleReject("bad_commit_header", `${sha}: headers ${keys.join(",")}`);
  }
  for (const who of ["author", "committer"]) {
    const m = /^.* <([^<>]*)> \d+ [+-]\d{4}$/.exec(authors[who]);
    if (!m) throw new BundleReject("bad_commit_header", `${sha}: malformed ${who}`);
    if (m[1] !== identity.email) throw new BundleReject("foreign_author", `${sha}: ${who} ${m[1]}`);
  }
  if (msg.length > caps.msgBytes) throw new BundleReject("bad_message", `${sha}: ${msg.length} bytes`);
  if (msg.includes(0)) throw new BundleReject("bad_message", `${sha}: NUL byte`);
  let text;
  try { text = utf8.decode(msg); } catch { throw new BundleReject("bad_message", `${sha}: not UTF-8`); }
  return { sha, subject: text.split("\n")[0] };
}

function checkSymlinks(G, Q, symlinks) {
  if (!symlinks.length) return;
  const oids = [...new Set(symlinks.map((s) => s.dstOid))];
  const got = parseBatch(G(["cat-file", "--batch"], { gitDir: Q, input: `${oids.join("\n")}\n` }), oids.length);
  const byOid = new Map(oids.map((o, i) => [o, got[i]]));
  for (const s of symlinks) {
    const b = byOid.get(s.dstOid);
    if (!b || b.missing) throw new BundleReject("bad_symlink", `${s.path}: target blob missing`);
    if (b.body.includes(0)) throw new BundleReject("bad_symlink", `${s.path}: NUL in target`);
    checkSymlinkTarget(s.path, b.body.toString("utf8"));
  }
}

function checkCollisions(G, Q, commit, diff, rawLen) {
  const dirs = new Set([""]);
  for (const e of diff) {
    if (e.dstMode === "000000") continue;
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const specs = [...dirs].map((d) => `${commit}:${d}`);
  const trees = parseBatch(G(["cat-file", "--batch"], { gitDir: Q, input: `${specs.join("\n")}\n` }), specs.length);
  trees.forEach((t, i) => {
    if (t.missing || t.type !== "tree") throw new BundleReject("bad_path", `cannot read tree ${specs[i]}`);
    const seen = new Map();
    for (const ent of parseTree(t.body, rawLen)) {
      if (ent.name === null) throw new BundleReject("bad_path", `non-UTF-8 name in ${specs[i]}`);
      const key = foldName(ent.name);
      if (seen.has(key)) {
        throw new BundleReject("path_collision", { dir: [...dirs][i], names: [seen.get(key), ent.name] });
      }
      seen.set(key, ent.name);
    }
  });
}

function checkBlobSizes(G, Q, blobs, caps) {
  const oids = [...blobs.keys()];
  if (!oids.length) return;
  const sizes = parseCheck(G(["cat-file", "--batch-check"], { gitDir: Q, input: `${oids.join("\n")}\n` }), oids.length);
  let total = 0;
  sizes.forEach((s, i) => {
    if (s.missing) throw new BundleReject("fsck_failed", { stage: "read", error: `missing blob ${oids[i]}` });
    if (s.size > caps.blobBytes) throw new BundleReject("blob_too_large", `${blobs.get(oids[i])}: ${s.size} bytes`);
    total += s.size;
  });
  if (total > caps.newBlobTotal) throw new BundleReject("bundle_too_large", `new blobs total ${total} bytes`);
}

function classify(G, Q, net) {
  const reasons = new Map();
  const add = (path, why) => {
    if (!reasons.has(path)) reasons.set(path, []);
    if (!reasons.get(path).includes(why)) reasons.get(path).push(why);
  };
  const pkgs = [];
  for (const e of net) {
    for (const p of SENSITIVE_PATTERNS) if (p.re.test(e.path)) add(e.path, p.id);
    if (e.dstMode === "120000" || e.srcMode === "120000") add(e.path, "symlink");
    if (e.dstMode === "100755" && e.srcMode !== "100755") add(e.path, "executable");
    if (/(^|\/)package\.json$/.test(e.path)) pkgs.push(e);
  }
  if (pkgs.length) {
    const zero = /^0+$/;
    const oids = [...new Set(pkgs.flatMap((e) => [e.srcOid, e.dstOid]).filter((o) => !zero.test(o)))];
    const got = oids.length
      ? parseBatch(G(["cat-file", "--batch"], { gitDir: Q, input: `${oids.join("\n")}\n` }), oids.length)
      : [];
    const body = new Map(oids.map((o, i) => [o, got[i].missing ? null : got[i].body]));
    for (const e of pkgs) {
      const keys = pkgChanged(zero.test(e.srcOid) ? null : body.get(e.srcOid), zero.test(e.dstOid) ? null : body.get(e.dstOid));
      for (const k of keys) add(e.path, `package.json:${k}`);
    }
  }
  const sensitive = [...reasons.keys()];
  return { sensitive, sensitiveDetail: sensitive.map((path) => ({ path, reasons: reasons.get(path) })) };
}

// ---------------------------------------------------------------- import

export function importBundle({ verified, repo, runId, expectOld = null, gitOpts = {} }) {
  const G = (a, o = {}) => gitOk(a, { repo, ...gitOpts, ...o });
  const R = (a, o = {}) => git(a, { repo, ...gitOpts, ...o });
  if (typeof runId !== "string" || !SAFE_ID.test(runId) || runId.includes("..") || /(\.lock|\.)$/.test(runId)) {
    return { ok: false, code: "bad_run_id", detail: JSON.stringify(runId) };
  }
  const target = `refs/heads/detent/${runId}`;
  const tmp = `refs/detent/import/${runId}/${verified && verified.step}`;
  try {
    if (!verified || verified.ok !== true || !verified.quarantine || !verified.head) {
      return { ok: false, code: "bad_verified", detail: "importBundle needs a successful verifyBundle result" };
    }
    if (!/^[A-Za-z0-9._-]+$/.test(verified.step || "")) return { ok: false, code: "bad_verified", detail: "step" };
    if (git(["check-ref-format", target], gitOpts).status !== 0) return { ok: false, code: "bad_run_id", detail: target };
    const sha = createHash("sha256").update(readFileSync(verified.copy)).digest("hex");
    if (sha !== verified.bundle_sha256) return { ok: false, code: "copy_tampered", detail: "bundle copy changed after verification" };
    const qHead = G(["rev-parse", "--verify", `${QUARANTINE_REF}^{commit}`], { repo: undefined, gitDir: verified.quarantine }).toString().trim();
    if (qHead !== verified.head) return { ok: false, code: "quarantine_changed", detail: "quarantine head moved" };

    const refs = G(["for-each-ref", "--format=%(refname)", "refs/heads/detent"]).toString().split("\n").filter(Boolean);
    if (refs.includes("refs/heads/detent")) {
      return { ok: false, code: "ref_conflict", detail: "a branch named exactly 'detent' exists and blocks refs/heads/detent/*; rename or delete it" };
    }
    if (refs.some((r) => r.startsWith(`${target}/`))) {
      return { ok: false, code: "ref_conflict", detail: `${target} is a directory of other refs` };
    }
    const cur = R(["rev-parse", "--verify", "--quiet", target]);
    const have = cur.status === 0 ? cur.stdout.toString().trim() : null;
    if (have !== expectOld) {
      return { ok: false, code: "import_conflict", detail: `${target} is ${have}, expected ${expectOld}` };
    }

    G(["fetch", "--no-tags", "--no-write-fetch-head", "--", verified.quarantine, `${QUARANTINE_REF}:${tmp}`], { allowFile: true });
    try {
      if (expectOld) {
        const anc = R(["merge-base", "--is-ancestor", expectOld, verified.head]);
        if (anc.status !== 0) return { ok: false, code: "import_conflict", detail: "head does not descend from the previous import" };
      }
      const zero = "0".repeat(verified.head.length);
      const u = R(["update-ref", "-m", `detent drive import ${verified.step}`, "--no-deref", target, verified.head, expectOld || zero]);
      if (u.status !== 0) {
        const err = u.stderr.toString().trim();
        return { ok: false, code: /exists|directory|cannot lock/.test(err) ? "ref_conflict" : "import_conflict", detail: err };
      }
    } finally {
      G(["update-ref", "-d", tmp]);
    }
    rmSync(verified.quarantine, { recursive: true, force: true });
    return { ok: true, head: verified.head, ref: target };
  } catch (e) {
    if (e instanceof GitError) return { ok: false, code: e.code === "git_failed" ? "import_failed" : e.code, detail: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------- clone, export, recheck diff

export function makeWorkClone({ repo, sourceRef, dest, identity, maxTreeBytes = 200 * MB, gitOpts = {} }) {
  const fail = (detail) => new BundleReject("clone_failed", detail);
  const m = /^refs\/heads\/(?:detent|sdlc)\/(.+)$/.exec(sourceRef || "");
  if (!m || !SAFE_ID.test(m[1])) throw fail(`sourceRef must be refs/heads/(detent|sdlc)/<run>, got ${sourceRef}`);
  if (!isAbsolute(dest || "") || existsSync(dest)) throw fail(`dest must be a new absolute path: ${dest}`);
  if (!identity || !identity.name || !identity.email) throw fail("identity name and email required");
  const short = sourceRef.slice("refs/heads/".length);
  const branch = `sdlc/${m[1]}`;
  const G = (a, o = {}) => gitOk(a, { ...gitOpts, ...o });
  const base_sha = G(["rev-parse", "--verify", `${sourceRef}^{commit}`], { repo }).toString().trim();
  let total = 0;
  for (const rec of G(["ls-tree", "-r", "-l", "-z", base_sha], { repo }).toString("latin1").split("\0")) {
    const sz = /^\d+ \w+ [0-9a-f]+ +(\d+|-)\t/.exec(rec);
    if (sz && sz[1] !== "-") total += Number(sz[1]);
  }
  if (total > maxTreeBytes) throw fail(`tree is ${total} bytes, cap ${maxTreeBytes}`);
  try {
    G(["clone", "--no-local", "--no-hardlinks", "--single-branch", "--branch", short, "--no-tags", "--template=", "--", `file://${repo}`, dest], { allowFile: true });
    G(["remote", "remove", "origin"], { repo: dest });
    if (short !== branch) G(["branch", "-m", short, branch], { repo: dest });
    G(["config", "--local", "user.name", identity.name], { repo: dest });
    G(["config", "--local", "user.email", identity.email], { repo: dest });
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e instanceof GitError ? fail(e.message) : e;
  }
  return { base_sha, branch };
}

// Runs inside the sandbox with the child's work dir read-only; mirrors the git hardening.
export function bundleExportArgv({ work, branch, base, out }) {
  if (typeof work !== "string" || !isAbsolute(work)) throw new TypeError("work must be an absolute path");
  if (typeof out !== "string" || !isAbsolute(out)) throw new TypeError("out must be an absolute path");
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(branch || "") || branch.includes("..")) throw new TypeError(`unsafe branch ${branch}`);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base || "")) throw new TypeError("base must be a full oid");
  return ["-C", work, ...HARD_GIT, "bundle", "create", out, branch, `^${base}`];
}

export function diffForRecheck({ repo, base, head, cap, gitOpts = {} }) {
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (!oid.test(base || "") || !oid.test(head || "")) throw new TypeError("base and head must be full oids");
  const d = git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", base, head], {
    repo, ...gitOpts, maxBuffer: cap + 1, allowTruncate: true,
  });
  if (!d.truncated && d.status !== 0) throw new GitError("git_failed", d.stderr.toString());
  let patch = d.stdout.subarray(0, cap).toString("utf8");
  while (Buffer.byteLength(patch) > cap) patch = patch.slice(0, -1);
  const log = gitOk(["log", "--no-show-signature", "--no-color", "--reverse", "--format=%H%x09%s", `${base}..${head}`], { repo, ...gitOpts })
    .toString("utf8").split("\n").filter(Boolean).map((l) => {
      const t = l.indexOf("\t");
      return { sha: l.slice(0, t), subject: l.slice(t + 1) };
    });
  return { patch, log, truncated: d.truncated || d.stdout.length > cap };
}
