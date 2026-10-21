// run new seeds env.json with the index's suggested verify command, never commands.verify
// (detent drive turns commands.verify into a Bash permission).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { engine, mkRepo, readJson, detentHome } from "./helpers.mjs";

const INDEX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index", "index.mjs");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function indexed(repo) {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  spawnSync("git", ["-C", repo, "add", "package.json"]);
  spawnSync("git", ["-C", repo, "commit", "-q", "-m", "pkg"], { env: { ...process.env, ...GIT_ENV } });
  const r = spawnSync(process.execPath, [INDEX, "build", "--repo", repo], { encoding: "utf8", env: { ...process.env, DETENT_INDEX_TAGGER: "regex" } });
  assert.equal(r.status, 0, r.stderr);
}

test("run new with an index profile writes suggested.verify and no commands.verify", () => {
  const repo = mkRepo();
  indexed(repo);
  const r = engine(["run", "new", "--ticket", "octo/repo#1", "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const env = readJson(join(detentHome(), ".sdlc", r.json.run_id, "env.json"));
  assert.deepEqual(env.suggested.verify, { source: "index", command: "npm test" });
  assert.equal(env.commands?.verify, undefined);
});

test("run new without an index writes no env.json", () => {
  const repo = mkRepo();
  const r = engine(["run", "new", "--ticket", "octo/repo#2", "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(detentHome(), ".sdlc", r.json.run_id, "env.json")), false);
});

test("engine env still merges after the seed, keeping suggested", () => {
  const repo = mkRepo();
  indexed(repo);
  const r = engine(["run", "new", "--ticket", "octo/repo#3", "--repo", repo]);
  const e = engine(["env", "--run", r.json.run_id, "--verify", "node --test"]);
  assert.equal(e.code, 0, e.stdout + e.stderr);
  const env = readJson(join(detentHome(), ".sdlc", r.json.run_id, "env.json"));
  assert.equal(env.commands.verify, "node --test");
  assert.equal(env.suggested.verify.source, "index");
});
