import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, idx, commit } from "./fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HERE, "..", "..", "adapters", "repo-index-knowledge");
const DETENT = join(HERE, "..", "..", "cli", "detent.mjs");

const call = (req) => {
  const r = spawnSync(ADAPTER, [], { input: typeof req === "string" ? req : JSON.stringify(req), encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* exit-code cases below assert on code */ }
  return { code: r.status, json, err: r.stderr };
};

let repo;
before(() => { repo = makeRepo(); idx(repo, ["build"]); });

test("fresh index: results carry repo-index sources, excerpts and confidence", () => {
  const r = call({ query: "validateToken session", repo_path: repo, max_results: 100 });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.provider, "repo-index");
  assert.ok(r.json.results.length >= 1 && r.json.results.length <= 25);
  const top = r.json.results[0];
  assert.equal(top.source, "repo-index:src/auth.js");
  assert.ok(top.excerpt.length <= 240 && top.excerpt.includes("validateToken"));
  assert.ok(top.confidence > 0 && top.confidence <= 1);
  assert.equal(r.json.warning, undefined);
  assert.ok(r.json.next_step);
});

test("stale index: still answers, with a warning and lower confidence", () => {
  const fresh = call({ query: "validateToken", repo_path: repo }).json.results[0].confidence;
  commit(repo, { "src/auth.js": "export function validateToken(t) { return 1; }\n" }, "edit");
  const r = call({ query: "validateToken", repo_path: repo });
  assert.equal(r.code, 0, r.err);
  assert.match(r.json.warning, /stale/i);
  assert.ok(r.json.results[0].confidence < fresh);
});

test("missing index exits 1 and points at detent index build", () => {
  const r = call({ query: "x", repo_path: makeRepo() });
  assert.equal(r.code, 1);
  assert.match(r.json.next_step, /detent index build/);
});

test("contract violations exit 2", () => {
  assert.equal(call("not json").code, 2);
  assert.equal(call({ query: "x" }).code, 2);
  assert.equal(call({ repo_path: repo }).code, 2);
});

test("non-directory repo_path is a provider failure (exit 1)", () => {
  assert.equal(call({ query: "x", repo_path: join(repo, "nope") }).code, 1);
});

test("detent index routes to the index CLI", () => {
  const r = spawnSync(process.execPath, [DETENT, "index", "status", "--repo", makeRepo()], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).state, "missing");
  assert.match(spawnSync(process.execPath, [DETENT, "help"], { encoding: "utf8" }).stdout, /detent index/);
});
