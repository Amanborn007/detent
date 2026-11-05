// drive-implement-identity.test.mjs — the implement child commits as the user: the identity is read on the
// host from the source repo's git config (then the user's global config) and handed to the work clone.
// A missing name or email stops the step with git_identity_missing instead of inventing one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { approvedRun, implDrive, git } from "./drive-kit.mjs";

const ADD = "echo hello > f.txt && git add f.txt && git commit -q -m add-f";
const happy = () => ({ impl: { commands: [{ cmd: ADD }] } });
const showRef = (t) => git(t.repo, "log", "-1", "--format=%an|%ae|%cn|%ce", `refs/heads/detent/${t.runId}`).stdout.trim();
const hasRef = (t) => git(t.repo, "rev-parse", "--verify", "-q", `refs/heads/detent/${t.runId}`).status === 0;
const unset = (t, key) => git(t.repo, "config", "--local", "--unset", key);
const fakeHome = (body) => {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "impl-id-home-")));
  if (body !== undefined) writeFileSync(join(h, ".gitconfig"), body);
  return h;
};

test("commits carry the source repo's configured name and email as author and committer", () => {
  const t = approvedRun();
  const r = implDrive(t, happy());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(showRef(t), "Impl Tester|t@example.invalid|Impl Tester|t@example.invalid");
});

test("the identity comes from the source repo, not from a clone's own config", () => {
  const t = approvedRun();
  git(t.repo, "config", "--local", "user.name", "Someone Else");
  git(t.repo, "config", "--local", "user.email", "else@example.invalid");
  const r = implDrive(t, happy());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(showRef(t), "Someone Else|else@example.invalid|Someone Else|else@example.invalid");
});

test("with nothing in the repo, the user's global ~/.gitconfig supplies the identity", () => {
  const t = approvedRun();
  unset(t, "user.name");
  unset(t, "user.email");
  const home = fakeHome("[user]\n\tname = Global Gina\n\temail = gina@example.invalid\n");
  const r = implDrive(t, happy(), { env: { HOME: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(showRef(t), "Global Gina|gina@example.invalid|Global Gina|gina@example.invalid");
});

test("the repo's config wins over the global one, key by key", () => {
  const t = approvedRun();
  unset(t, "user.email");
  const home = fakeHome("[user]\n\tname = Global Gina\n\temail = gina@example.invalid\n");
  const r = implDrive(t, happy(), { env: { HOME: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(showRef(t), "Impl Tester|gina@example.invalid|Impl Tester|gina@example.invalid");
});

test("no name anywhere stops with git_identity_missing before any child runs", () => {
  const t = approvedRun();
  unset(t, "user.name");
  const r = implDrive(t, happy(), { env: { HOME: fakeHome("") } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "git_identity_missing");
  assert.match(r.json.next_step, /git config user\.name/);
  assert.match(String(r.json.detail ?? r.json.next_step), /user\.name/);
  assert.equal(r.calls.length, 0);
  assert.equal(hasRef(t), false);
});

test("no email anywhere stops with git_identity_missing, and names the email key", () => {
  const t = approvedRun();
  unset(t, "user.email");
  const r = implDrive(t, happy(), { env: { HOME: fakeHome("") } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "git_identity_missing");
  assert.match(r.json.next_step, /git config user\.email/);
  assert.equal(r.calls.length, 0);
});

test("with HOME unset the global config is not guessed at", () => {
  const t = approvedRun();
  unset(t, "user.name");
  unset(t, "user.email");
  const r = implDrive(t, happy());
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "git_identity_missing");
  assert.equal(r.calls.length, 0);
});

test("a name or email that git would not accept in an author line stops as git_identity_invalid", () => {
  for (const [key, value] of [["user.email", "a<b@example.invalid"], ["user.name", "Evil >Name"], ["user.name", "   "]]) {
    const t = approvedRun();
    git(t.repo, "config", "--local", key, value);
    const r = implDrive(t, happy());
    assert.equal(r.code, 1, `${key}=${value}: ${r.stdout}${r.stderr}`);
    assert.equal(r.json.reason, key === "user.name" && !value.trim() ? "git_identity_missing" : "git_identity_invalid", `${key}=${value}`);
    assert.equal(r.calls.length, 0);
  }
});

test("a child commit authored as anyone but the host-read identity is still rejected as foreign_author", () => {
  for (const env of ["GIT_AUTHOR_EMAIL=evil@example.invalid", "GIT_COMMITTER_EMAIL=evil@example.invalid"]) {
    const t = approvedRun();
    const r = implDrive(t, { impl: { commands: [{ cmd: `echo hi > f.txt && git add f.txt && ${env} git commit -q -m sneaky` }] } });
    assert.equal(r.code, 1, `${env}: ${r.stdout}${r.stderr}`);
    assert.equal(r.json.reason, "bundle_rejected", env);
    assert.match(JSON.stringify(r.json), /foreign_author/, env);
    assert.equal(hasRef(t), false);
  }
});

test("the old fixed bot identity is no longer accepted: a commit by it is foreign too", () => {
  const t = approvedRun();
  const cmd = "echo hi > f.txt && git add f.txt && GIT_AUTHOR_EMAIL=implement@detent.invalid GIT_COMMITTER_EMAIL=implement@detent.invalid git commit -q -m old";
  const r = implDrive(t, { impl: { commands: [{ cmd }] } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(JSON.stringify(r.json), /foreign_author/);
});
