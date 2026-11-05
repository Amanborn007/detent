// drive-implement-checks.test.mjs — the fail-closed checks drive runs on a finished implement child,
// as pure functions: the transcript shape, the one-to-one match between Bash tool uses and shim log lines,
// and the sentinel. Anything wrong here discards the step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const load = () => import("../drive/implement.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");

const bashUse = (id, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
const result = (over = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, num_turns: 2, ...over });
const init = JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"] });
const toolResult = (id) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "x" }] } });
const stream = (...lines) => `${lines.join("\n")}\n`;

const call = (cmd, over = {}) => JSON.stringify({ ev: "call", mode: "shell", ts: 1, ok: true, tokens: {}, names: {}, findings: [], failures: [], inconclusive: [], cmd, cmd_sha256: sha(cmd), ...over });
const wrapped = (cmd) => `export TMPDIR=/t\n${cmd}\n`;
const bash = (...cmds) => cmds.map((command, i) => ({ id: `t${i}`, command }));

// ---------------------------------------------------------------- transcript shape

test("a clean stream-json transcript yields its Bash commands in order and the result", async () => {
  const { parseImplementTranscript } = await load();
  const out = stream(init, bashUse("a", { command: "ls", description: "list", timeout: 5000 }), toolResult("a"), bashUse("b", { command: "pwd" }), toolResult("b"), result());
  const t = parseImplementTranscript(out);
  assert.deepEqual(t.problems, []);
  assert.deepEqual(t.bash.map((b) => b.command), ["ls", "pwd"]);
  assert.equal(t.result.total_cost_usd, 0.01);
});

test("a Bash input with any key beyond command, description and timeout is a problem", async () => {
  const { parseImplementTranscript } = await load();
  for (const extra of [{ sandbox: false }, { cwd: "/" }, { env: {} }]) {
    const t = parseImplementTranscript(stream(init, bashUse("a", { command: "ls", ...extra }), result()));
    assert.ok(t.problems.some((p) => /^bash_key:/.test(p)), JSON.stringify(extra));
  }
});

test("a truthy dangerouslyDisableSandbox is a problem, whatever its type", async () => {
  const { parseImplementTranscript } = await load();
  for (const v of [true, "true", 1, "yes"]) {
    const t = parseImplementTranscript(stream(init, bashUse("a", { command: "ls", dangerouslyDisableSandbox: v }), result()));
    assert.ok(t.problems.some((p) => /^dangerously_disable_sandbox/.test(p)), String(v));
  }
});

test("run_in_background true is a problem", async () => {
  const { parseImplementTranscript } = await load();
  const t = parseImplementTranscript(stream(init, bashUse("a", { command: "sleep 1", run_in_background: true }), result()));
  assert.ok(t.problems.some((p) => /^run_in_background/.test(p)));
});

test("explicit false for those two keys is harmless", async () => {
  const { parseImplementTranscript } = await load();
  const t = parseImplementTranscript(stream(init, bashUse("a", { command: "ls", run_in_background: false, dangerouslyDisableSandbox: false }), result()));
  assert.deepEqual(t.problems, []);
});

test("a command that is not a string is a problem", async () => {
  const { parseImplementTranscript } = await load();
  const t = parseImplementTranscript(stream(init, bashUse("a", { command: ["ls"] }), result()));
  assert.ok(t.problems.some((p) => /^command_not_string/.test(p)));
});

test("a tool use other than Bash is a problem", async () => {
  const { parseImplementTranscript } = await load();
  const other = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Read", input: { file_path: "/etc/passwd" } }] } });
  assert.ok(parseImplementTranscript(stream(init, other, result())).problems.some((p) => /^non_bash_tool/.test(p)));
});

test("a line that is not JSON, a second result and a result that is not last are problems", async () => {
  const { parseImplementTranscript } = await load();
  assert.ok(parseImplementTranscript(stream(init, "not json", result())).problems.some((p) => /^bad_line/.test(p)));
  assert.ok(parseImplementTranscript(stream(init, result(), result())).problems.some((p) => /^multiple_results/.test(p)));
  assert.ok(parseImplementTranscript(stream(init, result(), toolResult("a"))).problems.some((p) => /^result_not_last/.test(p)));
});

test("a transcript with no result line has no result object", async () => {
  const { parseImplementTranscript } = await load();
  assert.equal(parseImplementTranscript(stream(init)).result, null);
});

// ---------------------------------------------------------------- shim log against tool uses

test("log lines that match the Bash tool uses one to one, in order, pass", async () => {
  const { checkShimCalls } = await load();
  const r = checkShimCalls({ callLog: `${call(wrapped("ls"))}\n${call(wrapped("pwd"))}\n`, bash: bash("ls", "pwd") });
  assert.deepEqual(r.problems, []);
  assert.equal(r.calls.length, 2);
});

test("a -c string that wraps a heredoc or multiline command still contains it verbatim", async () => {
  const { checkShimCalls } = await load();
  const cmd = "cat > f <<'EOF'\nhello\nEOF\ngit add f";
  assert.deepEqual(checkShimCalls({ callLog: `${call(wrapped(cmd))}\n`, bash: bash(cmd) }).problems, []);
});

test("an extra log line is a count mismatch", async () => {
  const { checkShimCalls } = await load();
  const r = checkShimCalls({ callLog: `${call(wrapped("ls"))}\n${call(wrapped("rm -rf /"))}\n`, bash: bash("ls") });
  assert.ok(r.problems.some((p) => /^count_mismatch/.test(p)));
});

test("a missing log line is a count mismatch", async () => {
  const { checkShimCalls } = await load();
  const r = checkShimCalls({ callLog: `${call(wrapped("ls"))}\n`, bash: bash("ls", "pwd") });
  assert.ok(r.problems.some((p) => /^count_mismatch/.test(p)));
});

test("reordered log lines are refused", async () => {
  const { checkShimCalls } = await load();
  const r = checkShimCalls({ callLog: `${call(wrapped("pwd"))}\n${call(wrapped("ls"))}\n`, bash: bash("ls", "pwd") });
  assert.ok(r.problems.some((p) => /^command_not_in_cmd/.test(p)));
});

test("a -c string that does not contain the tool use's command is refused", async () => {
  const { checkShimCalls } = await load();
  const r = checkShimCalls({ callLog: `${call("echo something else")}\n`, bash: bash("ls") });
  assert.ok(r.problems.some((p) => /^command_not_in_cmd/.test(p)));
});

test("a log line whose cmd does not match its sha256 is refused", async () => {
  const { checkShimCalls } = await load();
  const r = checkShimCalls({ callLog: `${call(wrapped("ls"), { cmd_sha256: sha("other") })}\n`, bash: bash("ls") });
  assert.ok(r.problems.some((p) => /^hash_mismatch/.test(p)));
});

test("a malformed log line, a non-object line and a line missing cmd are refused", async () => {
  const { checkShimCalls } = await load();
  for (const bad of ["{not json", "[]", "7", JSON.stringify({ ev: "call", mode: "shell", ts: 1, ok: true })]) {
    const r = checkShimCalls({ callLog: `${bad}\n`, bash: bash("ls") });
    assert.ok(r.problems.some((p) => /^(bad_log_line|bad_call_shape)/.test(p)), bad);
  }
});

test("a log line with any mode but shell, or any event but call, is refused", async () => {
  const { checkShimCalls } = await load();
  for (const over of [{ mode: "env" }, { mode: undefined }, { ev: "state" }]) {
    const r = checkShimCalls({ callLog: `${call(wrapped("ls"), over)}\n`, bash: bash("ls") });
    assert.ok(r.problems.some((p) => /^(bad_mode|bad_call_shape)/.test(p)), JSON.stringify(over));
  }
});

test("an empty log with no Bash tool use is clean", async () => {
  const { checkShimCalls } = await load();
  assert.deepEqual(checkShimCalls({ callLog: "", bash: [] }).problems, []);
});

// ---------------------------------------------------------------- sentinel

function sentinel(content) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "impl-sentinel-")));
  const p = join(d, "sentinel");
  writeFileSync(p, content);
  return p;
}

test("an empty sentinel is clean; any byte in it is a problem", async () => {
  const { checkSentinel } = await load();
  assert.deepEqual(checkSentinel(sentinel("")), []);
  assert.ok(checkSentinel(sentinel("x")).some((p) => /^sentinel_written/.test(p)));
});

test("a missing, replaced or non-regular sentinel is a problem", async () => {
  const { checkSentinel } = await load();
  const d = realpathSync(mkdtempSync(join(tmpdir(), "impl-sentinel-")));
  assert.ok(checkSentinel(join(d, "nope")).some((p) => /^sentinel_missing/.test(p)));
  mkdirSync(join(d, "dir"));
  assert.ok(checkSentinel(join(d, "dir")).some((p) => /^sentinel_missing/.test(p)));
  chmodSync(d, 0o700);
});
