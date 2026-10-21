import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters", "claude-reviewer");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

const GOOD = {
  summary: "Retry path skips reconcile()",
  location: "src/a.js:3",
  action: "ask-user",
  risk_level: "high",
  detail: "The early return bypasses reconcile().",
};

// The stub records argv and stdin, then prints the envelope chosen by STUB_MODE.
function mkStub() {
  const dir = mkdtempSync(join(tmpdir(), "clrev-stub-"));
  const bin = join(dir, "claude");
  const log = join(dir, "log.json");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: fs.realpathSync(process.cwd()), entries: fs.readdirSync(".") }));
const mode = process.env.STUB_MODE;
const good = ${JSON.stringify(GOOD)};
const env = (result) => JSON.stringify({ type: "result", is_error: false, result, total_cost_usd: 0.0123 });
if (mode === "exit1") { process.stderr.write("boom\\n"); process.exit(1); }
if (mode === "valid") console.log(env(JSON.stringify({ findings: [good] })));
if (mode === "fenced") console.log(env("\`\`\`json\\n" + JSON.stringify({ findings: [good] }) + "\\n\`\`\`"));
if (mode === "badenum") console.log(env(JSON.stringify({ findings: [{ ...good, action: "yolo" }] })));
if (mode === "badrisk") console.log(env(JSON.stringify({ findings: [{ ...good, risk_level: "meh" }] })));
if (mode === "badloc") console.log(env(JSON.stringify({ findings: [{ ...good, location: "somewhere" }] })));
if (mode === "array") console.log(JSON.stringify([{ type: "system", subtype: "init" }, { type: "assistant" }, JSON.parse(env(JSON.stringify({ findings: [good] })))]));
if (mode === "nonjson") console.log(env("looks fine to me"));
if (mode === "noenvelope") console.log("not an envelope");
`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

function mkRepo({ change = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "clrev-"));
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { env: { ...process.env, ...GIT_ENV } });
  g("init", "-q");
  writeFileSync(join(dir, "a.js"), "one\n");
  g("add", "."); g("commit", "-q", "-m", "init");
  if (change) writeFileSync(join(dir, "a.js"), "one\nSECRET_MARKER_LINE two\n");
  return dir;
}

function run(req, { args = [], mode = "valid", stub = mkStub(), env = {} } = {}) {
  const r = spawnSync(ADAPTER, args, {
    input: JSON.stringify(req), encoding: "utf8",
    env: { ...process.env, DETENT_CLAUDE_BIN: stub.bin, STUB_MODE: mode, ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* asserted by tests */ }
  const called = existsSync(stub.log);
  return { code: r.status, json, stderr: r.stderr, called, rec: called ? JSON.parse(readFileSync(stub.log, "utf8")) : null };
}

const req = (repo, diff_ref = "HEAD") => ({ repo_path: repo, diff_ref, ticket_id: "T-1" });

test("valid findings pass through, exit 0, with next_step", () => {
  const r = run(req(mkRepo()));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.findings, [GOOD]);
  assert.ok(r.json.next_step);
});

test("fenced JSON result is accepted", () => {
  const r = run(req(mkRepo()), { mode: "fenced" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.findings, [GOOD]);
});

test("the message-array envelope that claude 2.1 prints is accepted", () => {
  const r = run(req(mkRepo()), { mode: "array" });
  assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json));
  assert.deepEqual(r.json.findings, [GOOD]);
  assert.match(r.stderr, /0\.0123/);
});

test("envelope cost is logged to stderr", () => {
  const r = run(req(mkRepo()));
  assert.match(r.stderr, /0\.0123/);
});

for (const mode of ["badenum", "badrisk", "badloc", "nonjson", "noenvelope"]) {
  test(`${mode}: not contract-shaped, exit 2`, () => {
    const r = run(req(mkRepo()), { mode });
    assert.equal(r.code, 2);
    assert.ok(r.json.error);
    assert.ok(r.json.next_step);
  });
}

test("claude exits 1: adapter exits 1", () => {
  const r = run(req(mkRepo()), { mode: "exit1" });
  assert.equal(r.code, 1);
  assert.ok(r.json.error);
});

test("claude binary cannot spawn: exit 1", () => {
  const r = run(req(mkRepo()), { stub: { bin: "/nonexistent/claude", log: "/nonexistent/log" } });
  assert.equal(r.code, 1);
});

test("empty diff returns no findings without calling claude", () => {
  const r = run(req(mkRepo({ change: false })));
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.findings, []);
  assert.equal(r.called, false);
});

test("argv isolates claude from user, project and MCP config", () => {
  const { rec } = run(req(mkRepo()));
  const a = rec.argv;
  assert.ok(a.includes("-p"));
  assert.equal(a[a.indexOf("--tools") + 1], "");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.ok(a.includes("--no-session-persistence"));
  assert.equal(a[a.indexOf("--output-format") + 1], "json");
  assert.ok(!a.includes("--bare"));
});

test("diff is on stdin between two identical nonce markers, never in argv", () => {
  const { rec } = run(req(mkRepo()));
  const marks = [...rec.stdin.matchAll(/DIFF ([0-9a-f]{16,})-----/g)];
  assert.equal(marks.length, 2);
  assert.equal(marks[0][1], marks[1][1]);
  const between = rec.stdin.slice(marks[0].index, marks[1].index);
  assert.match(between, /SECRET_MARKER_LINE/);
  assert.ok(!rec.argv.join(" ").includes("SECRET_MARKER_LINE"));
  assert.match(rec.stdin, /ignore/i);
});

test("the nonce differs between runs", () => {
  const repo = mkRepo();
  const n = () => /DIFF ([0-9a-f]{16,})-----/.exec(run(req(repo)).rec.stdin)[1];
  assert.notEqual(n(), n());
});

test("--model and --bare are passed through", () => {
  const { rec } = run(req(mkRepo()), { args: ["--model", "sonnet", "--bare"] });
  assert.equal(rec.argv[rec.argv.indexOf("--model") + 1], "sonnet");
  assert.ok(rec.argv.includes("--bare"));
  assert.ok(!rec.argv.includes("--setting-sources"));
});

test("diff past --max-diff-bytes is truncated and says so", () => {
  const r = run(req(mkRepo()), { args: ["--max-diff-bytes", "40"] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.rec.stdin, /truncated/i);
  assert.ok(!r.rec.stdin.includes("SECRET_MARKER_LINE"));
  assert.match(r.json.next_step, /truncated/i);
});

test("diff_ref starting with a dash is refused", () => {
  const r = run(req(mkRepo(), "-x"));
  assert.equal(r.code, 2);
  assert.equal(r.called, false);
});

test("bad requests: exit 2", () => {
  const repo = mkRepo();
  for (const bad of [
    { ...req(repo), repo_path: "rel" },
    { ...req(repo), repo_path: join(repo, "nope") },
    { ...req(repo), diff_ref: "" },
    { ...req(repo), ticket_id: 3 },
  ]) {
    const r = run(bad);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.equal(r.called, false);
  }
});

test("a git failure on the diff is a provider failure, exit 1", () => {
  const r = run(req(mkRepo(), "no-such-ref"));
  assert.equal(r.code, 1);
  assert.equal(r.called, false);
});

test("argv is exactly the pre-port array", () => {
  const base = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];
  assert.deepEqual(run(req(mkRepo())).rec.argv, [...base, "--setting-sources", ""]);
  assert.deepEqual(run(req(mkRepo()), { args: ["--model", "sonnet"] }).rec.argv, [...base, "--setting-sources", "", "--model", "sonnet"]);
  assert.deepEqual(run(req(mkRepo()), { args: ["--bare"] }).rec.argv, [...base, "--bare"]);
  assert.deepEqual(run(req(mkRepo()), { args: ["--model", "sonnet", "--bare"] }).rec.argv, [...base, "--bare", "--model", "sonnet"]);
});

test("prompt is stdin-only, cwd is an empty temp dir", () => {
  const repo = mkRepo();
  const { rec } = run(req(repo));
  assert.ok(!rec.argv.includes(rec.stdin));
  assert.match(rec.stdin, /ticket T-1/);
  assert.match(basename(rec.cwd), /^detent-claude-reviewer-/);
  assert.notEqual(rec.cwd, realpathSync(repo));
  assert.deepEqual(rec.entries, []);
});

test("DETENT_RUNTIME=nope: exit 2 naming the runtime, claude never called", () => {
  const r = run(req(mkRepo()), { env: { DETENT_RUNTIME: "nope" } });
  assert.equal(r.code, 2);
  assert.match(r.json.error, /nope/);
  assert.ok(r.json.next_step);
  assert.equal(r.called, false);
});
