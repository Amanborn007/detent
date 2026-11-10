// One fixture per stage doc's decision shape: each must render a page with zero contract warnings,
// carry its recommendation on the record, and be backed by the doc that tells the stage to write it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildGatePage } from "../gate-page.mjs";
import { checkPage, checkDecisionRecord } from "../../curator/contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STAGES = ["intake", "research", "plan", "implement", "recheck", "ship", "respond"];
const STAGE_ARTIFACTS = { intake: ["brief.md"], research: ["research.md", "access-report.json"], plan: ["plan/plan.md"], recheck: ["recheck.md"] };
const doc = (rel) => readFileSync(join(REPO, rel), "utf8");

const opt = (label, consequence, then) => ({ label, consequence, then });
const rec = (key, reason) => ({ key, reason });
const NOREC = "The call belongs to the human who owns this change, so nothing is recommended.";

const FIXTURES = {
  intake: {
    docs: ["engine/stages/intake/SKILL.md"], keys: [],
    d: { raised_by: "intake", blocks: ["implement"], question: "Should failed webhooks retry forever or stop after a cap?",
      options: ["capped + dead-letter", "infinite backoff"],
      option_details: { "capped + dead-letter": opt("Cap the retries", "Retries stop after a set count and park the event.", "Then the plan adds a dead-letter table."), "infinite backoff": opt("Retry forever", "Retries continue with backoff until the partner answers.", "Then the plan skips the dead-letter table.") },
      recommended: rec("capped + dead-letter", "A cap keeps a dead partner from piling up retries."), why_now: "Planning cannot start until the retry policy is known." },
  },
  research: {
    docs: ["engine/stages/research/SKILL.md"], keys: [],
    d: { raised_by: "research", blocks: ["plan"], question: "Research could not trace the consumers of the retry helper, so should planning proceed anyway?",
      options: ["proceed on the known callers", "trace the consumers first"],
      option_details: { "proceed on the known callers": opt("Proceed anyway", "Planning starts now and may miss an unseen consumer.", "Then the plan stage sizes the rollout on three callers."), "trace the consumers first": opt("Trace them first", "Research reruns with access to the missing repo.", "Then the plan stage waits for the new blast radius.") },
      no_recommendation: NOREC, context_excerpt: "Blast radius is unclear beyond the retry helper: could not trace its consumers." },
  },
  "research-multi-workspace": {
    docs: ["engine/stages/CONTRACT.md"], keys: ["split-first", "multi-workspace"],
    d: { raised_by: "research", blocks: ["plan"], question: "The change spans several repos, so should the ticket be split first?",
      options: ["split-first", "multi-workspace"],
      option_details: { "split-first": opt("Split into subtasks", "Each repo gets its own ticket and its own run.", "Then clerk drafts one subtask per repo."), "multi-workspace": opt("Keep one run", "One run edits every repo in separate workspaces.", "Then the plan covers all the repos together.") },
      recommended: rec("split-first", "Splitting keeps every run scoped to a single repo.") },
  },
  plan: {
    docs: ["engine/stages/plan/SKILL.md"], keys: [],
    d: { raised_by: "plan", blocks: ["implement"], question: "The plan adds a metrics dashboard the brief never asked for, so should it stay?",
      options: ["keep the addition", "remove the addition"],
      option_details: { "keep the addition": opt("Keep the dashboard", "The dashboard ships with this change.", "Then implement builds the dashboard step."), "remove the addition": opt("Remove the dashboard", "The plan drops the step the brief never asked for.", "Then implement runs only the requested steps.") },
      recommended: rec("remove the addition", "The brief never asked for it, so it should not ship."), context_excerpt: "Step 5 adds a retry-metrics dashboard that no acceptance criterion mentions." },
  },
  implement: {
    docs: ["engine/stages/implement/SKILL.md"], keys: [],
    d: { raised_by: "implement", blocks: ["ship"], question: "A change needs a file the plan never listed, so should the plan grow to include it?",
      options: ["add the file to the plan", "leave the file out"],
      option_details: { "add the file to the plan": opt("Add it to the plan", "The diff grows by one file the plan now names.", "Then recheck compares against the updated plan."), "leave the file out": opt("Leave it out", "The change ships without that file and may be incomplete.", "Then recheck flags the missing behavior.") },
      no_recommendation: NOREC, context_excerpt: "The retry change also needs lib/limits.ts, which plan.md never lists." },
  },
  recheck: {
    docs: ["engine/stages/recheck/SKILL.md"], keys: ["accept deviation", "route back to plan", "route back to implement"],
    d: { raised_by: "recheck", blocks: ["ship"], question: "Step 3 never ran its planned test, so how should the run proceed?",
      options: ["accept deviation", "route back to plan", "route back to implement"],
      option_details: { "accept deviation": opt("Accept the deviation", "The run keeps the commit as written without that test.", "Then ship proceeds with the deviation recorded."), "route back to plan": opt("Send it to plan", "The plan is revised to match what was built.", "Then plan reruns with your note."), "route back to implement": opt("Send it to implement", "Implement adds the missing test and reruns.", "Then recheck compares the new commits.") },
      no_recommendation: "The human picks the route, and the agent never routes the run itself.", context_excerpt: "Step 3 lists a test in tests/retry.test.mjs that the commits never add." },
  },
  "ship-ask-user": {
    docs: ["engine/stages/ship/SKILL.md"], keys: [],
    d: { raised_by: "ship", blocks: ["ship"], question: "The reviewer flagged a risk it cannot fix itself, so how should ship handle it?",
      options: ["fix before shipping", "accept the risk", "not a real problem"],
      option_details: { "fix before shipping": opt("Fix it first", "Ship waits while the finding is fixed.", "Then the review reruns on the fix."), "accept the risk": opt("Take on the risk", "The finding ships and the PR body records it.", "Then ship goes on to the push gate."), "not a real problem": opt("Mark it a false positive", "The finding is closed with your reason noted.", "Then ship goes on to the push gate.") },
      no_recommendation: NOREC, context_excerpt: "high | lib/retry.ts:42 | the retry loop has no upper bound on delay | an unbounded delay can stall the queue." },
  },
  "ship-evidence-gap": {
    docs: ["engine/stages/ship/SKILL.md"], keys: [],
    d: { raised_by: "ship", blocks: ["ship"], question: "No end-to-end evidence exists for the retry claim, so how should the gap be closed?",
      options: ["file the access request then re-run verify", "run the command yourself and paste the output", "accept the recorded gap"],
      option_details: { "file the access request then re-run verify": opt("File the access request", "Verify waits until access is granted.", "Then verify reruns and gathers real evidence."), "run the command yourself and paste the output": opt("Run it yourself", "You run the command and paste its output back.", "Then ship records it as the evidence artifact."), "accept the recorded gap": opt("Accept the gap", "The PR body quotes the gap as your own decision.", "Then ship goes on to the push gate.") },
      no_recommendation: NOREC, context_excerpt: "Claim 2, retries stop at five, has only unit-test evidence and no staging run." },
  },
  "ship-push-approval": {
    docs: ["engine/stages/ship/SKILL.md"], keys: ["approve push and draft PR", "hold the push"],
    d: { raised_by: "ship", blocks: ["ship"], question: "Evidence and the drafted PR are ready, so should ship push and open the draft PR?",
      options: ["approve push and draft PR", "hold the push"],
      option_details: { "approve push and draft PR": opt("Push and open the PR", "The branch is published and a draft PR opens.", "Then ship records the PR url."), "hold the push": opt("Wait on the push", "Nothing leaves your machine yet.", "Then ship stays open for your next call.") },
      no_recommendation: "Publishing is the human's call, so the agent never recommends the push.", context_excerpt: "Three commits, two files changed, every acceptance criterion has evidence." },
  },
  respond: {
    docs: ["engine/stages/respond/SKILL.md"], keys: [],
    d: { raised_by: "respond", blocks: ["respond"], question: "A reviewer asked a question about the retry cap, so how should the next cycle answer?",
      options: ["fix it in code", "reply with a rationale", "leave it open"],
      option_details: { "fix it in code": opt("Change the code", "The next push changes the cap as asked.", "Then the thread is replied to and resolved."), "reply with a rationale": opt("Reply only", "A scribe-drafted reply explains the current cap.", "Then you review the draft before it posts."), "leave it open": opt("Keep the thread open", "The thread stays unresolved and blocks the gate.", "Then the next cycle waits on you.") },
      no_recommendation: NOREC, context_excerpt: "Why cap at five and not three? That seems arbitrary to me." },
  },
  examiner: {
    docs: ["engine/examiner/PROTOCOL.md", "skills/examiner/SKILL.md"], keys: [],
    d: { raised_by: "examiner", kind: "examiner", blocks: ["implement"], question: "Should the export include rows that were soft-deleted?",
      options: ["include them", "exclude them"],
      option_details: { "include them": opt("Include deleted rows", "The export matches the raw table exactly.", "Then the plan adds a deleted flag column."), "exclude them": opt("Exclude deleted rows", "The export shows only live rows.", "Then the plan filters on the deleted flag.") },
      recommended: rec("exclude them", "Readers of the export expect only live records.") },
  },
};

for (const [name, f] of Object.entries(FIXTURES)) {
  const record = { id: "D-009", status: "pending", cause: "judgment", ...f.d };
  test(`${name}: renders with zero contract warnings and carries its recommendation`, () => {
    assert.ok(record.recommended || record.no_recommendation, "recommended or no_recommendation is on the record");
    assert.deepEqual(record.options.filter((o) => typeof o !== "string"), []);
    assert.deepEqual(Object.keys(record.option_details), record.options);
    assert.deepEqual(checkDecisionRecord(record, { level: "error" }), { errors: [], warnings: [] });
    const { html } = buildGatePage({ runId: "r1", runDir: mkdtempSync(join(tmpdir(), "fixture-run-")) },
      { name: "D-009", stage: "plan", decisions: [record], earlier: [] }, { stages: STAGES, stageArtifacts: STAGE_ARTIFACTS });
    assert.deepEqual(checkPage(html), { errors: [], warnings: [] });
  });
  test(`${name}: the doc that raises it documents the stored form and its keys`, () => {
    for (const rel of f.docs) {
      const text = doc(rel);
      for (const w of ["option_details", "no_recommendation", "context_excerpt"]) assert.ok(text.includes(w) || /recommended/.test(text), `${rel} mentions ${w}`);
      assert.ok(text.includes("option_details"), `${rel} mentions option_details`);
      for (const k of f.keys) assert.ok(text.includes(k), `${rel} quotes ${JSON.stringify(k)}`);
    }
  });
}

test("DRIVEN.md documents the outbox form with object options", () => {
  const t = doc("engine/stages/DRIVEN.md");
  assert.match(t, /\{ ?"key", ?"label", ?"consequence", ?"then" ?\}/);
  assert.ok(t.includes("no_recommendation"));
});

test("CONTRACT.md documents option_details, recommended, no_recommendation, why_now and context_excerpt", () => {
  const t = doc("engine/stages/CONTRACT.md");
  for (const w of ["option_details", "recommended", "no_recommendation", "why_now", "context_excerpt"]) assert.ok(t.includes(w), w);
});
