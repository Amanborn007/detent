import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeRepo, idx, git, commit, put, coChange, indexDir, readIndexFile, INDEX_FILES, exists,
} from "./fixture.mjs";

const json = (s) => JSON.parse(s);
const allIndexText = (repo) => INDEX_FILES.map((f) => readIndexFile(repo, f)).join("\n");

let repo;
before(() => {
  repo = makeRepo();
  // history fixtures: strong pair, borderline-kept pair, weak pair, oversize commit
  coChange(repo, ["co/a.js", "co/b.js"], 6, "ab");
  coChange(repo, ["co/d.js", "co/e.js"], 5, "de");
  for (let i = 0; i < 15; i++) commit(repo, { "co/d.js": `// solo ${i}\n` }, "d solo");
  coChange(repo, ["co/f.js", "co/g.js"], 5, "fg");
  for (let i = 0; i < 25; i++) commit(repo, { "co/f.js": `// solo ${i}\n` }, "f solo");
  const big = {};
  for (let i = 0; i < 51; i++) big[`gen/f${i}.js`] = `// ${i}\n`;
  commit(repo, big, "huge");
});

test("build writes the five files and a complete manifest", () => {
  const r = idx(repo, ["build"]);
  assert.equal(r.code, 0, r.err);
  for (const f of INDEX_FILES) assert.ok(exists(join(indexDir(repo), f)), `${f} missing`);
  const m = json(readIndexFile(repo, "manifest.json"));
  assert.equal(m.head_sha, git(repo, "rev-parse", "HEAD"));
  assert.equal(m.tagger, "regex");
  assert.ok(m.generator_version && m.built_at);
  assert.match(m.files["src/auth.js"], /^[0-9a-f]{40}$/);
  assert.ok(readIndexFile(repo, "profile.md").split("\n").length <= 200);
  assert.ok(readIndexFile(repo, "map.md").length <= 6400, "map over ~1.5k tokens");
});

test("two builds are identical apart from built_at", () => {
  const snap = () => Object.fromEntries(INDEX_FILES.map((f) => {
    let t = readIndexFile(repo, f);
    if (f === "manifest.json") { const m = json(t); delete m.built_at; t = JSON.stringify(m); }
    return [f, t];
  }));
  idx(repo, ["build"]);
  const a = snap();
  idx(repo, ["build"]);
  assert.deepEqual(snap(), a);
});

test("secrets, binaries, oversize, untracked and ignored files never enter the index", () => {
  idx(repo, ["build"]);
  const m = json(readIndexFile(repo, "manifest.json"));
  for (const p of [".env", ".env.local", "secrets/db.js", "credentials.json", "server.pem", "tls.key",
    "id_rsa", "store.p12", "big.js", "blob.js", "untracked.js", "ignored.js"]) {
    assert.ok(!(p in m.files), `${p} was indexed`);
  }
  const text = allIndexText(repo);
  for (const n of ["envLeak", "envLocalLeak", "secretsDirFn", "bigFileFn", "binFileFn", "untrackedFn", "ignoredFn"]) {
    assert.ok(!text.includes(n), `${n} leaked into the index`);
  }
});

test("injected comment text and invisible characters never reach the index", () => {
  idx(repo, ["build"]);
  const text = allIndexText(repo);
  assert.ok(!/ignore previous/i.test(text));
  assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/.test(text), "invisible char in index");
  assert.ok(!text.includes("evil"), "name with a zero-width char was kept");
  assert.ok(!text.includes("hiddenPathFn"), "path with a zero-width char was indexed");
  assert.ok(text.includes("plainHelper"), "clean sibling definition lost");
  assert.match(readIndexFile(repo, "profile.md"), /eslint \./);
});

test("build adds .detent/ to .git/info/exclude, never .gitignore", () => {
  idx(repo, ["build"]);
  assert.match(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), /^\.detent\/$/m);
  assert.equal(git(repo, "status", "--porcelain").includes(".detent"), false);
  assert.ok(!readFileSync(join(repo, ".gitignore"), "utf8").includes(".detent"));
  idx(repo, ["build"]);
  const n = readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === ".detent/").length;
  assert.equal(n, 1, "exclude line duplicated");
});

test("--commit skips the exclude and says the index shows in git status", () => {
  const r2 = makeRepo();
  const r = idx(r2, ["build", "--commit"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!(exists(join(r2, ".git", "info", "exclude")) && readFileSync(join(r2, ".git", "info", "exclude"), "utf8").includes(".detent/")));
  assert.match(r.out + r.err, /git status/);
  assert.ok(git(r2, "status", "--porcelain").includes(".detent"));
});

test("from a linked worktree the exclude lands in the main repo's info/exclude", () => {
  const r2 = makeRepo();
  const wt = join(mkdtempSync(join(tmpdir(), "detent-index-wt-")), "wt");
  git(r2, "worktree", "add", "-q", "-b", "side", wt);
  const r = idx(wt, ["build"]);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(r2, ".git", "info", "exclude"), "utf8"), /^\.detent\/$/m);
  assert.ok(exists(join(wt, ".detent", "index", "manifest.json")));
});

test("profile reads commands, languages, layout, entry points, owners and pointers", () => {
  idx(repo, ["build"]);
  const p = readIndexFile(repo, "profile.md");
  for (const s of ["npm run test", "node --test", "make test", "go test ./...", "npm ci", "npm test"]) {
    assert.ok(p.includes(s), `profile lacks ${s}`);
  }
  assert.match(p, /\.js\b/); assert.match(p, /\.py\b/); assert.match(p, /\.go\b/);
  assert.match(p, /\bsrc\/\s*[:(-]?\s*\d+|src.*\d+ files?/);
  assert.ok(p.includes("bin/fx.js") && p.includes("cmd/srv/main.go") && p.includes("src/app.js"));
  assert.ok(p.includes("node") && /CMD/.test(p));
  assert.ok(p.includes("@acme/platform-team"));
  assert.ok(!p.includes("@alice") && !p.includes("bob@example.test"));
  for (const s of ["AGENTS.md", "README.md", "docs/"]) assert.ok(p.includes(s), `no pointer to ${s}`);
});

test("symbols cover JS, TS, Python, Go, Java and Rust definitions", () => {
  idx(repo, ["build"]);
  const names = new Set(readIndexFile(repo, "symbols.jsonl").trim().split("\n").map((l) => json(l).name));
  for (const n of ["validateToken", "SessionStore", "rotateKeys", "DEFAULT_TTL", "AppConfig", "RunMode", "Level",
    "parse_config", "ConfigLoader", "load_all", "Server", "StartServer", "Shutdown", "Main", "run",
    "Widget", "Render", "build_widget"]) {
    assert.ok(names.has(n), `missing definition ${n}`);
  }
});

test("query ranks the file whose path or definitions match the words", () => {
  idx(repo, ["build"]);
  const r = idx(repo, ["query", "validateToken", "session"]);
  assert.equal(r.code, 0, r.err);
  const res = json(r.out);
  assert.equal(res[0].path, "src/auth.js");
  assert.ok(res.length <= 10 && typeof res[0].score === "number");
});

test("status reports missing, fresh and stale; readers warn on stale", () => {
  const r2 = makeRepo();
  assert.equal(json(idx(r2, ["status"]).out).state, "missing");
  idx(r2, ["build"]);
  assert.equal(json(idx(r2, ["status"]).out).state, "fresh");
  commit(r2, { "src/auth.js": "export function validateToken(t) { return t; }\n" }, "edit");
  assert.equal(json(idx(r2, ["status"]).out).state, "stale");
  const q = idx(r2, ["query", "token"]);
  assert.match(q.err, /stale/i);
  const c = idx(r2, ["cochange", "src/auth.js"]);
  assert.match(c.err, /stale/i);
  const miss = idx(makeRepo(), ["query", "token"]);
  assert.notEqual(miss.code, 0);
  assert.match(miss.err, /detent index build/);
});

test("cochange applies the code-maat thresholds and skips oversize commits", () => {
  idx(repo, ["build"]);
  const a = json(idx(repo, ["cochange", "co/a.js"]).out);
  assert.equal(a["co/a.js"][0].partner, "co/b.js");
  assert.equal(a["co/a.js"][0].shared, 6);
  assert.ok(a["co/a.js"][0].coupling >= 30);
  assert.equal(json(idx(repo, ["cochange", "co/d.js"]).out)["co/d.js"][0].partner, "co/e.js");
  assert.deepEqual(json(idx(repo, ["cochange", "co/f.js"]).out)["co/f.js"], []);
  const h = readIndexFile(repo, "history.json");
  assert.ok(!h.includes("gen/f1.js"), "oversize commit counted");
  assert.ok(!/Zed|zed@/.test(h), "author identity in history");
  assert.ok(json(h).files["co/a.js"].commits >= 6);
});

test("refresh over changed, added and removed files equals a full rebuild", () => {
  const r2 = makeRepo();
  coChange(r2, ["co/a.js", "co/b.js"], 5, "ab");
  idx(r2, ["build"]);
  commit(r2, {
    "src/auth.js": "export function validateToken(t) { return !!t; }\nexport function revokeToken() {}\n",
    "src/fresh.js": "import { revokeToken } from './auth.js';\nrevokeToken(); revokeToken();\n",
  }, "add");
  git(r2, "rm", "-q", "src/util.py");
  git(r2, "commit", "-q", "-m", "drop util");
  coChange(r2, ["co/a.js", "co/b.js"], 1, "ab");
  const rf = idx(r2, ["refresh"]);
  assert.equal(rf.code, 0, rf.err);
  const snap = () => Object.fromEntries(INDEX_FILES.map((f) => {
    let t = readIndexFile(r2, f);
    if (f === "manifest.json") { const m = json(t); delete m.built_at; t = JSON.stringify(m); }
    return [f, t];
  }));
  const inc = snap();
  assert.ok(!inc["symbols.jsonl"].includes("parse_config"), "removed file kept");
  assert.ok(inc["symbols.jsonl"].includes("revokeToken"));
  idx(r2, ["build"]);
  assert.deepEqual(snap(), inc);
  assert.equal(json(idx(r2, ["status"]).out).state, "fresh");
});

test("a time budget that runs out is recorded in the manifest, not hidden", () => {
  const r2 = makeRepo();
  const r = idx(r2, ["build"], { DETENT_INDEX_BUDGET_MS: "0" });
  assert.equal(r.code, 0, r.err);
  const m = json(readIndexFile(r2, "manifest.json"));
  assert.ok(m.truncated && /budget/i.test(m.truncated.reason));
});

test("an unset tagger falls back to regex without failing when tree-sitter is absent", () => {
  const r2 = makeRepo();
  const r = idx(r2, ["build"], { DETENT_INDEX_TAGGER: "" });
  assert.equal(r.code, 0, r.err);
  assert.ok(["regex", "tree-sitter"].includes(json(readIndexFile(r2, "manifest.json")).tagger));
});
