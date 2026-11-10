// Drive rejects a child's decisions that would make the curator page fail the decision contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { setup, drive, readJson } from "./drive-kit.mjs";
import { checkDecisionRecord } from "../../curator/contract.mjs";

const opt = (key, consequence = "Changes the shipped behaviour for every caller") => ({ key, label: `Take path ${key}`, consequence });
const good = (over = {}) => ({
  key: "u1", question: "Which path should the change take?", options: [opt("a"), opt("b")], blocks: ["implement"], cause: "judgment",
  recommended: { key: "a", reason: "Path a keeps existing callers working unchanged" }, ...over,
});

function raise(d) {
  const t = setup();
  const r = drive(t, { manifestPatch: { decisions: [d] } }, ["--max-steps", "1"]);
  return { t, r, decisions: readJson(join(t.runDir, "decisions.json")) };
}

function assertRejected({ t, r, decisions }, check) {
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "outbox_rejected");
  const last = readJson(join(t.runDir, "drive-last.json"));
  assert.equal(last.code, "decision_contract", r.stdout);
  assert.match(String(last.detail), check);
  assert.match(String(last.detail), /u1/, "names the decision key");
  assert.equal(decisions.length, 0, "nothing was applied");
  assert.ok(readdirSync(join(t.runDir, ".drive", "quarantine")).length > 0, "outbox quarantined");
}

test("a three-word option consequence is rejected as decision_contract and quarantined", () => {
  assertRejected(raise(good({ options: [opt("a", "Slightly larger change"), opt("b")] })), /C5/);
});

test("a question that does not end in ? is rejected", () => {
  assertRejected(raise(good({ question: "Pick a path for the change" })), /C3/);
});

test("a recommendation reason under five words is rejected", () => {
  assertRejected(raise(good({ recommended: { key: "a", reason: "Safer" } })), /C4/);
});

test("a decision that meets the contract is applied", () => {
  const { r, decisions } = raise(good());
  assert.notEqual(r.json && r.json.reason, "outbox_rejected", r.stdout + r.stderr);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].question, "Which path should the change take?");
});

test("drive-authored access-degraded decisions pass the record contract", async () => {
  const { ACCESS_DEGRADED_OPTIONS, ACCESS_DEGRADED_DETAILS, ACCESS_DEGRADED_NO_RECOMMENDATION } = await import("../drive/access-degraded.mjs");
  const rec = {
    question: "CRITICAL source 'jira' is BLOCKED (no token). Enable: add one. How to proceed?",
    options: ACCESS_DEGRADED_OPTIONS, option_details: ACCESS_DEGRADED_DETAILS, no_recommendation: ACCESS_DEGRADED_NO_RECOMMENDATION,
  };
  const { errors } = checkDecisionRecord(rec, { level: "error" });
  assert.deepEqual(errors, []);
});
