// Unit tests for engine/eval/eval.mjs's resolveEvalRoots() — the root
// resolution that decides WHICH detent checkout an eval run grades.
//
// Why this exists: eval used to take a `--repo` flag that pointed the
// files-under-test at one checkout while the case specs, baseline and ledger
// came from DETENT_ROOT. That silently graded a foreign tree — new
// `must_match` pins went unexercised while the run still reported NEUTRAL —
// and wrote a ledger line carrying the foreign tree's git_sha, advancing this
// clone's burn-in with runs that never graded it.
//
// The remaining, subtler footgun after `--repo` is gone: a DETENT_ROOT env
// var pointing at a DIFFERENT but perfectly valid detent clone. A plain
// `engine eval --changed` from inside checkout A then grades checkout B, end
// to end, coherently and silently. That is what the cwd-mismatch guard below
// is for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveEvalRoots, EvalRefusal } from "../eval.mjs";

function mkDetentLike() {
  const root = mkdtempSync(join(tmpdir(), "eval-roots-"));
  mkdirSync(join(root, "evals"), { recursive: true });
  writeFileSync(join(root, "evals", "config.yaml"), "band: 0.05\nsuites: {}\n");
  return root;
}

test("resolveEvalRoots: DETENT_ROOT is preferred over the fallback", () => {
  const envRoot = mkDetentLike();
  try {
    const r = resolveEvalRoots({
      env: { DETENT_ROOT: envRoot }, cwd: envRoot, fallbackRoot: "/nonexistent-fallback",
    });
    assert.equal(r.detentRoot, envRoot);
    assert.equal(r.source, "env");
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test("resolveEvalRoots: falls back to the CLI's own clone when no env is set", () => {
  const fb = mkDetentLike();
  try {
    const r = resolveEvalRoots({ env: {}, cwd: fb, fallbackRoot: fb });
    assert.equal(r.detentRoot, fb);
    assert.equal(r.source, "fallback");
  } finally {
    rmSync(fb, { recursive: true, force: true });
  }
});

test("resolveEvalRoots: --repo is refused outright (single-root invariant)", () => {
  const fb = mkDetentLike();
  try {
    assert.throws(
      () => resolveEvalRoots({ env: {}, cwd: fb, fallbackRoot: fb, flags: { repo: "/somewhere/else" } }),
      (e) => e instanceof EvalRefusal && /--repo/.test(e.message),
    );
  } finally {
    rmSync(fb, { recursive: true, force: true });
  }
});

test("resolveEvalRoots: a DETENT_ROOT that is not a directory refuses", () => {
  const fb = mkDetentLike();
  try {
    assert.throws(
      () => resolveEvalRoots({ env: { DETENT_ROOT: join(fb, "nope") }, cwd: fb, fallbackRoot: fb }),
      (e) => e instanceof EvalRefusal && /is not a directory/.test(e.message),
    );
  } finally {
    rmSync(fb, { recursive: true, force: true });
  }
});

test("resolveEvalRoots: cwd inside a DIFFERENT detent checkout than the env root refuses", () => {
  const envRoot = mkDetentLike();   // the stale clone the env points at
  const here = mkDetentLike();      // the checkout the human is actually in
  try {
    assert.throws(
      () => resolveEvalRoots({ env: { DETENT_ROOT: envRoot }, cwd: here, fallbackRoot: envRoot }),
      (e) => e instanceof EvalRefusal
        && /DETENT_ROOT/.test(e.message)
        && e.message.includes(envRoot) && e.message.includes(here),
      "the refusal must name BOTH paths — that ambiguity is the whole bug",
    );
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  }
});

test("resolveEvalRoots: a nested cwd inside the env root is fine (not a mismatch)", () => {
  const envRoot = mkDetentLike();
  try {
    const nested = join(envRoot, "skills", "referee");
    mkdirSync(nested, { recursive: true });
    const r = resolveEvalRoots({ env: { DETENT_ROOT: envRoot }, cwd: nested, fallbackRoot: envRoot });
    assert.equal(r.detentRoot, envRoot);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test("resolveEvalRoots: --detent-root is the explicit escape hatch and overrides both env and cwd", () => {
  const envRoot = mkDetentLike();
  const here = mkDetentLike();
  const want = mkDetentLike();
  try {
    const r = resolveEvalRoots({
      env: { DETENT_ROOT: envRoot }, cwd: here, fallbackRoot: envRoot,
      flags: { "detent-root": want },
    });
    assert.equal(r.detentRoot, want, "explicit intent wins and suppresses the mismatch guard");
    assert.equal(r.source, "flag");
  } finally {
    for (const d of [envRoot, here, want]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path identity, not string equality. The first cut of this guard compared
// resolve()d strings, which normalizes `.`/`..` but canonicalizes neither
// symlinks nor filesystem case. Two real consequences on macOS:
//   * `/Users/x/code/...` and `/Users/x/Code/...` are the SAME directory
//     (same inode) but differ as strings — and the installed DETENT_ROOT
//     uses one spelling while process.cwd() reports the other, so eval
//     refused with a next_step naming the same directory twice.
//   * mkdtempSync() hands back `/tmp/...` while process.cwd() in that very
//     directory reports `/private/tmp/...`.
// These tests use the REAL process.cwd() rather than an injected string,
// because injecting the mkdtemp string is precisely what hid the bug.
// ---------------------------------------------------------------------------

test("resolveEvalRoots: the same directory reached by a symlink is NOT a mismatch", () => {
  const real = mkDetentLike();
  const link = join(mkdtempSync(join(tmpdir(), "eval-link-")), "linked");
  try {
    symlinkSync(real, link, "dir");
    const r = resolveEvalRoots({ env: { DETENT_ROOT: link }, cwd: real, fallbackRoot: real });
    assert.equal(existsSync(join(link, "evals", "config.yaml")), true, "sanity: the symlink resolves");
    assert.ok(r.detentRoot, "same inode reached two ways must not refuse");
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(dirname(link), { recursive: true, force: true });
  }
});

test("resolveEvalRoots: real process.cwd() inside the env root is NOT a mismatch", () => {
  const root = mkDetentLike();
  const prev = process.cwd();
  try {
    process.chdir(root);
    // process.cwd() here may be /private/tmp/... while `root` is /tmp/... —
    // the exact aliasing that made the injected-string tests vacuous.
    const r = resolveEvalRoots({ env: { DETENT_ROOT: root }, cwd: process.cwd(), fallbackRoot: root });
    assert.ok(r.detentRoot, "a real cwd in the env root must not refuse");
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveEvalRoots: a git worktree of the SAME repo resolves to the worktree, not a refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-wt-main-"));
  const wt = join(mkdtempSync(join(tmpdir(), "eval-wt-link-")), "wt");
  const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    mkdirSync(join(root, "evals"), { recursive: true });
    writeFileSync(join(root, "evals", "config.yaml"), "band: 0.05\nsuites: {}\n");
    git(["init", "-q", "-b", "main"], root);
    git(["config", "user.email", "t@t"], root); git(["config", "user.name", "t"], root);
    git(["add", "-A"], root); git(["commit", "-qm", "init"], root);
    const add = git(["worktree", "add", "-q", wt], root);
    assert.equal(add.status, 0, "sanity: worktree created: " + add.stderr);

    // The tree being edited is the worktree — and it is the tree whose diff
    // `--changed` reads. Refusing it would break the post-push eval nudge and
    // every engine-created .sdlc worktree.
    const r = resolveEvalRoots({ env: { DETENT_ROOT: root }, cwd: wt, fallbackRoot: root });
    const s = statSync(r.detentRoot), w = statSync(wt);
    assert.ok(s.dev === w.dev && s.ino === w.ino,
      `must resolve to the worktree being edited, got ${r.detentRoot}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(wt), { recursive: true, force: true });
  }
});

test("resolveEvalRoots: a genuinely unrelated detent checkout still refuses", () => {
  const envRoot = mkDetentLike();
  const here = mkDetentLike();
  try {
    assert.throws(
      () => resolveEvalRoots({ env: { DETENT_ROOT: envRoot }, cwd: here, fallbackRoot: envRoot }),
      (e) => e instanceof EvalRefusal && e.message.includes(envRoot) && e.message.includes(here),
      "unrelated checkouts must still refuse — that is the whole point of the guard",
    );
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  }
});

test("resolveEvalRoots: a bare --detent-root with no value refuses instead of silently falling through", () => {
  const root = mkDetentLike();
  try {
    assert.throws(
      () => resolveEvalRoots({ env: { DETENT_ROOT: root }, cwd: root, fallbackRoot: root, flags: { "detent-root": true } }),
      (e) => e instanceof EvalRefusal && /detent-root/.test(e.message),
      "a valueless escape-hatch flag must not quietly re-arm the guard it exists to escape",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
