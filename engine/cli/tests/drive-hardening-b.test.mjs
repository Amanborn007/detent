// Replaces the gate-page case in drive-hardening.test.mjs, whose attempts entry lacks the evidence field the outbox schema requires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setup, drive, throughStage } from "./drive-kit.mjs";

test("the gate page shows proposed commands, gotchas and attempts (well-formed proposal), escaped", () => {
  const t = setup();
  throughStage(t, "research");
  const patch = {
    env: { commands: { verify: "run <b>this</b>" }, gotchas: ["g <i>1</i>"] },
    attempts: [{ approach: "A <u>x</u>", outcome: "failed", evidence: "E <s>y</s>" }],
  };
  const r = drive(t, { manifestPatch: patch });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  const html = readFileSync(r.json.html, "utf8");
  assert.match(html, /Proposed by the child/);
  for (const w of ["run &lt;b&gt;this&lt;/b&gt;", "g &lt;i&gt;1&lt;/i&gt;", "A &lt;u&gt;x&lt;/u&gt;", "E &lt;s&gt;y&lt;/s&gt;"]) assert.ok(html.includes(w), w);
  assert.ok(!html.includes("<b>this</b>"));
});
