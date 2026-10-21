// verbs-help.test.mjs — the friendly verbs are listed in every help surface and routed by detent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { engine } from "./helpers.mjs";

const DETENT = join(dirname(fileURLToPath(import.meta.url)), "..", "detent.mjs");
const VERBS = ["start", "status", "continue", "decide", "approve", "revise", "doctor"];

test("detent help lists every friendly verb", () => {
  const r = spawnSync(process.execPath, [DETENT, "help"], { encoding: "utf8" });
  for (const v of VERBS) assert.match(r.stdout, new RegExp(`detent ${v}\\b`), v);
});

test("engine help documents every friendly verb", () => {
  const r = engine(["help"]);
  for (const v of VERBS) assert.ok(v in r.json.usage, v);
});

test("under the detent wrapper the unknown-command usage names detent and the verbs", () => {
  const r = spawnSync(process.execPath, [DETENT, "frobnicate"], { encoding: "utf8" });
  const line = JSON.parse(r.stdout.trim().split("\n").pop());
  for (const v of VERBS) assert.match(line.next_step, new RegExp(`\\b${v}\\b`), v);
  const r2 = spawnSync(process.execPath, [DETENT, "decide-why"], { encoding: "utf8" });
  assert.match(JSON.parse(r2.stdout.trim().split("\n").pop()).next_step, /detent decide-why|detent /);
});

test("detent routes a friendly verb to the engine", () => {
  const r = spawnSync(process.execPath, [DETENT, "doctor", "--json"], { encoding: "utf8" });
  const line = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.ok(Array.isArray(line.checks));
  assert.match(line.next_step, /^fix: |^everything/);
});
