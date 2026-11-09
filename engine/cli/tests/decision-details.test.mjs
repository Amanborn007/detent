import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson, eventsOf } from "./helpers.mjs";
import { setup, drive } from "./drive-kit.mjs";
import { renderText } from "../render.mjs";
import { loadRunState, checkSufficiency, buildNote } from "../../handoff/handoff.mjs";

const BARE_PATH = "/usr/bin:/bin";
const DETAILS = {
  a: { label: "Keep the cap", consequence: "Keeps retries bounded at five per request.", then: "Then the plan stage writes the capped steps." },
  b: { label: "Remove the cap", consequence: "Lets retries run until the partner answers.", then: "Then the plan stage writes the open-ended steps." },
};
const BRIEF = "# Brief: octo/repo#7\n\n## Goal\nDo the thing the ticket asks for.\n\n## Acceptance criteria\n- [ ] done\n";

function gate(decision) {
  const ctx = mkRun({ ticket: "octo/repo#7" });
  writeArtifact(ctx.runDir, "brief.md", BRIEF);
  writeJson(join(ctx.runDir, "decisions.json"), [{ id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which one?", status: "pending", ...decision }]);
  const cdir = mkdtempSync(join(tmpdir(), "decision-details-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", "D-001", "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: BARE_PATH, TEST_CLONE: cdir, CURATOR_NO_BROWSER: "1" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return { ctx, html: readFileSync(r.json.html, "utf8"), contract: eventsOf(ctx.runDir).filter((e) => e.event === "warning" && String(e.code).startsWith("gate_page_contract")) };
}

test("a gate with option_details and a recommendation raises no contract warning and shows the details", () => {
  const { html, contract } = gate({ options: ["a", "b"], option_details: DETAILS, recommended: { key: "a", reason: "Bounded retries protect the partner from load." } });
  assert.deepEqual(contract, []);
  assert.match(html, /data-plan-recommended="a"/);
  assert.match(html, /<strong>Keep the cap<\/strong>/);
  assert.match(html, /Keeps retries bounded at five per request\./);
  assert.match(html, /Then the plan stage writes the capped steps\./);
  assert.match(html, /data-plan-reason[^>]*>Bounded retries protect the partner from load\./);
});

test("a no_recommendation note is shown on the page", () => {
  const { html, contract } = gate({ options: ["a", "b"], option_details: DETAILS, no_recommendation: "Both are safe, you know the partner contract better." });
  assert.deepEqual(contract, []);
  assert.match(html, /data-plan-no-recommendation="Both are safe, you know the partner contract better\."/);
});

test("option strings stay the answer values: gate collect records the key", () => {
  const { ctx } = gate({ options: ["a", "b"], option_details: DETAILS, recommended: { key: "a", reason: "Bounded retries protect the partner from load." } });
  const f = join(mkdtempSync(join(tmpdir(), "decision-details-fb-")), "fb.json");
  writeJson(f, [{ type: "decision", question: "D-001", answer: "b" }]);
  const r = engine(["gate", "collect", "--run", ctx.runId, "--file", f], { env: { PATH: BARE_PATH } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const d = readJson(join(ctx.runDir, "decisions.json")).find((x) => x.id === "D-001");
  assert.equal(d.status, "answered");
  assert.equal(d.answer, "b");
});

test("drive copies option_details, recommended, why_now and context_excerpt onto the filed decision", () => {
  const t = setup();
  const decision = {
    key: "u1", question: "Capped or infinite?", cause: "judgment", blocks: ["plan"],
    options: [{ key: "capped", ...DETAILS.a }, { key: "infinite", ...DETAILS.b }],
    recommended: { key: "capped", reason: "Bounded retries protect the partner from load." },
    why_now: "The plan stage cannot start yet.", context_excerpt: "The brief caps retries at five.",
  };
  const r = drive(t, { manifestPatch: { status: "needs_human", decisions: [decision] } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const d = readJson(join(t.runDir, "decisions.json")).find((x) => x.question === "Capped or infinite?");
  assert.deepEqual(d.options, ["capped", "infinite"]);
  assert.equal(d.option_details.capped.label, "Keep the cap");
  assert.deepEqual(d.recommended, decision.recommended);
  assert.equal(d.why_now, decision.why_now);
  assert.equal(d.context_excerpt, decision.context_excerpt);
});

test("a decision with string options and no details files exactly as before", () => {
  const t = setup();
  const r = drive(t, { manifestPatch: { status: "needs_human", decisions: [{ key: "u1", question: "Capped or infinite?", cause: "judgment", blocks: ["plan"], options: ["capped", "infinite"] }] } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const d = readJson(join(t.runDir, "decisions.json")).find((x) => x.question === "Capped or infinite?");
  assert.deepEqual(d.options, ["capped", "infinite"]);
  for (const k of ["option_details", "recommended", "no_recommendation", "why_now", "context_excerpt"]) assert.ok(!(k in d), k);
});

test("handoff still names the rejected option string when the decision carries option_details", () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-details-handoff-"));
  const put = (n, v) => writeFileSync(join(dir, n), typeof v === "string" ? v : JSON.stringify(v));
  put("run.json", { run_id: "r", ticket_ref: "PROJ-1" });
  put("brief.md", "x");
  put("stage-status.json", { run_id: "r", stages: { intake: { status: "done" }, research: { status: "done" }, implement: { status: "in_progress" } } });
  put("attempts.jsonl", "");
  put("env.json", { commands: { verify: "node --test engine/" } });
  put("decisions.json", [{ id: "D-001", status: "answered", answer: "capped", options: ["capped", "infinite"], option_details: DETAILS,
    recommended: { key: "capped", reason: "Bounded retries protect the partner." } }]);
  put("decision-rationale.jsonl", JSON.stringify({ decision: "D-001", option: "infinite", why: "unbounded retries hammer the partner" }));
  const st = loadRunState(dir);
  assert.equal(checkSufficiency(st).sufficient, true);
  assert.match(buildNote(st).text, /rejected: infinite — unbounded retries hammer the partner/);
});

test("renderText still lists option strings for a decision with option_details", () => {
  const t = renderText({ ok: true, run_id: "r" }, { gates: [{ id: "D-001", question: "Which one?", options: ["a", "b"], option_details: DETAILS }] });
  assert.match(t, /options: a \| b/);
});
