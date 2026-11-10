// Child prose cites decisions by manifest key (D-<key>); drive rewrites them to the ids it assigns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, drive, readJson, writeJson } from "./drive-kit.mjs";

const opt = (key) => ({ key, label: `Take path ${key}`, consequence: "Changes the shipped behaviour for every caller" });
const dec = (key, over = {}) => ({
  key, question: `Which path for ${key}?`, options: [opt("a"), opt("b")], blocks: ["implement"], cause: "judgment",
  recommended: { key: "a", reason: "Path a keeps existing callers working unchanged" }, ...over,
});
const brief = (text) => `# Brief\n\n## Goal\nUsers can X.\n\n## Unknowns & open questions\n${text}\n`;

function run(briefText, decisions, seed) {
  const t = setup();
  if (seed) writeJson(join(t.runDir, "decisions.json"), seed);
  const r = drive(t, { files: { "brief.md": brief(briefText) }, manifestPatch: { decisions } }, ["--max-steps", "1"]);
  const out = readFileSync(join(t.runDir, "brief.md"), "utf8");
  return { t, r, out, ids: readJson(join(t.runDir, "decisions.json")).map((d) => d.id) };
}

test("a D-<key> reference in the brief becomes the decision id drive assigned", () => {
  const { r, out, ids } = run("Ticket is cut off (→ D-u1-truncated)", [dec("u1-truncated")]);
  assert.notEqual(r.json && r.json.reason, "outbox_rejected", r.stdout + r.stderr);
  assert.ok(ids.includes("D-001"), ids.join(","));
  assert.match(out, /\(→ D-001\)/);
  assert.ok(!out.includes("u1-truncated"), out);
});

test("keys that prefix one another do not clobber each other", () => {
  const { out } = run("First D-u1 and tenth D-u10 and again D-u1.", [dec("u1"), dec("u10")]);
  assert.match(out, /First D-001 and tenth D-002 and again D-001\./);
});

test("a raise after existing decisions maps to the next id", () => {
  const seed = [{ id: "D-001", raised_by: "engine", blocks: ["plan"], question: "Old?", options: ["x", "y"], status: "answered", answer: "x", answered_by: "human" }];
  const { out, ids } = run("See D-u1 for the open point.", [dec("u1")], seed);
  assert.ok(ids.includes("D-002"), ids.join(","));
  assert.match(out, /See D-002 for the open point\./);
});

test("an unmatched D-key and an existing D-001 style id are left alone", () => {
  const { out } = run("Unknown D-u9 and earlier D-001 and D-u1x stay.", [dec("u1")]);
  assert.match(out, /Unknown D-u9 and earlier D-001 and D-u1x stay\./);
});
