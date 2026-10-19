import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { engine, FIXTURES } from "./helpers.mjs";

const NODE = process.execPath;

function mkStackRepo(yaml) {
  const dir = mkdtempSync(join(tmpdir(), "engine-stack-"));
  writeFileSync(join(dir, "stack.yaml"), yaml);
  return dir;
}

function payloadFile(dir, obj) {
  const p = join(dir, "payload.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const FULL_STACK = `# fixture stack
engine_version: "1"
sockets:
  ticket:
    command: "${NODE}"
    args: ["${join(FIXTURES, "echo-ticket.mjs")}"]
    version: "builtin"
    timeout: "10s"
  helper:
    kind: skill
    skill: "brief-writer"
  lookup:
    kind: mcp_tool
    tool: "corpus__search_docs"
  knowledge:
    providers:
      - name: "a"
        command: "${NODE}"
        args: ["${join(FIXTURES, "knowledge-a.mjs")}"]
        version: "builtin"
      - name: "b"
        command: "${NODE}"
        args: ["${join(FIXTURES, "knowledge-b.mjs")}"]
        version: "builtin"
    merge:
      max_results: 3
      min_confidence: 0.3
`;

test("socket call dispatches exec kind: argv spawn, JSON on stdin, response passed through", () => {
  const repo = mkStackRepo(FULL_STACK);
  const pf = payloadFile(repo, { ticket_ref: "octo/repo#1" });
  const r = engine(["socket", "call", "ticket", "--payload-file", pf, "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.kind, "exec");
  assert.equal(r.json.response.id, "octo/repo#1");
  assert.match(r.json.response.body_excerpt, /octo\/repo#1/); // payload actually reached stdin
  assert.ok(r.json.next_step);
});

test("socket call surfaces exec contract violation as exit 2", () => {
  const repo = mkStackRepo(FULL_STACK);
  const pf = payloadFile(repo, { fail: 2 });
  const r = engine(["socket", "call", "ticket", "--payload-file", pf, "--repo", repo]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
});

test("socket call skill kind prints an instruction block for the invoking agent", () => {
  const repo = mkStackRepo(FULL_STACK);
  const pf = payloadFile(repo, { task: "write brief" });
  const r = engine(["socket", "call", "helper", "--payload-file", pf, "--repo", repo]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.kind, "skill");
  assert.equal(r.json.instruction.action, "invoke_skill");
  assert.equal(r.json.instruction.skill, "brief-writer");
  assert.deepEqual(r.json.instruction.payload, { task: "write brief" });
  assert.match(r.json.next_step, /cannot invoke skills/i);
});

test("socket call mcp_tool kind prints an instruction block for the invoking agent", () => {
  const repo = mkStackRepo(FULL_STACK);
  const r = engine(["socket", "call", "lookup", "--repo", repo]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.kind, "mcp_tool");
  assert.equal(r.json.instruction.action, "invoke_mcp_tool");
  assert.equal(r.json.instruction.tool, "corpus__search_docs");
  assert.match(r.json.next_step, /cannot invoke .*mcp/i);
});

test("knowledge socket fans out, merges with source attribution, dedupes and caps", () => {
  const repo = mkStackRepo(FULL_STACK);
  const pf = payloadFile(repo, { query: "backoff" });
  const r = engine(["socket", "call", "knowledge", "--payload-file", pf, "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.providers_succeeded.sort(), ["a", "b"]);
  assert.deepEqual(r.json.warnings, []);
  const results = r.json.results;
  // dedupe by source keeps highest confidence; min_confidence 0.3 drops docs/low.md; cap 3
  assert.deepEqual(results.map((x) => x.source), ["docs/x.md:1", "docs/shared.md:5", "docs/y.md:3"]);
  assert.equal(results[1].confidence, 0.8); // b's higher-confidence copy won the dedupe
  assert.equal(results[1].provider, "b"); // source attribution
  assert.equal(results[0].provider, "a");
});

test("knowledge socket: one provider failing is a warning, results still returned", () => {
  const repo = mkStackRepo(`engine_version: "1"
sockets:
  knowledge:
    providers:
      - name: "a"
        command: "${NODE}"
        args: ["${join(FIXTURES, "knowledge-a.mjs")}"]
      - name: "down"
        command: "${NODE}"
        args: ["${join(FIXTURES, "knowledge-fail.mjs")}"]
    merge:
      max_results: 10
      min_confidence: 0
`);
  const pf = payloadFile(repo, { query: "backoff" });
  const r = engine(["socket", "call", "knowledge", "--payload-file", pf, "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.providers_succeeded, ["a"]);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /down/);
  assert.ok(r.json.results.length >= 1);
});

test("knowledge socket: all providers failing aborts with exit 1", () => {
  const repo = mkStackRepo(`engine_version: "1"
sockets:
  knowledge:
    providers:
      - name: "down1"
        command: "${NODE}"
        args: ["${join(FIXTURES, "knowledge-fail.mjs")}"]
      - name: "down2"
        command: "${NODE}"
        args: ["${join(FIXTURES, "knowledge-fail.mjs")}"]
`);
  const pf = payloadFile(repo, { query: "backoff" });
  const r = engine(["socket", "call", "knowledge", "--payload-file", pf, "--repo", repo]);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /all .*providers failed/i);
});

test("socket call refuses when stack.yaml is missing", () => {
  const repo = mkdtempSync(join(tmpdir(), "engine-nostack-"));
  const r = engine(["socket", "call", "ticket", "--repo", repo]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /stack\.yaml/);
});

test("socket call refuses an unknown socket name", () => {
  const repo = mkStackRepo(FULL_STACK);
  const r = engine(["socket", "call", "nonesuch", "--repo", repo]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /nonesuch/);
});

test("socket call parses the shipped stack.example.yaml structure (yaml subset parser)", () => {
  // ensure the parser handles the real example file's shapes: nested maps, provider
  // lists, inline flow arrays, comments. Unknown-socket call against it should still
  // exit 2 with a clean reason (i.e. parsing succeeded, name lookup failed).
  const exampleDir = join(FIXTURES, "..", "..", "..");
  const r = engine(["socket", "call", "nonesuch", "--stack", join(exampleDir, "stack.example.yaml"), "--repo", exampleDir]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.json.reason, /nonesuch/);
  assert.ok(r.json.known_sockets.includes("deploy-harness"), "parsed socket names: " + r.json.known_sockets);
  assert.ok(r.json.known_sockets.includes("knowledge"));
});
