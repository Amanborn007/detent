import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeError, UnknownRuntimeError, RuntimeRequestError, CapabilityError,
  resolveRuntimeName, validateRequest, requireCapabilities, createRuntime, getRuntime,
} from "../runtime.mjs";
import { scratch, makeFake, baseRequest, spawned } from "./kit.mjs";

test("error classes carry a stable code and extend RuntimeError", () => {
  assert.ok(new UnknownRuntimeError("x") instanceof RuntimeError);
  assert.equal(new UnknownRuntimeError("x").code, "unknown_runtime");
  assert.equal(new RuntimeRequestError("x").code, "bad_request");
  assert.equal(new CapabilityError("x").code, "capability_missing");
});

test("resolveRuntimeName: claude-code when neither flag nor DETENT_RUNTIME is set", () => {
  assert.equal(resolveRuntimeName({ env: {} }), "claude-code");
});

test("resolveRuntimeName: flag beats DETENT_RUNTIME, which beats the default", () => {
  assert.equal(resolveRuntimeName({ flag: "claude-code", env: { DETENT_RUNTIME: "nope" } }), "claude-code");
  assert.equal(resolveRuntimeName({ env: { DETENT_RUNTIME: "claude-code" } }), "claude-code");
});

test("resolveRuntimeName: an unregistered or empty name throws UnknownRuntimeError listing the known ones", () => {
  for (const args of [{ env: { DETENT_RUNTIME: "nope" } }, { env: { DETENT_RUNTIME: "" } }, { flag: "", env: {} }, { flag: "nope", env: {} }]) {
    assert.throws(() => resolveRuntimeName(args), (e) => {
      assert.ok(e instanceof UnknownRuntimeError);
      assert.deepEqual(e.known, ["claude-code"]);
      assert.equal(e.requested, args.flag !== undefined ? args.flag : args.env.DETENT_RUNTIME);
      assert.match(e.message, /claude-code/);
      return true;
    });
  }
});

test("getRuntime: an unknown name throws UnknownRuntimeError", () => {
  assert.throws(() => getRuntime({ name: "nope" }), UnknownRuntimeError);
});

test("validateRequest: accepts the documented request and returns it unchanged, with no defaults added", () => {
  const req = baseRequest("/tmp");
  const before = JSON.stringify(req);
  assert.equal(validateRequest(req), req);
  assert.equal(JSON.stringify(req), before);
});

test("validateRequest: unknown keys are RuntimeRequestError naming the field", () => {
  for (const key of ["extra", "tier"]) {
    assert.throws(() => validateRequest({ ...baseRequest("/tmp"), [key]: 1 }), (e) => {
      assert.ok(e instanceof RuntimeRequestError);
      assert.equal(e.field, key);
      return true;
    });
  }
});

test("validateRequest: each missing required field is named", () => {
  for (const key of ["prompt", "cwd", "output", "tools", "mcp", "settings"]) {
    const req = baseRequest("/tmp");
    delete req[key];
    assert.throws(() => validateRequest(req), (e) => e instanceof RuntimeRequestError && e.field === key, key);
  }
});

test("validateRequest: wrong types and values are RuntimeRequestError", () => {
  const bad = [
    { prompt: "" }, { prompt: 3 }, { cwd: "relative/dir" }, { output: "xml" }, { tools: "all" }, { mcp: "some" },
    { settings: { sources: "user" } }, { settings: { sources: "none", file: "rel.json" } }, { settings: { sources: "none", extra: 1 } },
    { auth: "oauth" }, { model: "" }, { persist_session: true }, { timeout_ms: 0 }, { timeout_ms: 1.5 },
  ];
  for (const over of bad) {
    assert.throws(() => validateRequest(baseRequest("/tmp", over)), RuntimeRequestError, JSON.stringify(over));
  }
  assert.throws(() => validateRequest(null), RuntimeRequestError);
  assert.throws(() => validateRequest([]), RuntimeRequestError);
});

test("validateRequest: the reserved keys are known, so they pass here and are refused by capability", () => {
  for (const over of [{ tools: { allow: ["Read"] } }, { deny_tools: ["Bash"] }, { add_dirs: ["/tmp"] }, { budget: { usd: 1 } }, { env: { A: "b" } }, { containment: {} }]) {
    assert.doesNotThrow(() => validateRequest(baseRequest("/tmp", over)), JSON.stringify(over));
  }
});

test("requireCapabilities: throws CapabilityError on the first undeclared value", () => {
  const caps = { output: ["text"], tools: ["none"], mcp: ["none"], settings_sources: ["none"], settings_file: false, auth: [], model: false, persist_session: false, timeout: false, budget: false, add_dirs: false, deny_tools: false, containment: false, env: false, tools_allow: false };
  assert.throws(() => requireCapabilities(caps, baseRequest("/tmp"), "fake"), (e) => {
    assert.ok(e instanceof CapabilityError);
    assert.equal(e.runtime, "fake");
    assert.equal(e.capability, "output");
    assert.equal(e.requested, "json");
    assert.match(e.message, /fake/);
    assert.match(e.message, /output/);
    return true;
  });
});

function fakeAdapter(caps) {
  const calls = [];
  return {
    calls,
    adapter: {
      name: "fake",
      capabilities: () => caps,
      plan: (req) => { calls.push(["plan", req]); return { bin: "fake-bin", args: ["-x"], cwd: req.cwd }; },
      parse: () => { calls.push(["parse"]); throw new Error("parse must not run"); },
    },
  };
}

test("an undeclared capability throws CapabilityError before plan() is called", () => {
  const caps = Object.freeze({ output: ["text"], tools: ["none"], mcp: ["none"], settings_sources: ["none"], settings_file: false, auth: [], model: false, persist_session: false, timeout: false, budget: false, add_dirs: false, deny_tools: false, containment: false, env: false, tools_allow: false });
  const { adapter, calls } = fakeAdapter(caps);
  const rt = createRuntime(adapter);
  assert.throws(() => rt.run(baseRequest("/tmp")), CapabilityError);
  assert.throws(() => rt.plan(baseRequest("/tmp")), CapabilityError);
  assert.deepEqual(calls, []);
});

test("createRuntime: plan() adds the bin override to what the adapter planned", () => {
  const caps = Object.freeze({ output: ["json"], tools: ["none"], mcp: ["none"], settings_sources: ["none"], settings_file: false, auth: [], model: false, persist_session: false, timeout: false, budget: false, add_dirs: false, deny_tools: false, containment: false, env: false, tools_allow: false });
  const { adapter } = fakeAdapter(caps);
  assert.equal(createRuntime(adapter).plan(baseRequest("/tmp")).bin, "fake-bin");
  assert.equal(createRuntime(adapter, { bin: "/x/y" }).plan(baseRequest("/tmp")).bin, "/x/y");
  assert.equal(createRuntime(adapter).name, "fake");
});

test("the real claude-code refuses budget, add_dirs and tools.allow, and never spawns the stub", () => {
  const dir = scratch();
  const rt = getRuntime({ name: "claude-code", bins: { "claude-code": makeFake(dir, "ok").bin } });
  const cases = [
    [{ budget: { usd: 1 } }, "budget"],
    [{ add_dirs: ["/tmp"] }, "add_dirs"],
    [{ tools: { allow: ["Read"] } }, "tools_allow"],
    [{ deny_tools: ["Bash"] }, "deny_tools"],
    [{ containment: { mode: "x" } }, "containment"],
    [{ env: { A: "b" } }, "env"],
  ];
  for (const [over, capability] of cases) {
    assert.throws(() => rt.run(baseRequest(dir, over)), (e) => {
      assert.ok(e instanceof CapabilityError, capability);
      assert.equal(e.capability, capability);
      assert.equal(e.runtime, "claude-code");
      return true;
    });
  }
  assert.equal(spawned(dir), false);
});

test("bins overrides only the runtime it names", () => {
  assert.equal(getRuntime({ name: "claude-code", bins: { "claude-code": "/x/claude" } }).plan(baseRequest("/tmp")).bin, "/x/claude");
  assert.equal(getRuntime({ name: "claude-code", bins: { other: "/x/other" } }).plan(baseRequest("/tmp")).bin, "claude");
  assert.equal(getRuntime({ name: "claude-code" }).plan(baseRequest("/tmp")).bin, "claude");
});

test("getRuntime without a name resolves DETENT_RUNTIME the same way resolveRuntimeName does", () => {
  assert.equal(getRuntime({}).name, "claude-code");
});

test("run() returns spawn, exit and timeout failures as responses and never throws for them", () => {
  const dir = scratch();
  const gone = getRuntime({ name: "claude-code", bins: { "claude-code": makeFake(dir, "nobin").bin } }).run(baseRequest(dir));
  assert.equal(gone.stop, "error");
  assert.equal(gone.error.kind, "spawn");
  const bad = getRuntime({ name: "claude-code", bins: { "claude-code": makeFake(dir, "exit1").bin } }).run(baseRequest(dir));
  assert.equal(bad.error.kind, "exit");
  assert.equal(bad.error.exit_code, 1);
  assert.match(bad.raw.stderr, /boom/);
});
