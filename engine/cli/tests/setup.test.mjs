// setup.test.mjs — `engine setup` fills detent.user.yaml, writes a starter stack.yaml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engine, mkRepo, detentHome } from "./helpers.mjs";

function stub(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// Stubs answer for `git config user.name|user.email` and `gh api user`.
function probes({ gh = "echo octocat", name = "Ada Lovelace", email = "ada@example.invalid" } = {}) {
  const d = mkdtempSync(join(tmpdir(), "setup-stubs-"));
  const git = stub(d, "git", `case "$2" in user.name) echo "${name}";; user.email) echo "${email}";; esac`);
  const ghc = stub(d, "gh", gh);
  return { DETENT_GIT_CMD: git, DETENT_GH_CMD: ghc };
}

function userYaml() { return join(detentHome(), "detent.user.yaml"); }

test("setup creates detent.user.yaml and fills empty name, email and github_login", () => {
  const repo = mkRepo();
  const r = engine(["setup", "--repo", repo], { env: probes() });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  const y = readFileSync(userYaml(), "utf8");
  assert.match(y, /name: "Ada Lovelace"/);
  assert.match(y, /email: "ada@example\.invalid"/);
  assert.match(y, /github_login: "octocat"/);
  assert.ok(Array.isArray(r.json.unresolved));
  assert.ok(r.json.unresolved.includes("user.teams"));
  assert.match(r.json.next_step, /detent run new --ticket/);
});

test("setup never overwrites a value that is already set", () => {
  const repo = mkRepo();
  writeFileSync(userYaml(), 'user:\n  name: "Keep Me"\n  email: keep@example.invalid\n  github_login: ""\n  teams: []\n');
  const r = engine(["setup", "--repo", repo], { env: probes() });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const y = readFileSync(userYaml(), "utf8");
  assert.match(y, /name: "Keep Me"/);
  assert.match(y, /email: keep@example\.invalid/);
  assert.doesNotMatch(y, /Ada Lovelace/);
  assert.match(y, /github_login: "octocat"/);
  assert.ok(r.json.left_alone.includes("user.name"));
  assert.ok(r.json.left_alone.includes("user.email"));
});

test("setup reports github_login as unresolved when gh fails, and still succeeds", () => {
  const repo = mkRepo();
  const r = engine(["setup", "--repo", repo], { env: probes({ gh: "echo 'not logged in' >&2; exit 1" }) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.unresolved.includes("user.github_login"));
  assert.doesNotMatch(readFileSync(userYaml(), "utf8"), /github_login: "[^"]/);
  assert.ok(existsSync(join(repo, "stack.yaml")));
});

test("setup writes stack.yaml with absolute adapter paths that exist", () => {
  const repo = mkRepo();
  const r = engine(["setup", "--repo", repo], { env: probes() });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const y = readFileSync(join(repo, "stack.yaml"), "utf8");
  assert.match(y, /engine_version: "1"/);
  const cmds = [...y.matchAll(/command: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(cmds.length, 3);
  for (const c of cmds) {
    assert.ok(c.startsWith("/"), `not absolute: ${c}`);
    assert.ok(existsSync(c), `missing: ${c}`);
  }
  for (const n of ["gh-ticket", "repo-docs-knowledge", "gh-bot-comments"]) {
    assert.ok(cmds.some((c) => c.endsWith(`/engine/adapters/${n}`)), n);
  }
  assert.equal((y.match(/version: "builtin"/g) || []).length, 3);
  assert.ok(r.json.wrote.includes(join(repo, "stack.yaml")));
});

test("setup refuses an existing stack.yaml without --force, and overwrites with it", () => {
  const repo = mkRepo();
  writeFileSync(join(repo, "stack.yaml"), "# mine\nsockets: {}\n");
  const r = engine(["setup", "--repo", repo], { env: probes() });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /stack\.yaml/);
  assert.match(readFileSync(join(repo, "stack.yaml"), "utf8"), /# mine/);
  assert.equal(existsSync(userYaml()), false, "nothing written when refusing");
  const f = engine(["setup", "--repo", repo, "--force"], { env: probes() });
  assert.equal(f.code, 0, f.stdout + f.stderr);
  assert.match(readFileSync(join(repo, "stack.yaml"), "utf8"), /engine_version: "1"/);
});

test("setup refuses a work repo that is not a git repo with exit 2", () => {
  mkRepo();
  const plain = mkdtempSync(join(tmpdir(), "setup-plain-"));
  const r = engine(["setup", "--repo", plain], { env: probes() });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /git/i);
  assert.equal(existsSync(join(plain, "stack.yaml")), false);
});

test("the written stack.yaml is accepted by the engine (knowledge socket call)", () => {
  const repo = mkRepo();
  writeFileSync(join(repo, "README.md"), "# Widgets\nThe widget frobnicator.\n");
  const s = engine(["setup", "--repo", repo], { env: probes() });
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const pf = join(repo, "payload.json");
  writeFileSync(pf, JSON.stringify({ query: "widget", repo_path: repo }));
  const r = engine(["socket", "call", "knowledge", "--payload-file", pf, "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
});
