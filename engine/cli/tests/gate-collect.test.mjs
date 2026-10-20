import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ENGINE, engine, mkRun, writeArtifact, readJson, writeJson, throughResearch, eventsOf } from "./helpers.mjs";

const CURATOR_CLI = join(fileURLToPath(import.meta.url), "..", "..", "..", "curator", "cli.mjs");
// No real curator may leak in from the developer's PATH.
const BARE_PATH = "/usr/bin:/bin";

function scratch() { return mkdtempSync(join(tmpdir(), "gate-collect-test-")); }

/** A stub `curator` on its own PATH dir: records calls, `open` prints a url, `drain` prints STUB_DRAIN. */
function mkCuratorStub(dir) {
  const bin = join(dir, "curator");
  writeFileSync(bin, `#!/bin/sh
echo "$@" >> "$CURATOR_LOG"
case "$1" in
  open) echo '{"url":"http://127.0.0.1:9/s/abc","key":"'"$2"'"}' ;;
  drain) printf '%s\\n' "$STUB_DRAIN" ;;
esac
`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A run parked on the plan intent gate, with its gate page rendered by `gate open`. */
function atPlanGate() {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan <b>bold</b>\n");
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2);
  const cdir = scratch();
  mkCuratorStub(cdir);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: `${cdir}:${BARE_PATH}` } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const gate = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.gate === "intent");
  return { ctx, gate, html: r.json.html, cdir };
}

function collect(ctx, items, env = {}) {
  const f = join(scratch(), "feedback.json");
  writeJson(f, items);
  return engine(["gate", "collect", "--run", ctx.runId, "--file", f], { env: { PATH: BARE_PATH, ...env } });
}

test("gate open writes .plans/<run>-<gate>.html with one question block per pending decision", () => {
  const { ctx, gate, html } = atPlanGate();
  assert.equal(html, join(ctx.home, ".plans", `${ctx.runId}-intent.html`));
  const text = readFileSync(html, "utf8");
  assert.ok(text.includes(`data-plan-question="${gate.id}"`));
  assert.ok(text.includes('data-plan-option="approve"') && text.includes('data-plan-option="revise"'));
  assert.ok(text.includes("&lt;b&gt;bold&lt;/b&gt;"), "plan.md is embedded as escaped, preformatted text");
  assert.ok(text.includes("prefers-color-scheme"));
});

test("the generated gate page passes the curator artifact check", () => {
  const { html } = atPlanGate();
  const chk = spawnSync(process.execPath, [CURATOR_CLI, "check", html], { encoding: "utf8" });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
});

test("gate open lists every pending decision that blocks the same stage on one page", () => {
  const { ctx, gate, html } = atPlanGate();
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, [...readJson(p), {
    id: "D-050", raised_by: "plan", blocks: ["implement"], question: "Cap retries at 3?",
    options: ["yes", "no"], status: "pending",
  }]);
  const cdir = scratch();
  mkCuratorStub(cdir);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: `${cdir}:${BARE_PATH}` } });
  const text = readFileSync(r.json.html, "utf8");
  assert.equal(r.json.html, html);
  assert.ok(text.includes(`data-plan-question="${gate.id}"`) && text.includes('data-plan-question="D-050"'));
});

test("gate collect --file answers a pending decision from an exact option", () => {
  const { ctx, gate } = atPlanGate();
  const r = collect(ctx, [{ type: "decision", question: gate.id, answer: "approve", note: "lgtm" }]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.answered, [gate.id]);
  const d = readJson(join(ctx.runDir, "decisions.json")).find((x) => x.id === gate.id);
  assert.equal(d.status, "answered");
  assert.equal(d.answer, "approve");
  assert.equal(d.answered_by, "human");
  assert.equal(d.answered_via, "curator");
  assert.equal(d.note, "lgtm");
  assert.ok(!Number.isNaN(Date.parse(d.answered_at)));
  assert.ok(eventsOf(ctx.runDir).some((e) => e.event === "gate_answered" && e.decision_id === gate.id));
});

test("gate collect rejects a non-option and leaves a null answer pending", () => {
  const { ctx, gate } = atPlanGate();
  let r = collect(ctx, [{ type: "decision", question: gate.id, answer: "banana" }]);
  assert.deepEqual(r.json.answered, []);
  assert.equal(r.json.unresolved.length, 1);
  assert.equal(r.json.unresolved[0].id, gate.id);
  r = collect(ctx, [{ type: "decision", question: gate.id, answer: null, note: "need more info" }]);
  assert.deepEqual(r.json.answered, []);
  assert.equal(r.json.unresolved[0].note, "need more info");
  r = collect(ctx, [{ type: "decision", question: "D-999", answer: "approve" }]);
  assert.deepEqual(r.json.answered, []);
  assert.equal(readJson(join(ctx.runDir, "decisions.json")).find((x) => x.id === gate.id).status, "pending");
});

test("gate collect appends selection and prompt items to review-feedback.jsonl", () => {
  const { ctx } = atPlanGate();
  const r = collect(ctx, [
    { type: "selection", comment: "tighten this", selectedText: "step 2" },
    { type: "prompt", text: "also check retries" },
  ]);
  assert.equal(r.json.feedback, 2);
  const lines = readFileSync(join(ctx.runDir, "review-feedback.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].comment, "tighten this");
});

test("gate collect with no curator returns immediately and does not touch decisions.json", () => {
  const { ctx } = atPlanGate();
  const p = join(ctx.runDir, "decisions.json");
  const before = readFileSync(p, "utf8");
  const r = engine(["gate", "collect", "--run", ctx.runId], { env: { PATH: BARE_PATH } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.collected, 0);
  assert.equal(r.json.note, "nothing yet");
  assert.equal(readFileSync(p, "utf8"), before);
});

test("gate collect drains curator for the run's gate page only and maps the answer", () => {
  const { ctx, gate, html } = atPlanGate();
  const cdir = scratch();
  mkCuratorStub(cdir);
  const log = join(cdir, "log");
  const drain = JSON.stringify({ key: realpathSync(html), status: "feedback",
    prompts: [{ type: "decision", question: gate.id, answer: "revise", note: "split step 3" }] });
  const r = engine(["gate", "collect", "--run", ctx.runId], {
    env: { PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: log, STUB_DRAIN: drain },
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.answered, [gate.id]);
  assert.equal(readJson(join(ctx.runDir, "decisions.json")).find((x) => x.id === gate.id).answer, "revise");
  assert.equal(readFileSync(log, "utf8").trim(), `drain ${realpathSync(html)}`);
});

test("gate collect refuses feedback that curator attributes to a page outside this run", () => {
  const { ctx, gate } = atPlanGate();
  const cdir = scratch();
  mkCuratorStub(cdir);
  const other = join(cdir, "other.html");
  writeFileSync(other, "<html></html>");
  const drain = JSON.stringify({ key: other, status: "feedback",
    prompts: [{ type: "decision", question: gate.id, answer: "approve" }] });
  const r = engine(["gate", "collect", "--run", ctx.runId], {
    env: { PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: join(cdir, "log"), STUB_DRAIN: drain },
  });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(readJson(join(ctx.runDir, "decisions.json")).find((x) => x.id === gate.id).status, "pending");
});

test("gate collect with a curator that has nothing returns nothing yet", () => {
  const { ctx } = atPlanGate();
  const cdir = scratch();
  mkCuratorStub(cdir);
  const r = engine(["gate", "collect", "--run", ctx.runId], {
    env: { PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: join(cdir, "log"), STUB_DRAIN: '{"status":"idle","sessions":0,"drained":0}' },
  });
  assert.equal(r.json.collected, 0);
  assert.equal(r.json.note, "nothing yet");
});

test("a collected approval lets the gated stage end", () => {
  const { ctx, gate } = atPlanGate();
  assert.equal(collect(ctx, [{ type: "decision", question: gate.id, answer: "approve" }]).code, 0);
  const r = engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
});

test("engine output past the pipe buffer is not truncated when the reader is slow", async () => {
  const ctx = mkRun();
  const f = join(scratch(), "feedback.json");
  writeJson(f, Array.from({ length: 800 }, (_, i) => ({ type: "decision", question: `D-9${i}`, answer: "approve" })));
  const child = spawn(process.execPath, [ENGINE, "gate", "collect", "--run", ctx.runId, "--file", f], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DETENT_ROOT: ctx.home },
  });
  const closed = new Promise((r) => child.on("close", r));
  child.stdout.pause();
  await new Promise((r) => setTimeout(r, 500));
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => { out += c; });
  child.stdout.resume();
  await closed;
  assert.ok(out.length > 20000, `payload should exceed the pipe buffer, got ${out.length}`);
  assert.equal(JSON.parse(out.trim()).unresolved.length, 800, "the whole JSON line arrives");
});

function parkAtPlan(ctx) {
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2);
}

test("gate collect for a run never drains a run whose id it is a prefix of", () => {
  const a = mkRun({ slug: "fix-it" });
  parkAtPlan(a);
  const b = mkRun({ repo: a.repo, slug: "fix-it-v2" });
  parkAtPlan(b);
  const cdir = scratch();
  mkCuratorStub(cdir);
  const env = { PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: join(cdir, "log") };
  const ra = engine(["gate", "open", "intent", "--run", a.runId], { env });
  const rb = engine(["gate", "open", "intent", "--run", b.runId], { env });
  assert.ok(a.runId !== b.runId && b.runId.startsWith(`${a.runId}-`), `${a.runId} / ${b.runId}`);
  const gateB = readJson(join(b.runDir, "decisions.json")).find((d) => d.gate === "intent");
  const drain = JSON.stringify({ key: realpathSync(rb.json.html), status: "feedback",
    prompts: [{ type: "decision", question: gateB.id, answer: "approve" }] });
  engine(["gate", "collect", "--run", a.runId], { env: { ...env, STUB_DRAIN: drain } });
  const log = readFileSync(join(cdir, "log"), "utf8");
  assert.ok(!log.includes(realpathSync(rb.json.html)), `drain was handed B's page:\n${log}`);
  assert.ok(log.includes(realpathSync(ra.json.html)));
  const gateA = readJson(join(a.runDir, "decisions.json")).find((d) => d.gate === "intent");
  assert.equal(gateA.status, "pending", "A's decision must stay pending");
});

test("a judgment decision cannot be resolved by the proceed-degraded answer and stays reopenable", () => {
  const DEGRADED = "proceed degraded (accept degraded confidence)";
  const ctx = mkRun();
  parkAtPlan(ctx);
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() } : d));
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeJson(p, [...readJson(p), { id: "D-095", raised_by: "research", blocks: ["implement"], cause: "judgment",
    question: "Retry?", options: ["cap", "forever", DEGRADED], status: "pending" }]);
  let r = collect(ctx, [{ type: "decision", question: "D-095", answer: DEGRADED }]);
  assert.deepEqual(r.json.answered, [], "the degraded string must not resolve a judgment decision");
  assert.equal(r.json.unresolved.length, 1);
  assert.equal(readJson(p).find((d) => d.id === "D-095").status, "pending");

  // a decision already left in the stuck state by an earlier collect
  writeJson(p, readJson(p).map((d) => d.id === "D-095" ? { ...d, status: "answered", answer: DEGRADED } : d));
  const cdir = scratch();
  mkCuratorStub(cdir);
  r = engine(["gate", "open", "D-095", "--run", ctx.runId], { env: { PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: join(cdir, "log") } });
  assert.equal(r.json.mode, "curator", r.stdout);
  assert.ok(readFileSync(r.json.html, "utf8").includes('data-plan-question="D-095"'));
  r = collect(ctx, [{ type: "decision", question: "D-095", answer: "cap" }]);
  assert.deepEqual(r.json.answered, ["D-095"]);
  assert.equal(readJson(p).find((d) => d.id === "D-095").answer, "cap");
});

test("the generated gate page passes the curator artifact check for ordinary options and gate names", () => {
  const cases = [
    { gate: "intent", options: ["run in sequence", "keep as is"] },
    { gate: "intent", options: ["approve", "revise"] },
    { gate: "intent", options: ["accept", "back to plan", "back to implement"] },
    { gate: "approach", options: ["A", "B", "C"] },
    { gate: "compare-options", options: ["option one", "option two", "option three"] },
  ];
  for (const c of cases) {
    const ctx = mkRun();
    parkAtPlan(ctx);
    const p = join(ctx.runDir, "decisions.json");
    const base = readJson(p);
    const next = c.gate === "intent"
      ? base.map((d) => d.gate === "intent" ? { ...d, options: c.options } : d)
      : [...base, { id: "D-060", gate: c.gate, raised_by: "plan", blocks: ["plan"], question: "Which?", options: c.options, status: "pending" }];
    writeJson(p, next);
    const cdir = scratch();
    mkCuratorStub(cdir);
    const r = engine(["gate", "open", c.gate, "--run", ctx.runId], { env: { PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: join(cdir, "log") } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const chk = spawnSync(process.execPath, [CURATOR_CLI, "check", r.json.html], { encoding: "utf8" });
    assert.equal(chk.status, 0, `${JSON.stringify(c)}\n${chk.stdout}${chk.stderr}`);
  }
});

test("gate collect persists every drained item, including ones it cannot apply", () => {
  const { ctx, gate, html } = atPlanGate();
  const cdir = scratch();
  mkCuratorStub(cdir);
  const env = { PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: join(cdir, "log") };
  const drain = JSON.stringify({ key: realpathSync(html), status: "feedback",
    prompts: [{ type: "decision", question: gate.id, answer: null, note: "need more info" }] });
  const r = engine(["gate", "collect", "--run", ctx.runId], { env: { ...env, STUB_DRAIN: drain } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const fb = join(ctx.runDir, "review-feedback.jsonl");
  const lines = readFileSync(fb, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].note, "need more info");
});

test("gate collect persists drained feedback even when the page is refused as foreign", () => {
  const { ctx, gate } = atPlanGate();
  const cdir = scratch();
  mkCuratorStub(cdir);
  const other = join(cdir, "other.html");
  writeFileSync(other, "<html></html>");
  const drain = JSON.stringify({ key: other, status: "feedback",
    prompts: [{ type: "selection", comment: "keep this note", selectedText: "step 2" },
      { type: "decision", question: gate.id, answer: "approve" }] });
  const r = engine(["gate", "collect", "--run", ctx.runId], {
    env: { PATH: `${cdir}:${BARE_PATH}`, CURATOR_LOG: join(cdir, "log"), STUB_DRAIN: drain },
  });
  assert.equal(r.code, 1, r.stdout);
  const lines = readFileSync(join(ctx.runDir, "review-feedback.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].comment, "keep this note");
});
