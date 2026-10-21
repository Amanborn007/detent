import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRuntime } from "../runtime.mjs";
import { judgeCase, runJudgeCase } from "../../eval/graders/judge.mjs";
import { baseRequest, scratch, spawned } from "./kit.mjs";
import { makeOpenAIFake, startServerProcess } from "./openai-kit.mjs";
import { GOOD_FINDING, sha } from "./fake-openai-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..", "..", "cli", "engine.mjs");
const REVIEWER = join(HERE, "..", "..", "adapters", "claude-reviewer");
const RUNTIME_URL = pathToFileURL(join(HERE, "..", "runtime.mjs")).href;
const SENTINEL = "sk-sentinel-4f9a1c";

// Every DETENT_* variable these tests care about starts unset, so the host's own config cannot leak in.
function envWith(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k === "DETENT_RUNTIME" || k.startsWith("DETENT_OPENAI_") || k === "DETENT_CLAUDE_BIN") delete e[k];
  return { ...e, ...extra };
}

async function withServer(mode, fn, logdir) {
  const s = await startServerProcess(mode, logdir);
  try { return await fn(s); } finally { s.close(); }
}

const cfg = (url, extra = {}) => ({ DETENT_OPENAI_BASE_URL: url, DETENT_OPENAI_MODEL: "fake-model", ...extra });

function verb(args, { input, env } = {}) {
  const r = spawnSync(process.execPath, [ENGINE, "runtime", ...args], { input, encoding: "utf8", env: envWith(env) });
  const lines = r.stdout.trim().split("\n");
  return { code: r.status, json: lines.length === 1 && lines[0] ? JSON.parse(lines[0]) : null, stderr: r.stderr };
}

test("a flaky server: stop ok, the two retry warnings are in raw.stderr and reach the parent's stderr", async () => {
  await withServer("flaky", async ({ url }) => {
    const script = `import { getRuntime } from ${JSON.stringify(RUNTIME_URL)};
const r = getRuntime({ name: "openai-compatible" }).run(${JSON.stringify(baseRequest(tmpdir(), { output: "text" }))});
process.stdout.write(JSON.stringify(r));`;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: envWith(cfg(url)) });
    assert.equal(p.status, 0, p.stderr);
    const r = JSON.parse(p.stdout);
    assert.equal(r.stop, "ok");
    assert.equal(r.text, "hi");
    const w1 = "openai-compatible: attempt 1/3 failed (HTTP 503); retrying in 500ms";
    const w2 = "openai-compatible: attempt 2/3 failed (HTTP 503); retrying in 1000ms";
    for (const w of [w1, w2]) {
      assert.equal(r.raw.stderr.split(w).length - 1, 1, w);
      assert.equal(p.stderr.split(w).length - 1, 1, w);
    }
    assert.equal(JSON.parse(r.raw.stdout).attempts, 3);
  });
});

test("record: Authorization is on the wire only when a key is configured", async () => {
  const logdir = mkdtempSync(join(tmpdir(), "openai-record-"));
  await withServer("record", async ({ url }) => {
    const run = (env) => getRuntime({ name: "openai-compatible", env }).run(baseRequest(tmpdir(), { output: "text" }));
    assert.equal(run({ ...envWith(cfg(url)) }).stop, "ok");
    assert.equal(run({ ...envWith(cfg(url, { DETENT_OPENAI_API_KEY_ENV: "DETENT_FAKE_KEY", DETENT_FAKE_KEY: SENTINEL })) }).stop, "ok");
    const [bare, keyed] = readFileSync(join(logdir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(bare.headers.authorization, undefined);
    assert.equal(keyed.headers.authorization, sha(`Bearer ${SENTINEL}`));
    for (const q of [bare, keyed]) {
      assert.equal(q.method, "POST");
      assert.equal(q.path, "/v1/chat/completions");
      assert.deepEqual(JSON.parse(q.body), { model: "fake-model", messages: [{ role: "user", content: "say hi" }], stream: false });
      assert.ok(!q.body.includes(SENTINEL));
    }
  }, logdir);
});

test("runtime capabilities --runtime openai-compatible exits 0", () => {
  const r = verb(["capabilities", "--runtime", "openai-compatible"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.runtime, "openai-compatible");
  assert.deepEqual(r.json.capabilities.tools, ["none"]);
  assert.deepEqual(r.json.capabilities.auth, ["api_key"]);
});

test("runtime run with the base url unset exits 2 naming it and spawns nothing", () => {
  const dir = scratch();
  const r = verb(["run", "--runtime", "openai-compatible", "--bin", makeOpenAIFake(dir, "ok").bin], { input: JSON.stringify(baseRequest(dir)), env: { DETENT_OPENAI_MODEL: "m" } });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /DETENT_OPENAI_BASE_URL/);
  assert.match(r.json.next_step, /set DETENT_OPENAI_BASE_URL; see engine\/runtime\/CONTRACT\.md \(openai-compatible\)/);
  assert.equal(spawned(dir), false);
});

test("runtime run against a server exits 0 and prints the answer", async () => {
  await withServer("ok", ({ url }) => {
    const r = verb(["run", "--runtime", "openai-compatible"], { input: JSON.stringify(baseRequest(tmpdir())), env: cfg(url) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.runtime, "openai-compatible");
    assert.equal(r.json.stop, "ok");
    assert.equal(r.json.text, "hi");
  });
});

test("runtime run via DETENT_RUNTIME against a server that stays down exits 1 with runtime_error", async () => {
  await withServer("down", ({ url }) => {
    const r = verb(["run"], { input: JSON.stringify(baseRequest(tmpdir())), env: cfg(url, { DETENT_RUNTIME: "openai-compatible" }) });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.response.error.kind, "runtime_error");
    assert.match(r.json.response.error.message, /503/);
    assert.match(r.stderr, /attempt 2\/3 failed/);
  });
});

// The judge reads process.env and spawnSync inherits it, so these swap it for the duration of one call.
function withProcessEnv(vars, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k === "DETENT_RUNTIME" || k.startsWith("DETENT_OPENAI_")) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("judge under DETENT_RUNTIME=openai-compatible scores through the endpoint and never checks for claude", async () => {
  await withServer("score", ({ url }) => {
    let consulted = 0;
    const r = withProcessEnv(cfg(url, { DETENT_RUNTIME: "openai-compatible" }), () =>
      runJudgeCase({ id: "J", prompt: "rate this" }, { hasClaude: () => { consulted++; return false; } }));
    assert.equal(r.recorded, true);
    assert.equal(r.score, 0.7);
    assert.equal(consulted, 0);
    assert.equal(withProcessEnv(cfg(url, { DETENT_RUNTIME: "openai-compatible" }), () => judgeCase({ id: "J", prompt: "p" }, { k: 1 })).score, 0.7);
  });
});

test("judge against a 401 degrades to recorded:false, naming the runtime and the status", async () => {
  await withServer("401-echo-auth", ({ url }) => {
    const r = withProcessEnv(cfg(url, { DETENT_RUNTIME: "openai-compatible" }), () => runJudgeCase({ id: "J", prompt: "rate this" }));
    assert.equal(r.recorded, false);
    assert.match(r.note, /openai-compatible/);
    assert.match(r.note, /401/);
  });
});

test("judge with no endpoint configured degrades loudly, and an unknown runtime does too", () => {
  const a = withProcessEnv({ DETENT_RUNTIME: "openai-compatible" }, () => runJudgeCase({ id: "J", prompt: "p" }));
  assert.equal(a.recorded, false);
  assert.match(a.note, /DETENT_OPENAI_BASE_URL/);
  const b = withProcessEnv({ DETENT_RUNTIME: "nope" }, () => runJudgeCase({ id: "J", prompt: "p" }));
  assert.equal(b.recorded, false);
  assert.match(b.note, /nope/);
});

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), "oai-rev-"));
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { env: { ...process.env, ...GIT_ENV } });
  g("init", "-q");
  writeFileSync(join(dir, "a.js"), "one\n");
  g("add", "."); g("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.js"), "one\ntwo\n");
  return dir;
}
function review(env) {
  const r = spawnSync(REVIEWER, [], { input: JSON.stringify({ repo_path: mkRepo(), diff_ref: "HEAD", ticket_id: "T-1" }), encoding: "utf8", env: envWith({ DETENT_RUNTIME: "openai-compatible", ...env }) });
  return { code: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
}

test("reviewer under DETENT_RUNTIME=openai-compatible returns the findings", async () => {
  await withServer("findings", ({ url }) => {
    const r = review(cfg(url));
    assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json));
    assert.deepEqual(r.json.findings, [GOOD_FINDING]);
  });
});

test("reviewer with no model configured exits 2 naming DETENT_OPENAI_MODEL", () => {
  const r = review({ DETENT_OPENAI_BASE_URL: "http://127.0.0.1:9/v1" });
  assert.equal(r.code, 2);
  assert.match(r.json.error, /DETENT_OPENAI_MODEL/);
  assert.ok(r.json.next_step);
});

test("reviewer against an endpoint that answers garbage exits 2 as a contract violation", async () => {
  await withServer("garbage", ({ url }) => {
    const r = review(cfg(url));
    assert.equal(r.code, 2, r.stderr + JSON.stringify(r.json));
    assert.match(r.json.error, /response body is not JSON/);
    assert.ok(r.json.next_step);
  });
});
