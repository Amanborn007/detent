// Unit tests for the handoff module. Zero dependencies (node:test).
//
// The tests that matter here are the NEGATIVE ones: a handoff that reports
// itself complete while silently dropping a dead end is worse than no handoff,
// because the successor trusts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRunState, checkSufficiency, currentStage, rankAttempts, buildNote,
  pendingGates, NOTE_ATTEMPTS, NOTE_TARGET_TOKENS, HANDOFF_SCHEMA,
} from "../handoff.mjs";

function mkrun(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

const RUN = { run_id: "2026-08-13-proj-2516-x", ticket_ref: "PROJ-2516" };
const STATUS_IMPL = {
  run_id: "r",
  stages: { intake: { status: "done" }, research: { status: "done" }, implement: { status: "in_progress" } },
};
const ENV_OK = { commands: { verify: "node --test engine/" } };

// --- loading: absence must stay distinguishable from emptiness --------------

test("a missing artifact loads as null, not as an empty default", () => {
  const st = loadRunState(mkrun({ "run.json": RUN }));
  assert.equal(st.attempts, null, "no attempts.jsonl must not read as []");
  assert.equal(st.decisions, null);
  assert.equal(st.env, null);
  assert.equal(st.hasBrief, false);
});

test("an empty attempts.jsonl is [] — recorded that nothing failed", () => {
  const st = loadRunState(mkrun({ "run.json": RUN, "attempts.jsonl": "\n\n" }));
  assert.deepEqual(st.attempts, []);
});

test("malformed JSONL names the offending line rather than skipping it", () => {
  const dir = mkrun({ "attempts.jsonl": '{"approach":"a"}\nnot-json\n' });
  assert.throws(() => loadRunState(dir), /line 2 of/);
});

test("malformed decisions.json throws instead of silently degrading", () => {
  const dir = mkrun({ "decisions.json": "{oops" });
  assert.throws(() => loadRunState(dir), /invalid JSON/);
});

// --- sufficiency ------------------------------------------------------------

test("a complete implement-stage run is sufficient", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "do the thing",
    "decisions.json": [], "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
  }));
  const r = checkSufficiency(st);
  assert.equal(r.sufficient, true, r.missing.join("; "));
  assert.equal(r.stage, "implement");
});

test("no attempts log at implement is a HARD gap — the successor re-tries dead ends", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "decisions.json": [],
    "stage-status.json": STATUS_IMPL, "env.json": ENV_OK,
  }));
  const r = checkSufficiency(st);
  assert.equal(r.sufficient, false);
  assert.match(r.missing.join(" "), /attempts\.jsonl/);
});

test("no attempts log at intake is only a warning — nothing has been tried yet", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "decisions.json": [],
    "stage-status.json": { stages: { intake: { status: "in_progress" } } },
  }));
  const r = checkSufficiency(st);
  assert.equal(r.sufficient, true, r.missing.join("; "));
  assert.match(r.warnings.join(" "), /attempts\.jsonl absent/);
});

test("env.json without commands.verify is a hard gap — cannot close its own loop", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "decisions.json": [],
    "stage-status.json": STATUS_IMPL, "attempts.jsonl": "",
    "env.json": { commands: { build: "make" } },
  }));
  assert.match(checkSufficiency(st).missing.join(" "), /commands\.verify/);
});

test("a discard with no recorded reason is a HARD gap", () => {
  // TIGHTENED again, and this reverses my earlier position. Knowing that an
  // option lost does not stop a successor relitigating it — only the reason
  // does, and the boundary claims to be lossless. It is a hard gap now because
  // `engine decide-why` makes it satisfiable; before that producer existed,
  // requiring it would have failed every gated run.
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
    "decisions.json": [{ id: "D-001", status: "answered", answer: "reuse lib/retry.ts",
                         options: ["reuse lib/retry.ts", "new implementation"] }],
  }));
  const r = checkSufficiency(st);
  assert.equal(r.sufficient, false);
  assert.match(r.missing.join(" "), /D-001 discarded "new implementation" with no recorded reason/);
  assert.match(r.missing.join(" "), /engine decide-why/, "the gap must name its own producer");
});

test("a reason in the rationale sidecar satisfies the gap", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
    "decisions.json": [{ id: "D-001", status: "answered", answer: "reuse lib/retry.ts",
                         options: ["reuse lib/retry.ts", "new implementation"] }],
    // A sidecar, because CONTRACT.md forbids amending an answered decision.
    "decision-rationale.jsonl": JSON.stringify({
      decision: "D-001", option: "new implementation",
      why: "duplicates three existing callers",
    }),
  }));
  const r = checkSufficiency(st);
  assert.equal(r.sufficient, true, r.missing.join("; "));
  assert.match(buildNote(st).text, /rejected: new implementation — duplicates three existing callers/);
});

test("a truthy-but-empty rejected_options does not count as recorded", () => {
  // Any truthy value used to pass — {}, "", [] — while the note renders only
  // non-empty arrays, so a decision could certify a handoff and then show the
  // successor nothing at all.
  for (const bogus of [{}, "", [], "reasons exist somewhere", [{ option: "x" }], [{ why_not: "y" }]]) {
    const st = loadRunState(mkrun({
      "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
      "attempts.jsonl": "", "env.json": ENV_OK,
      "decisions.json": [{ id: "D-002", status: "answered", answer: "a",
                           options: ["a", "b"], rejected_options: bogus }],
    }));
    assert.equal(checkSufficiency(st).sufficient, false,
      `rejected_options=${JSON.stringify(bogus)} must not certify the handoff`);
  }
});

test("rejected_options must use the documented {option, why_not} shape", () => {
  const mk = (rejected) => loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
    "decisions.json": [{ id: "D-003", status: "answered", answer: "a",
                         options: ["a", "b"], rejected_options: rejected }],
  }));
  const ok = checkSufficiency(mk([{ option: "b", why_not: "slower under load" }]));
  assert.equal(ok.sufficient, true, ok.missing.join("; "));

  // A bare string cannot say WHICH option it refers to, so it is not accepted:
  // validating it meant passing the check and then showing the reader no reason.
  assert.equal(checkSufficiency(mk(["b lost on latency"])).sufficient, false);
});

test("an answered decision with no alternatives has nothing to relitigate", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
    "decisions.json": [{ id: "D-004", status: "answered", answer: "proceed", options: ["proceed"] }],
  }));
  assert.equal(checkSufficiency(st).sufficient, true);
});

test("pending gates are surfaced with the stages they block", () => {
  const gates = pendingGates([
    { id: "D-002", status: "pending", question: "cap retries?", blocks: ["implement"] },
    { id: "D-003", status: "answered", answer: "y" },
    { id: "D-004", status: "pending", question: "which repo?" },
  ]);
  assert.equal(gates.length, 2);
  assert.deepEqual(gates[1].blocks, ["implement"], "absent blocks defaults to implement");
});

// --- attempt ranking --------------------------------------------------------

test("attempts are uncapped in storage but the note projects at most NOTE_ATTEMPTS", () => {
  // long sessions accumulate dozens of failed approaches; a storage cap would
  // discard most of the record.
  const many = Array.from({ length: 63 }, (_, i) => ({ approach: "a" + i, outcome: "failed" }));
  assert.equal(rankAttempts(many).length, NOTE_ATTEMPTS);
  assert.equal(NOTE_ATTEMPTS, 5);
});

test("ranking prefers failed over abandoned over superseded, recent first", () => {
  const r = rankAttempts([
    { approach: "old-failed", outcome: "failed" },
    { approach: "superseded", outcome: "superseded" },
    { approach: "abandoned", outcome: "abandoned" },
    { approach: "new-failed", outcome: "failed" },
  ], 3);
  assert.deepEqual(r.map((x) => x.approach), ["new-failed", "old-failed", "abandoned"]);
});

// --- note -------------------------------------------------------------------

test("the note names every dropped attempt count and points at the full log", () => {
  const attempts = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ approach: "approach-" + i, outcome: "failed" })).join("\n");
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "decisions.json": [],
    "stage-status.json": STATUS_IMPL, "attempts.jsonl": attempts, "env.json": ENV_OK,
  }));
  const note = buildNote(st);
  assert.equal(note.schema, HANDOFF_SCHEMA);
  assert.match(note.text, /15 further attempt\(s\) in `attempts\.jsonl`/);
  assert.match(note.text, /Already tried/);
});

test("an incomplete handoff says so loudly in the note itself", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "stage-status.json": STATUS_IMPL, "decisions.json": [],
  }));
  const note = buildNote(st);
  assert.equal(note.sufficient, false);
  assert.match(note.text, /This handoff is INCOMPLETE/);
  assert.match(note.text, /brief\.md/);
});

test("pending gates appear in the note as do-not-proceed", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
    "decisions.json": [{ id: "D-009", status: "pending", question: "cap retries?", blocks: ["implement"] }],
  }));
  assert.match(buildNote(st).text, /Open gates — do NOT proceed[\s\S]*D-009/);
});

test("rejected options are carried into the note so they are not re-proposed", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
    "decisions.json": [{
      id: "D-001", status: "answered", answer: "reuse lib/retry.ts",
      rejected_options: [{ option: "new implementation", why_not: "duplicates 3 existing callers" }],
    }],
  }));
  const t = buildNote(st).text;
  assert.match(t, /Settled — do not relitigate/);
  assert.match(t, /rejected: new implementation — duplicates 3 existing callers/);
});

test("over_target is reported, never silently truncated", () => {
  const attempts = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ approach: "x".repeat(2000), outcome: "failed" })).join("\n");
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "decisions.json": [],
    "stage-status.json": STATUS_IMPL, "attempts.jsonl": attempts, "env.json": ENV_OK,
  }));
  const note = buildNote(st);
  assert.equal(note.over_target, true);
  assert.ok(note.estimated_tokens > NOTE_TARGET_TOKENS);
  // The content survives: the cap is advisory.
  assert.ok(note.text.includes("x".repeat(2000)));
});

test("currentStage prefers in_progress, else the last done", () => {
  assert.equal(currentStage(STATUS_IMPL), "implement");
  assert.equal(currentStage({ stages: { intake: { status: "done" }, research: { status: "done" } } }), "research");
  assert.equal(currentStage(null), null);
});

// --- Review fix: a clean run, and a synthetic respond-pr run -------------

test("an EMPTY attempts.jsonl means 'nothing failed' and is sufficient", () => {
  // The distinction that makes the check usable at all: null = nobody ever
  // recorded a log; [] = the question was answered and the answer is none.
  // Without this a run that simply went well could never hand off, and the
  // only escape would be to fabricate a failure.
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "decisions.json": [],
    "stage-status.json": STATUS_IMPL, "attempts.jsonl": "", "env.json": ENV_OK,
  }));
  assert.deepEqual(st.attempts, []);
  assert.equal(checkSufficiency(st).sufficient, true);
});

test("a respond-pr run needs no brief — the PR is the task statement", () => {
  const st = loadRunState(mkrun({
    "run.json": { run_id: "r", entry: "respond-pr", synthetic: true, pr_url: "https://github.com/o/r/pull/1" },
    "decisions.json": [], "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
  }));
  const r = checkSufficiency(st);
  assert.equal(r.sufficient, true, r.missing.join("; "));
  assert.match(r.warnings.join(" "), /respond-pr run/);
});

test("a respond-pr run naming NO pr is still a hard gap", () => {
  const st = loadRunState(mkrun({
    "run.json": { run_id: "r", entry: "respond-pr", synthetic: true },
    "decisions.json": [], "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
  }));
  assert.match(checkSufficiency(st).missing.join(" "), /names no PR/);
});

test("a normal run with no brief is still a hard gap", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "decisions.json": [], "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
  }));
  assert.match(checkSufficiency(st).missing.join(" "), /brief\.md/);
});

// --- rejected options: derived where possible, hard gap only when not ------

test("a derived discard still appears in the note, marked as unexplained", () => {
  // It no longer CERTIFIES the handoff, but the successor should still see that
  // the option was considered — --force writes the note regardless.
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
    "decisions.json": [{ id: "D-001", status: "answered", answer: "reuse lib/retry.ts",
                         options: ["reuse lib/retry.ts", "new implementation"] }],
  }));
  const note = buildNote(st);
  assert.equal(note.sufficient, false);
  assert.match(note.text, /rejected \(no reason recorded\): new implementation/);
});

test("an answered decision with NEITHER rejected_options nor options is a hard gap", () => {
  const st = loadRunState(mkrun({
    "run.json": RUN, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": ENV_OK,
    "decisions.json": [{ id: "D-007", status: "answered", answer: "just do it" }],
  }));
  const r = checkSufficiency(st);
  assert.equal(r.sufficient, false);
  assert.match(r.missing.join(" "), /D-007.*already ruled out/);
});
