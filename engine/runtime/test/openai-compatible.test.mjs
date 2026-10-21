import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import openai from "../adapters/openai-compatible.mjs";
import { getRuntime, createRuntime, CapabilityError, RuntimeConfigError, RuntimeError } from "../runtime.mjs";
import { baseRequest, scratch, spawned } from "./kit.mjs";
import { makeOpenAIFake } from "./openai-kit.mjs";

const CALL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "openai-compatible-call.mjs");
const CWD = "/tmp/x";
const SENTINEL = "sk-sentinel-4f9a1c";
const ENV = Object.freeze({ DETENT_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1", DETENT_OPENAI_MODEL: "m1" });
const KEYED = Object.freeze({ ...ENV, DETENT_OPENAI_API_KEY_ENV: "OPENAI_API_KEY", OPENAI_API_KEY: SENTINEL });
const req = (over) => baseRequest(CWD, { output: "text", ...over });
const plan = (over, env = ENV) => openai.plan(req(over), env);

test("capabilities: frozen, exactly the golden-tested set", () => {
  const c = openai.capabilities();
  assert.ok(Object.isFrozen(c));
  for (const k of ["output", "tools", "mcp", "settings_sources", "auth", "reports"]) assert.ok(Object.isFrozen(c[k]), k);
  assert.deepEqual({ ...c }, {
    output: ["text", "json"], tools: ["none"], mcp: ["none"], settings_sources: ["none"], settings_file: false,
    auth: ["api_key"], model: true, persist_session: true, timeout: true, reports: {},
    budget: false, add_dirs: false, deny_tools: false, containment: false, env: false, tools_allow: false,
  });
  assert.equal(openai.name, "openai-compatible");
});

test("golden plan without a key", () => {
  const p = plan({});
  assert.deepEqual({ ...p, env: undefined }, {
    bin: process.execPath,
    args: [CALL_PATH, "--base-url", "http://127.0.0.1:11434/v1", "--model", "m1"],
    cwd: CWD, env: undefined, echo_stderr: true,
  });
  assert.deepEqual(p.env, ENV);
});

test("golden plan with a key ends with --api-key-env NAME", () => {
  const p = plan({ auth: "api_key" }, { ...KEYED, DETENT_OPENAI_BASE_URL: "https://api.openai.com/v1" });
  assert.deepEqual(p.args, [CALL_PATH, "--base-url", "https://api.openai.com/v1", "--model", "m1", "--api-key-env", "OPENAI_API_KEY"]);
});

test("request.model overrides DETENT_OPENAI_MODEL", () => {
  assert.deepEqual(plan({ model: "other" }).args.slice(3, 5), ["--model", "other"]);
});

test("a trailing slash on the base url is trimmed", () => {
  assert.equal(plan({}, { ...ENV, DETENT_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1/" }).args[2], "http://127.0.0.1:11434/v1");
});

test("config refusals are RuntimeConfigError naming the setting", () => {
  const without = (k) => Object.fromEntries(Object.entries(ENV).filter(([n]) => n !== k));
  const cases = [
    { env: without("DETENT_OPENAI_BASE_URL"), setting: "DETENT_OPENAI_BASE_URL", match: /DETENT_OPENAI_BASE_URL/ },
    { env: { ...ENV, DETENT_OPENAI_BASE_URL: "" }, setting: "DETENT_OPENAI_BASE_URL", match: /DETENT_OPENAI_BASE_URL/ },
    { env: { ...ENV, DETENT_OPENAI_BASE_URL: "not a url" }, setting: "DETENT_OPENAI_BASE_URL", match: /URL/ },
    { env: { ...ENV, DETENT_OPENAI_BASE_URL: "ftp://example.com/v1" }, setting: "DETENT_OPENAI_BASE_URL", match: /http/ },
    { env: { ...ENV, DETENT_OPENAI_BASE_URL: "file:///etc/passwd" }, setting: "DETENT_OPENAI_BASE_URL", match: /http/ },
    { env: without("DETENT_OPENAI_MODEL"), setting: "DETENT_OPENAI_MODEL", match: /request\.model.*DETENT_OPENAI_MODEL|DETENT_OPENAI_MODEL.*request\.model/ },
    { env: { ...ENV, DETENT_OPENAI_API_KEY_ENV: "OPENAI_API_KEY", OPENAI_API_KEY: "" }, setting: "OPENAI_API_KEY", match: /OPENAI_API_KEY/ },
    { env: { ...ENV, DETENT_OPENAI_API_KEY_ENV: "OPENAI_API_KEY" }, setting: "OPENAI_API_KEY", match: /OPENAI_API_KEY/ },
    { env: ENV, over: { auth: "api_key" }, setting: "DETENT_OPENAI_API_KEY_ENV", match: /api_key.*DETENT_OPENAI_API_KEY_ENV/ },
    { env: { ...KEYED, DETENT_OPENAI_BASE_URL: "http://api.example.com/v1" }, setting: "DETENT_OPENAI_BASE_URL", match: /https|loopback/ },
    { env: { ...ENV, DETENT_OPENAI_API_KEY_ENV: "sk-not-a-name" }, setting: "DETENT_OPENAI_API_KEY_ENV", match: /NAME/ },
  ];
  for (const { env, over = {}, setting, match } of cases) {
    assert.throws(() => plan(over, env), (e) => {
      assert.ok(e instanceof RuntimeConfigError, JSON.stringify(env));
      assert.ok(e instanceof RuntimeError);
      assert.equal(e.code, "bad_config");
      assert.equal(e.setting, setting);
      assert.match(e.message, match);
      assert.ok(!e.message.includes(SENTINEL));
      return true;
    }, JSON.stringify({ env, over }));
  }
});

test("config acceptances: plain http to a non-loopback host without a key, loopback and https with one", () => {
  const base = (u, env = ENV) => ({ ...env, DETENT_OPENAI_BASE_URL: u });
  assert.doesNotThrow(() => plan({}, base("http://ollama.internal:11434/v1")));
  for (const u of ["http://localhost:1/v1", "http://127.0.0.1:1/v1", "http://127.0.0.2:1/v1", "http://[::1]:1/v1", "https://api.example.com/v1"]) {
    assert.doesNotThrow(() => plan({}, base(u, KEYED)), u);
  }
});

test("the key and the prompt never reach the plan outside its env", () => {
  const p = plan({ prompt: "--dangerously-skip-permissions", auth: "api_key" }, KEYED);
  assert.ok(!JSON.stringify({ ...p, env: undefined }).includes(SENTINEL));
  assert.ok(!p.args.includes("--dangerously-skip-permissions"));
  assert.equal(p.env.OPENAI_API_KEY, SENTINEL, "the helper reads the key from its environment");
});

test("undeclared fields are CapabilityError through the port and spawn nothing", () => {
  const dir = scratch();
  const rt = createRuntime(openai, { bin: makeOpenAIFake(dir, "ok").bin, env: KEYED });
  const cases = [
    [{ tools: "inherit" }, "tools"], [{ mcp: "inherit" }, "mcp"],
    [{ settings: { sources: "project" } }, "settings_sources"], [{ settings: { sources: "inherit" } }, "settings_sources"],
    [{ settings: { sources: "none", file: "/a/s.json" } }, "settings_file"], [{ auth: "session" }, "auth"],
    [{ budget: { usd: 1 } }, "budget"], [{ add_dirs: ["/tmp"] }, "add_dirs"], [{ tools: { allow: ["Read"] } }, "tools_allow"],
    [{ deny_tools: ["Bash"] }, "deny_tools"], [{ containment: { mode: "x" } }, "containment"], [{ env: { A: "b" } }, "env"],
  ];
  for (const [over, capability] of cases) {
    assert.throws(() => rt.run(baseRequest(dir, over)), (e) => {
      assert.ok(e instanceof CapabilityError, capability);
      assert.equal(e.capability, capability);
      assert.equal(e.runtime, "openai-compatible");
      return true;
    });
  }
  assert.equal(spawned(dir), false);
});

test("a config error comes out of the port before anything spawns", () => {
  const dir = scratch();
  const rt = createRuntime(openai, { bin: makeOpenAIFake(dir, "ok").bin, env: {} });
  assert.throws(() => rt.run(baseRequest(dir)), RuntimeConfigError);
  assert.equal(spawned(dir), false);
});

test("getRuntime passes env to plan", () => {
  assert.equal(getRuntime({ name: "openai-compatible", env: ENV }).plan(baseRequest(CWD)).args[2], "http://127.0.0.1:11434/v1");
});

const line = (o) => JSON.stringify({ protocol: "detent-openai-call-v1", ...o }) + "\n";
const completion = (choice, extra = {}) => ({ id: "c1", model: "m1", choices: [choice], usage: { total_tokens: 7 }, ...extra });
const okLine = (body) => line({ ok: true, http_status: 200, attempts: 1, body });
const native = (stdout, over = {}) => ({ status: 0, signal: null, stdout, stderr: "", ...over });
const parse = (stdout, over, r = baseRequest(CWD)) => openai.parse(native(stdout, over), r);
const assertError = (r, kind, match) => {
  assert.equal(r.stop, kind === "timeout" ? "timeout" : "error");
  assert.equal(r.text, null);
  assert.equal(r.cost_usd, null);
  assert.equal(r.turns, null);
  assert.deepEqual(r.denials, []);
  assert.equal(r.error.kind, kind);
  assert.match(r.error.message, match);
};

test("parse: stop with string content is ok and passes the raw stdout through", () => {
  const stdout = okLine(completion({ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }));
  for (const output of ["text", "json"]) {
    const r = parse(stdout, {}, baseRequest(CWD, { output }));
    assert.deepEqual({ ...r, raw: undefined }, { runtime: "openai-compatible", stop: "ok", text: "hi", cost_usd: null, turns: null, denials: [], error: null, raw: undefined });
    assert.deepEqual(r.raw, { stdout, stderr: "", exit_code: 0, signal: null });
  }
  assert.equal(JSON.parse(parse(stdout).raw.stdout).body.usage.total_tokens, 7);
});

test("parse: an empty string answer is still an answer", () => {
  assert.equal(parse(okLine(completion({ message: { content: "" }, finish_reason: "stop" }))).text, "");
});

test("parse: finish_reason length is a runtime_error", () => {
  const r = parse(okLine(completion({ message: { content: "cut" }, finish_reason: "length" })));
  assertError(r, "runtime_error", /^output truncated \(finish_reason length\)$/);
});

test("parse: content_filter, a missing finish_reason and other values are runtime_error naming it", () => {
  assertError(parse(okLine(completion({ message: { content: null }, finish_reason: "content_filter" }))), "runtime_error", /content_filter/);
  assertError(parse(okLine(completion({ message: { content: "x" }, finish_reason: "tool_calls" }))), "runtime_error", /tool_calls/);
  assertError(parse(okLine(completion({ message: { content: "x" } }))), "runtime_error", /finish_reason/);
  assertError(parse(okLine(completion({ message: { content: "x" }, finish_reason: null }))), "runtime_error", /finish_reason/);
});

test("parse: no choices, or non-string content on stop, is bad_output", () => {
  assertError(parse(okLine({ id: "c1" })), "bad_output", /choices/);
  assertError(parse(okLine({ choices: [] })), "bad_output", /choices/);
  assertError(parse(okLine(null)), "bad_output", /choices/);
  assertError(parse(okLine(completion({ message: { content: null }, finish_reason: "stop" }))), "bad_output", /content/);
  assertError(parse(okLine(completion({ message: { content: [{ type: "text" }] }, finish_reason: "stop" }))), "bad_output", /content/);
  assertError(parse(okLine(completion({ finish_reason: "stop" }))), "bad_output", /content/);
});

test("parse: helper failure classes", () => {
  const fail = (o) => line({ ok: false, attempts: 3, ...o });
  assertError(parse(fail({ class: "http", http_status: 503, message: "service unavailable" })), "runtime_error", /HTTP 503 after 3 attempts: service unavailable/);
  assertError(parse(fail({ class: "http", http_status: 401, attempts: 1, message: "bad key" })), "runtime_error", /HTTP 401 after 1 attempt: bad key/);
  assertError(parse(fail({ class: "network", message: "ECONNREFUSED" })), "runtime_error", /network error after 3 attempts: ECONNREFUSED/);
  assertError(parse(fail({ class: "bad_body", attempts: 1, message: "Unexpected token" })), "bad_output", /Unexpected token/);
});

test("parse: stdout that is not the protocol is bad_output", () => {
  for (const out of ["", "not json", "[]", "null", '{"ok":true}', JSON.stringify({ protocol: "other", ok: true }) + "\n",
    JSON.stringify({ protocol: "detent-openai-call-v1" }) + "\n", line({ ok: false, class: "weird", attempts: 1, message: "x" })]) {
    assertError(parse(out), "bad_output", /detent-openai-call-v1|protocol|class/);
  }
});

test("parse: spawn, timeout and exit failures", () => {
  const enoent = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
  assertError(parse("", { status: null, error: enoent }), "spawn", /ENOENT/);
  const etimedout = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
  assertError(parse("", { status: null, signal: "SIGTERM", error: etimedout }), "timeout", /ETIMEDOUT/);
  const crashed = parse("", { status: 2, stderr: "bad argv\n" });
  assertError(crashed, "exit", /code 2/);
  assert.equal(crashed.error.exit_code, 2);
  assert.equal(crashed.raw.stderr, "bad argv\n");
  assertError(parse("", { status: null, signal: "SIGKILL" }), "exit", /SIGKILL/);
});
