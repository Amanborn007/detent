// Contract checks every runtime adapter must pass. Registers node:test tests when called; importing it does nothing.
// fixture is { name, makeFake(dir, mode) -> { bin } }; the modes and the <dir>/spawned marker rule are in test/kit.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntime, CapabilityError } from "./runtime.mjs";

const ENUMS = { output: ["text", "json"], tools: ["none", "inherit"], mcp: ["none", "inherit"], settings_sources: ["none", "project", "inherit"] };
const BOOLS = ["settings_file", "model", "persist_session", "timeout", "budget", "add_dirs", "deny_tools", "containment", "env", "tools_allow"];
const KEYS = [...Object.keys(ENUMS), "auth", "reports", ...BOOLS].sort();
const RESPONSE_KEYS = ["cost_usd", "denials", "error", "raw", "runtime", "stop", "text", "turns"];
const STOPS = ["ok", "budget", "turns", "timeout", "error"];
const KINDS = ["spawn", "exit", "bad_output", "runtime_error", "timeout"];

const PROBES = [
  { capability: "tools_allow", over: { tools: { allow: ["Read"] } } },
  { capability: "deny_tools", over: { deny_tools: ["Bash"] } },
  { capability: "add_dirs", over: { add_dirs: ["/tmp"] } },
  { capability: "budget", over: { budget: { usd: 1 } } },
  { capability: "env", over: { env: { A: "b" } } },
  { capability: "containment", over: { containment: { mode: "x" } } },
];

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "conformance-")));
const baseRequest = (cwd, over = {}) => ({ prompt: "say hi", cwd, output: "json", tools: "none", mcp: "none", settings: { sources: "none" }, ...over });

export function conformanceSuite(fixture) {
  const { name, makeFake } = fixture;
  const rtFor = (dir, mode) => getRuntime({ name, bins: { [name]: makeFake(dir, mode).bin } });
  const label = (s) => `conformance[${name}]: ${s}`;

  test(label("capabilities() matches the key schema, is frozen and is stable"), () => {
    const c = getRuntime({ name }).capabilities();
    assert.deepEqual(Object.keys(c).sort(), KEYS);
    assert.ok(Object.isFrozen(c));
    for (const k of [...Object.keys(ENUMS), "auth"]) {
      assert.ok(Array.isArray(c[k]) && c[k].every((v) => typeof v === "string"), k);
      assert.ok(Object.isFrozen(c[k]), `${k} frozen`);
    }
    for (const [k, all] of Object.entries(ENUMS)) assert.ok(c[k].every((v) => all.includes(v)), `${k} declares only contract values`);
    for (const k of BOOLS) assert.equal(typeof c[k], "boolean", k);
    assert.ok(Object.isFrozen(c.reports));
    assert.ok(Object.values(c.reports).every((v) => typeof v === "string"));
    assert.deepEqual(getRuntime({ name }).capabilities(), c);
  });

  test(label("every declared enum value plans to {bin, args, cwd} and the prompt never reaches argv"), () => {
    const rt = getRuntime({ name });
    const c = rt.capabilities();
    const dir = scratch();
    const prompt = "--dangerously-skip-permissions";
    const requests = [];
    for (const v of c.output) requests.push({ output: v });
    for (const v of c.tools) requests.push({ tools: v });
    for (const v of c.mcp) requests.push({ mcp: v });
    for (const v of c.settings_sources) requests.push({ settings: { sources: v } });
    for (const v of c.auth) requests.push({ auth: v });
    for (const over of requests) {
      const p = rt.plan(baseRequest(dir, { prompt, ...over }));
      assert.equal(typeof p.bin, "string", JSON.stringify(over));
      assert.ok(Array.isArray(p.args) && p.args.every((a) => typeof a === "string"), JSON.stringify(over));
      assert.equal(p.cwd, dir);
      assert.ok(!p.args.includes(prompt), JSON.stringify(over));
    }
  });

  test(label("undeclared keys and values throw CapabilityError and spawn nothing"), () => {
    const dir = scratch();
    const rt = rtFor(dir, "ok");
    const c = rt.capabilities();
    let probed = 0;
    for (const { capability, over } of PROBES) {
      if (c[capability] !== false) continue;
      probed++;
      assert.throws(() => rt.run(baseRequest(dir, over)), (e) => {
        assert.ok(e instanceof CapabilityError, capability);
        assert.equal(e.capability, capability);
        assert.equal(e.runtime, name);
        return true;
      });
    }
    for (const [k, all] of Object.entries(ENUMS)) {
      for (const v of all.filter((x) => !c[k].includes(x))) {
        probed++;
        const over = k === "settings_sources" ? { settings: { sources: v } } : { [k]: v };
        assert.throws(() => rt.run(baseRequest(dir, over)), CapabilityError, `${k}=${v}`);
      }
    }
    assert.ok(probed > 0, "the probe table exercised nothing");
    assert.equal(existsSync(join(dir, "spawned")), false);
  });

  test(label("ok returns exactly the contract keys and types"), () => {
    const dir = scratch();
    const r = rtFor(dir, "ok").run(baseRequest(dir));
    assert.deepEqual(Object.keys(r).sort(), RESPONSE_KEYS);
    assert.equal(r.runtime, name);
    assert.ok(STOPS.includes(r.stop));
    assert.equal(r.stop, "ok");
    assert.equal(typeof r.text, "string");
    assert.ok(r.cost_usd === null || typeof r.cost_usd === "number");
    assert.ok(r.turns === null || Number.isInteger(r.turns));
    assert.ok(Array.isArray(r.denials));
    assert.equal(r.error, null);
    assert.deepEqual(Object.keys(r.raw).sort(), ["exit_code", "signal", "stderr", "stdout"]);
    assert.equal(typeof r.raw.stdout, "string");
    assert.equal(typeof r.raw.stderr, "string");
  });

  test(label("a failing child is stop error, kind exit, with the exit code"), () => {
    const dir = scratch();
    const r = rtFor(dir, "exit1").run(baseRequest(dir));
    assert.equal(r.stop, "error");
    assert.equal(r.error.kind, "exit");
    assert.equal(r.error.exit_code, 1);
    assert.ok(KINDS.includes(r.error.kind));
    assert.equal(typeof r.error.message, "string");
    assert.equal(r.text, null);
  });

  test(label("a missing binary is kind spawn and does not throw"), () => {
    const dir = scratch();
    const r = rtFor(dir, "nobin").run(baseRequest(dir));
    assert.equal(r.stop, "error");
    assert.equal(r.error.kind, "spawn");
  });

  test(label("garbage stdout with json output is bad_output"), () => {
    const dir = scratch();
    const r = rtFor(dir, "garbage").run(baseRequest(dir, { output: "json" }));
    assert.equal(r.stop, "error");
    assert.equal(r.error.kind, "bad_output");
  });

  test(label("timeout_ms ends a slow child as stop timeout"), () => {
    const dir = scratch();
    const r = rtFor(dir, "sleep").run(baseRequest(dir, { timeout_ms: 300 }));
    assert.equal(r.stop, "timeout");
    assert.equal(r.error.kind, "timeout");
  });

  test(label("cost_usd is a number or null, never coerced"), () => {
    const dir = scratch();
    const json = rtFor(dir, "ok").run(baseRequest(dir));
    assert.ok(json.cost_usd === null || typeof json.cost_usd === "number");
    const text = rtFor(scratch(), "ok").run(baseRequest(dir, { output: "text" }));
    if (rtFor(dir, "ok").capabilities().reports.cost_usd !== "text") assert.equal(text.cost_usd, null);
  });
}
