import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { conformanceSuite } from "../conformance.mjs";
import { makeOpenAIFake } from "./openai-kit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RIGHT = ["add_dirs", "budget", "containment", "deny_tools", "env", "tools_allow", "approvals=deny", "mcp=inherit", "settings_sources=inherit", "settings_sources=project", "tools=inherit"];

const runChild = (undeclared) => {
  const dir = mkdtempSync(join(tmpdir(), "undeclared-"));
  const file = join(dir, "child.test.mjs");
  writeFileSync(file, `
import { conformanceSuite } from ${JSON.stringify(join(here, "..", "conformance.mjs"))};
import { makeOpenAIFake } from ${JSON.stringify(join(here, "openai-kit.mjs"))};
Object.assign(process.env, {
  DETENT_OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
  DETENT_OPENAI_MODEL: "fake-model",
  DETENT_OPENAI_API_KEY_ENV: "DETENT_FAKE_KEY",
  DETENT_FAKE_KEY: "sk-sentinel",
});
delete process.env.DETENT_RUNTIME;
conformanceSuite({ name: "openai-compatible", makeFake: makeOpenAIFake, undeclared: ${JSON.stringify(undeclared)} });
`);
  const r = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  return { status: r.status, out: r.stdout + r.stderr };
};

test("a conformance fixture without an undeclared list is refused", () => {
  assert.throws(() => conformanceSuite({ name: "openai-compatible", makeFake: makeOpenAIFake }), /fixture.undeclared/);
});

test("a wrong undeclared list fails the suite", () => {
  const r = runChild(RIGHT.filter((x) => x !== "budget"));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /expected list/);
});

test("the right undeclared list passes", () => {
  const r = runChild(RIGHT);
  assert.equal(r.status, 0, r.out);
});
