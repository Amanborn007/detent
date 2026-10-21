import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, commit, idx, readIndexFile } from "./fixture.mjs";

function repoWith(files) {
  const repo = mkdtempSync(join(tmpdir(), "detent-refs-"));
  git(repo, "init", "-q", "-b", "main");
  commit(repo, files, "initial");
  return repo;
}
const order = (repo) => {
  assert.equal(idx(repo, ["build"]).code, 0);
  return readIndexFile(repo, "map.md").split("\n").filter((l) => /\.js$/.test(l));
};
const users = (body) => Object.fromEntries([1, 2, 3].map((i) => [`use${i}.js`, body]));

test("a file referenced only through a generic name ranks below one referenced through a specific identifier", () => {
  const repo = repoWith({
    "a-generic.js": "export function options() {}\n",
    "z-specific.js": "export function computeLedgerBalance() {}\n",
    ...users("options(); options(); options(); options(); computeLedgerBalance();\n"),
  });
  const o = order(repo);
  assert.ok(o.indexOf("z-specific.js") < o.indexOf("a-generic.js"), o.join(","));
});

test("a name defined in two files counts less than one defined in a single file", () => {
  const repo = repoWith({
    "a-dup1.js": "export function renderInvoice() {}\n",
    "a-dup2.js": "export function renderInvoice() {}\n",
    "z-solo.js": "export function renderReceipt() {}\n",
    ...users("renderInvoice(); renderReceipt();\n"),
  });
  const o = order(repo);
  assert.ok(o.indexOf("z-solo.js") < o.indexOf("a-dup1.js"), o.join(","));
});

test("a file mentioning its own definitions gains no rank from itself", () => {
  const repo = repoWith({
    "a-selfish.js": "export function computeTotals() { return computeTotals(); }\n",
    "z-other.js": "export function computeMargins() {}\n",
    "use.js": "computeMargins();\n",
  });
  const o = order(repo);
  assert.ok(o.indexOf("z-other.js") < o.indexOf("a-selfish.js"), o.join(","));
});
