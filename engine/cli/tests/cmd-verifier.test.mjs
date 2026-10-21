import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters", "cmd-verifier");
const NODE = process.execPath;
const KINDS_OK = "e2e-run";

function mkRepo({ ignore = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cmdv-"));
  spawnSync("git", ["init", "-q", dir]);
  if (ignore) writeFileSync(join(dir, ".gitignore"), ".verify\n");
  return dir;
}

function script(name, body) {
  const p = join(mkdtempSync(join(tmpdir(), "cmdv-s-")), name);
  writeFileSync(p, body);
  return `"${NODE}" "${p}"`;
}

function evidenceCmd(lines) {
  return script("ev.mjs", `console.log(${JSON.stringify(lines.join("\n"))});`);
}

function run(req, args, input) {
  const r = spawnSync(ADAPTER, args, { input: input ?? JSON.stringify(req), encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* asserted by tests */ }
  return { code: r.status, json, stderr: r.stderr };
}

const okTest = script("t.mjs", `console.log("# pass 3\\n# fail 0");`);
const ev = (claim, extra = {}) => JSON.stringify({ claim, kind: KINDS_OK, note: "ran it", ...extra });

function req(repo, claims = ["a"]) {
  return { repo_path: repo, diff_ref: "main...HEAD", ticket_id: "T-1", claims };
}

test("all claims covered: pass, exit 0, artifacts saved", () => {
  const repo = mkRepo();
  const r = run(req(repo, ["a", "b"]), ["--test", okTest, "--evidence", evidenceCmd([ev("a"), ev("b", { artifact: "/x/y.png" })])]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.verdict, "pass");
  assert.equal(r.json.evidence.length, 2);
  assert.equal(r.json.evidence[1].artifact, "/x/y.png");
  assert.equal(r.json.evidence[0].artifact, join(repo, ".verify", "evidence-output.txt"));
  assert.ok(existsSync(join(repo, ".verify", "test-output.txt")));
  assert.match(readFileSync(join(repo, ".verify", "evidence-output.txt"), "utf8"), /"claim"/);
  assert.ok(r.json.next_step);
});

test("TAP counts are parsed", () => {
  const repo = mkRepo();
  const t = script("t.mjs", `console.log("# pass 7\\n# fail 0");`);
  const r = run(req(repo), ["--test", t, "--evidence", evidenceCmd([ev("a")])]);
  assert.equal(r.json.test_results.passed, 7);
  assert.equal(r.json.test_results.failed, 0);
  assert.equal(r.json.test_results.note, undefined);
});

test("no TAP summary: falls back to exit code and says so", () => {
  const repo = mkRepo();
  const t = script("t.mjs", `console.log("ok");`);
  const r = run(req(repo), ["--test", t, "--evidence", evidenceCmd([ev("a")])]);
  assert.equal(r.json.test_results.passed, 1);
  assert.equal(r.json.test_results.failed, 0);
  assert.match(r.json.test_results.note, /exit code/);
});

test("uncovered claim: fail, exit 1, uncovered_claims listed", () => {
  const repo = mkRepo();
  const r = run(req(repo, ["a", "b"]), ["--test", okTest, "--evidence", evidenceCmd([ev("a")])]);
  assert.equal(r.code, 1);
  assert.equal(r.json.verdict, "fail");
  assert.deepEqual(r.json.uncovered_claims, ["b"]);
});

test("empty evidence can never pass", () => {
  const repo = mkRepo();
  const r = run(req(repo), ["--test", okTest, "--evidence", script("e.mjs", "")]);
  assert.equal(r.code, 1);
  assert.equal(r.json.verdict, "fail");
});

test("failing test command: fail, exit 1", () => {
  const repo = mkRepo();
  const t = script("t.mjs", `console.log("# pass 1\\n# fail 2"); process.exit(1);`);
  const r = run(req(repo), ["--test", t, "--evidence", evidenceCmd([ev("a")])]);
  assert.equal(r.code, 1);
  assert.equal(r.json.verdict, "fail");
  assert.equal(r.json.test_results.failed, 2);
});

test("bad evidence kind: exit 2 naming the line", () => {
  const repo = mkRepo();
  const bad = JSON.stringify({ claim: "a", kind: "vibes", note: "n" });
  const r = run(req(repo), ["--test", okTest, "--evidence", evidenceCmd([ev("a"), bad])]);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /line 2/);
});

test("malformed evidence line: exit 2", () => {
  const repo = mkRepo();
  const r = run(req(repo), ["--test", okTest, "--evidence", evidenceCmd(["not json"])]);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /line 1/);
});

test("evidence command receives the request on stdin", () => {
  const repo = mkRepo();
  const e = script("e.mjs", `
import { readFileSync } from "node:fs";
const q = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify({ claim: q.claims[0], kind: "log-capture", note: q.ticket_id }));`);
  const r = run(req(repo), ["--test", okTest, "--evidence", e]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.evidence[0].note, "T-1");
});

test("commands run with cwd = repo_path and --out is honoured", () => {
  const repo = mkRepo();
  const e = script("e.mjs", `console.log(JSON.stringify({claim:"a",kind:"e2e-run",note:process.cwd()}));`);
  const r = run(req(repo), ["--test", okTest, "--evidence", e, "--out", "art"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(repo, "art", "test-output.txt")));
  assert.equal(r.json.evidence[0].note, readFileSync(join(repo, "art", "evidence-output.txt"), "utf8").match(/"note":"([^"]+)"/)[1]);
});

test("warns when the out dir is not git-ignored", () => {
  const repo = mkRepo({ ignore: false });
  const r = run(req(repo), ["--test", okTest, "--evidence", evidenceCmd([ev("a")])]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /not ignored by git/);
});

test("no warning when the out dir is ignored", () => {
  const repo = mkRepo();
  const r = run(req(repo), ["--test", okTest, "--evidence", evidenceCmd([ev("a")])]);
  assert.doesNotMatch(r.stderr, /not ignored/);
});

test("bad requests: exit 2", () => {
  const repo = mkRepo();
  const args = ["--test", okTest, "--evidence", evidenceCmd([ev("a")])];
  for (const bad of [
    { ...req(repo), repo_path: "relative/path" },
    { ...req(repo), repo_path: join(repo, "nope") },
    { ...req(repo), diff_ref: 5 },
    { ...req(repo), ticket_id: undefined },
    { ...req(repo), claims: [] },
    { ...req(repo), claims: ["a", 3] },
  ]) {
    const r = run(bad, args);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.ok(r.json.error);
  }
  assert.equal(run(null, args, "not json").code, 2);
});

test("missing required args: exit 2", () => {
  const repo = mkRepo();
  assert.equal(run(req(repo), ["--evidence", "true"]).code, 2);
  assert.equal(run(req(repo), ["--test", "true"]).code, 2);
});
