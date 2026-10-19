// blast-radius.test.mjs — hermetic, no network. Exercises the plan/merge pure
// functions plus one CLI-spawn round-trip. Mirrors engine/bench/test's pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planBlastRadius, mergeBlastRadius, BlastRadiusError } from "../blast-radius.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "blast-radius.mjs");

function runCli(args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input: input || "" });
  let json = null;
  const out = (r.stdout || "").trim();
  if (out) {
    try { json = JSON.parse(out.split("\n").pop()); } catch { /* leave null; assert on raw */ }
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// planBlastRadius
// ---------------------------------------------------------------------------

test("plan (no neighbors yet) emits one neighbor-discovery query", () => {
  const plan = planBlastRadius({ service: "subscriptions-svc", depth: "standard" });
  assert.equal(plan.service, "subscriptions-svc");
  assert.equal(plan.depth, "standard");
  assert.equal(plan.queries.length, 1);
  assert.equal(plan.queries[0].purpose, "neighbor-discovery");
  assert.equal(plan.queries[0].query, "subscriptions-svc dependencies callers callees");
  assert.match(plan.instructions, /neighbor-gotchas/);
  // Company-neutral: never names a specific knowledge provider.
  assert.doesNotMatch(plan.instructions, /acme-kb/i);
});

test("plan defaults depth to 'standard'", () => {
  const plan = planBlastRadius({ service: "x" });
  assert.equal(plan.depth, "standard");
});

test("plan (with neighbors) emits one neighbor-gotchas query per neighbor", () => {
  const plan = planBlastRadius({ service: "subscriptions-svc", depth: "deep", neighbors: ["event-log-svc", "deliveries-svc"] });
  assert.equal(plan.queries.length, 2);
  for (const q of plan.queries) assert.equal(q.purpose, "neighbor-gotchas");
  assert.equal(plan.queries[0].query, "event-log-svc gotchas open concerns");
  assert.equal(plan.queries[1].query, "deliveries-svc gotchas open concerns");
});

test("plan refuses a missing service", () => {
  assert.throws(() => planBlastRadius({ depth: "standard" }), BlastRadiusError);
});

// ---------------------------------------------------------------------------
// mergeBlastRadius — happy path + honesty rules
// ---------------------------------------------------------------------------

test("merge with a stub fixture produces attributed neighbors + markdown", () => {
  const merged = mergeBlastRadius({
    service: "subscriptions-svc",
    provider_status: "reachable",
    results: [
      {
        neighbor: "event-log-svc",
        direction: "callee",
        gotchas: [{ text: "dedupe invariant breaks on retried writes", source: "kb: event-log-svc-audit" }],
      },
    ],
  });
  assert.equal(merged.service, "subscriptions-svc");
  assert.equal(merged.neighbors.length, 1);
  assert.equal(merged.neighbors[0].name, "event-log-svc");
  assert.equal(merged.neighbors[0].direction, "callee");
  assert.equal(merged.neighbors[0].gotchas[0].source, "kb: event-log-svc-audit");
  assert.deepEqual(merged.gaps, []);
  assert.equal(merged.markdown, [
    "### Blast radius (1-hop neighbors of subscriptions-svc)",
    "- event-log-svc: dedupe invariant breaks on retried writes [kb: event-log-svc-audit]",
  ].join("\n"));
});

test("merge refuses when provider_status is missing", () => {
  assert.throws(() => mergeBlastRadius({ service: "x", results: [] }), BlastRadiusError);
});

test("merge refuses an unattributed gotcha (never fabricate a source)", () => {
  assert.throws(
    () => mergeBlastRadius({
      service: "x",
      provider_status: "reachable",
      results: [{ neighbor: "n1", gotchas: [{ text: "something" }] }],
    }),
    BlastRadiusError,
  );
});

test("blocked provider status -> blocked:true, no neighbors section", () => {
  const merged = mergeBlastRadius({ service: "subscriptions-svc", provider_status: "blocked", results: [] });
  assert.equal(merged.blocked, true);
  assert.ok(merged.reason);
  assert.equal(merged.neighbors, undefined);
  assert.equal(merged.markdown, undefined);
});

test("partial provider status -> blocked:true too (never present a partial provider as full)", () => {
  const merged = mergeBlastRadius({ service: "subscriptions-svc", provider_status: "partial", results: [] });
  assert.equal(merged.blocked, true);
});

test("zero-hit discovery (no neighbors at all) records an explicit gaps entry", () => {
  const merged = mergeBlastRadius({ service: "subscriptions-svc", provider_status: "reachable", results: [] });
  assert.equal(merged.neighbors.length, 0);
  assert.equal(merged.gaps.length, 1);
  assert.match(merged.gaps[0], /no neighbors discovered/);
  assert.match(merged.markdown, /no neighbors discovered/i);
});

test("a neighbor with zero gotchas is recorded in gaps, never silently omitted", () => {
  const merged = mergeBlastRadius({
    service: "subscriptions-svc",
    provider_status: "reachable",
    results: [{ neighbor: "deliveries-svc", gotchas: [] }],
  });
  assert.equal(merged.neighbors.length, 1);
  assert.equal(merged.gaps.length, 1);
  assert.match(merged.gaps[0], /deliveries-svc.*no gotchas found/);
  assert.match(merged.markdown, /deliveries-svc: \(no gotchas found\)/);
});

// ---------------------------------------------------------------------------
// CLI round-trip
// ---------------------------------------------------------------------------

test("CLI: plan --service X prints one JSON line, exit 0", () => {
  const r = runCli(["plan", "--service", "subscriptions-svc"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.queries[0].purpose, "neighbor-discovery");
});

test("CLI: merge reads results JSON from stdin, exit 0", () => {
  const stdin = JSON.stringify([
    { neighbor: "event-log-svc", direction: "callee", gotchas: [{ text: "g1", source: "kb: doc-1" }] },
  ]);
  const r = runCli(["merge", "--service", "subscriptions-svc", "--status", "reachable"], stdin);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.neighbors[0].name, "event-log-svc");
});

test("CLI: merge without --status exits 2 (refusal)", () => {
  const r = runCli(["merge", "--service", "subscriptions-svc"], "[]");
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
});

test("CLI: plan without --service exits 2 (refusal)", () => {
  const r = runCli(["plan"]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
});
