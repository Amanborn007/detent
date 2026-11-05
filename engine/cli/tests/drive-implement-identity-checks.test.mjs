// drive-implement-identity-checks.test.mjs — corrected twins of three cases in drive-implement-identity.test.mjs.
// The test helper hands the child the real process env, so "HOME unset" needs { HOME: undefined }, and a
// bundle rejection code is recorded in drive-last.json, not in the stdout JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { approvedRun, implDrive, git } from "./drive-kit.mjs";

const hasRef = (t) => git(t.repo, "rev-parse", "--verify", "-q", `refs/heads/detent/${t.runId}`).status === 0;
const lastRaw = (t) => readFileSync(join(t.runDir, "drive-last.json"), "utf8");
const commitWith = (assign) => ({ impl: { commands: [{ cmd: `echo hi > f.txt && git add f.txt && ${assign} git commit -q -m sneaky` }] } });

test("with HOME unset the global config is not guessed at", () => {
  const t = approvedRun();
  git(t.repo, "config", "--local", "--unset", "user.name");
  git(t.repo, "config", "--local", "--unset", "user.email");
  const r = implDrive(t, commitWith(""), { env: { HOME: undefined, XDG_CONFIG_HOME: undefined } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "git_identity_missing");
  assert.equal(r.calls.length, 0);
});

test("a child commit authored or committed as anyone but the host-read identity is rejected as foreign_author", () => {
  for (const assign of ["GIT_AUTHOR_EMAIL=evil@example.invalid", "GIT_COMMITTER_EMAIL=evil@example.invalid"]) {
    const t = approvedRun();
    const r = implDrive(t, commitWith(assign));
    assert.equal(r.code, 1, `${assign}: ${r.stdout}${r.stderr}`);
    assert.equal(r.json.reason, "bundle_rejected", assign);
    assert.match(lastRaw(t), /foreign_author/, assign);
    assert.equal(hasRef(t), false, assign);
  }
});

test("the old fixed bot identity is foreign too", () => {
  const t = approvedRun();
  const r = implDrive(t, commitWith("GIT_AUTHOR_EMAIL=implement@detent.invalid GIT_COMMITTER_EMAIL=implement@detent.invalid"));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "bundle_rejected");
  assert.match(lastRaw(t), /foreign_author/);
});
