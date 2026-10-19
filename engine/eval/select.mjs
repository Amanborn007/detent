/**
 * select — pure suite-selection logic for `engine eval`: map a changed-path
 * set against each suite's `select:` globs (evals/config.yaml) to the set of
 * suites that changed set touches, plus a git-diff helper that produces the
 * changed-path list in the first place. No grading here — see
 * graders/deterministic.mjs and graders/judge.mjs for that.
 *
 * Zero dependencies, Node >= 18.
 */
"use strict";

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Refusal type — thrown for anything the CLI should surface as exit 2.
// Lives here (rather than eval.mjs) so both modules can throw it without a
// circular import; eval.mjs re-exports it for its own public API.
// ---------------------------------------------------------------------------

export class EvalRefusal extends Error {
  constructor(reason, next_step, extra = {}) {
    super(reason);
    this.name = "EvalRefusal";
    this.next_step = next_step;
    this.extra = extra;
  }
}

/** All suite names declared in config, in declaration order. */
export function allSuites(config) {
  return Object.keys((config && config.suites) || {});
}

/**
 * Glob -> RegExp. `**` crosses directory boundaries; a lone `*` stays within
 * one path segment; `?` matches exactly one character within one segment
 * (never a slash). A `**` segment with a slash on each side also matches the
 * ZERO-segment case, e.g. glob "a" + slash + "**" + slash + "b" matches
 * "a/b" as well as "a/x/b", "a/x/y/b", ... — same as a leading "**" + slash
 * and a trailing slash + "**" (both of which already matched zero segments
 * before this fix; only the middle form didn't). Anchors both ends
 * (whole-path match).
 */
export function globToRegExp(glob) {
  // Placeholders built from plain ASCII letters only — none of these
  // characters are touched by the regex-escape pass below, so they survive
  // it untouched and get swapped for their real regex fragments afterward.
  const MID = "MID"; // "/**/ " -> zero-or-more full segments
  const LEAD = "LEAD"; // leading "**/ " -> zero-or-more leading segments
  const TRAIL = "TRAIL"; // trailing "/**" -> zero-or-more trailing segments
  const DBLSTAR = "DBLSTAR"; // any other "**" -> crosses directories

  let g = glob;
  g = g.replace(/\/\*\*\//g, MID);
  g = g.replace(/^\*\*\//, LEAD);
  g = g.replace(/\/\*\*$/, TRAIL);
  g = g.replace(/\*\*/g, DBLSTAR);

  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");

  const withDblStar = escaped.split(DBLSTAR).join(".*");
  const withMid = withDblStar.split(MID).join("(?:/.*)?/");
  const withLead = withMid.split(LEAD).join("(?:.*/)?");
  const withTrail = withLead.split(TRAIL).join("(?:/.*)?");

  return new RegExp(`^${withTrail}$`);
}

/**
 * Pure glob -> suite mapping.
 *   changedPaths: string[] of repo-relative paths (e.g. from git diff).
 *   config: parsed evals/config.yaml shape ({ suites: { <name>: { select: [...] } } }).
 * Returns the suite names (declaration order) whose `select` globs match at
 * least one changed path. An empty changedPaths list always yields an empty
 * selection — never "select everything" by accident.
 */
export function selectSuites({ changedPaths, config }) {
  const selected = [];
  for (const [suite, def] of Object.entries((config && config.suites) || {})) {
    const patterns = ((def && def.select) || []).map(globToRegExp);
    if ((changedPaths || []).some((p) => patterns.some((re) => re.test(p)))) {
      selected.push(suite);
    }
  }
  return selected;
}

function refExists(repoRoot, ref) {
  const check = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repoRoot, encoding: "utf8" });
  return check.status === 0;
}

/** Pick the diff base: prefer origin/main, fall back to main. Refuses (2) if neither exists. */
export function mergeBaseRef(repoRoot) {
  for (const ref of ["origin/main", "main"]) {
    if (refExists(repoRoot, ref)) return ref;
  }
  throw new EvalRefusal(
    "neither origin/main nor main exists — cannot compute changed paths",
    "fetch origin/main, or pass --suite <name> explicitly instead of --changed",
  );
}

/**
 * Changed paths vs the merge-base of `base` (default: resolved via
 * mergeBaseRef — origin/main, falling back to main) and HEAD. Uses
 * `git diff --name-only <base>...HEAD` — the three-dot form already diffs
 * from the merge-base, so no separate `git merge-base` shell-out is needed.
 * `-c core.quotepath=false` makes this robust to a user/CI config with
 * core.quotepath=true (the git default): without it, any non-ASCII path
 * byte gets octal-escaped and wrapped in quotes (e.g. `"caf\303\251.md"`),
 * which would never match a suite's `select:` glob and would silently drop
 * that suite from `--changed`/`--pr`. Throws EvalRefusal if neither ref
 * exists, or if git itself fails.
 */
export function changedPathsFromGit(repoRoot, base) {
  const ref = base || mergeBaseRef(repoRoot);
  const diff = spawnSync(
    "git",
    ["-c", "core.quotepath=false", "diff", "--name-only", `${ref}...HEAD`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (diff.status !== 0) {
    throw new EvalRefusal(
      `git diff failed: ${(diff.stderr || "").trim() || "unknown git error"}`,
      "run inside a git repo with a valid history (fetch-depth 0 in CI)",
    );
  }
  return diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}
