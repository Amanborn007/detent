// Contract checks for the reserved fields a runtime declares: a malformed shape is refused and nothing spawns.
// Same fixture as conformance.mjs. A runtime that declares none of them registers a test that proves it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntime, RuntimeRequestError } from "./runtime.mjs";

const SHAPES = [
  { capability: "tools_allow", over: { tools: { allow: ["Read"] } }, field: "tools.allow" },
  { capability: "deny_tools", over: { deny_tools: ["Bash"] }, field: "deny_tools[0]" },
  { capability: "add_dirs", over: { add_dirs: ["relative"] }, field: "add_dirs[0]" },
  { capability: "budget", over: { budget: { usd: -1 } }, field: "budget.usd" },
  { capability: "env", over: { env: { "1BAD": "x" } }, field: "env.1BAD" },
  { capability: "containment", over: { containment: { mode: "x" } }, field: "containment" },
];

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "conformance-shapes-")));
const baseRequest = (cwd, over = {}) => ({ prompt: "say hi", cwd, output: "json", tools: "none", mcp: "none", settings: { sources: "none" }, ...over });

export function shapeConformance({ name, makeFake }) {
  test(`conformance[${name}]: declared reserved capabilities reject malformed shapes and spawn nothing`, () => {
    const dir = scratch();
    const rt = getRuntime({ name, bins: { [name]: makeFake(dir, "ok").bin } });
    const c = rt.capabilities();
    const declared = SHAPES.filter(({ capability }) => c[capability] === true);
    for (const { capability, over, field } of declared) {
      for (const call of ["check", "plan", "run"]) {
        assert.throws(() => rt[call](baseRequest(dir, over)), (e) => {
          assert.ok(e instanceof RuntimeRequestError, `${call} ${capability}`);
          assert.equal(e.field, field, `${call} ${capability}`);
          return true;
        });
      }
    }
    assert.equal(existsSync(join(dir, "spawned")), false);
  });
}
