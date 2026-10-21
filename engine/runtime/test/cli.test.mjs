import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratch, makeFake, baseRequest, readLog, spawned } from "./kit.mjs";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "engine.mjs");

function verb(args, { input, env = {} } = {}) {
  const e = { ...process.env };
  delete e.DETENT_RUNTIME;
  Object.assign(e, env);
  const r = spawnSync(process.execPath, [ENGINE, "runtime", ...args], { input, encoding: "utf8", env: e });
  const lines = r.stdout.trim().split("\n");
  return { code: r.status, lines, json: lines.length === 1 && lines[0] ? JSON.parse(lines[0]) : null, stderr: r.stderr };
}

test("runtime run: stdin request plus --bin fake gives one JSON line, exit 0, and the fake saw the golden argv", () => {
  const dir = scratch();
  const { bin } = makeFake(dir, "ok");
  const r = verb(["run", "--bin", bin], { input: JSON.stringify(baseRequest(dir, { persist_session: false })) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.lines.length, 1);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.runtime, "claude-code");
  assert.equal(r.json.stop, "ok");
  assert.equal(r.json.text, "hi");
  assert.equal(r.json.cost_usd, 0.0123);
  assert.ok(r.json.next_step);
  assert.deepEqual(readLog(dir).argv, ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""]);
  assert.equal(readLog(dir).stdin, "say hi");
});

test("runtime run: --runtime claude-code is accepted", () => {
  const dir = scratch();
  const r = verb(["run", "--runtime", "claude-code", "--bin", makeFake(dir, "ok").bin], { input: JSON.stringify(baseRequest(dir)) });
  assert.equal(r.code, 0, r.stderr);
});

test("runtime run: bad stdin JSON exits 2", () => {
  const r = verb(["run"], { input: "{nope" });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.reason && r.json.next_step);
});

test("runtime run: an unknown request key exits 2 naming the field", () => {
  const dir = scratch();
  const r = verb(["run", "--bin", makeFake(dir, "ok").bin], { input: JSON.stringify({ ...baseRequest(dir), tier: "fast" }) });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /tier/);
  assert.equal(spawned(dir), false);
});

test("runtime run: an undeclared capability exits 2 naming capability and runtime, and spawns nothing", () => {
  const dir = scratch();
  const r = verb(["run", "--bin", makeFake(dir, "ok").bin], { input: JSON.stringify(baseRequest(dir, { budget: { usd: 1 } })) });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /budget/);
  assert.match(r.json.reason, /claude-code/);
  assert.equal(spawned(dir), false);
});

test("runtime run: a failing child exits 1 with response.stop=error", () => {
  const dir = scratch();
  const r = verb(["run", "--bin", makeFake(dir, "exit1").bin], { input: JSON.stringify(baseRequest(dir)) });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.response.stop, "error");
  assert.equal(r.json.response.error.kind, "exit");
  assert.ok(r.json.reason && r.json.next_step);
});

test("runtime run: a timeout exits 1 with response.stop=timeout", () => {
  const dir = scratch();
  const r = verb(["run", "--bin", makeFake(dir, "sleep").bin], { input: JSON.stringify(baseRequest(dir, { timeout_ms: 300 })) });
  assert.equal(r.code, 1);
  assert.equal(r.json.response.stop, "timeout");
});

test("runtime run: a missing binary exits 1, not 2", () => {
  const dir = scratch();
  const r = verb(["run", "--bin", makeFake(dir, "nobin").bin], { input: JSON.stringify(baseRequest(dir)) });
  assert.equal(r.code, 1);
  assert.equal(r.json.response.error.kind, "spawn");
});

test("runtime run: DETENT_RUNTIME=nope exits 2 naming the runtime, nothing spawned", () => {
  const dir = scratch();
  const r = verb(["run", "--bin", makeFake(dir, "ok").bin], { input: JSON.stringify(baseRequest(dir)), env: { DETENT_RUNTIME: "nope" } });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /nope/);
  assert.match(r.json.reason, /claude-code/);
  assert.equal(spawned(dir), false);
});

test("runtime run: --runtime beats DETENT_RUNTIME", () => {
  const dir = scratch();
  const r = verb(["run", "--runtime", "claude-code", "--bin", makeFake(dir, "ok").bin], { input: JSON.stringify(baseRequest(dir)), env: { DETENT_RUNTIME: "nope" } });
  assert.equal(r.code, 0, r.stderr);
});

test("runtime capabilities prints the declaration", () => {
  const r = verb(["capabilities"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.runtime, "claude-code");
  assert.deepEqual(r.json.capabilities.output, ["text", "json"]);
  assert.equal(r.json.capabilities.budget, false);
  assert.ok(r.json.next_step);
});

test("runtime capabilities with an unknown --runtime exits 2", () => {
  const r = verb(["capabilities", "--runtime", "nope"]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /nope/);
});

test("runtime with no or an unknown subcommand exits 2", () => {
  assert.equal(verb([]).code, 2);
  assert.equal(verb(["frob"]).code, 2);
});
