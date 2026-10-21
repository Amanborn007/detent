// Opt-in tests against a real endpoint. Without the opt-in variable they show as SKIP. Opted in with
// the config missing is a FAIL, never a quiet skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRuntime } from "../runtime.mjs";
import { baseRequest } from "./kit.mjs";

const PROMPT = "Reply with exactly the word PONG";
const skip = (flag) => (process.env[flag] === "1" ? false : `set ${flag}=1 to run`);
const need = (name) => { assert.ok(process.env[name], `${name} is required when this live test is opted into`); return process.env[name]; };

function ask(env) {
  const rt = getRuntime({ name: "openai-compatible", env });
  return rt.run(baseRequest(process.cwd(), { prompt: PROMPT, output: "text", timeout_ms: 120000 }));
}

function assertPong(r) {
  assert.equal(r.stop, "ok", JSON.stringify(r.error));
  assert.match(r.text, /pong/i);
  const body = JSON.parse(r.raw.stdout).body;
  assert.ok(body.usage.total_tokens > 0, "usage.total_tokens");
  assert.equal(typeof body.model, "string");
}

test("live: ollama answers through the adapter", { skip: skip("DETENT_LIVE_OLLAMA") }, () => {
  const model = need("DETENT_LIVE_OLLAMA_MODEL");
  assertPong(ask({ ...process.env, DETENT_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1", DETENT_OPENAI_MODEL: model, DETENT_OPENAI_API_KEY_ENV: "" }));
});

test("live: OpenAI answers through the adapter and the key never reaches the response", { skip: skip("DETENT_LIVE_OPENAI") }, () => {
  const key = need("OPENAI_API_KEY");
  const model = need("DETENT_LIVE_OPENAI_MODEL");
  const r = ask({ ...process.env, DETENT_OPENAI_BASE_URL: "https://api.openai.com/v1", DETENT_OPENAI_MODEL: model, DETENT_OPENAI_API_KEY_ENV: "OPENAI_API_KEY" });
  assertPong(r);
  assert.ok(!JSON.stringify(r).includes(key));
});
