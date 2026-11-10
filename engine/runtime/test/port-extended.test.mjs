import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as port from "../runtime.mjs";
import { baseRequest, scratch, makeFake, spawned } from "./kit.mjs";

const { getRuntime, createRuntime, RuntimeRequestError, CapabilityError } = port;
const CWD = "/tmp/x";
const req = (over) => baseRequest(CWD, over);
const badField = (over, field) => assert.throws(() => port.validateDeclared(req(over)), (e) => {
  assert.ok(e instanceof RuntimeRequestError, JSON.stringify(over));
  assert.equal(e.field, field, JSON.stringify(over));
  return true;
}, JSON.stringify(over));

test("approvals: only deny passes validateRequest", () => {
  assert.doesNotThrow(() => port.validateRequest(req({ approvals: "deny" })));
  for (const v of ["allow", "", 1, null, ["deny"]]) {
    assert.throws(() => port.validateRequest(req({ approvals: v })), (e) => e instanceof RuntimeRequestError && e.field === "approvals", String(v));
  }
});

test("approvals: a runtime that lists none refuses deny with CapabilityError", () => {
  const rt = getRuntime({ name: "openai-compatible", bins: { "openai-compatible": "/nope" } });
  assert.throws(() => rt.check(req({ approvals: "deny" })), (e) => e instanceof CapabilityError && e.capability === "approvals" && e.requested === "deny");
});

test("validateDeclared accepts the documented shapes", () => {
  const ok = [
    { deny_tools: [{ shell_prefix: "git push" }, { shell_prefix: "rm" }] },
    { tools: { allow: ["read", "glob", "grep", "write", "edit", "todo"] } },
    { add_dirs: ["/a", "/b"] },
    { budget: { usd: 0.5 } }, { budget: { turns: 3 } }, { budget: { usd: 1, turns: 2 } },
    { env: { A_1: "x", _b: "" } },
    { containment: "strict" },
  ];
  for (const over of ok) assert.doesNotThrow(() => port.validateDeclared(req(over)), JSON.stringify(over));
});

test("validateDeclared: deny_tools shapes", () => {
  badField({ deny_tools: [] }, "deny_tools");
  badField({ deny_tools: "git" }, "deny_tools");
  badField({ deny_tools: ["Bash"] }, "deny_tools[0]");
  badField({ deny_tools: [{ shell_prefix: "a" }, { prefix: "b" }] }, "deny_tools[1]");
  badField({ deny_tools: [{ shell_prefix: "a", extra: 1 }] }, "deny_tools[0]");
  badField({ deny_tools: [{ shell_prefix: 3 }] }, "deny_tools[0].shell_prefix");
  for (const p of ["", "Bash(x", "x)", "a*", "a\nb", "a\0b"]) badField({ deny_tools: [{ shell_prefix: p }] }, "deny_tools[0].shell_prefix");
});

test("validateDeclared: tools.allow shapes", () => {
  badField({ tools: {} }, "tools");
  badField({ tools: { allow: ["read"], extra: 1 } }, "tools");
  badField({ tools: { allow: [] } }, "tools.allow");
  badField({ tools: { allow: "read" } }, "tools.allow");
  badField({ tools: { allow: ["Read"] } }, "tools.allow");
  badField({ tools: { allow: ["bash"] } }, "tools.allow");
  badField({ tools: { allow: ["read", "read"] } }, "tools.allow");
});

test("validateDeclared: add_dirs shapes", () => {
  badField({ add_dirs: [] }, "add_dirs");
  badField({ add_dirs: "/a" }, "add_dirs");
  badField({ add_dirs: ["rel"] }, "add_dirs[0]");
  badField({ add_dirs: [3] }, "add_dirs[0]");
  badField({ add_dirs: ["/a", "/a"] }, "add_dirs");
});

test("validateDeclared: budget shapes", () => {
  badField({ budget: {} }, "budget");
  badField({ budget: 5 }, "budget");
  badField({ budget: { usd: 1, tokens: 2 } }, "budget.tokens");
  for (const usd of [0, -1, Infinity, NaN, "1", null]) badField({ budget: { usd } }, "budget.usd");
  for (const turns of [0, -1, 1.5, "2", null]) badField({ budget: { turns } }, "budget.turns");
});

test("validateDeclared: env shapes", () => {
  badField({ env: [] }, "env");
  badField({ env: "A=b" }, "env");
  badField({ env: { "1A": "x" } }, "env.1A");
  badField({ env: { "A-B": "x" } }, "env.A-B");
  badField({ env: { A: 1 } }, "env.A");
  badField({ env: { A: "x\0y" } }, "env.A");
});

test("validateDeclared: containment is the string strict and nothing else", () => {
  for (const v of ["loose", "", { mode: "strict" }, true]) badField({ containment: v }, "containment");
});

test("order: a runtime lacking the capability throws CapabilityError even for a malformed shape", () => {
  const rt = getRuntime({ name: "openai-compatible", bins: { "openai-compatible": "/nope" } });
  const probes = [
    [{ containment: { mode: "x" } }, "containment"], [{ deny_tools: ["Bash"] }, "deny_tools"], [{ tools: { allow: ["Read"] } }, "tools_allow"],
    [{ budget: { usd: -1 } }, "budget"], [{ env: { "1": 2 } }, "env"], [{ add_dirs: ["rel"] }, "add_dirs"],
  ];
  for (const [over, capability] of probes) {
    for (const call of ["check", "plan", "run"]) {
      assert.throws(() => rt[call](req(over)), (e) => e instanceof CapabilityError && e.capability === capability, `${call} ${capability}`);
    }
  }
});

test("order: validateRequest, then capabilities, then shape, then the adapter", () => {
  const rt = getRuntime({ name: "claude-code", bins: { "claude-code": "/nope" } });
  assert.throws(() => rt.plan(req({ approvals: "allow", budget: { usd: -1 } })), (e) => e instanceof RuntimeRequestError && e.field === "approvals");
  assert.throws(() => rt.plan(req({ budget: { usd: -1 } })), (e) => e instanceof RuntimeRequestError && e.field === "budget.usd");
  assert.throws(() => rt.plan(req({ containment: "strict" })), (e) => e instanceof RuntimeRequestError && e.field === "containment");
});

test("rt.check runs validation without the adapter planning, and rt.plan still plans", () => {
  const calls = [];
  const caps = Object.freeze({
    output: ["json"], tools: ["none"], mcp: ["none"], settings_sources: ["none"], settings_file: false, auth: [], model: false, persist_session: false,
    timeout: false, budget: true, add_dirs: false, deny_tools: false, containment: false, env: false, tools_allow: false, approvals: [],
  });
  const adapter = { name: "fake", capabilities: () => caps, plan: (r) => { calls.push("plan"); return { bin: "b", args: [], cwd: r.cwd }; }, parse: () => ({}) };
  const rt = createRuntime(adapter);
  assert.doesNotThrow(() => rt.check(req({ budget: { usd: 1 } })));
  assert.deepEqual(calls, []);
  assert.throws(() => rt.check(req({ budget: { usd: 0 } })), RuntimeRequestError);
  assert.throws(() => rt.check(req({ add_dirs: ["/a"] })), CapabilityError);
  rt.plan(req({ budget: { usd: 1 } }));
  assert.deepEqual(calls, ["plan"]);
});

test("probeContainment throws CapabilityError naming containment for openai-compatible, and spawns nothing", () => {
  const dir = scratch();
  const rt = getRuntime({ name: "openai-compatible", bins: { "openai-compatible": makeFake(dir, "ok").bin } });
  assert.throws(() => rt.probeContainment({ env: {} }), (e) => e instanceof CapabilityError && e.capability === "containment" && e.runtime === "openai-compatible" && e.requested === "strict");
  assert.equal(spawned(dir), false);
});

function versionFake(dir, text) {
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "probe.json"))}, JSON.stringify({ argv: process.argv.slice(2), seen: process.env.PROBE_SEEN ?? null }));
process.stdout.write(${JSON.stringify(text)});
`);
  chmodSync(bin, 0o755);
  return bin;
}

test("probeContainment spawns the bin with --version, the given env, and returns the adapter's verdict", async () => {
  const { readFileSync } = await import("node:fs");
  const dir = scratch();
  const rt = getRuntime({ name: "claude-code", bins: { "claude-code": versionFake(dir, "2.1.306 (Claude Code)\n") } });
  assert.deepEqual(rt.probeContainment({ env: { PROBE_SEEN: "yes" } }), { ok: true, version: "2.1.306 (Claude Code)" });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")), { argv: ["--version"], seen: "yes" });
  const old = getRuntime({ name: "claude-code", bins: { "claude-code": versionFake(scratch(), "2.1.305\n") } });
  assert.deepEqual(old.probeContainment({ env: {} }), { ok: false, kind: "version", text: "2.1.305", min: "2.1.306" });
});

test("probeContainment reports a missing binary as kind spawn and does not throw", () => {
  const rt = getRuntime({ name: "claude-code", bins: { "claude-code": join(scratch(), "no-such-claude") } });
  const r = rt.probeContainment({ env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "spawn");
  assert.equal(typeof r.message, "string");
});

test("a contained request runs with the request env as the child's whole environment", async () => {
  const { readFileSync } = await import("node:fs");
  const dir = scratch();
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(join(dir, "env.json"))}, JSON.stringify(process.env));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hi" }));
`);
  chmodSync(bin, 0o755);
  const rt = getRuntime({ name: "claude-code", bins: { "claude-code": bin } });
  const r = rt.run(baseRequest(dir, { env: { ONLY_THIS: "1", PATH: process.env.PATH } }));
  assert.equal(r.stop, "ok");
  const seen = JSON.parse(readFileSync(join(dir, "env.json"), "utf8"));
  assert.equal(seen.ONLY_THIS, "1");
  assert.equal("HOME" in seen, false);
});
