import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratch, baseRequest } from "./kit.mjs";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "engine.mjs");

function verb(args, { input, env = {} } = {}) {
  const e = { ...process.env };
  delete e.DETENT_RUNTIME;
  Object.assign(e, env);
  const r = spawnSync(process.execPath, [ENGINE, "runtime", ...args], { input, encoding: "utf8", env: e });
  const lines = r.stdout.trim().split("\n");
  return { code: r.status, json: lines.length === 1 && lines[0] ? JSON.parse(lines[0]) : null, stderr: r.stderr };
}

const GIT = ["commit", "push", "reset", "checkout", "rebase", "merge", "clean", "add", "stash"];
const owlRequest = (cwd) => ({
  prompt: "p", cwd, output: "json", tools: "inherit", mcp: "inherit", settings: { sources: "project", file: "/abs/s.json" },
  approvals: "deny", deny_tools: GIT.map((g) => ({ shell_prefix: `git ${g}` })),
});

test("runtime plan prints the owl plan as one JSON line, exit 0, spawning nothing", () => {
  const dir = scratch();
  const r = verb(["plan"], { input: JSON.stringify(owlRequest(dir)) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.runtime, "claude-code");
  assert.deepEqual(r.json.plan, {
    bin: "claude", cwd: dir,
    args: ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--setting-sources", "project", "--settings", "/abs/s.json", "--disallowedTools",
      ...GIT.map((g) => `Bash(git ${g}*)`)],
  });
  assert.ok(r.json.next_step);
});

test("runtime plan --bin replaces the binary, and a request env comes back in plan.env", () => {
  const dir = scratch();
  const r = verb(["plan", "--bin", "/x/claude"], { input: JSON.stringify(baseRequest(dir, { env: { A: "b" } })) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.plan.bin, "/x/claude");
  assert.deepEqual(r.json.plan.env, { A: "b" });
});

test("runtime plan exits 2 for a capability the runtime lacks", () => {
  const r = verb(["plan", "--runtime", "openai-compatible"], { input: JSON.stringify(baseRequest("/tmp", { deny_tools: [{ shell_prefix: "git push" }] })) });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /deny_tools/);
  assert.match(r.json.reason, /openai-compatible/);
});

test("runtime plan exits 2 for bad JSON, a bad shape and an unknown runtime", () => {
  assert.equal(verb(["plan"], { input: "{nope" }).code, 2);
  const shape = verb(["plan"], { input: JSON.stringify(baseRequest("/tmp", { budget: { usd: -1 } })) });
  assert.equal(shape.code, 2);
  assert.match(shape.json.reason, /budget\.usd/);
  assert.equal(verb(["plan", "--runtime", "nope"], { input: JSON.stringify(baseRequest("/tmp")) }).code, 2);
});

test("runtime plan exits 2 for an openai-compatible request when the endpoint is not configured", () => {
  const r = verb(["plan", "--runtime", "openai-compatible"], { input: JSON.stringify(baseRequest("/tmp")) });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /DETENT_OPENAI_BASE_URL/);
});

const files = (stdout, stderr = "") => {
  const dir = scratch();
  writeFileSync(join(dir, "out"), stdout);
  writeFileSync(join(dir, "err"), stderr);
  return { dir, out: join(dir, "out"), err: join(dir, "err") };
};
const envelope = (o = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hi", total_cost_usd: 0.25, num_turns: 3, permission_denials: [], ...o });
const parseArgs = (f, rest = ["--exit-code", "0"]) => ["parse", "--stdout", f.out, "--stderr", f.err, ...rest];

test("runtime parse of an ok envelope exits 0 with the response", () => {
  const f = files(envelope());
  const r = verb(parseArgs(f), { input: JSON.stringify(baseRequest(f.dir)) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.stop, "ok");
  assert.equal(r.json.text, "hi");
  assert.equal(r.json.cost_usd, 0.25);
  assert.equal(r.json.turns, 3);
  assert.equal(r.json.raw.exit_code, 0);
  assert.ok(r.json.next_step);
});

test("runtime parse of a budget stop exits 0", () => {
  const f = files(envelope({ subtype: "error_max_budget_usd", is_error: true }));
  const r = verb(parseArgs(f), { input: JSON.stringify(baseRequest(f.dir)) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.stop, "budget");
});

test("runtime parse of an is_error envelope exits 1 with the response", () => {
  const f = files(envelope({ is_error: true, result: "auth failed" }));
  const r = verb(parseArgs(f), { input: JSON.stringify(baseRequest(f.dir)) });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.response.stop, "error");
  assert.equal(r.json.response.error.message, "auth failed");
  assert.ok(r.json.reason && r.json.next_step);
});

test("runtime parse with a nonzero exit code still carries the envelope's cost", () => {
  const f = files(envelope(), "boom");
  const r = verb(parseArgs(f, ["--exit-code", "1"]), { input: JSON.stringify(baseRequest(f.dir)) });
  assert.equal(r.code, 1);
  assert.equal(r.json.response.error.kind, "exit");
  assert.equal(r.json.response.cost_usd, 0.25);
  assert.equal(r.json.response.raw.stderr, "boom");
});

test("runtime parse with --signal reports the signal in raw", () => {
  const f = files("");
  const r = verb(parseArgs(f, ["--signal", "SIGTERM"]), { input: JSON.stringify(baseRequest(f.dir)) });
  assert.equal(r.code, 1);
  assert.equal(r.json.response.raw.signal, "SIGTERM");
  assert.equal(r.json.response.raw.exit_code, null);
});

test("runtime parse leaves cost_usd null when the envelope has none", () => {
  const f = files(JSON.stringify({ type: "result", result: "x" }));
  const r = verb(parseArgs(f), { input: JSON.stringify(baseRequest(f.dir)) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.cost_usd, null);
  assert.equal(r.json.turns, null);
});

test("runtime parse exits 2 when a required flag is missing", () => {
  const f = files(envelope());
  const input = JSON.stringify(baseRequest(f.dir));
  assert.equal(verb(["parse", "--stdout", f.out, "--exit-code", "0"], { input }).code, 2);
  assert.equal(verb(["parse", "--stderr", f.err, "--exit-code", "0"], { input }).code, 2);
  assert.equal(verb(["parse", "--stdout", f.out, "--stderr", f.err], { input }).code, 2);
});

test("runtime parse exits 2 for both or neither of --exit-code and --signal, and a bad value", () => {
  const f = files(envelope());
  const input = JSON.stringify(baseRequest(f.dir));
  assert.equal(verb(parseArgs(f, ["--exit-code", "0", "--signal", "SIGTERM"]), { input }).code, 2);
  assert.equal(verb(parseArgs(f, ["--exit-code", "abc"]), { input }).code, 2);
  assert.equal(verb(parseArgs(f, ["--signal", "term"]), { input }).code, 2);
});

test("runtime parse exits 2 for an unreadable file and for a refused request", () => {
  const f = files(envelope());
  const input = JSON.stringify(baseRequest(f.dir));
  const gone = verb(["parse", "--stdout", join(f.dir, "missing"), "--stderr", f.err, "--exit-code", "0"], { input });
  assert.equal(gone.code, 2);
  assert.match(gone.json.reason, /missing/);
  const refused = verb(parseArgs(f), { input: JSON.stringify(baseRequest(f.dir, { budget: { usd: -1 } })) });
  assert.equal(refused.code, 2);
  assert.match(refused.json.reason, /budget\.usd/);
  assert.equal(verb(parseArgs(f), { input: "{nope" }).code, 2);
});

test("runtime parse does not need the openai endpoint configured", () => {
  const f = files(JSON.stringify({ protocol: "detent-openai-call-v1", ok: true, http_status: 200, attempts: 1, body: { choices: [{ finish_reason: "stop", message: { content: "yo" } }] } }));
  const r = verb(["parse", "--runtime", "openai-compatible", ...parseArgs(f).slice(1)], { input: JSON.stringify(baseRequest(f.dir, { output: "text" })) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.text, "yo");
});
