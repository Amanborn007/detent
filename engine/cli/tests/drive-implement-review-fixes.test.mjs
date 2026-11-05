// drive-implement-review-fixes.test.mjs — the PR 41 review fixes (H1, H2, M2, L1, L2, S1, S2) for `drive --implement`.
// Same doubles as drive-implement.test.mjs: a stub claude, a fake host box and a trivial probe (drive-implement-deps.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { approvedRun, implDrive, implDriveAsync, git, readJson, writeJson } from "./drive-kit.mjs";
import { engine } from "./helpers.mjs";

const ADD = "echo hello > f.txt && git add f.txt && git commit -q -m add-f";
const ADD2 = "echo more > g.txt && git add g.txt && git commit -q -m add-g";
const BOTH = "echo hello > f.txt && mkdir -p .github && echo x > .github/ci.yml && git add -A && git commit -q -m both";
const happy = (cmd = ADD, over = {}) => ({ impl: { commands: [{ cmd }], ...over } });
const decisionsOf = (t) => readJson(join(t.runDir, "decisions.json"));
const gateOf = (t, g) => decisionsOf(t).find((d) => d.gate === g);
const gatesOf = (t, g) => decisionsOf(t).filter((d) => d.gate === g);
const last = (t) => readJson(join(t.runDir, "drive-last.json"));
const implCalls = (r) => r.calls.filter((c) => c.tools === "Bash");
const recheckCalls = (r) => r.calls.filter((c) => c.tools !== "Bash");
const events = (t) => readFileSync(join(t.runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const branchOid = (t, name) => { const x = git(t.repo, "rev-parse", "--verify", "-q", `refs/heads/${name}`); return x.status === 0 ? x.stdout.trim() : null; };
const detentRef = (t) => `detent/${t.runId}`;

function answer(t, gate, text) {
  const p = join(t.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => (d.gate === gate ? { ...d, status: "answered", answer: text, answered_by: "human", answered_at: new Date().toISOString() } : d)));
}

const NOT_SHIP = "not acceptable - do not ship this change";
const DRIFT = "drift - route back to plan or implement";
const GOOD = "reviewed - matches the plan";

// ---------------------------------------------------------------- H1: gates are raised before the import

test("ship gates are raised before the import (a fault injected after the import leaves both gates pending)", () => {
  const t = approvedRun();
  const r = implDrive(t, { ...happy(BOTH), recheck: { killParent: true } });
  assert.equal(r.code, null, `drive should have been killed during the recheck: ${r.stdout}${r.stderr}`);
  const oid = branchOid(t, detentRef(t));
  assert.match(oid, /^[0-9a-f]{40}$/, "the import happened");
  for (const g of ["sensitive-paths", "recheck-review"]) {
    const d = gateOf(t, g);
    assert.ok(d && d.status === "pending", `${g} is pending`);
    assert.equal(d.head, oid, `${g} records the imported head`);
    assert.ok(Array.isArray(d.blocking_answers) && d.blocking_answers.length === 1, `${g} names its blocking answer`);
  }
  assert.match(gateOf(t, "recheck-review").question, /recheck\.md is missing/);
});

test("an import_conflict withdraws the gates it raised and the next --implement is not blocked by them", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(BOTH), { deps: { advanceRefOnVerify: true } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "import_conflict");
  for (const g of ["sensitive-paths", "recheck-review"]) {
    const d = gateOf(t, g);
    assert.ok(d, `${g} was raised before the import`);
    assert.equal(d.status, "withdrawn");
    assert.equal(d.withdrawn_reason, "import_conflict");
  }
  assert.equal(events(t).filter((e) => e.event === "gate_withdrawn").length, 2);

  const r2 = implDrive(t, happy(ADD));
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.equal(r2.json.stopped, "needs_human");
  assert.equal(implCalls(r2).length, 2, "the second --implement ran its child");
  assert.ok(gatesOf(t, "recheck-review").some((d) => d.status === "pending"));
});

// ---------------------------------------------------------------- H2: a blocking answer keeps ship blocked

test("a 'do not ship' answer keeps ship blocked", () => {
  const t = approvedRun();
  implDrive(t, happy(BOTH));
  answer(t, "sensitive-paths", NOT_SHIP);
  answer(t, "recheck-review", GOOD);
  const before = branchOid(t, detentRef(t));
  const r = implDrive(t, happy(ADD2));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  assert.ok(r.json.decisions.includes(gateOf(t, "sensitive-paths").id));
  assert.equal(implCalls(r).length, 1, "no second implement child");
  assert.equal(branchOid(t, detentRef(t)), before);
});

test("a 'drift' answer refuses the next --implement while detent/<run> still holds the head", () => {
  const t = approvedRun();
  implDrive(t, happy(ADD));
  answer(t, "recheck-review", DRIFT);
  const r = implDrive(t, happy(ADD2));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  assert.equal(implCalls(r).length, 1, "no second implement child");
  assert.match(r.json.next_step, new RegExp(`git branch -D detent/${t.runId}`));
  assert.match(r.json.next_step, /detent decide/);
});

test("after detent/<run> is deleted, --implement withdraws the held gate and builds from sdlc/<run>", () => {
  const t = approvedRun();
  implDrive(t, happy(ADD));
  const old = gateOf(t, "recheck-review");
  answer(t, "recheck-review", DRIFT);
  assert.equal(git(t.repo, "branch", "-D", detentRef(t)).status, 0);
  const r = implDrive(t, happy(ADD));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(implCalls(r).length, 2, "the second --implement ran its child");
  const now = decisionsOf(t).find((d) => d.id === old.id);
  assert.equal(now.status, "withdrawn");
  assert.match(now.withdrawn_reason, /no longer contains/);
  assert.ok(gatesOf(t, "recheck-review").some((d) => d.id !== old.id && d.status === "pending"), "a fresh gate was raised");
});

test("a held decision can be re-answered through gate collect", () => {
  const t = approvedRun();
  implDrive(t, happy(ADD));
  const d = gateOf(t, "recheck-review");
  answer(t, "recheck-review", DRIFT);
  const f = join(realpathSync(mkdtempSync(join(tmpdir(), "review-fixes-"))), "feedback.json");
  writeJson(f, [{ type: "decision", question: d.id, answer: GOOD }]);
  const c = engine(["gate", "collect", "--run", t.runId, "--file", f], { env: { PATH: "/usr/bin:/bin" } });
  assert.equal(c.code, 0, c.stdout + c.stderr);
  assert.deepEqual(c.json.answered, [d.id]);
  assert.deepEqual(c.json.unresolved, []);
  assert.equal(gateOf(t, "recheck-review").answer, GOOD);
});

test("a crash between raise and import leaves a stale gate that the next --implement withdraws", () => {
  const t = approvedRun();
  const orphan = spawnSync("git", ["-C", t.repo, "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "orphan"], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  }).stdout.trim();
  assert.match(orphan, /^[0-9a-f]{40}$/);
  const p = join(t.runDir, "decisions.json");
  writeJson(p, [...readJson(p), {
    id: "D-900", raised_by: "implement", status: "pending", gate: "recheck-review", blocks: ["ship"], cause: "judgment",
    question: "stale", options: [GOOD, DRIFT], head: orphan, blocking_answers: [DRIFT],
  }]);
  const r = implDrive(t, happy(ADD));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(implCalls(r).length, 1, "the implement child ran: the stale gate did not block");
  assert.equal(decisionsOf(t).find((d) => d.id === "D-900").status, "withdrawn");
});

// ---------------------------------------------------------------- M2: a failing verify imports nothing

test("a failing verify stops as verify_failed and detent/<run> is untouched", () => {
  const t = approvedRun({ verify: "test -f nope.txt" });
  const r = implDrive(t, happy(ADD));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "verify_failed");
  assert.match(r.json.next_step, /verify/);
  assert.equal(branchOid(t, detentRef(t)), null);
  assert.equal(last(t).implement.verify.exit_code, 1);
  assert.match(readFileSync(join(t.runDir, "recheck.md"), "utf8"), /verify failed; nothing was imported/);
  assert.equal(recheckCalls(r).length, 0, "no recheck child");
  const made = r.events.filter((e) => e.ev === "box_created");
  for (const b of made) assert.ok(!existsSync(b.dir), `box ${b.dir} removed`);
});

test("a timed-out verify stops as verify_failed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(ADD), { deps: { verifyTimedOut: true } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "verify_failed");
  assert.equal(last(t).implement.verify.timed_out, true);
  assert.equal(branchOid(t, detentRef(t)), null);
});

test("no ship gate is raised on verify_failed", () => {
  const t = approvedRun({ verify: "test -f nope.txt" });
  const r = implDrive(t, happy(BOTH));
  assert.equal(r.json.reason, "verify_failed");
  assert.equal(gatesOf(t, "sensitive-paths").length + gatesOf(t, "recheck-review").length, 0);
});

// ---------------------------------------------------------------- L1: probe, hostbox errors, signals

test("a HostboxError from the verify box stops as hostbox_failed with drive-last written", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(ADD), { deps: { verifyThrows: "hostbox_spawn_failed" } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "hostbox_failed");
  assert.equal(last(t).reason, "hostbox_failed");
  assert.match(JSON.stringify(last(t)), /hostbox_spawn_failed/);
  assert.equal(branchOid(t, detentRef(t)), null);
});

test("a HostboxError from the export box stops as hostbox_failed", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(ADD), { deps: { exportThrows: "sandbox_unavailable:nested" } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "hostbox_failed");
  assert.match(JSON.stringify(last(t)), /sandbox_unavailable:nested/);
});

test("the probe is finished when the step throws after it was made", () => {
  const t = approvedRun();
  const r = implDrive(t, happy(ADD), { deps: { probeBadExps: true } });
  assert.notEqual(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.events.filter((e) => e.ev === "probe_finish").length, 1);
  assert.match(r.json.reason, /engine internal error/, "the original error is not masked");
});

test("SIGTERM during the verify box kills the box process group", async () => {
  const t = approvedRun();
  const pidFile = join(t.d, "sleeper.pid");
  const { child, done } = implDriveAsync(t, happy(ADD), { deps: { realBoxSleep: pidFile } });
  let pid = null;
  try {
    for (let i = 0; i < 300 && pid === null; i++) {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()) pid = Number(readFileSync(pidFile, "utf8").trim());
      else await new Promise((res) => setTimeout(res, 100));
    }
    assert.ok(pid, "the verify box started a sleeper");
    child.kill("SIGTERM");
    const out = await done;
    assert.equal(out.code, 143, out.stdout + out.stderr);
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch (e) { if (e.code !== "ESRCH") throw e; alive = false; }
    }
    assert.equal(alive, false, "the sleeper in the box process group is gone");
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    child.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------- L2: the author name is checked, not just the email

test("GIT_AUTHOR_NAME=Evil with the right email is foreign_author", () => {
  const t = approvedRun();
  const r = implDrive(t, happy("echo hello > f.txt && git add f.txt && GIT_AUTHOR_NAME=Evil git commit -q -m add-f"));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "bundle_rejected");
  assert.match(JSON.stringify(last(t)), /foreign_author/);
  assert.equal(branchOid(t, detentRef(t)), null);
});

test("GIT_COMMITTER_NAME=Evil with the right email is foreign_author", () => {
  const t = approvedRun();
  const r = implDrive(t, happy("echo hello > f.txt && git add f.txt && GIT_COMMITTER_NAME=Evil git commit -q -m add-f"));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "bundle_rejected");
  assert.match(JSON.stringify(last(t)), /foreign_author/);
});

test("a host name ending in '.' and trailing space still imports", () => {
  const t = approvedRun();
  git(t.repo, "config", "user.name", "Impl Tester. ");
  const r = implDrive(t, happy(ADD));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  assert.match(branchOid(t, detentRef(t)), /^[0-9a-f]{40}$/);
});

const ID = { name: "Detent Drive", email: "drive@detent.invalid" };
const gx = (cwd, args, env = {}) => {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: ID.name, GIT_AUTHOR_EMAIL: ID.email, GIT_COMMITTER_NAME: ID.name, GIT_COMMITTER_EMAIL: ID.email, ...env },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

async function verifyWith(env) {
  const { verifyBundle } = await import("../drive/bundle.mjs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-fixes-bundle-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  gx(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  gx(repo, ["add", "-A"]);
  gx(repo, ["commit", "-q", "-m", "base"]);
  const base = gx(repo, ["rev-parse", "HEAD"]);
  gx(repo, ["branch", "sdlc/run1"]);
  const work = join(root, "work");
  gx(root, ["clone", "-q", "--no-local", repo, work]);
  gx(work, ["checkout", "-q", "-b", "sdlc/run1", "origin/sdlc/run1"]);
  writeFileSync(join(work, "b.txt"), "b\n");
  gx(work, ["add", "-A"]);
  gx(work, ["commit", "-q", "-m", "work"], env);
  const file = join(root, "b.bundle");
  gx(work, ["bundle", "create", file, "refs/heads/sdlc/run1", `^${base}`]);
  return verifyBundle({ bundlePath: file, repo, base, branch: "refs/heads/sdlc/run1", identity: ID, scratch: join(root, "scratch"), step: "s1" });
}

test("verifyBundle accepts the expected name and email", async () => {
  const r = await verifyWith({});
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("verifyBundle rejects an author with the right email and another name", async () => {
  const r = await verifyWith({ GIT_AUTHOR_NAME: "Evil" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "foreign_author");
});

test("verifyBundle rejects a committer with the right email and another name", async () => {
  const r = await verifyWith({ GIT_COMMITTER_NAME: "Evil" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "foreign_author");
});

// ---------------------------------------------------------------- S1: an empty recheck is not a recheck

test("a recheck result without text is recorded as did-not-run in recheck.md", () => {
  const t = approvedRun();
  const r = implDrive(t, { ...happy(ADD), recheck: { text: "   \n" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(readFileSync(join(t.runDir, "recheck.md"), "utf8"), /did not run: the recheck child returned no text/);
  assert.equal(last(t).implement.recheck.ran, false);
});

// ---------------------------------------------------------------- S2: run.base_sha is checked before any spend

test("a malformed base_sha fails run_base_invalid before the child runs", () => {
  const t = approvedRun();
  const p = join(t.runDir, "run.json");
  writeJson(p, { ...readJson(p), base_sha: "zzz" });
  const r = implDrive(t, happy(ADD));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "run_base_invalid");
  assert.equal(r.calls.length, 0);
});

test("a base_sha that is not an ancestor of the source ref fails run_base_invalid before the child runs", () => {
  const t = approvedRun();
  const orphan = spawnSync("git", ["-C", t.repo, "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "orphan"], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  }).stdout.trim();
  const p = join(t.runDir, "run.json");
  writeJson(p, { ...readJson(p), base_sha: orphan });
  const r = implDrive(t, happy(ADD));
  assert.equal(r.json.reason, "run_base_invalid", r.stdout + r.stderr);
  assert.equal(r.calls.length, 0);
});

test("an absent base_sha is noted in recheck.md", () => {
  const t = approvedRun();
  const p = join(t.runDir, "run.json");
  const run = readJson(p);
  delete run.base_sha;
  writeJson(p, run);
  const r = implDrive(t, happy(ADD));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(readFileSync(join(t.runDir, "recheck.md"), "utf8"), /run\.json has no base_sha; the diff covers this step only/);
});
