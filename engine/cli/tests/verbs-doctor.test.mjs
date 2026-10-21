// verbs-doctor.test.mjs — `doctor` is one line per check and exits 1 if any fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { engine, mkRepo, detentHome } from "./helpers.mjs";
import { HUMAN, scratch, stubBin, setOrigin } from "./verbs-helpers.mjs";

function healthy() {
  const repo = mkRepo();
  setOrigin(repo, "https://github.com/octo/repo.git");
  const bin = scratch();
  stubBin(bin, "curator", "exit 0");
  const gh = stubBin(bin, "gh", `case "$1" in
  auth) echo "Logged in as octocat" ;;
  api) echo true ;;
esac`);
  const tool = stubBin(bin, "tool", "exit 0");
  writeFileSync(join(repo, "stack.yaml"), `engine_version: "1"\n\nsockets:\n  ticket:\n    command: ${JSON.stringify(tool)}\n    version: "builtin"\n`);
  return { repo, env: { ...HUMAN, PATH: `${bin}:/usr/bin:/bin`, DETENT_GH_CMD: gh } };
}

const byName = (r, name) => r.json.checks.find((c) => c.name === name);

test("doctor passes on a healthy setup, one check per line", () => {
  const { repo, env } = healthy();
  const r = engine(["doctor"], { cwd: repo, env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const name of ["node", "git", "gh auth", "gh push access", "curator", "stack.yaml", "sockets", "DETENT_ROOT"]) {
    assert.equal(byName(r, name)?.status, "PASS", `${name}: ${r.stdout}`);
  }
});

test("doctor fails on a missing stack.yaml and exits 1", () => {
  const { repo, env } = healthy();
  const r = engine(["doctor"], { cwd: join(repo, ".."), env });
  assert.equal(r.code, 1);
  const bare = mkRepo();
  const r2 = engine(["doctor"], { cwd: bare, env });
  assert.equal(r2.code, 1, r2.stdout);
  assert.equal(byName(r2, "stack.yaml").status, "FAIL");
});

test("doctor fails when a socket command is not executable", () => {
  const { repo, env } = healthy();
  writeFileSync(join(repo, "stack.yaml"), `engine_version: "1"\n\nsockets:\n  ticket:\n    command: /nonexistent/tool\n    version: "builtin"\n`);
  const r = engine(["doctor"], { cwd: repo, env });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(byName(r, "sockets").status, "FAIL");
  assert.match(byName(r, "sockets").detail, /\/nonexistent\/tool/);
});

test("doctor reports when the active gh account cannot push, and does not switch accounts", () => {
  const { repo, env } = healthy();
  const bin = scratch();
  const gh = stubBin(bin, "gh", `case "$1" in
  auth) echo "Logged in as octocat" ;;
  api) echo false ;;
esac`);
  const r = engine(["doctor"], { cwd: repo, env: { ...env, DETENT_GH_CMD: gh } });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(byName(r, "gh push access").status, "FAIL");
  assert.match(byName(r, "gh push access").detail, /octo/);
});

test("doctor without curator on PATH fails that line", () => {
  const { repo, env } = healthy();
  const r = engine(["doctor"], { cwd: repo, env: { ...env, PATH: "/usr/bin:/bin" } });
  assert.equal(byName(r, "curator").status, "FAIL");
  assert.equal(r.code, 1);
});

test("doctor at a terminal prints one line per check", () => {
  const { repo, env } = healthy();
  const r = engine(["doctor"], { cwd: repo, env: { ...env, DETENT_FORCE_TTY: "1" } });
  const lines = r.stdout.trim().split("\n").filter((l) => /^(PASS|FAIL|WARN) /.test(l));
  assert.ok(lines.length >= 8, r.stdout);
});

test("doctor with DETENT_ROOT unset warns with the fallback path and still exits 0", () => {
  const { repo, env } = healthy();
  const r = engine(["doctor"], { cwd: repo, env: { ...env, DETENT_ROOT: "" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const c = byName(r, "DETENT_ROOT");
  assert.equal(c.status, "WARN", r.stdout);
  assert.match(c.detail, /detent/);
  assert.ok(c.detail.includes(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")), c.detail);
});
