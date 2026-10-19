// Unit tests for engine/routing/routing.mjs. Zero dependencies (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROUTING_SCHEMA, loadRoutingConfig, tierOf, advisorConsultEvent,
} from "../routing.mjs";
import { DEFAULT_RATES } from "../../bench/bench.mjs";

// The actual detent root (three levels up from engine/routing/test/) — used
// to load the REAL committed engine/routing/routing.json, not a fixture copy.
const DETENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fixtureRoot(configObj) {
  const root = mkdtempSync(join(tmpdir(), "routing-test-"));
  const dir = join(root, "engine", "routing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "routing.json"), JSON.stringify(configObj));
  return root;
}

const VALID = {
  schema: ROUTING_SCHEMA,
  tiers: { strong: ["fable", "opus"], fast: ["sonnet"], light: ["haiku"] },
  escalation: {
    on_block: "consult-strong-advisor",
    authority: "recommend-only",
    promotion: { requires: "paired cost+quality ledger lines", min_paired_ledger_lines: 10 },
  },
};

test("a valid config parses", () => {
  const root = fixtureRoot(VALID);
  const { config } = loadRoutingConfig(root);
  assert.equal(config.schema, ROUTING_SCHEMA);
  assert.deepEqual(config.tiers.strong, ["fable", "opus"]);
  assert.equal(config.escalation.authority, "recommend-only");
});

test("authority: auto-apply throws", () => {
  const bad = { ...VALID, escalation: { ...VALID.escalation, authority: "auto-apply" } };
  const root = fixtureRoot(bad);
  assert.throws(() => loadRoutingConfig(root), /recommend-only/);
});

test("absent authority throws", () => {
  const { authority, ...rest } = VALID.escalation;
  const bad = { ...VALID, escalation: rest };
  const root = fixtureRoot(bad);
  assert.throws(() => loadRoutingConfig(root), /recommend-only/);
});

test("empty tiers object throws", () => {
  const bad = { ...VALID, tiers: {} };
  const root = fixtureRoot(bad);
  assert.throws(() => loadRoutingConfig(root), /non-empty/);
});

test("unknown/empty tier array throws", () => {
  const bad = { ...VALID, tiers: { ...VALID.tiers, ghost: [] } };
  const root = fixtureRoot(bad);
  assert.throws(() => loadRoutingConfig(root), /non-empty array/);
});

test("wrong schema string throws", () => {
  const bad = { ...VALID, schema: "detent-routing-v0" };
  const root = fixtureRoot(bad);
  assert.throws(() => loadRoutingConfig(root), /schema/);
});

test("tierOf finds the tier a model belongs to; unknown model -> null", () => {
  const { config } = loadRoutingConfig(fixtureRoot(VALID));
  assert.equal(tierOf("fable", config), "strong");
  assert.equal(tierOf("sonnet", config), "fast");
  assert.equal(tierOf("haiku", config), "light");
  assert.equal(tierOf("gpt-nope", config), null);
  assert.equal(tierOf(null, config), null);
});

test("advisorConsultEvent is pure and carries no id field", () => {
  const event = advisorConsultEvent({ model: "fable", tier: "strong", trigger: "gate:intent", decisionId: "D-001" });
  assert.equal(event.event, "advisor_consult");
  assert.equal(event.model, "fable");
  assert.equal(event.tier, "strong");
  assert.equal(event.trigger, "gate:intent");
  assert.equal(event.decision_id, "D-001");
  assert.equal(event.authority, "recommend-only");
  assert.ok(!("id" in event), "id is reserved for external_request correlation");
});

test("advisorConsultEvent defaults decision_id to null when omitted", () => {
  const event = advisorConsultEvent({ model: "opus", tier: "strong", trigger: "free-text note" });
  assert.equal(event.decision_id, null);
});

test("routing tiers stay a subset of the bench rate table — cross-check against drift", () => {
  const { config } = loadRoutingConfig(fixtureRoot(VALID));
  const routedModels = Object.values(config.tiers).flat();
  const pricedModels = Object.keys(DEFAULT_RATES).filter((k) => !k.startsWith("_"));
  for (const m of routedModels) {
    assert.ok(pricedModels.includes(m), `routed model "${m}" has no DEFAULT_RATES entry — routing/pricing drift`);
  }
});

test("the COMMITTED engine/routing/routing.json parses, is recommend-only, and cannot drift from bench pricing", () => {
  // Loads the real file on disk (not a fixture copy) so an edit to the
  // committed config that adds an unpriced model, or corrupts the schema,
  // fails this test instead of only surfacing at runtime in `engine advisor
  // consult` — see docs/model-routing.md's "cannot silently drift apart" claim.
  const { config } = loadRoutingConfig(DETENT_ROOT);
  assert.equal(config.schema, ROUTING_SCHEMA);
  assert.equal(config.escalation.authority, "recommend-only");

  const routedModels = Object.values(config.tiers).flat();
  const pricedModels = Object.keys(DEFAULT_RATES).filter((k) => !k.startsWith("_"));
  for (const m of routedModels) {
    assert.ok(pricedModels.includes(m), `routed model "${m}" has no DEFAULT_RATES entry — routing/pricing drift`);
  }
});
