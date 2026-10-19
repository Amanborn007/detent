// help.test.mjs — `engine help` / `--help` print usage JSON and exit 0;
// unknown commands still refuse with exit 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { engine } from "./helpers.mjs";

test("engine help exits 0 with a usage map and next_step", () => {
  const r = engine(["help"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.usage && typeof r.json.usage === "object");
  for (const cmd of ["run new", "stage begin", "stage end", "gate open", "socket call", "next", "help"]) {
    assert.ok(cmd in r.json.usage, `usage missing '${cmd}'`);
  }
  assert.ok(Array.isArray(r.json.stages) && r.json.stages.includes("intake"));
  assert.ok(typeof r.json.next_step === "string" && r.json.next_step.length > 0);
});

test("engine --help behaves like engine help (exit 0, usage JSON)", () => {
  const r = engine(["--help"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.usage && "next" in r.json.usage);
});

test("--help wins even alongside another command word", () => {
  const r = engine(["next", "--help"]);
  assert.equal(r.code, 0);
  assert.ok(r.json.usage);
});

test("unknown commands still refuse with exit 2", () => {
  const r = engine(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /unknown command/);
});
