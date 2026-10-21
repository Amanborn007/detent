import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { complete, retryable, backoffMs } from "../adapters/openai-compatible-call.mjs";
import { startServerProcess } from "./openai-kit.mjs";

const CALL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "openai-compatible-call.mjs");
const SENTINEL = "sk-sentinel-4f9a1c";
const OK_BODY = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { total_tokens: 5 } };

const res = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) });

// Each entry of `script` is a Response, or an Error to reject with; the last repeats.
function rig(script) {
  const calls = [], sleeps = [], warnings = [];
  let i = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = script[Math.min(i++, script.length - 1)];
    if (next instanceof Error) throw next;
    return next.clone();
  };
  const go = (over = {}) => complete({
    baseUrl: "http://h.test/v1", model: "m", prompt: "p", apiKey: undefined,
    fetch, sleep: async (ms) => { sleeps.push(ms); }, warn: (l) => warnings.push(l), ...over,
  });
  return { go, calls, sleeps, warnings };
}

test("request golden: method, url, headers and the exact body", async () => {
  const t = rig([res(200, OK_BODY)]);
  const out = await t.go();
  assert.deepEqual(out, { protocol: "detent-openai-call-v1", ok: true, http_status: 200, attempts: 1, body: OK_BODY });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, "http://h.test/v1/chat/completions");
  assert.equal(t.calls[0].init.method, "POST");
  assert.deepEqual(t.calls[0].init.headers, { "Content-Type": "application/json" });
  assert.equal(t.calls[0].init.body, JSON.stringify({ model: "m", messages: [{ role: "user", content: "p" }], stream: false }));
  assert.deepEqual(t.warnings, []);
  assert.deepEqual(t.sleeps, []);
});

test("request golden: Authorization is sent only with a key", async () => {
  const t = rig([res(200, OK_BODY)]);
  await t.go({ apiKey: SENTINEL });
  assert.deepEqual(t.calls[0].init.headers, { "Content-Type": "application/json", Authorization: `Bearer ${SENTINEL}` });
  assert.ok(!t.calls[0].init.body.includes(SENTINEL));
});

test("flaky: two 503s then 200 is ok on attempt 3 with two warnings and sleeps 500 then 1000", async () => {
  const t = rig([res(503, "busy"), res(503, "busy"), res(200, OK_BODY)]);
  const out = await t.go();
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 3);
  assert.deepEqual(t.sleeps, [500, 1000]);
  assert.deepEqual(t.warnings, [
    "openai-compatible: attempt 1/3 failed (HTTP 503); retrying in 500ms",
    "openai-compatible: attempt 2/3 failed (HTTP 503); retrying in 1000ms",
  ]);
});

test("Retry-After seconds are honoured and capped at 10s", async () => {
  for (const [header, want] of [["2", 2000], ["99", 10000], ["0", 0]]) {
    const t = rig([res(429, "slow down", { "Retry-After": header }), res(200, OK_BODY)]);
    assert.equal((await t.go()).ok, true);
    assert.deepEqual(t.sleeps, [want], header);
    assert.match(t.warnings[0], new RegExp(`HTTP 429\\); retrying in ${want}ms$`));
  }
});

test("down: three 503s is ok:false class http with the last body in the message", async () => {
  const t = rig([res(503, "first"), res(503, "second"), res(503, "third body")]);
  const out = await t.go();
  assert.equal(out.protocol, "detent-openai-call-v1");
  assert.equal(out.ok, false);
  assert.equal(out.class, "http");
  assert.equal(out.http_status, 503);
  assert.equal(out.attempts, 3);
  assert.match(out.message, /third body/);
  assert.equal(t.calls.length, 3);
  assert.deepEqual(t.sleeps, [500, 1000]);
  assert.equal(t.warnings.length, 2);
});

test("400, 401 and 404 are not retried and do not warn", async () => {
  for (const status of [400, 401, 404]) {
    const t = rig([res(status, `nope ${status}`), res(200, OK_BODY)]);
    const out = await t.go();
    assert.equal(out.ok, false);
    assert.equal(out.class, "http");
    assert.equal(out.http_status, status);
    assert.equal(out.attempts, 1);
    assert.match(out.message, new RegExp(`nope ${status}`));
    assert.equal(t.calls.length, 1, String(status));
    assert.deepEqual(t.warnings, []);
    assert.deepEqual(t.sleeps, []);
  }
});

test("408, 429, 500, 502, 504 are retried like 503", async () => {
  for (const status of [408, 429, 500, 502, 504]) {
    const t = rig([res(status, "x"), res(200, OK_BODY)]);
    assert.equal((await t.go()).attempts, 2, String(status));
  }
});

test("a rejected fetch is retried and then reported as class network", async () => {
  const t = rig([refused()]);
  const out = await t.go();
  assert.equal(out.ok, false);
  assert.equal(out.class, "network");
  assert.equal(out.attempts, 3);
  assert.match(out.message, /ECONNREFUSED/);
  assert.equal(t.calls.length, 3);
  assert.equal(t.warnings[0], "openai-compatible: attempt 1/3 failed (ECONNREFUSED); retrying in 500ms");
  assert.equal(t.warnings[1], "openai-compatible: attempt 2/3 failed (ECONNREFUSED); retrying in 1000ms");
  assert.ok(!("http_status" in out));
});

test("a network error followed by a good answer is ok", async () => {
  const out = await rig([refused(), res(200, OK_BODY)]).go();
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
});

test("a 200 that is not JSON is bad_body and is not retried", async () => {
  const t = rig([res(200, "<html>gateway</html>"), res(200, OK_BODY)]);
  const out = await t.go();
  assert.equal(out.ok, false);
  assert.equal(out.class, "bad_body");
  assert.equal(out.attempts, 1);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.warnings, []);
});

test("the key is scrubbed from every emitted message and body", async () => {
  const echoed = JSON.stringify({ error: { message: "bad key", echo: `Bearer ${SENTINEL}` } });
  const fail = await rig([res(401, echoed)]).go({ apiKey: SENTINEL });
  assert.equal(fail.ok, false);
  assert.ok(!JSON.stringify(fail).includes(SENTINEL));
  assert.match(fail.message, /\[redacted\]/);
  const ok = await rig([res(200, { ...OK_BODY, echo: SENTINEL })]).go({ apiKey: SENTINEL });
  assert.ok(!JSON.stringify(ok).includes(SENTINEL));
  assert.equal(ok.body.echo, "[redacted]");
  const t = rig([res(503, SENTINEL), res(200, OK_BODY)]);
  await t.go({ apiKey: SENTINEL });
  assert.ok(!t.warnings.join("\n").includes(SENTINEL));
});

test("retryable and backoffMs", () => {
  for (const s of [408, 429, 500, 502, 503, 504]) assert.equal(retryable(s), true, String(s));
  for (const s of [400, 401, 403, 404, 422, 501]) assert.equal(retryable(s), false, String(s));
  assert.equal(retryable(refused()), true);
  assert.equal(backoffMs(1), 500);
  assert.equal(backoffMs(2), 1000);
  assert.equal(backoffMs(1, "2"), 2000);
  assert.equal(backoffMs(2, "99"), 10000);
  assert.equal(backoffMs(1, "Wed, 21 Oct 2026 07:28:00 GMT"), 500);
  assert.throws(() => backoffMs(3), RangeError);
});

function helper(args, { input = "hello", env = {} } = {}) {
  const e = { ...process.env, ...env };
  delete e.DETENT_OPENAI_BASE_URL;
  return spawnSync(process.execPath, [CALL_PATH, ...args], { input, encoding: "utf8", env: e });
}

test("the helper rejects bad argv with a nonzero exit and nothing on stdout", () => {
  for (const args of [[], ["--model", "m"], ["--base-url", "http://h.test/v1"], ["--base-url", "http://h.test/v1", "--model"],
    ["--base-url", "http://h.test/v1", "--model", "m", "--frob", "x"], ["--base-url", "a", "--base-url", "b", "--model", "m"],
    ["--base-url", "http://h.test/v1", "--model", "m", "stray"]]) {
    const r = helper(args);
    assert.notEqual(r.status, 0, JSON.stringify(args));
    assert.equal(r.stdout, "", JSON.stringify(args));
    assert.ok(r.stderr.length > 0, JSON.stringify(args));
  }
});

test("the helper fails when the named key variable is empty, naming the variable", () => {
  const r = helper(["--base-url", "http://h.test/v1", "--model", "m", "--api-key-env", "DETENT_FAKE_KEY"], { env: { DETENT_FAKE_KEY: "" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DETENT_FAKE_KEY/);
});

test("the helper prints one protocol line, reads the key from its environment and exits 0 even for http failures", async () => {
  const ok = await startServerProcess("ok");
  const down = await startServerProcess("401-echo-auth");
  try {
    const good = helper(["--base-url", ok.url, "--model", "m", "--api-key-env", "DETENT_FAKE_KEY"], { env: { DETENT_FAKE_KEY: SENTINEL } });
    assert.equal(good.status, 0, good.stderr);
    const lines = good.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).body.choices[0].message.content, "hi");
    const bad = helper(["--base-url", down.url, "--model", "m", "--api-key-env", "DETENT_FAKE_KEY"], { env: { DETENT_FAKE_KEY: SENTINEL } });
    assert.equal(bad.status, 0, bad.stderr);
    const o = JSON.parse(bad.stdout);
    assert.deepEqual([o.ok, o.class, o.http_status, o.attempts], [false, "http", 401, 1]);
    assert.ok(!bad.stdout.includes(SENTINEL));
    assert.match(bad.stdout, /\[redacted\]/);
  } finally {
    ok.close();
    down.close();
  }
});
