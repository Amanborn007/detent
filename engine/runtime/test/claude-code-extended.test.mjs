import { test } from "node:test";
import assert from "node:assert/strict";
import * as cc from "../adapters/claude-code.mjs";
import { buildChildArgs } from "../../cli/drive/profile.mjs";
import { baseRequest } from "./kit.mjs";

const adapter = cc.default;
const CWD = "/tmp/x";
const plan = (over) => adapter.plan(baseRequest(CWD, over));
const GIT = ["commit", "push", "reset", "checkout", "rebase", "merge", "clean", "add", "stash"];
const OWL_ARGV = [
  "-p", "--output-format", "json", "--permission-mode", "dontAsk", "--setting-sources", "project", "--settings", "/abs/owl-settings.json",
  "--disallowedTools",
  "Bash(git commit*)", "Bash(git push*)", "Bash(git reset*)", "Bash(git checkout*)", "Bash(git rebase*)",
  "Bash(git merge*)", "Bash(git clean*)", "Bash(git add*)", "Bash(git stash*)",
];

test("owl request plans exactly the argv owl.sh runs", () => {
  const p = adapter.plan({
    prompt: "p", cwd: "/repo", output: "json", tools: "inherit", mcp: "inherit",
    settings: { sources: "project", file: "/abs/owl-settings.json" }, approvals: "deny",
    deny_tools: GIT.map((g) => ({ shell_prefix: `git ${g}` })),
  });
  assert.deepEqual(p.args, OWL_ARGV);
  assert.equal(p.bin, "claude");
  assert.equal(p.cwd, "/repo");
  assert.equal("env" in p, false);
});

test("generic slots: approvals", () => {
  assert.deepEqual(plan({ approvals: "deny" }).args,
    ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--permission-mode", "dontAsk", "--setting-sources", ""]);
});

test("generic slots: tools.allow maps the portable names and keeps their order", () => {
  assert.deepEqual(plan({ tools: { allow: ["todo", "read", "grep", "glob", "write", "edit"] } }).args,
    ["-p", "--output-format", "json", "--tools", "TodoWrite,Read,Grep,Glob,Write,Edit", "--strict-mcp-config", "--setting-sources", ""]);
});

test("generic slots: add_dirs, one --add-dir each, after --model", () => {
  assert.deepEqual(plan({ model: "m", add_dirs: ["/a", "/b"] }).args,
    ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--model", "m", "--add-dir", "/a", "--add-dir", "/b"]);
});

test("generic slots: budget flags are String() of the numbers, and each is optional", () => {
  const head = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", ""];
  assert.deepEqual(plan({ budget: { usd: 4.9999, turns: 12 } }).args, [...head, "--max-budget-usd", "4.9999", "--max-turns", "12"]);
  assert.deepEqual(plan({ budget: { usd: 0.6 } }).args, [...head, "--max-budget-usd", "0.6"]);
  assert.deepEqual(plan({ budget: { turns: 3 } }).args, [...head, "--max-turns", "3"]);
});

test("generic slots: deny_tools goes last, one Bash(<prefix>*) per entry in order", () => {
  assert.deepEqual(plan({ deny_tools: [{ shell_prefix: "rm -rf" }, { shell_prefix: "git push" }] }).args,
    ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disallowedTools", "Bash(rm -rf*)", "Bash(git push*)"]);
});

test("generic slots: every new field together keeps the documented order", () => {
  const p = plan({
    persist_session: false, approvals: "deny", settings: { sources: "project", file: "/s.json" }, model: "m",
    add_dirs: ["/a"], budget: { usd: 1, turns: 2 }, deny_tools: [{ shell_prefix: "x" }], tools: { allow: ["read"] },
  });
  assert.deepEqual(p.args, [
    "-p", "--output-format", "json", "--tools", "Read", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "dontAsk",
    "--setting-sources", "project", "--settings", "/s.json", "--model", "m", "--add-dir", "/a",
    "--max-budget-usd", "1", "--max-turns", "2", "--disallowedTools", "Bash(x*)",
  ]);
});

test("env: plan.env is a copy of request.env, and absent when the request has none", () => {
  const env = { PATH: "/usr/bin", HOME: "/h" };
  const p = plan({ env });
  assert.deepEqual(p.env, env);
  assert.notEqual(p.env, env);
  assert.equal("env" in plan({}), false);
});

const IN = "/sandbox/inputs";
const OUT = "/sandbox/outbox";
const ALLOW = ["read", "glob", "grep", "write", "edit", "todo"];
const contained = (over = {}) => ({
  prompt: "p", cwd: "/sandbox/work", output: "json", tools: { allow: ALLOW }, mcp: "none",
  settings: { sources: "inherit", file: "/sandbox/settings.json" }, approvals: "deny", model: "claude-sonnet-5-5",
  budget: { usd: 5, turns: 20 }, add_dirs: [IN, OUT], env: { PATH: "/usr/bin", HOME: "/h" }, containment: "strict", ...over,
});
const bare = { settings: { sources: "none", file: "/sandbox/settings.json" }, auth: "api_key" };

test("containment strict equals profile.mjs buildChildArgs for OAuth and --bare, across budgets", () => {
  for (const usd of [0.6, 4.9999, 5]) {
    for (const useBare of [false, true]) {
      const req = contained({ budget: { usd, turns: 7 }, ...(useBare ? bare : {}) });
      const p = adapter.plan(req);
      assert.deepEqual(p.args, buildChildArgs({
        model: "claude-sonnet-5-5", settingsFile: "/sandbox/settings.json", inputs: IN, outbox: OUT, maxBudgetUsd: usd, maxTurns: 7, bare: useBare,
      }), `usd=${usd} bare=${useBare}`);
      assert.equal(p.bin, "claude");
      assert.equal(p.cwd, "/sandbox/work");
      assert.deepEqual(p.env, req.env);
    }
  }
});

test("containment strict refuses a missing or wrong required field, naming containment", () => {
  const without = (k) => { const r = contained(); delete r[k]; return r; };
  const cases = {
    "output text": contained({ output: "text" }),
    "tools none": contained({ tools: "none" }),
    "tools inherit": contained({ tools: "inherit" }),
    "mcp inherit": contained({ mcp: "inherit" }),
    "no approvals": without("approvals"),
    "no settings.file": contained({ settings: { sources: "inherit" } }),
    "no model": without("model"),
    "no budget": without("budget"),
    "no budget.usd": contained({ budget: { turns: 1 } }),
    "no budget.turns": contained({ budget: { usd: 1 } }),
    "no add_dirs": without("add_dirs"),
    "no env": without("env"),
  };
  for (const [label, req] of Object.entries(cases)) {
    assert.throws(() => adapter.plan(req), (e) => e.code === "bad_request" && e.field === "containment", label);
  }
});

test("containment strict refuses deny_tools, persist_session and project sources", () => {
  const cases = {
    deny_tools: contained({ deny_tools: [{ shell_prefix: "git push" }] }),
    persist_session: contained({ persist_session: false }),
    "sources project": contained({ settings: { sources: "project", file: "/sandbox/settings.json" } }),
  };
  for (const [label, req] of Object.entries(cases)) {
    assert.throws(() => adapter.plan(req), (e) => e.code === "bad_request" && e.field === "containment", label);
  }
});

test("containment strict accepts only inherit with no auth, or none with api_key", () => {
  const f = "/sandbox/settings.json";
  const cases = {
    "inherit + api_key": { settings: { sources: "inherit", file: f }, auth: "api_key" },
    "inherit + session": { settings: { sources: "inherit", file: f }, auth: "session" },
    "none, no auth": { settings: { sources: "none", file: f } },
    "none + session": { settings: { sources: "none", file: f }, auth: "session" },
  };
  for (const [label, over] of Object.entries(cases)) {
    assert.throws(() => adapter.plan(contained(over)), (e) => e.code === "bad_request" && e.field === "containment", label);
  }
});

test("the containment probe asks for --version with a 30 s timeout", () => {
  assert.equal(adapter.containment.bin, "claude");
  assert.deepEqual(adapter.containment.probe_args, ["--version"]);
  assert.equal(adapter.containment.timeout_ms, 30000);
});

test("probe check: 2.1.305 fails the version floor, 2.1.306 and later pass", () => {
  const check = (stdout) => adapter.containment.check({ status: 0, signal: null, stdout, stderr: "" });
  assert.deepEqual(check("2.1.305 (Claude Code)\n"), { ok: false, kind: "version", text: "2.1.305 (Claude Code)", min: "2.1.306" });
  assert.deepEqual(check("2.1.306 (Claude Code)\n"), { ok: true, version: "2.1.306 (Claude Code)" });
  assert.deepEqual(check("2.2.0\n"), { ok: true, version: "2.2.0" });
  assert.deepEqual(check("3.0.0"), { ok: true, version: "3.0.0" });
  assert.deepEqual(check("1.9.999"), { ok: false, kind: "version", text: "1.9.999", min: "2.1.306" });
});

test("probe check: garbage and empty output fail as version, a spawn error as spawn", () => {
  assert.deepEqual(adapter.containment.check({ status: 0, stdout: "banana\n", stderr: "" }), { ok: false, kind: "version", text: "banana", min: "2.1.306" });
  assert.deepEqual(adapter.containment.check({ status: 0, stdout: "", stderr: "" }), { ok: false, kind: "version", text: "", min: "2.1.306" });
  const error = Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" });
  assert.deepEqual(adapter.containment.check({ status: null, signal: null, stdout: null, stderr: null, error }), { ok: false, kind: "spawn", message: "spawnSync claude ENOENT" });
});

test("the version helpers live in the adapter", () => {
  assert.equal(cc.MIN_CLAUDE_VERSION, "2.1.306");
  assert.deepEqual(cc.parseVersion("claude 2.1.306 (x)"), [2, 1, 306]);
  assert.equal(cc.parseVersion("none"), null);
  assert.equal(cc.versionAtLeast("2.1.305"), false);
  assert.equal(cc.versionAtLeast("2.1.306"), true);
  assert.equal(cc.versionAtLeast("2.1.4", "2.1.3"), true);
});

const envelope = { type: "result", subtype: "success", is_error: false, result: "answer", total_cost_usd: 0.42, num_turns: 9, permission_denials: [{ tool_name: "Bash" }] };

test("parse: a nonzero exit still fills cost, turns and denials from a valid envelope", () => {
  const r = adapter.parse({ status: 1, signal: null, stdout: JSON.stringify(envelope), stderr: "x" }, baseRequest(CWD));
  assert.equal(r.stop, "error");
  assert.deepEqual(r.error, { kind: "exit", message: "exited with code 1", exit_code: 1 });
  assert.equal(r.text, null);
  assert.equal(r.cost_usd, 0.42);
  assert.equal(r.turns, 9);
  assert.deepEqual(r.denials, [{ tool_name: "Bash" }]);
});

test("parse: a nonzero exit reads the figures from the array envelope too", () => {
  const r = adapter.parse({ status: 1, signal: null, stdout: JSON.stringify([{ type: "system" }, envelope]), stderr: "" }, baseRequest(CWD));
  assert.equal(r.cost_usd, 0.42);
  assert.equal(r.turns, 9);
});

test("parse: a nonzero exit with unparseable stdout keeps null, null and []", () => {
  for (const stdout of ["", "not json", "5", "null"]) {
    const r = adapter.parse({ status: 2, signal: null, stdout, stderr: "" }, baseRequest(CWD));
    assert.equal(r.error.kind, "exit", stdout);
    assert.equal(r.cost_usd, null);
    assert.equal(r.turns, null);
    assert.deepEqual(r.denials, []);
  }
});
