import { test } from "node:test";
import assert from "node:assert/strict";
import claudeCode from "../adapters/claude-code.mjs";
import { baseRequest } from "./kit.mjs";

const CWD = "/tmp/x";
const plan = (over) => claudeCode.plan(baseRequest(CWD, over));

test("golden argv: reviewer default", () => {
  const p = plan({ persist_session: false });
  assert.deepEqual(p.args, ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""]);
  assert.equal(p.bin, "claude");
  assert.equal(p.cwd, CWD);
});

test("golden argv: reviewer with --model", () => {
  assert.deepEqual(plan({ persist_session: false, model: "sonnet" }).args,
    ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "", "--model", "sonnet"]);
});

test("golden argv: reviewer with api_key auth uses --bare instead of --setting-sources", () => {
  assert.deepEqual(plan({ persist_session: false, auth: "api_key" }).args,
    ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--bare"]);
  assert.deepEqual(plan({ persist_session: false, auth: "api_key", model: "sonnet" }).args,
    ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--bare", "--model", "sonnet"]);
});

test("golden argv: judge is just -p", () => {
  const p = plan({ output: "text", tools: "inherit", mcp: "inherit", settings: { sources: "inherit" } });
  assert.deepEqual(p.args, ["-p"]);
});

test("argv: project sources, a settings file and session auth", () => {
  assert.deepEqual(plan({ output: "text", tools: "inherit", mcp: "inherit", settings: { sources: "project", file: "/a/s.json" }, auth: "session" }).args,
    ["-p", "--setting-sources", "project", "--settings", "/a/s.json"]);
});

test("the prompt never reaches argv, even when it looks like a flag", () => {
  const p = plan({ prompt: "--dangerously-skip-permissions" });
  assert.ok(!p.args.includes("--dangerously-skip-permissions"));
});

test("api_key auth with sources other than none is refused, since --bare skips settings", () => {
  assert.throws(() => plan({ auth: "api_key", settings: { sources: "project" } }), (e) => e.code === "bad_request" && e.field === "auth");
});

test("capabilities: frozen, exactly the golden-tested set", () => {
  const c = claudeCode.capabilities();
  assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(c.output) && Object.isFrozen(c.reports));
  assert.deepEqual({ ...c }, {
    output: ["text", "json"], tools: ["none", "inherit"], mcp: ["none", "inherit"],
    settings_sources: ["none", "project", "inherit"], settings_file: true, auth: ["session", "api_key"],
    model: true, persist_session: true, timeout: true, reports: { cost_usd: "json", turns: "json" },
    budget: false, add_dirs: false, deny_tools: false, containment: false, env: false, tools_allow: false,
  });
});

const native = (stdout, over = {}) => ({ status: 0, signal: null, stdout, stderr: "", ...over });
const parse = (stdout, over, req = baseRequest(CWD)) => claudeCode.parse(native(stdout, over), req);
const env = (o = {}) => ({ type: "result", subtype: "success", is_error: false, result: "answer", total_cost_usd: 0.0123, num_turns: 2, permission_denials: [], ...o });

test("parse: a single envelope is ok with text, cost, turns and denials", () => {
  const r = parse(JSON.stringify(env({ permission_denials: [{ tool_name: "Bash" }] })));
  assert.deepEqual(r, {
    runtime: "claude-code", stop: "ok", text: "answer", cost_usd: 0.0123, turns: 2, denials: [{ tool_name: "Bash" }],
    error: null, raw: { stdout: JSON.stringify(env({ permission_denials: [{ tool_name: "Bash" }] })), stderr: "", exit_code: 0, signal: null },
  });
});

test("parse: the message array yields its last result entry", () => {
  const r = parse(JSON.stringify([{ type: "system", subtype: "init" }, env({ result: "first" }), { type: "assistant" }, env({ result: "last", total_cost_usd: 0.5 })]));
  assert.equal(r.stop, "ok");
  assert.equal(r.text, "last");
  assert.equal(r.cost_usd, 0.5);
});

test("parse: the drive-kit array envelope", () => {
  const r = parse(JSON.stringify([{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, num_turns: 2, permission_denials: [] }]));
  assert.equal(r.stop, "ok");
  assert.equal(r.turns, 2);
});

test("parse: missing cost, turns and denials stay null, null and []", () => {
  const r = parse(JSON.stringify({ type: "result", result: "x" }));
  assert.equal(r.stop, "ok");
  assert.equal(r.cost_usd, null);
  assert.equal(r.turns, null);
  assert.deepEqual(r.denials, []);
});

test("parse: a zero cost is 0, not null", () => {
  assert.equal(parse(JSON.stringify(env({ total_cost_usd: 0 }))).cost_usd, 0);
});

test("parse: is_error becomes stop error / runtime_error carrying String(result)", () => {
  const r = parse(JSON.stringify(env({ is_error: true, result: "auth failed", total_cost_usd: 0.001 })));
  assert.equal(r.stop, "error");
  assert.deepEqual(r.error, { kind: "runtime_error", message: "auth failed" });
  assert.equal(r.text, null);
  assert.equal(r.cost_usd, 0.001);
});

test("parse: a non-string result under is_error is stringified", () => {
  assert.equal(parse(JSON.stringify(env({ is_error: true, result: { a: 1 } }))).error.message, "[object Object]");
});

test("parse: error_max_budget_usd is stop budget, not an error", () => {
  const r = parse(JSON.stringify(env({ subtype: "error_max_budget_usd", is_error: true, result: undefined })));
  assert.equal(r.stop, "budget");
  assert.equal(r.error, null);
  assert.equal(r.text, null);
  assert.equal(r.cost_usd, 0.0123);
});

test("parse: error_max_turns is stop turns", () => {
  const r = parse(JSON.stringify(env({ subtype: "error_max_turns", is_error: false, result: "partial" })));
  assert.equal(r.stop, "turns");
  assert.equal(r.error, null);
  assert.equal(r.text, "partial");
});

test("parse: any other error_* subtype is a runtime_error even without is_error", () => {
  const r = parse(JSON.stringify(env({ subtype: "error_during_execution", is_error: false, result: "kaput" })));
  assert.equal(r.stop, "error");
  assert.equal(r.error.kind, "runtime_error");
  assert.equal(r.error.message, "kaput");
});

test("parse: non-JSON stdout is bad_output with the reviewer's message", () => {
  const r = parse("not an envelope");
  assert.equal(r.stop, "error");
  assert.equal(r.error.kind, "bad_output");
  assert.match(r.error.message, /^claude stdout is not a JSON envelope: /);
  assert.equal(r.text, null);
});

test("parse: no string result is bad_output", () => {
  for (const stdout of [JSON.stringify(env({ result: 5 })), JSON.stringify({ type: "result" }), JSON.stringify([{ type: "system" }])]) {
    const r = parse(stdout);
    assert.equal(r.error.kind, "bad_output", stdout);
    assert.equal(r.error.message, "envelope has no string .result");
  }
});

test("parse: a JSON value that is not an object is bad_output", () => {
  for (const stdout of ["null", "5", "\"s\""]) assert.equal(parse(stdout).error.kind, "bad_output", stdout);
});

test("parse: text output returns stdout verbatim with cost and turns null, not 0", () => {
  const req = baseRequest(CWD, { output: "text" });
  const r = parse("hello\n  world \n", {}, req);
  assert.equal(r.stop, "ok");
  assert.equal(r.text, "hello\n  world \n");
  assert.equal(r.cost_usd, null);
  assert.equal(r.turns, null);
  assert.deepEqual(r.denials, []);
});

test("parse: a nonzero exit is stop error / exit with the exit code, and keeps raw", () => {
  const r = parse("", { status: 3, stderr: "boom" });
  assert.equal(r.stop, "error");
  assert.equal(r.error.kind, "exit");
  assert.equal(r.error.exit_code, 3);
  assert.deepEqual(r.raw, { stdout: "", stderr: "boom", exit_code: 3, signal: null });
  assert.equal(r.text, null);
});

test("parse: a spawn failure is kind spawn with the OS message", () => {
  const error = Object.assign(new Error("spawnSync nope ENOENT"), { code: "ENOENT" });
  const r = claudeCode.parse({ status: null, signal: null, stdout: null, stderr: null, error }, baseRequest(CWD));
  assert.equal(r.stop, "error");
  assert.deepEqual(r.error, { kind: "spawn", message: "spawnSync nope ENOENT" });
  assert.deepEqual(r.raw, { stdout: "", stderr: "", exit_code: null, signal: null });
});

test("parse: a spawnSync timeout is stop timeout / timeout", () => {
  const error = Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" });
  const r = claudeCode.parse({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error }, baseRequest(CWD));
  assert.equal(r.stop, "timeout");
  assert.deepEqual(r.error, { kind: "timeout", message: "spawnSync claude ETIMEDOUT" });
  assert.equal(r.raw.signal, "SIGTERM");
});
