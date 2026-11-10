import { test } from "node:test";
import assert from "node:assert/strict";
import * as port from "../runtime.mjs";
import * as cc from "../adapters/claude-code.mjs";
import { baseRequest } from "./kit.mjs";

const adapter = cc.default;
const { RuntimeRequestError } = port;
const ALLOW = ["read", "glob", "grep", "write", "edit", "todo"];
const contained = (over = {}) => ({
  prompt: "p", cwd: "/sandbox/work", output: "json", tools: { allow: ALLOW }, mcp: "none",
  settings: { sources: "inherit", file: "/sandbox/settings.json" }, approvals: "deny", model: "claude-sonnet-5-5",
  budget: { usd: 5, turns: 20 }, add_dirs: ["/sandbox/in", "/sandbox/out"], env: { PATH: "/usr/bin" }, containment: "strict", ...over,
});
const badDeclared = (over, field) => assert.throws(() => port.validateDeclared(baseRequest("/tmp/x", over)), (e) => {
  assert.ok(e instanceof RuntimeRequestError, JSON.stringify(over));
  assert.equal(e.field, field, JSON.stringify(over));
  return true;
}, JSON.stringify(over));

test("strict containment refuses the root and unnormalised add_dirs entries, naming containment", () => {
  for (const d of ["/", "/a/../b", "/a/./b", "/a//b", "/a/b/"]) {
    assert.throws(() => adapter.plan(contained({ add_dirs: ["/sandbox/in", d] })),
      (e) => e instanceof RuntimeRequestError && e.field === "containment", d);
  }
});

test("a duplicate add_dirs entry is refused with field add_dirs", () => {
  badDeclared({ add_dirs: ["/a", "/b", "/a"] }, "add_dirs");
});

test("strict containment accepts three normalised dirs and keeps their order in the argv", () => {
  const p = adapter.plan(contained({ add_dirs: ["/a", "/b/c", "/d"] }));
  const flags = p.args.flatMap((v, i) => (v === "--add-dir" ? [p.args[i + 1]] : []));
  assert.deepEqual(flags, ["/a", "/b/c", "/d"]);
  const generic = adapter.plan(baseRequest("/tmp/x", { add_dirs: ["/a", "/b/c", "/d"] }));
  assert.deepEqual(generic.args.slice(-6), ["--add-dir", "/a", "--add-dir", "/b/c", "--add-dir", "/d"]);
});

test("deny_tools refuses control characters, backslashes and surrounding whitespace", () => {
  for (const p of ["git\tpush", "\x7f", "git\\push", " git push", "git push ", "git\rpush", "\x1b[0m"]) {
    badDeclared({ deny_tools: [{ shell_prefix: p }] }, "deny_tools[0].shell_prefix");
  }
});

test("deny_tools still accepts real prefixes", () => {
  assert.doesNotThrow(() => port.validateDeclared(baseRequest("/tmp/x", { deny_tools: [{ shell_prefix: "git push" }, { shell_prefix: "rm -rf" }] })));
});

test("probe check: a nonzero status or a signal is kind exit, even with a valid version on stdout", () => {
  const ok = "2.1.306 (Claude Code)\n";
  const a = adapter.containment.check({ status: 1, signal: null, stdout: ok, stderr: "" });
  assert.equal(a.ok, false);
  assert.equal(a.kind, "exit");
  const b = adapter.containment.check({ status: null, signal: "SIGTERM", stdout: ok, stderr: "" });
  assert.equal(b.ok, false);
  assert.equal(b.kind, "exit");
});

test("probe check: version output must start with the version", () => {
  const check = (stdout) => adapter.containment.check({ status: 0, signal: null, stdout, stderr: "" });
  for (const t of ["claude 2.1.306 (x)", "garbage 2.1.306", "v2.1.306", "2.1.306x"]) {
    const r = check(t);
    assert.equal(r.ok, false, t);
    assert.equal(r.kind, "version", t);
  }
  assert.deepEqual(check("2.1.306 (Claude Code)\n"), { ok: true, version: "2.1.306 (Claude Code)" });
  assert.deepEqual(check("2.1.306"), { ok: true, version: "2.1.306" });
});
