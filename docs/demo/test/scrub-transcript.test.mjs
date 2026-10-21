// scrub-transcript.sh keeps the conversation, drops machine detail, and refuses a transcript that still carries it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRUB = join(dirname(fileURLToPath(import.meta.url)), "..", "scrub-transcript.sh");
const line = (o) => JSON.stringify(o);

function scrub(events, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scrub-"));
  const input = join(dir, "in.jsonl");
  const output = join(dir, "out.jsonl");
  writeFileSync(input, events.map(line).join("\n") + "\n");
  const r = spawnSync("bash", [SCRUB, input, output, "/detent:status"], {
    encoding: "utf8", env: { ...process.env, SCRUB_PLUGIN_ROOT: "/plugin/checkout", SCRUB_WORK_ROOT: "/work/fixture", DETENT_DENYLIST: join(dir, "deny.txt"), ...extraEnv },
  });
  return { ...r, out: r.status === 0 ? readFileSync(output, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : null };
}
const withDeny = () => { const f = mkdtempSync(join(tmpdir(), "deny-")); writeFileSync(join(f, "d.txt"), "zzz-not-present\n"); return join(f, "d.txt"); };

const events = () => [
  { type: "system", subtype: "hook_response", output: `ran for ${userInfo().username}` },
  { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "node /plugin/checkout/engine/cli/detent.mjs status" } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `Now using node v20.1.0 (npm v10.0.0)\nRepo at /work/fixture/repo, notes in ${homedir()}/notes` }] } },
  { type: "result", subtype: "success", is_error: false, duration_ms: 1000, num_turns: 1, total_cost_usd: 0.01, result: "ok" },
];

test("keeps user, assistant and result events, opens with the prompt, drops system events and thinking", () => {
  const r = scrub(events(), { DETENT_DENYLIST: withDeny() });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.map((e) => e.type), ["user", "assistant", "user", "result"]);
  assert.equal(r.out[0].message.content, "/detent:status");
  assert.deepEqual(r.out[1].message.content.map((b) => b.type), ["tool_use"]);
});

test("rewrites the plugin and work paths and the home directory, and drops shell-init noise", () => {
  const r = scrub(events(), { DETENT_DENYLIST: withDeny() });
  const text = JSON.stringify(r.out);
  assert.ok(text.includes("${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs"));
  assert.ok(text.includes("$DEMO_TMP/repo"));
  assert.ok(!text.includes(homedir()));
  assert.ok(!text.includes("Now using node"));
});

test("a denylisted string fails the scrub and names only file:line", () => {
  const dir = mkdtempSync(join(tmpdir(), "deny-"));
  writeFileSync(join(dir, "d.txt"), "secretco\n");
  const ev = events();
  ev[3].result = "see secretco docs";
  const r = scrub(ev, { DETENT_DENYLIST: join(dir, "d.txt") });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /secretco/);
});
