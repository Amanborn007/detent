// The pre-open gate in `curator open`.
//
// The rules were advisory for a full session and were ignored for a full session, so the check runs
// in the CLI and a failing artifact is not served. These cases never reach the server: the gate sits
// ahead of it, and the state dir below points at a pid that is not a curator server so the command
// stops on an unreachable server rather than spawning one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "cli.mjs");
const FIXTURES = path.join(here, "fixtures");

// pid 1 exists and is not a curator server, so resolveServer() reports unreachable and cmdOpen
// fails without spawning. That keeps these cases off the real ~/.curator state.
function stateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-gate-"));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ pid: 1, port: 59999 }));
  return dir;
}

function run(cmd, fixture, env = {}) {
  const result = spawnSync("node", [CLI, cmd, path.join(FIXTURES, fixture)], {
    encoding: "utf8",
    env: { ...process.env, CURATOR_STATE_DIR: stateDir(), CURATOR_NO_BROWSER: "1", ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const open = (fixture, env) => run("open", fixture, env);
const check = (fixture, env) => run("check", fixture, env);

test("an artifact that fails the check is not opened", () => {
  const { code, out } = open("diagram-owed.html");
  assert.equal(code, 1);
  assert.match(out, /fails the pre-open check, so it was not opened/);
  // The reason travels with the refusal, so the caller does not have to re-run the check by hand.
  assert.match(out, /has no drawing in its own section/);
  // And the way past it is named rather than left to be guessed at.
  assert.match(out, /CURATOR_NO_CHECK=1/);
});

test("every fault class is refused, not just the diagram one", () => {
  for (const fixture of ["remote-fetch.html", "remote-css.html", "rel-tokens.html",
                         "hardcoded-paint.html", "badges-and-mermaid.html"]) {
    const { code, out } = open(fixture);
    assert.equal(code, 1, `${fixture}:\n${out}`);
    assert.match(out, /fails the pre-open check/, fixture);
  }
});

test("CURATOR_NO_CHECK gets past the gate rather than being refused by it", () => {
  const { out } = open("diagram-owed.html", { CURATOR_NO_CHECK: "1" });
  // What happens after the gate depends on whether this shell can reach loopback, so assert only
  // that the gate did not stop it. Asserting the exit code here made this pass sandboxed (loopback
  // blocked, so the command stopped on an unreachable server) and fail unsandboxed (it spawned one).
  assert.doesNotMatch(out, /fails the pre-open check/);
});

// `check` is the gate on its own, so it settles pass and fail with no server in the picture.
test("check passes a clean artifact and fails a bad one, naming the problems", () => {
  const clean = check("passes-clean.html");
  assert.equal(clean.code, 0, clean.out);
  assert.match(clean.out, /"check":"passed"/);

  const bad = check("diagram-owed.html");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /"check":"failed"/);
  assert.match(bad.out, /has no drawing in its own section/);
});

test("only CURATOR_NO_CHECK=1 disables the gate, not any nonempty value", () => {
  // An ambient CURATOR_NO_CHECK=0 or =false must not turn a mandatory gate off.
  for (const value of ["0", "false", ""]) {
    const { code, out } = open("diagram-owed.html", { CURATOR_NO_CHECK: value });
    assert.equal(code, 1, `CURATOR_NO_CHECK=${value}:\n${out}`);
    assert.match(out, /fails the pre-open check/, `CURATOR_NO_CHECK=${value}`);
  }
});

test("check reports a dark-mode warning without failing on it", () => {
  // remote-fetch.html has a dark-mode block, so use a fixture that does not: the warning must be
  // carried to the caller and must not gate.
  const { code, out } = check("no-dark-mode.html");
  assert.equal(code, 0, out);
  assert.match(out, /"check":"passed"/);
  assert.match(out, /prefers-color-scheme/);
});
