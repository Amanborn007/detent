#!/usr/bin/env node
/**
 * engine — the SDLC engine runner CLI (v0).
 *
 * Deterministic driver for the file-based run state defined in
 * engine/stages/CONTRACT.md, per the wiring blueprint (D1: files authoritative,
 * events.jsonl additive; D2: CLI-enforced transitions; D4: thin `next` driver,
 * no orchestrator prompt; D7: curator by contract, never vendored; D8:
 * three-kind socket dispatch).
 *
 * Zero dependencies. Node >= 18.
 *
 * Every command prints exactly one JSON line to stdout with a `next_step`.
 * Exit codes: 0 = ok · 1 = provider/environment failure · 2 = refusal
 * (illegal transition, contract violation, missing prerequisite).
 */
"use strict";

import {
  readFileSync, writeFileSync, appendFileSync, renameSync, existsSync,
  mkdirSync, readdirSync, statSync, accessSync, constants, rmSync, realpathSync, writeSync,
} from "node:fs";
import { join, resolve, dirname, delimiter, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { runBenchmark, checkpointBenchmark, ledgerLine } from "../bench/bench.mjs";
import { runEval, EvalRefusal, resolveEvalRoots } from "../eval/eval.mjs";
import { loadRoutingConfig, tierOf, advisorConsultEvent } from "../routing/routing.mjs";
import { readSteps, renderLiveHtml, isRunComplete, STEP_KINDS, STEP_STATUSES } from "./liveview.mjs";
import { loadRunState, buildNote, checkSufficiency, currentStage } from "../handoff/handoff.mjs";
import { analyzeSpend, trackingLine, compareTracking } from "../spend/spend.mjs";
import { homedir } from "node:os";
import { resolvePackPath, validatePackFile, PackPathError } from "../pack/pack.mjs";

// ---------------------------------------------------------------------------
// Stage model (task-mandated order; plan carries the intent gate; ship bundles
// review/test-evidence/docs/lint as sub-steps of one stage).
// ---------------------------------------------------------------------------

const STAGES = ["intake", "research", "plan", "implement", "recheck", "ship", "respond"];

// Required exit artifacts per stage, per engine/stages/CONTRACT.md. A stage not
// listed has none in v0; its `end` checks gates only. research needs both, or a
// run that skipped the access preflight ends clean.
const STAGE_ARTIFACTS = {
  intake: ["brief.md"],
  research: ["research.md", "access-report.json"],
  plan: ["plan/plan.md"],
  recheck: ["recheck.md"],
};

// The artifact a stage is named by, for prose and for the handoff pointer.
function primaryArtifact(stage) {
  const a = STAGE_ARTIFACTS[stage];
  return a ? a[0] : null;
}

// The answer a human records to accept a degraded state (CONTRACT.md,
// "The proceed-degraded answer").
const PROCEED_DEGRADED_ANSWER = "proceed degraded (accept degraded confidence)";

// Named gates that block a stage's `end`. v0 ships one: the intent gate on plan.
const STAGE_END_GATES = {
  plan: {
    name: "intent",
    playbook: "plan-review",
    blocks: ["implement"],
    question:
      "Intent gate: does plan/plan.md faithfully implement brief.md (goal, acceptance criteria, constraints)? Approve to unlock implement; revise to loop back to plan.",
    options: ["approve", "revise"],
    context: "plan/plan.md",
  },
};

// ---------------------------------------------------------------------------
// Output helpers — one JSON line, always a next_step, structured refusals.
// ---------------------------------------------------------------------------

// There is no `engine` binary on PATH; under the detent wrapper, name the one that exists.
function forCaller(text) {
  return process.env.DETENT_CLI === "1" ? text.replace(/\bengine (?=(?:setup|run|stage|gate|socket|next|dashboard|live|bench|eval|pack|respond|step|advisor|handoff|attempt|env|decide-why|spend|help)\b)/g, "detent ") : text;
}

// process.exit() drops a buffered stream write, and a pipe truncates past ~8KB.
// Write synchronously and retry the EAGAIN a non-blocking pipe returns.
function writeLineSync(line) {
  const buf = Buffer.from(line, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if (e.code !== "EAGAIN") throw e;
    }
  }
}

function out(obj, code = 0) {
  if (typeof obj.next_step === "string") obj.next_step = forCaller(obj.next_step);
  writeLineSync(JSON.stringify(obj) + "\n");
  process.exit(code);
}

function refuse(reason, next_step, extra = {}) {
  out({ ok: false, reason, next_step, ...extra }, 2);
}

function fail(reason, next_step, extra = {}) {
  out({ ok: false, reason, next_step, ...extra }, 1);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// File helpers — atomic JSON writes (temp + rename, per CONTRACT.md).
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, p);
}

function appendEvent(runDir, event) {
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify({ ts: nowIso(), ...event }) + "\n");
}

/**
 * Write a PARTIAL benchmark checkpoint the moment a run parks on a gate. A
 * human/async answer can take hours or days; we must have the benchmark of the
 * work done so far recorded BEFORE that wait — never only at run completion.
 * Best-effort by contract: a benchmark failure must never block or mask the
 * gate itself, so this swallows errors (surfaced only in --verbose) and the
 * caller proceeds to park regardless.
 */
function checkpointOnPark(runDir, reason, gateId) {
  try {
    checkpointBenchmark(runDir, { reason, gateId, detentRoot: detentRoot() });
  } catch (e) {
    if (process.env.ENGINE_VERBOSE) process.stderr.write(`bench checkpoint skipped: ${e.message}\n`);
  }
}

/**
 * Write the successor-facing handoff note at the moment a run parks.
 *
 * Called at the THREE episode boundaries, in increasing order of how obviously
 * the session is finished:
 *
 *   1. `engine stage end` refused because a gate is pending;
 *   2. `engine gate open` rendered a gate for a human;
 *   3. a stage completed successfully.
 *
 * (1) and (2) are parks: the next move belongs to a human, which on this
 * workload means hours or days. A session held open across that wait comes back
 * cold, and a cold turn re-uploads the whole context at many times a warm turn.
 *
 * (3) is different in kind and matters for a different reason: nobody is being
 * waited on, but the next stage reads files rather than conversation, so the
 * finishing session holds nothing it needs. Ending there keeps each episode's
 * context proportional to ONE stage instead of the whole run, which is what
 * stops per-turn cost compounding across a long task.
 *
 * Long-stage checkpoints remain deliberately unwired — mid-stage there is no
 * file-complete point to hand over from, so a boundary there would be exactly
 * the lossy kind this module exists to prevent.
 *
 * Best-effort like the benchmark: writing the note must never block or mask the
 * gate. But an INSUFFICIENT handoff is returned to the caller rather than
 * swallowed — the whole value of the boundary is that losing something is loud.
 * Nothing here refuses: the human is being asked a question either way.
 */
function handoffOnPark(runDir, stage = null) {
  try {
    const state = loadRunState(runDir);
    // The caller knows the stage; inferring it from stage-status.json cannot
    // work at either boundary (a parked stage is `blocked`, and after a stage
    // completes every earlier stage is `done` too).
    const note = buildNote(state, { stage });
    const dir = join(runDir, "handoff");
    mkdirSync(dir, { recursive: true });
    const stageFile = STAGES.includes(note.stage) ? note.stage : "unknown";
    const path = join(dir, `${stageFile}.md`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, note.text);
    renameSync(tmp, path);
    return {
      handoff: path,
      sufficient: note.sufficient,
      missing: note.missing,
      next_session: note.sufficient
        ? "this session can end — the next episode starts fresh from the handoff note"
        : `handoff is INCOMPLETE (${note.missing.join("; ")}) — resuming this session may be safer than starting fresh until these are recorded`,
    };
  } catch (e) {
    // Unconditional: a failed write AT an episode boundary is the moment the
    // boundary silently stops being safe, so it does not hide behind a flag.
    process.stderr.write(`handoff FAILED at episode boundary: ${e.message}\n`);
    // sufficient:null, never false. `false` means "the run is missing
    // artifacts"; this means "we do not know" — a strictly worse state that a
    // caller must not read as a verdict.
    return { handoff: null, sufficient: null, handoff_error: e.message };
  }
}

/**
 * Emit a `gate_answered` event for every decision the CLI now observes as
 * answered but hasn't logged yet. Human-gate wait is measured as
 * gate_answered_ts − gate_opened_ts (see engine/bench), so this is what makes
 * the answer half of a gate visible on the timeline. The event carries the
 * human's `answered_at` timestamp (bench prefers it over the emission ts).
 * Idempotent: it scans events.jsonl and never double-logs a decision.
 * The CLI still NEVER writes an answer — it only records that a human did.
 */
function syncGateAnsweredEvents(runDir, decisions) {
  const answered = decisions.filter((d) => d.status === "answered");
  if (answered.length === 0) return;
  const logged = new Set();
  const p = join(runDir, "events.jsonl");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.event === "gate_answered" && e.decision_id) logged.add(e.decision_id);
      } catch { /* tolerate a partial trailing line */ }
    }
  }
  for (const d of answered) {
    if (logged.has(d.id)) continue;
    appendEvent(runDir, {
      event: "gate_answered",
      gate: d.gate || d.id,
      decision_id: d.id,
      answer: d.answer ?? null,
      answered_at: d.answered_at || null,
    });
  }
}

// ---------------------------------------------------------------------------
// Arg parsing — tiny, positional + --flags.
// ---------------------------------------------------------------------------

/**
 * Flags a command may legitimately repeat. Everything else is single-valued, and
 * repeating it is a refusal rather than a silent overwrite.
 */
const REPEATABLE_FLAGS = new Set(["gotcha"]);

function parseArgs(argv) {
  const duplicates = new Set();
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const hasValue = !(next === undefined || next.startsWith("--"));
      // `--__`-prefixed flags are internal test-only seams (e.g. `engine
      // eval`'s `__judgeExecutor`) — never settable from a real CLI
      // invocation. Consume (and drop) the value too.
      if (key.startsWith("__")) {
        if (hasValue) i++;
        continue;
      }
      if (hasValue) {
        if (key in flags) {
          // A repeat either accumulates (for genuinely repeatable flags) or is a
          // hard error. It must never silently discard the earlier value:
          // `--gotcha a --gotcha b` kept only `b`, so cmdEnv's array handling
          // was unreachable and half the caller's input vanished.
          if (REPEATABLE_FLAGS.has(key)) {
            flags[key] = (Array.isArray(flags[key]) ? flags[key] : [flags[key]]).concat(next);
          } else {
            duplicates.add(key);
          }
        } else {
          flags[key] = REPEATABLE_FLAGS.has(key) ? [next] : next;
        }
        i++;
      } else if (!(key in flags)) {
        flags[key] = true;
      }
    } else positional.push(a);
  }
  return { positional, flags, duplicates: [...duplicates] };
}

// ---------------------------------------------------------------------------
// Run resolution. Run state is CENTRALIZED (.plans/ and .sdlc/
// live in the detent clone, not per work repo — tasks span multiple repos):
// resolved via DETENT_ROOT, falling back to the detent clone this CLI
// lives in (engine/cli/engine.mjs -> ../../..).
// ---------------------------------------------------------------------------

function detentRoot() {
  const envRoot = process.env.DETENT_ROOT;
  if (envRoot) {
    const r = resolve(envRoot);
    if (!existsSync(r) || !statSync(r).isDirectory()) {
      refuse(`DETENT_ROOT is not a directory: ${r}`,
        "point DETENT_ROOT at your detent clone (or unset it to use the clone this CLI lives in)");
    }
    return r;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function sdlcHome() {
  return join(detentRoot(), ".sdlc");
}

function repoOf(flags) {
  const repo = resolve(flags.repo || process.cwd());
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    refuse(`repo path is not a directory: ${repo}`, "pass --repo <path-to-working-repo>");
  }
  return repo;
}

function runRepoOf(runDir) {
  try {
    return readJson(join(runDir, "run.json")).repo || null;
  } catch {
    return null;
  }
}

function findRun(repo, flags) {
  const sdlc = sdlcHome();
  if (flags.run) {
    // --run resolves regardless of --repo: multi-repo tasks share the one home.
    const runDir = join(sdlc, flags.run);
    if (!existsSync(join(runDir, "run.json"))) {
      refuse(`no run '${flags.run}' under ${sdlc}`, "engine run new --ticket <ref> to create one, or check --run");
    }
    return { runId: flags.run, runDir };
  }
  if (!existsSync(sdlc)) {
    refuse(`no .sdlc/ directory in ${sdlc.replace(/\/\.sdlc$/, "")} — no runs exist`, "engine run new --ticket <ref> [--repo <path>]");
  }
  // Without --run, scope to runs whose run.json records this work repo.
  const runs = readdirSync(sdlc)
    .filter((d) => existsSync(join(sdlc, d, "run.json")))
    .filter((d) => runRepoOf(join(sdlc, d)) === repo);
  if (runs.length === 0) {
    refuse(`no runs for repo ${repo} under ${sdlc}`,
      "engine run new --ticket <ref> [--repo <path>], or pass --run <run-id> (runs list: engine dashboard)");
  }
  if (runs.length > 1) {
    refuse(`multiple runs for repo ${repo} under ${sdlc} — ambiguous`, "pass --run <run-id>", { runs: runs.sort() });
  }
  return { runId: runs[0], runDir: join(sdlc, runs[0]) };
}

function loadStatus(runDir) {
  return readJson(join(runDir, "stage-status.json"));
}

function saveStatus(runDir, status) {
  writeJsonAtomic(join(runDir, "stage-status.json"), status);
}

function loadDecisions(runDir) {
  const p = join(runDir, "decisions.json");
  return existsSync(p) ? readJson(p) : [];
}

function saveDecisions(runDir, decisions) {
  writeJsonAtomic(join(runDir, "decisions.json"), decisions);
}

function nextDecisionId(decisions) {
  let max = 0;
  for (const d of decisions) {
    const m = /^D-(\d+)$/.exec(d.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "D-" + String(max + 1).padStart(3, "0");
}

// A judgment decision answered with the degraded-proceed string is not
// resolved: that answer is legal only for an external/infra/capability/data
// unblock, never a bypass of the owner's own call.
function isUnresolvedJudgment(d) {
  return d.cause === "judgment" && typeof d.answer === "string" &&
    d.answer.trim().toLowerCase() === PROCEED_DEGRADED_ANSWER;
}

function pendingBlockers(decisions, stage) {
  return decisions.filter((d) =>
    Array.isArray(d.blocks) && d.blocks.includes(stage) &&
    (d.status === "pending" || isUnresolvedJudgment(d)));
}

// ---------------------------------------------------------------------------
// engine run new
// ---------------------------------------------------------------------------

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function cmdRunNew(flags) {
  if (!flags.ticket || flags.ticket === true) {
    refuse("run new requires --ticket <ref>", "engine run new --ticket <ref> [--repo <path>] [--slug <slug>] [--no-worktree]");
  }
  const repo = repoOf(flags);
  const date = nowIso().slice(0, 10);
  const key = slugify(String(flags.ticket));
  const slug = flags.slug && flags.slug !== true ? slugify(String(flags.slug)) : "";
  const runId = [date, key, slug].filter(Boolean).join("-");
  const runDir = join(sdlcHome(), runId);
  if (existsSync(runDir)) {
    refuse(`run directory already exists: ${runDir} — run-ids are immutable; a re-run is a NEW run`,
      "pass a different --slug to create a new run directory");
  }

  // Default documented flow: the run's working area is a dedicated git
  // worktree of the work repo, at <run-dir>/worktree on branch sdlc/<run-id>.
  // The worktree is disposable (recreate from the branch if pruned); the run
  // STATE stays in the detent home. --no-worktree opts out.
  const wantWorktree = !flags["no-worktree"];
  let worktree = null;
  let branch = null;
  let baseSha = null;
  if (wantWorktree) {
    const head = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" });
    if (head.status !== 0) {
      refuse(
        `cannot create the run worktree: ${repo} is not a git repo with at least one commit (git rev-parse HEAD failed)`,
        "commit something first, or pass --no-worktree to run without a dedicated worktree",
      );
    }
    baseSha = head.stdout.trim();
    branch = `sdlc/${runId}`;
    worktree = join(runDir, "worktree");
    mkdirSync(runDir, { recursive: true });
    const add = spawnSync("git", ["-C", repo, "worktree", "add", "-b", branch, worktree], { encoding: "utf8" });
    if (add.status !== 0) {
      rmSync(runDir, { recursive: true, force: true }); // nothing half-created
      fail(`git worktree add failed for ${worktree} (branch ${branch}): ${(add.stderr || "").trim()}`,
        "fix the git error above and re-run, or pass --no-worktree");
    }
  } else {
    mkdirSync(runDir, { recursive: true });
  }

  writeJsonAtomic(join(runDir, "run.json"), {
    run_id: runId,
    ticket_ref: String(flags.ticket),
    repo,
    worktree,
    branch,
    base_sha: baseSha,
    created_at: nowIso(),
  });
  const stages = {};
  for (const s of STAGES) stages[s] = { status: "pending" };
  writeJsonAtomic(join(runDir, "stage-status.json"), { run_id: runId, stages });
  writeJsonAtomic(join(runDir, "decisions.json"), []);
  // attempts.jsonl is deliberately NOT created here. The handoff distinguishes
  // "nobody recorded anything" (absent) from "nothing was rejected" (present
  // and empty), and only an explicit `engine attempt --none` may produce the
  // second. Creating it at birth would make an agent that simply never recorded
  // its dead ends indistinguishable from one that asserted there were none —
  // certifying a handoff on silence, which is worse than refusing one.
  appendEvent(runDir, { event: "run_created", run_id: runId, ticket_ref: String(flags.ticket) });
  ensureSdlcIgnored(detentRoot());
  out({
    ok: true,
    run_id: runId,
    run_dir: runDir,
    worktree,
    branch,
    stage: "intake",
    status: "pending",
    next_step: `engine stage begin intake --run ${runId} --repo ${repo}`,
  });
}

/** CONTRACT.md: ".sdlc/ MUST be gitignored ... the engine wiring adds the ignore
 *  entry if missing." With centralized run state this applies to the detent
 *  clone (the home), not the work repo. */
function ensureSdlcIgnored(root) {
  if (!existsSync(join(root, ".git"))) return; // not a git repo — nothing to do
  const check = spawnSync("git", ["-C", root, "check-ignore", "-q", ".sdlc"], { encoding: "utf8" });
  if (check.status === 0) return; // already ignored
  const gi = join(root, ".gitignore");
  const existing = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gi, existing + sep + ".sdlc/\n");
}

// ---------------------------------------------------------------------------
// engine respond --pr — synthetic standalone entry into the `respond` stage,
// arming sentinel/respond directly against an already-open PR (no brief, no
// plan, no ticket). Every stage before `respond` is written "skipped" — never
// faked "done" (honesty rule) — and the run carries `synthetic: true` +
// `entry: "respond-pr"` so benchmarks/dashboards never mistake it for a
// full-pipeline run.
// ---------------------------------------------------------------------------

function cmdRespond(flags) {
  if (!flags.pr || flags.pr === true) {
    refuse("respond requires --pr <url|number>",
      "engine respond --pr <url|number> [--repo <path>] [--slug <slug>] [--no-worktree]");
  }
  const repo = repoOf(flags);
  const prArg = String(flags.pr);

  const view = spawnSync("gh",
    ["pr", "view", prArg, "--json", "url,state,isDraft,headRefName,headRefOid,isCrossRepository,number"],
    { cwd: repo, encoding: "utf8" });
  if (view.error) {
    fail(`gh spawn failed: ${view.error.message}`,
      "ensure the gh CLI is installed, authenticated, and on PATH");
  }
  if (view.status !== 0) {
    fail(`gh pr view ${prArg} failed (exit ${view.status}): ${(view.stderr || "").trim()}`,
      "check the --pr value (url or number) and that gh is authenticated for this repo — never proceed on partial data");
  }
  let pr;
  try {
    pr = JSON.parse(view.stdout);
  } catch (e) {
    fail(`gh pr view returned non-JSON stdout: ${e.message}`,
      "this is unexpected gh output — inspect it directly, never proceed on partial data");
  }

  // Arming rule (mirrors the respond stage's own arming rule): open, non-draft
  // only. Fork PRs (isCrossRepository) refuse loudly — the run's worktree
  // pushes back to the work repo's remote and can never land on the fork.
  if (pr.state !== "OPEN") {
    refuse(`PR ${pr.url || prArg} is not open (state: ${pr.state})`,
      "respond --pr only arms on an OPEN PR");
  }
  if (pr.isDraft) {
    refuse(`PR ${pr.url} is a draft`,
      "respond is dormant until the PR is marked ready (gh pr ready <pr>) — re-run engine respond --pr once it is non-draft");
  }
  if (pr.isCrossRepository) {
    refuse(`PR ${pr.url} is a fork PR (cross-repository) — a push from this clone cannot land on the fork's branch`,
      "MVP refuses fork PRs loudly rather than half-working; land the fix from a branch in this repo instead");
  }

  const prUrlMatch = /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(pr.url || "");
  if (!prUrlMatch) {
    fail(`gh pr view returned an unexpected url: ${JSON.stringify(pr.url)}`,
      "this is a bug or unexpected gh output — inspect it directly");
  }
  const [, owner, repoName] = prUrlMatch;
  const prNumber = pr.number ?? Number(prUrlMatch[3]);

  const date = nowIso().slice(0, 10);
  const prSlug = slugify(`${owner}-${repoName}-${prNumber}`);
  const userSlug = flags.slug && flags.slug !== true ? slugify(String(flags.slug)) : "";
  const runId = [date, "respond", prSlug, userSlug].filter(Boolean).join("-");
  const runDir = join(sdlcHome(), runId);
  if (existsSync(runDir)) {
    refuse(`run directory already exists: ${runDir} — run-ids are immutable; a re-run is a NEW run`,
      "pass a different --slug to create a new run directory");
  }

  mkdirSync(runDir, { recursive: true });

  // Worktree: unlike `run new` (a fresh sdlc/<run-id> branch), this checks out
  // the PR's OWN head branch — the run acts directly on the PR under review.
  const wantWorktree = !flags["no-worktree"];
  let worktree = null;
  let branch = null;
  if (wantWorktree) {
    branch = pr.headRefName;
    const fetch = spawnSync("git", ["-C", repo, "fetch", "origin", pr.headRefName], { encoding: "utf8" });
    if (fetch.status !== 0) {
      rmSync(runDir, { recursive: true, force: true }); // nothing half-created
      fail(`git fetch origin ${pr.headRefName} failed in ${repo}: ${(fetch.stderr || "").trim()}`,
        "fix the git error above and re-run, or pass --no-worktree");
    }
    worktree = join(runDir, "worktree");
    const add = spawnSync("git", ["-C", repo, "worktree", "add", worktree, pr.headRefName], { encoding: "utf8" });
    if (add.status !== 0) {
      rmSync(runDir, { recursive: true, force: true }); // nothing half-created
      fail(`git worktree add failed for ${worktree} (branch ${branch}): ${(add.stderr || "").trim()}`,
        "the PR branch may already be checked out elsewhere — fix the git error above, or pass --no-worktree");
    }
  }

  // Every stage before respond is "skipped" — an honest, explicit non-status
  // (never a fake "done": D-02/honesty rule). Only this synthetic entry point
  // ever writes "skipped"; no other writer exists.
  const stages = {};
  const skipReason = "synthetic respond --pr entry";
  for (const s of STAGES) {
    stages[s] = s === "respond"
      ? { status: "pending" }
      : { status: "skipped", reason: skipReason, updated_at: nowIso() };
  }
  const skippedStages = STAGES.filter((s) => s !== "respond");

  writeJsonAtomic(join(runDir, "run.json"), {
    run_id: runId,
    ticket_ref: pr.url,
    repo,
    worktree,
    branch,
    created_at: nowIso(),
    synthetic: true,
    entry: "respond-pr",
    pr: { url: pr.url, number: prNumber, head_ref: pr.headRefName, head_sha: pr.headRefOid },
  });
  writeJsonAtomic(join(runDir, "stage-status.json"), { run_id: runId, stages });
  writeJsonAtomic(join(runDir, "decisions.json"), []);
  appendEvent(runDir, { event: "run_created", run_id: runId, ticket_ref: pr.url });
  appendEvent(runDir, { event: "stages_skipped", stages: skippedStages, reason: skipReason });
  ensureSdlcIgnored(detentRoot());

  out({
    ok: true,
    run_id: runId,
    run_dir: runDir,
    worktree,
    branch,
    synthetic: true,
    pr: { url: pr.url, number: prNumber, head_ref: pr.headRefName, head_sha: pr.headRefOid },
    stage: "respond",
    status: "pending",
    next_step: `engine stage begin respond --run ${runId} --repo ${repo} — then follow engine/stages/respond/SKILL.md (standalone mode)`,
  });
}

// ---------------------------------------------------------------------------
// engine stage begin/end
// ---------------------------------------------------------------------------

function requireKnownStage(stage) {
  if (!STAGES.includes(stage)) {
    refuse(`unknown stage '${stage}'`, `stages in order: ${STAGES.join(" -> ")}`);
  }
}

function cmdStageBegin(stage, flags) {
  requireKnownStage(stage);
  const repo = repoOf(flags);
  const { runId, runDir } = findRun(repo, flags);
  const status = loadStatus(runDir);
  const entry = status.stages[stage];
  if (entry.status === "done") {
    refuse(`stage '${stage}' is already done — re-running a stage is a NEW run (run-ids are immutable)`,
      "engine run new --ticket <ref> to start a fresh run");
  }
  // D2: begin refuses when any prior stage is not done. A "skipped" stage
  // (synthetic entry points, e.g. `engine respond --pr`) satisfies this too —
  // it is an honest, explicit non-status, never a fake "done".
  const priors = STAGES.slice(0, STAGES.indexOf(stage));
  const notDone = priors.filter((s) => !["done", "skipped"].includes(status.stages[s].status));
  if (notDone.length > 0) {
    refuse(
      `illegal transition: cannot begin '${stage}' — prior stage(s) not done: ${notDone.join(", ")}`,
      `engine next --run ${runId} to see the current stage`,
      { blocking_stages: notDone },
    );
  }
  // Gate rule (CONTRACT.md): never begin a stage a pending decision blocks.
  const decisions = loadDecisions(runDir);
  syncGateAnsweredEvents(runDir, decisions);
  const blockers = pendingBlockers(decisions, stage);
  if (blockers.length > 0) {
    const ids = blockers.map((d) => d.id);
    status.stages[stage] = { status: "blocked", blocked_on: ids, updated_at: nowIso() };
    saveStatus(runDir, status);
    appendEvent(runDir, { event: "stage_blocked", stage, blocked_on: ids });
    refuse(
      `gate rule: pending decision(s) block '${stage}': ${ids.join(", ")} — the engine never skips a pending gate`,
      `engine gate open ${blockers[0].gate || ids[0]} --run ${runId} --repo ${repo}`,
      { blocked_on: ids },
    );
  }
  status.stages[stage] = { status: "in_progress", updated_at: nowIso() };
  saveStatus(runDir, status);
  appendEvent(runDir, { event: "stage_begin", stage });
  const artifacts = STAGE_ARTIFACTS[stage];
  out({
    ok: true,
    run_id: runId,
    stage,
    status: "in_progress",
    next_step: artifacts
      ? `produce ${artifacts.join(" and ")} in ${runDir}, then: engine stage end ${stage} --run ${runId} --repo ${repo}`
      : `do the ${stage} work, then: engine stage end ${stage} --run ${runId} --repo ${repo}`,
  });
}

/**
 * TDD ordering gate for `stage end recheck`. Implement RECORDS a tdd block
 * (test_name, red_sha, green_sha) or a tdd.exempt reason; only recheck judges
 * it, per the settled implement-records/recheck-decides split.
 *
 * This proves ORDER ONLY: that red_sha is an ancestor of green_sha in the git
 * DAG. It does NOT prove the test was ever observed failing, that claim rests
 * entirely on implement's own attestation and cannot be checked from git
 * objects alone.
 */
function checkTddOrdering(repo, status) {
  const implEntry = status.stages.implement;
  if (!implEntry) return { ok: true };
  // A run with no implement stage (synthetic `respond --pr` entry) has
  // nothing to check, see handoff.mjs's syntheticFromPr handling.
  if (implEntry.status === "skipped") {
    return { ok: true, exempt: "implement stage skipped (synthetic run)" };
  }
  const tdd = implEntry.tdd;
  if (!tdd || typeof tdd !== "object") {
    return { ok: false, reason: "implement recorded no 'tdd' block, recheck cannot verify red-before-green ordering" };
  }
  if (tdd.exempt !== undefined) {
    if (typeof tdd.exempt !== "string" || !tdd.exempt.trim()) {
      return { ok: false, reason: "implement's tdd.exempt is present but empty, a reason is required" };
    }
    return { ok: true, exempt: tdd.exempt };
  }
  for (const k of ["test_name", "red_sha", "green_sha"]) {
    if (!tdd[k] || typeof tdd[k] !== "string" || !tdd[k].trim()) {
      return { ok: false, reason: `implement's tdd block is missing '${k}'` };
    }
  }
  const { red_sha, green_sha } = tdd;
  if (red_sha === green_sha) {
    return { ok: false, reason: `tdd.red_sha equals tdd.green_sha (${red_sha}), that proves nothing about ordering` };
  }
  for (const [label, sha] of [["red_sha", red_sha], ["green_sha", green_sha]]) {
    const r = spawnSync("git", ["-C", repo, "cat-file", "-e", sha], { encoding: "utf8" });
    if (r.status !== 0) {
      return { ok: false, reason: `tdd.${label} (${sha}) does not resolve to a git object in ${repo}` };
    }
  }
  const anc = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", red_sha, green_sha], { encoding: "utf8" });
  if (anc.status !== 0) {
    return { ok: false, reason: `tdd.red_sha (${red_sha}) is not an ancestor of tdd.green_sha (${green_sha}), red must precede green` };
  }
  return { ok: true };
}

function cmdStageEnd(stage, flags) {
  requireKnownStage(stage);
  const repo = repoOf(flags);
  const { runId, runDir } = findRun(repo, flags);
  const status = loadStatus(runDir);
  const entry = status.stages[stage];
  if (entry.status !== "in_progress" && entry.status !== "blocked") {
    refuse(`cannot end '${stage}': it is '${entry.status}', not in_progress (was it ever begun?)`,
      `engine stage begin ${stage} --run ${runId} --repo ${repo}`);
  }
  const endBlockers = pendingBlockers(loadDecisions(runDir), stage);
  if (endBlockers.length > 0) {
    const ids = endBlockers.map((d) => d.id);
    refuse(`cannot end '${stage}': pending decision(s) block it: ${ids.join(", ")}`,
      `engine gate open ${endBlockers[0].gate || ids[0]} --run ${runId} --repo ${repo}`,
      { blocked_on: ids });
  }
  // Required artifacts per CONTRACT.md. Every missing one is named, so a single
  // re-run fixes them all rather than one refusal per file.
  const missing = (STAGE_ARTIFACTS[stage] || []).filter((a) => !existsSync(join(runDir, a)));
  if (missing.length > 0) {
    refuse(`cannot end '${stage}': required artifact missing: ${missing.join(", ")} (expected in ${runDir})`,
      `write ${missing.join(" and ")}, then re-run: engine stage end ${stage} --run ${runId} --repo ${repo}`,
      { missing_artifact: missing });
  }
  // implement RECORDS its tdd block here (test_name, red_sha, green_sha, or
  // an exempt reason); it never judges its own ordering. Optional at the CLI
  // level, omitting it just means recheck will refuse until it is recorded.
  let tddRecord = null;
  if (stage === "implement") {
    const exempt = flags["tdd-exempt"] && flags["tdd-exempt"] !== true ? String(flags["tdd-exempt"]) : null;
    const testName = flags["tdd-test"] && flags["tdd-test"] !== true ? String(flags["tdd-test"]) : null;
    const redSha = flags["tdd-red"] && flags["tdd-red"] !== true ? String(flags["tdd-red"]) : null;
    const greenSha = flags["tdd-green"] && flags["tdd-green"] !== true ? String(flags["tdd-green"]) : null;
    if (exempt && (testName || redSha || greenSha)) {
      refuse("--tdd-exempt cannot be combined with --tdd-test/--tdd-red/--tdd-green",
        "record either a real tdd block or an exemption, never both");
    }
    if (exempt) {
      tddRecord = { exempt };
    } else if (testName || redSha || greenSha) {
      if (!(testName && redSha && greenSha)) {
        refuse("recording a tdd block requires --tdd-test, --tdd-red, and --tdd-green together",
          'engine stage end implement --tdd-test "<name>" --tdd-red <sha> --tdd-green <sha>  (or --tdd-exempt "<reason>" for a CONDITIONAL-skip run)');
      }
      tddRecord = { test_name: testName, red_sha: redSha, green_sha: greenSha };
    }
  }
  // recheck ASSERTS the ordering implement recorded, from git objects, never
  // from prose. Structural, so it refuses loudly rather than filing a gate.
  if (stage === "recheck") {
    const tddCheck = checkTddOrdering(repo, status);
    if (!tddCheck.ok) {
      refuse(`cannot end 'recheck': TDD ordering check failed, ${tddCheck.reason}`,
        "fix the tdd block implement recorded in stage-status.json (or record a genuine --tdd-exempt at implement), then re-run: engine stage end recheck",
        { tdd_check: tddCheck });
    }
  }
  // Named end-gate (v0: the intent gate on plan). Raised lazily, answered only
  // by a human (curator or hand-edit) — the CLI never writes an answer.
  const gateDef = STAGE_END_GATES[stage];
  if (gateDef) {
    let decisions = loadDecisions(runDir);
    syncGateAnsweredEvents(runDir, decisions);
    let gate = decisions.find((d) => d.gate === gateDef.name);
    if (!gate) {
      gate = {
        id: nextDecisionId(decisions),
        gate: gateDef.name,
        raised_by: "engine",
        blocks: gateDef.blocks,
        question: gateDef.question,
        options: gateDef.options,
        context: gateDef.context,
        status: "pending",
      };
      decisions.push(gate);
      saveDecisions(runDir, decisions);
      appendEvent(runDir, { event: "gate_raised", stage, gate: gateDef.name, decision_id: gate.id });
    }
    if (gate.status === "pending") {
      status.stages[stage] = { status: "blocked", blocked_on: [gate.id], updated_at: nowIso() };
      saveStatus(runDir, status);
      // The run is about to block on a human answer — checkpoint the benchmark
      // of the work done up to here before that (possibly long) wait begins.
      checkpointOnPark(runDir, `gate-pending:${gateDef.name}`, gate.id);
      // ...and write the handoff, so this session can END rather than idle
      // across the wait and come back to a cold cache. See handoffOnPark().
      const ho = handoffOnPark(runDir, stage);
      refuse(
        `cannot end '${stage}': the ${gateDef.name} gate (${gate.id}) is pending — a human must answer it`,
        `engine gate open ${gateDef.name} --run ${runId} --repo ${repo}`,
        { gate: gateDef.name, decision_id: gate.id, ...ho },
      );
    }
    if (gate.status === "answered" && gate.answer === "revise") {
      refuse(
        `the ${gateDef.name} gate verdict is 'revise' — loop back, update ${primaryArtifact(stage) || "the stage artifact"}, and re-raise the gate (new decision block)`,
        `revise per the gate annotations, then engine stage end ${stage} again after a fresh gate approval`,
        { gate: gateDef.name, decision_id: gate.id, verdict: "revise" },
      );
    }
  }
  const done = { status: "done", updated_at: nowIso() };
  if (primaryArtifact(stage)) done.artifact = primaryArtifact(stage);
  if (tddRecord) done.tdd = tddRecord;
  status.stages[stage] = done;
  saveStatus(runDir, status);
  appendEvent(runDir, { event: "stage_end", stage });
  const idx = STAGES.indexOf(stage);
  const next = STAGES[idx + 1];
  // A completed stage is the SECOND episode boundary (the first being a gate
  // park). CONTRACT.md already treats stages as independent — they read files,
  // not conversation — so the session that finished this stage carries nothing
  // the next one needs. Ending here keeps each episode's context proportional
  // to one stage instead of the whole run, which is what makes per-turn cost
  // stop compounding. Advisory, never blocking: `next_step` still names the
  // next command, and an insufficient handoff downgrades the advice rather
  // than withholding it.
  const ho = handoffOnPark(runDir, stage);
  out({
    ok: true,
    run_id: runId,
    stage,
    status: "done",
    ...ho,
    episode_boundary: ho.sufficient === true
      ? "this stage is a clean episode boundary — end the session and start the next stage fresh"
      : ho.sufficient === null
        ? "handoff could NOT be written — do not treat this as a safe boundary; stay in this session"
        : "handoff INCOMPLETE — carrying on in this session is safer until the gaps above are recorded",
    next_step: next
      ? `engine stage begin ${next} --run ${runId} --repo ${repo}`
      : "run complete — all stages done",
  });
}

// ---------------------------------------------------------------------------
// engine step <label> — an explicit, ADDITIVE-ONLY checklist entry for the
// live-view MVP (D1: files authoritative, events.jsonl additive). This is NOT
// automatic tool/thinking capture (there is no transcript telemetry today —
// see engine/cli/README.md's "Live-view MVP" section); it is a verb a
// stage/skill can call itself to say "here is a step I am doing" so the
// dashboard can render a checklist. Never touches stage-status.json and
// never interacts with a gate.
// ---------------------------------------------------------------------------

function cmdStep(label, flags) {
  if (!label || typeof label !== "string" || !label.trim()) {
    refuse("step requires a label",
      "engine step <label> --run <id> [--repo <path>] [--kind tool|thinking|plan|answer] [--status todo|doing|done]");
  }
  if (!flags.run || flags.run === true) {
    refuse("step requires --run <id>",
      "engine step <label> --run <id> [--repo <path>] [--kind tool|thinking|plan|answer] [--status todo|doing|done]");
  }
  const repo = repoOf(flags);
  const { runId, runDir } = findRun(repo, flags);
  const kind = flags.kind && flags.kind !== true ? String(flags.kind) : "tool";
  if (!STEP_KINDS.includes(kind)) {
    refuse(`unknown --kind '${kind}'`, `--kind must be one of ${STEP_KINDS.join("|")}`);
  }
  const stepStatus = flags.status && flags.status !== true ? String(flags.status) : "todo";
  if (!STEP_STATUSES.includes(stepStatus)) {
    refuse(`unknown --status '${stepStatus}'`, `--status must be one of ${STEP_STATUSES.join("|")}`);
  }
  const status = loadStatus(runDir);
  const stage = STAGES.find((s) => status.stages[s] && !["done", "skipped"].includes(status.stages[s].status)) || null;
  // No `id` field: `id` is reserved for external_request/response correlation
  // in bench.mjs (see engine/bench/bench.mjs) — a step event must never collide.
  appendEvent(runDir, { event: "step", stage, kind, label: String(label), status: stepStatus });
  out({
    ok: true,
    run_id: runId,
    stage,
    kind,
    label: String(label),
    status: stepStatus,
    next_step: "engine dashboard to view the run's step checklist",
  });
}

// ---------------------------------------------------------------------------
// engine gate open <gate-id>
// Renders a pending gate. Curator is integrated BY CONTRACT (blueprint D7):
// if a `curator` executable is on PATH we write/refresh the gate artifact and
// print the curator open+poll commands; otherwise we print a terminal
// fallback. This CLI never answers a decision — only a human does.
// ---------------------------------------------------------------------------

function curatorOnPath() {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "curator");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

function cmdGateOpen(gateId, flags) {
  if (!gateId) refuse("gate open requires a gate id", "engine gate open <gate-name-or-decision-id>");
  const repo = repoOf(flags);
  const { runId, runDir } = findRun(repo, flags);
  const decisions = loadDecisions(runDir);
  syncGateAnsweredEvents(runDir, decisions);
  const decision = decisions.find((d) => d.gate === gateId || d.id === gateId);
  if (!decision) {
    refuse(`no decision or gate '${gateId}' in ${join(runDir, "decisions.json")}`,
      "list pending gates with: engine next, or check decisions.json",
      { known: decisions.map((d) => d.gate || d.id) });
  }
  // Which stage does this gate belong to? Named gates map via STAGE_END_GATES;
  // plain decisions render against the first stage they block.
  let stage = null;
  let playbook = "decision";
  for (const [s, def] of Object.entries(STAGE_END_GATES)) {
    if (decision.gate === def.name) { stage = s; playbook = def.playbook; }
  }
  // For a plain decision the gate artifact renders against the stage the
  // decision blocks — that is what the human is being asked about. But that is
  // NOT the stage parking on the gate, so it must not decide the handoff
  // boundary; see boundaryStage below. My previous fix added a fallback further
  // down that never fired, because `stage` was already set here.
  if (!stage) stage = (decision.blocks && decision.blocks[0]) || null;
  const artifactPath = stage && primaryArtifact(stage) ? join(runDir, primaryArtifact(stage)) : null;
  const contextPaths = ["brief.md", "research.md"]
    .map((f) => join(runDir, f))
    .filter((p) => existsSync(p) && p !== artifactPath);

  // Write/refresh the gate artifact (the request half of the gate contract).
  const gatesDir = join(runDir, "gates");
  mkdirSync(gatesDir, { recursive: true });
  const gateArtifact = join(gatesDir, `${decision.gate || decision.id}.json`);
  writeJsonAtomic(gateArtifact, {
    schema: "engine-gate-request-v0",
    run_id: runId,
    gate_id: decision.gate || decision.id,
    decision_id: decision.id,
    stage,
    playbook,
    artifact_path: artifactPath,
    context_paths: contextPaths,
    decision,
    refreshed_at: nowIso(),
  });
  appendEvent(runDir, { event: "gate_opened", gate: decision.gate || decision.id, decision_id: decision.id });

  // A gate is now rendered for a human — the point the human gets involved.
  // Checkpoint the partial benchmark so the wait for their answer never leaves
  // us without a recorded benchmark (skipped automatically if the gate is
  // already answered, i.e. no real wait).
  let parkHandoff = null;
  const resolved = decision.status === "answered" && !isUnresolvedJudgment(decision);
  if (!resolved) {
    checkpointOnPark(runDir, `gate-open:${decision.gate || decision.id}`, decision.id);
    // The human now owns the next move, so this session has nothing left to do:
    // write the handoff and let it end rather than idle into a cold cache.
    // `blocks` describes DOWNSTREAM impact, not which stage owns the gate. Using
    // it meant a plan-stage gate that blocks `implement` was checked against
    // implement's stricter rules, so it demanded attempts.jsonl and env.json that
    // a plan-stage run has no business having — then advised keeping the costly
    // session open. Fall back to the live stage instead.
    // The LIVE stage, never `stage` above: `blocks` is downstream impact, so a
    // plan-stage gate blocking `implement` would be graded against implement's
    // requirements — demanding artifacts a plan-stage run has no business
    // having, then advising the session stay open, which inverts the point.
    const boundaryStage = currentStage(loadStatus(runDir));
    parkHandoff = handoffOnPark(runDir, boundaryStage);
    parkHandoff = {
      ...parkHandoff,
      episode_boundary: parkHandoff.sufficient === true
        ? "the human owns the next move — end this session; the next episode starts fresh from the handoff note"
        : parkHandoff.sufficient === null
          ? "handoff could NOT be written — do not treat this as a safe boundary; stay in this session"
          : "handoff INCOMPLETE — resuming this session is safer than starting fresh until the gaps are recorded",
    };
  }

  if (resolved) {
    out({
      ok: true,
      run_id: runId,
      mode: "already_answered",
      decision,
      gate_artifact: gateArtifact,
      next_step: stage
        ? `this gate is already answered ('${decision.answer}') — engine stage end ${stage} --run ${runId} --repo ${repo}`
        : "this gate is already answered — engine next",
    });
  }

  const curator = curatorOnPath();
  if (curator) {
    const html = renderGateArtifact({ runId, runDir }, {
      name: decision.gate || decision.id,
      stage,
      decisions: pendingFor(decisions, decision),
    });
    out({
      ok: true,
      run_id: runId,
      mode: "curator",
      decision,
      gate_artifact: gateArtifact,
      html,
      ...(parkHandoff || {}),
      next_step:
        `curator open ${html} ; once the human has answered there, run: engine gate collect --run ${runId}` +
        ` — it maps the curator answer into decisions.json; then re-run the refused engine command`,
    });
  }
  out({
    ok: true,
    run_id: runId,
    mode: "terminal_fallback",
    decision,
    gate_artifact: gateArtifact,
    ...(parkHandoff || {}),
    next_step:
      `curator is not on PATH. A HUMAN must answer decision ${decision.id} by editing ` +
      `${join(runDir, "decisions.json")}: set status:"answered", answer:<one of ${JSON.stringify(decision.options || [])}>, ` +
      `answered_by:"human", answered_at:<ISO-8601>. Agents never write answers. Then re-run the refused engine command.`,
  });
}

// ---------------------------------------------------------------------------
// Gate page and `engine gate collect`: gate open writes one curator page per
// (run, gate); collect maps the answers back. Only an exact option resolves one.
// ---------------------------------------------------------------------------

/** Pending decisions a human answers together with `decision` (same blocked stages). */
function pendingFor(decisions, decision) {
  const blocks = new Set(decision.blocks || []);
  return decisions.filter((d) => (d.status === "pending" || isUnresolvedJudgment(d)) &&
    (d.id === decision.id || (Array.isArray(d.blocks) && d.blocks.some((b) => blocks.has(b)))));
}

function renderGateArtifact({ runId, runDir }, gate) {
  const plansDir = join(detentRoot(), ".plans");
  mkdirSync(plansDir, { recursive: true });
  const file = join(plansDir, `${runId}-${gate.name}.html`);
  const primary = (gate.stage && STAGE_ARTIFACTS[gate.stage]) || [];
  const docs = [...new Set([...primary, ...Object.values(STAGE_ARTIFACTS).flat()])]
    .filter((rel) => existsSync(join(runDir, rel)));
  const docHtml = docs.map((rel, i) =>
    `<details${i === 0 ? " open" : ""}><summary>${escapeHtml(rel)}</summary><p><strong>${i === 0 ? "The artifact this gate reviews" : "Earlier run artifact, for context"}: ${escapeHtml(rel)}</strong></p><pre>${escapeHtml(readFileSync(join(runDir, rel), "utf8"))}</pre></details>`,
  ).join("\n");
  const blocks = gate.decisions.map((d) => {
    const options = (d.options || []).map((o) =>
      `<div class="option" data-plan-option="${escapeHtml(o)}"><strong>${escapeHtml(o)}</strong></div>`,
    ).join("\n");
    return `<section>
<h2>Decision ${escapeHtml(d.id)}</h2>
<div data-plan-question="${escapeHtml(d.id)}">
<p class="q-label">${escapeHtml(d.question || "")}</p>
${d.context ? `<p class="sub">Context: ${escapeHtml(d.context)}</p>` : ""}
<div class="options">
${options}
</div>
</div>
</section>`;
  }).join("\n");
  writeFileSync(file, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gate ${escapeHtml(gate.name)}</title>
<style>
  :root { --paper:#faf8f5; --paper-2:#efece7; --ink:#16273c; --muted:#7e7c76; --rule:#e1ddd7;
          --accent:#397882; --accent-tint:#bfe6ec; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --paper:#14181c; --paper-2:#1b2026; --ink:#e8e6e2; --muted:#98a2af;
      --rule:#2b3037; --accent:#7fc3cd; --accent-tint:#1d3a40; }
  }
  * { box-sizing: border-box; min-width: 0; }
  body { margin: 0; padding: 2rem 1rem 6rem; background: var(--paper); color: var(--ink);
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; line-height: 1.6; }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: .2rem 0 1rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  .eyebrow, .sub { font-family: var(--mono); font-size: .75rem; color: var(--muted); }
  pre { background: var(--paper-2); border: 1px solid var(--rule); padding: 1rem; overflow-x: auto;
        white-space: pre-wrap; font-family: var(--mono); font-size: .85rem; }
  summary { cursor: pointer; font-family: var(--mono); font-size: .85rem; }
  .q-label { font-weight: 600; }
  .options { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .6rem; }
  .option { border: 1px solid var(--rule); border-radius: .4rem; padding: .6rem 1rem; cursor: pointer; background: var(--paper-2); }
  .option:hover { border-color: var(--accent); }
  [data-curator-chosen] { border-color: var(--accent); background: var(--accent-tint); }
</style>
</head>
<body>
<main>
<p class="eyebrow">${escapeHtml(runId)} · gate ${escapeHtml(gate.name)}${gate.stage ? ` · stage ${escapeHtml(gate.stage)}` : ""}</p>
<h1>Needs your decision</h1>
${blocks}
<h2>What you are deciding on</h2>
${docHtml || `<p class="sub">No stage artifact has been written yet.</p>`}
</main>
</body>
</html>
`);
  return file;
}

// ---------------------------------------------------------------------------
// engine gate collect — map curator feedback into decisions.json. Non-blocking
// by design: it never waits for a human. Only an answer that is EXACTLY one of
// the decision's options resolves a decision; everything else stays pending.
// ---------------------------------------------------------------------------

function gateHtmlsOf(runId, runDir) {
  const plansDir = join(detentRoot(), ".plans");
  const names = new Set(loadDecisions(runDir).map((d) => d.gate || d.id));
  return new Set([...names]
    .map((n) => join(plansDir, `${runId}-${n}.html`))
    .filter((f) => existsSync(f))
    .map((f) => realpathSync(f)));
}

function persistFeedback(runDir, items) {
  if (items.length === 0) return;
  const lines = items.map((item) => JSON.stringify({ ts: nowIso(),
    ...(item && typeof item === "object" && !Array.isArray(item) ? item : { raw: item }) }) + "\n");
  appendFileSync(join(runDir, "review-feedback.jsonl"), lines.join(""));
}

/** Parse a feedback file: a JSON array of items, a {prompts:[...]} payload, or curator-drain JSON lines. */
function parseFeedbackText(text, label) {
  const lines = (() => {
    try { return [JSON.parse(text)]; } catch { return text.split("\n").filter((l) => l.trim()); }
  })();
  const items = [];
  for (const line of lines) {
    let v = line;
    if (typeof line === "string") {
      try { v = JSON.parse(line); } catch { throw new Error(`${label}: not valid JSON: ${line.slice(0, 120)}`); }
    }
    if (Array.isArray(v)) items.push(...v);
    else if (v && Array.isArray(v.prompts)) items.push(...v.prompts);
    else throw new Error(`${label}: expected an array of items or a {prompts:[...]} payload`);
  }
  return items;
}

/** Run `curator drain` and return the prompts addressed to this run's gate pages. */
function drainCuratorFor(runId, runDir) {
  const curator = curatorOnPath();
  if (!curator) return { items: [], note: "curator not on PATH" };
  const htmls = gateHtmlsOf(runId, runDir);
  if (htmls.size === 0) return { items: [], note: "no gate page rendered for this run yet" };
  const r = spawnSync(curator, ["drain", ...htmls], { encoding: "utf8", timeout: 30000 });
  if (r.error) throw new Error(`curator drain could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`curator drain exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(-400)}`);
  const items = [];
  for (const line of r.stdout.split("\n").filter((l) => l.trim())) {
    let v;
    try { v = JSON.parse(line); } catch { throw new Error(`curator drain printed non-JSON: ${line.slice(0, 120)}`); }
    if (!Array.isArray(v.prompts) || v.prompts.length === 0) continue;
    persistFeedback(runDir, v.prompts);
    let key = v.key;
    try { key = realpathSync(v.key); } catch { /* a key that no longer exists cannot be ours */ }
    if (!htmls.has(key)) throw new Error(`curator drain returned feedback for ${v.key}, which is not one of this run's gate pages`);
    items.push(...v.prompts);
  }
  return { items };
}

function applyFeedback(runDir, items) {
  const decisions = loadDecisions(runDir);
  const answered = [];
  const unresolved = [];
  let feedback = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") throw new Error(`feedback item is not an object: ${JSON.stringify(item)}`);
    if (item.type !== "decision") {
      feedback++;
      continue;
    }
    const d = decisions.find((x) => x.id === item.question);
    const base = { id: item.question, answer: item.answer ?? null, ...(item.note ? { note: item.note } : {}) };
    if (!d) { unresolved.push({ ...base, reason: "no such decision" }); continue; }
    if (d.status !== "pending" && !isUnresolvedJudgment(d)) { unresolved.push({ ...base, reason: `decision is ${d.status}, not pending` }); continue; }
    if (typeof item.answer !== "string" || !Array.isArray(d.options) || !d.options.includes(item.answer)) {
      unresolved.push({ ...base, reason: item.answer == null ? "no option chosen" : `'${item.answer}' is not one of the options` });
      continue;
    }
    if (isUnresolvedJudgment({ cause: d.cause, answer: item.answer })) {
      unresolved.push({ ...base, reason: "a judgment decision cannot be resolved by the proceed-degraded answer" });
      continue;
    }
    Object.assign(d, {
      status: "answered", answer: item.answer, answered_by: "human", answered_via: "curator",
      answered_at: new Date().toISOString(), ...(item.note ? { note: item.note } : {}),
    });
    answered.push(d.id);
  }
  if (answered.length) saveDecisions(runDir, decisions);
  syncGateAnsweredEvents(runDir, decisions);
  return { answered, unresolved, feedback, pending: decisions.filter((d) => d.status === "pending" || isUnresolvedJudgment(d)).map((d) => d.id) };
}

function collectResult(runId, runDir, items, extra = {}) {
  if (items.length === 0) {
    return { ok: true, run_id: runId, collected: 0, note: "nothing yet", answered: [], unresolved: [], feedback: 0, ...extra };
  }
  const r = applyFeedback(runDir, items);
  return {
    ok: true, run_id: runId, collected: items.length,
    answered: r.answered, unresolved: r.unresolved, feedback: r.feedback, ...extra,
    next_step: r.pending.length
      ? `still pending: ${r.pending.join(", ")} — answer in curator, then: engine gate collect --run ${runId}`
      : `all decisions answered — re-run the refused engine command`,
  };
}

function cmdGateCollect(flags) {
  const repo = repoOf(flags);
  const { runId, runDir } = findRun(repo, flags);
  let items;
  let extra = {};
  if (flags.file !== undefined) {
    if (flags.file === true) refuse("--file requires a path", "engine gate collect --run <id> --file <feedback.json>");
    const f = resolve(String(flags.file));
    if (!existsSync(f)) refuse(`feedback file not found: ${f}`, "pass a curator feedback JSON file");
    try { items = parseFeedbackText(readFileSync(f, "utf8"), f); } catch (e) { refuse(e.message, "fix the feedback file"); }
    persistFeedback(runDir, items);
  } else {
    try {
      const d = drainCuratorFor(runId, runDir);
      items = d.items;
      extra = d.note ? { curator: d.note } : {};
    } catch (e) { fail(e.message, "check `curator status`, or pass --file <feedback.json>"); }
  }
  const res = collectResult(runId, runDir, items, extra);
  out({ next_step: `waiting on a human: engine gate collect --run ${runId} again after they answer in curator`, ...res });
}

// ---------------------------------------------------------------------------
// stack.yaml — minimal YAML-subset parser (zero-dep, covers the shapes used by
// engine/stack.example.yaml: nested maps by indentation, lists of maps, inline
// flow arrays, quoted scalars, comments). Anything else is a loud parse error.
// ---------------------------------------------------------------------------

function stripYamlComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "#" && !inQuote && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(v) {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("[")) {
    try { return JSON.parse(v.replace(/'/g, '"')); } catch { throw new Error("unparsable inline array: " + v); }
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseYamlSubset(text, sourceName) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const noComment = stripYamlComment(raw);
    if (!noComment.trim()) continue;
    lines.push({ indent: /^ */.exec(noComment)[0].length, text: noComment.trim() });
  }
  let i = 0;
  function parseBlock(indent) {
    return lines[i].text.startsWith("- ") ? parseList(indent) : parseMap(indent);
  }
  function keyVal(text) {
    const m = /^([^:]+):(?:\s+(.*))?$/.exec(text);
    if (!m) throw new Error(`unparsable line in ${sourceName}: '${text}'`);
    return [m[1].trim(), m[2] === undefined ? "" : m[2].trim()];
  }
  function parseMap(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const [key, val] = keyVal(lines[i].text);
      i++;
      if (val === "") {
        if (i < lines.length && lines[i].indent > indent) obj[key] = parseBlock(lines[i].indent);
        else obj[key] = null;
      } else obj[key] = parseScalar(val);
    }
    return obj;
  }
  function parseList(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
      const rest = lines[i].text.slice(2).trim();
      if (/^[^:\s"]+:(\s|$)/.test(rest)) {
        const item = {};
        const [key, val] = keyVal(rest);
        item[key] = val === "" ? null : parseScalar(val);
        i++;
        if (i < lines.length && lines[i].indent > indent && !lines[i].text.startsWith("- ")) {
          Object.assign(item, parseMap(lines[i].indent));
        }
        arr.push(item);
      } else {
        arr.push(parseScalar(rest));
        i++;
      }
    }
    return arr;
  }
  const doc = parseBlock(lines.length ? lines[0].indent : 0);
  if (i < lines.length) throw new Error(`unparsed trailing content in ${sourceName} at: '${lines[i].text}'`);
  return doc;
}

function loadStack(repo, flags) {
  const candidates = flags.stack && flags.stack !== true
    ? [resolve(flags.stack)]
    : [join(repo, "stack.yaml"), join(repo, "engine", "stack.yaml")];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    refuse(`no stack.yaml found (looked at: ${candidates.join(", ")})`,
      "copy engine/stack.example.yaml to stack.yaml and wire your providers, or pass --stack <path>");
  }
  let doc;
  try {
    doc = parseYamlSubset(readFileSync(found, "utf8"), found);
  } catch (e) {
    refuse(`failed to parse ${found}: ${e.message}`,
      "the engine ships a minimal YAML-subset parser — keep stack.yaml to the shapes in stack.example.yaml");
  }
  if (!doc || typeof doc.sockets !== "object" || doc.sockets === null) {
    refuse(`${found} has no 'sockets:' map`, "see engine/stack.example.yaml for the expected shape");
  }
  return { stackPath: found, stack: doc };
}

// ---------------------------------------------------------------------------
// engine socket call <name> — three-kind dispatch (blueprint D8).
// ---------------------------------------------------------------------------

function parseTimeout(v) {
  if (v === undefined || v === null) return 120000;
  const m = /^(\d+)(s|m|h)?$/.exec(String(v).trim());
  if (!m) refuse(`unparsable timeout '${v}' in stack.yaml`, "use e.g. \"30s\", \"10m\", \"1h\"");
  const n = Number(m[1]);
  return n * ({ s: 1000, m: 60000, h: 3600000 }[m[2] || "s"]);
}

function resolveCommand(cmd, stackPath) {
  if (isAbsolute(cmd)) return cmd;
  if (cmd.includes("/")) {
    const rel = resolve(dirname(stackPath), cmd);
    if (existsSync(rel)) return rel;
  }
  return cmd; // rely on PATH
}

function kindOf(entry) {
  if (entry.kind) return entry.kind;
  if (entry.command) return "exec";
  return null;
}

/** Run one exec provider. Returns {ok, response?, code, stderr}. Retries exit-1 once. */
function runExec(entry, payload, stackPath, providerName) {
  const cmd = resolveCommand(String(entry.command), stackPath);
  const args = (entry.args || []).map(String);
  const timeout = parseTimeout(entry.timeout);
  const attempt = () => spawnSync(cmd, args, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout,
  });
  let r = attempt();
  // A JSON body on exit 1 is a deliberate provider answer, so retrying cannot change it.
  const jsonBody = (x) => { try { return JSON.parse(x.stdout); } catch { return undefined; } };
  if (r.status === 1 && jsonBody(r) === undefined) {
    process.stderr.write(`warning: provider '${providerName}' exited 1, retrying once\n`);
    r = attempt();
  }
  if (r.error) {
    return { ok: false, code: 1, stderr: `spawn failed: ${r.error.message}` };
  }
  if (r.status !== 0) {
    const body = r.status === 1 || r.status === 2 ? jsonBody(r) : undefined;
    return {
      ok: false,
      code: r.status === 2 ? 2 : 1,
      stderr: (r.stderr || "").trim(),
      ...(body !== undefined ? { response: body } : {}),
    };
  }
  try {
    return { ok: true, code: 0, response: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, code: 2, stderr: `provider stdout is not valid JSON: ${e.message}` };
  }
}

function instructionBlock(name, kind, entry, payload) {
  const target = kind === "skill" ? { skill: entry.skill || entry.name } : { tool: entry.tool || entry.name };
  const what = kind === "skill" ? "skills" : "MCP tools";
  out({
    ok: true,
    socket: name,
    kind,
    instruction: {
      action: kind === "skill" ? "invoke_skill" : "invoke_mcp_tool",
      ...target,
      payload,
      response_contract: `engine/sockets/${name}.md`,
    },
    next_step:
      `this CLI cannot invoke ${what} — that is by design (only the invoking agent can). ` +
      `Invoke ${kind === "skill" ? `skill '${target.skill}'` : `MCP tool '${target.tool}'`} with the payload above, ` +
      `and treat its output as the '${name}' socket response (contract: engine/sockets/${name}.md).`,
  });
}

function cmdSocketCall(name, flags) {
  if (!name) refuse("socket call requires a socket name", "engine socket call <name> [--payload-file f]");
  const repo = repoOf(flags);
  const { stackPath, stack } = loadStack(repo, flags);
  const entry = stack.sockets[name];
  if (!entry) {
    refuse(`socket '${name}' is not declared in ${stackPath}`,
      "declare it in stack.yaml or check the name",
      { known_sockets: Object.keys(stack.sockets) });
  }
  let payload = {};
  if (flags["payload-file"] && flags["payload-file"] !== true) {
    try {
      payload = JSON.parse(readFileSync(resolve(flags["payload-file"]), "utf8"));
    } catch (e) {
      refuse(`cannot read payload file: ${e.message}`, "pass --payload-file <valid-json-file>");
    }
  }

  // Multi-provider fan-out (the knowledge socket, per engine/sockets/knowledge.md).
  if (Array.isArray(entry.providers)) {
    return socketFanOut(name, entry, payload, stackPath);
  }

  const kind = kindOf(entry);
  if (kind === "exec") {
    const r = runExec(entry, payload, stackPath, name);
    if (!r.ok) {
      const why = r.stderr || (r.response && typeof r.response.error === "string" ? r.response.error : "");
      const msg = `socket '${name}' exec provider failed (exit ${r.code}): ${why}`;
      const extra = r.response !== undefined ? { response: r.response } : {};
      if (r.code === 2) refuse(msg, "the provider rejected the request as a contract violation — fix the payload or the provider", extra);
      fail(msg, "check the provider command in stack.yaml, then re-invoke", extra);
    }
    out({
      ok: true,
      socket: name,
      kind: "exec",
      response: r.response,
      next_step: r.response.next_step || "consume the response per the socket contract",
    });
  }
  if (kind === "skill" || kind === "mcp_tool") return instructionBlock(name, kind, entry, payload);
  refuse(`socket '${name}' in ${stackPath} has no dispatchable kind (need 'command' for exec, or kind: skill|mcp_tool)`,
    "see engine/stack.example.yaml and blueprint D8");
}

function socketFanOut(name, entry, payload, stackPath) {
  const merge = entry.merge || {};
  const maxResults = merge.max_results ?? 25;
  const minConfidence = merge.min_confidence ?? 0;
  const succeeded = [];
  const warnings = [];
  const manual = [];
  const collected = [];
  for (const provider of entry.providers) {
    const pname = provider.name || provider.command || "unnamed";
    const kind = kindOf(provider);
    if (kind === "skill" || kind === "mcp_tool") {
      manual.push({
        provider: pname,
        kind,
        instruction: {
          action: kind === "skill" ? "invoke_skill" : "invoke_mcp_tool",
          [kind === "skill" ? "skill" : "tool"]: provider.skill || provider.tool,
          payload,
        },
      });
      continue;
    }
    if (kind !== "exec") {
      warnings.push(`provider '${pname}' has no dispatchable kind — skipped`);
      continue;
    }
    const r = runExec(provider, payload, stackPath, pname);
    if (!r.ok) {
      warnings.push(`provider '${pname}' failed (exit ${r.code}): ${r.stderr}`);
      continue;
    }
    succeeded.push(pname);
    for (const res of r.response.results || []) {
      collected.push({ ...res, provider: pname });
    }
  }
  if (succeeded.length === 0 && manual.length === 0) {
    fail(`all ${entry.providers.length} '${name}' providers failed — aborting (zero providers succeeding is a hard failure per the socket contract)`,
      "fix at least one provider in stack.yaml, then re-invoke",
      { warnings });
  }
  // Merge: dedupe by source keeping the highest confidence, filter, rank, cap.
  const bySource = new Map();
  for (const res of collected) {
    if ((res.confidence ?? 0) < minConfidence) continue;
    const prev = bySource.get(res.source);
    if (!prev || (res.confidence ?? 0) > (prev.confidence ?? 0)) bySource.set(res.source, res);
  }
  const results = [...bySource.values()]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, maxResults);
  for (const w of warnings) process.stderr.write("warning: " + w + "\n");
  out({
    ok: true,
    socket: name,
    kind: "fan_out",
    providers_succeeded: succeeded,
    warnings,
    ...(manual.length ? { manual_providers: manual } : {}),
    results,
    next_step: manual.length
      ? "this CLI cannot invoke skill/MCP providers — the invoking agent must run manual_providers itself and merge those results with the ones above (dedupe by source, rank by confidence)"
      : "read the highest-confidence sources in full before relying on excerpts",
  });
}

// ---------------------------------------------------------------------------
// engine next — the thin driver (blueprint D4). Reads state, prints the exact
// next command. No orchestrator prompt.
// ---------------------------------------------------------------------------

function cmdNext(flags) {
  const repo = repoOf(flags);
  const { runId, runDir } = findRun(repo, flags);
  const status = loadStatus(runDir);
  const decisions = loadDecisions(runDir);
  syncGateAnsweredEvents(runDir, decisions);
  const current = STAGES.find((s) => !["done", "skipped"].includes(status.stages[s].status));
  if (!current) {
    out({ ok: true, run_id: runId, stage: null, status: "done",
      next_step: "run complete — all stages done" });
  }
  const entry = status.stages[current];
  const artifact = (STAGE_ARTIFACTS[current] || []).join(" and ") || null;
  const base = { ok: true, run_id: runId, stage: current, status: entry.status };
  const suffix = `--run ${runId} --repo ${repo}`;

  if (entry.status === "pending") {
    const blockers = pendingBlockers(decisions, current);
    if (blockers.length > 0) {
      out({ ...base,
        entry_state: `blocked by pending decision(s): ${blockers.map((d) => d.id).join(", ")}`,
        next_step: `engine gate open ${blockers[0].gate || blockers[0].id} ${suffix}` });
    }
    out({ ...base,
      entry_state: "all prior stages done, no blocking decisions",
      exit_state: artifact ? `will require ${artifact}` : "no required artifact",
      next_step: `engine stage begin ${current} ${suffix}` });
  }
  if (entry.status === "blocked") {
    const ids = entry.blocked_on || [];
    const first = decisions.find((d) => ids.includes(d.id));
    out({ ...base,
      entry_state: `blocked on: ${ids.join(", ")}`,
      next_step: `engine gate open ${(first && first.gate) || ids[0] || "?"} ${suffix}` });
  }
  // in_progress
  if (artifact && !existsSync(join(runDir, artifact))) {
    out({ ...base,
      exit_state: `required artifact missing: ${artifact}`,
      next_step: `produce ${artifact} in ${runDir}, then: engine stage end ${current} ${suffix}` });
  }
  const gateDef = STAGE_END_GATES[current];
  if (gateDef) {
    const gate = decisions.find((d) => d.gate === gateDef.name);
    if (gate && gate.status === "pending") {
      out({ ...base,
        exit_state: `artifact present; ${gateDef.name} gate pending (${gate.id})`,
        next_step: `engine gate open ${gateDef.name} ${suffix}` });
    }
  }
  out({ ...base,
    exit_state: artifact ? `artifact present: ${artifact}` : "no required artifact",
    next_step: `engine stage end ${current} ${suffix}` });
}

// ---------------------------------------------------------------------------
// engine dashboard — render ALL runs under the centralized .sdlc/ into one
// self-contained curator artifact (per run: stage, status, pending gates,
// age) and print how to open it. Data assembly is pure reads; the artifact
// follows the curator skill's self-containment rules (inline CSS, system
// fonts, no external URLs, light+dark).
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function humanAge(createdAt, now = Date.now()) {
  const ms = now - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Assemble the dashboard data for every run under the centralized .sdlc/. */
function assembleDashboard(sdlc) {
  if (!existsSync(sdlc)) return [];
  const runs = [];
  for (const d of readdirSync(sdlc).sort()) {
    const runDir = join(sdlc, d);
    if (!existsSync(join(runDir, "run.json"))) continue;
    const runJson = readJson(join(runDir, "run.json"));
    let stage = null;
    let stageStatus = null;
    let blockedOn = [];
    const statusPath = join(runDir, "stage-status.json");
    if (existsSync(statusPath)) {
      const status = readJson(statusPath);
      stage = STAGES.find((s) => status.stages[s] && !["done", "skipped"].includes(status.stages[s].status)) || null;
      if (stage) {
        stageStatus = status.stages[stage].status;
        blockedOn = status.stages[stage].blocked_on || [];
      } else {
        stageStatus = "done"; // run complete
      }
    } else {
      stageStatus = "unreadable (stage-status.json missing)";
    }
    const decisions = loadDecisions(runDir);
    const pendingGates = decisions
      .filter((x) => x.status === "pending")
      .map((x) => ({ id: x.id, gate: x.gate || null, question: x.question, blocks: x.blocks || [] }));
    const { steps, steps_recorded } = readSteps(runDir);
    runs.push({
      run_id: runJson.run_id || d,
      ticket_ref: runJson.ticket_ref || null,
      repo: runJson.repo || null,
      worktree: runJson.worktree || null,
      branch: runJson.branch || null,
      stage: stage,
      stage_status: stageStatus,
      blocked_on: blockedOn,
      pending_gates: pendingGates,
      created_at: runJson.created_at || null,
      age: runJson.created_at ? humanAge(runJson.created_at) : "unknown",
      steps,
      steps_recorded,
    });
  }
  return runs;
}

// Live-view MVP (engine/cli/README.md's "Live-view MVP" section): a per-row
// checklist cell rendered from deriveSteps()'s output. Honesty rule: an
// absent/empty checklist renders "no steps recorded", never an
// empty-but-checked-off list.
function renderStepsCell(r) {
  if (!r.steps_recorded || !r.steps || r.steps.length === 0) {
    return `<span class="none">no steps recorded</span>`;
  }
  const mark = { done: "&#9745;", doing: "&#9655;", todo: "&#9744;" };
  const items = r.steps.map((s) =>
    `<li>${mark[s.status] || mark.todo} ${escapeHtml(s.label)} <span class="sub">[${escapeHtml(s.kind)}]</span></li>`,
  ).join("");
  return `<details><summary>steps (${r.steps.length})</summary><ul class="steps">${items}</ul></details>`;
}

function renderDashboardHtml(runs, sdlc) {
  const badge = (s) => {
    const cls = { pending: "b-pending", in_progress: "b-progress", blocked: "b-blocked", done: "b-done", skipped: "b-skipped" }[s] || "b-pending";
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  };
  const rows = runs.map((r) => {
    const gates = r.pending_gates.length
      ? `<ul class="gates">` + r.pending_gates.map((g) =>
          `<li><code>${escapeHtml(g.id)}</code>${g.gate ? ` (${escapeHtml(g.gate)})` : ""} — ${escapeHtml(g.question || "")} <em>blocks: ${escapeHtml((g.blocks || []).join(", "))}</em></li>`,
        ).join("") + `</ul>`
      : `<span class="none">none</span>`;
    return `<tr>
      <td><code>${escapeHtml(r.run_id)}</code><div class="sub">${escapeHtml(r.ticket_ref || "")}</div></td>
      <td class="sub">${escapeHtml(r.repo || "")}</td>
      <td>${r.stage ? escapeHtml(r.stage) : "complete"}</td>
      <td>${badge(r.stage_status)}</td>
      <td>${gates}</td>
      <td>${renderStepsCell(r)}</td>
      <td>${escapeHtml(r.age)}</td>
    </tr>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engine dashboard — all runs</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; min-width: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 2rem auto; max-width: 72rem; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  .hint { opacity: .7; font-size: .85rem; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid rgba(128,128,128,.35); vertical-align: top; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .75; }
  code { font-size: .85em; }
  .sub { opacity: .65; font-size: .8rem; word-break: break-all; }
  .badge { padding: .1rem .5rem; border-radius: .6rem; font-size: .78rem; white-space: nowrap; }
  .b-pending  { background: rgba(128,128,128,.22); }
  .b-progress { background: rgba( 70,130,240,.28); }
  .b-blocked  { background: rgba(220, 80, 60,.30); }
  .b-done     { background: rgba( 60,170, 90,.28); }
  .b-skipped  { background: rgba(128,128,128,.28); }
  .gates { margin: 0; padding-left: 1rem; }
  .gates li { margin: .15rem 0; }
  .none { opacity: .5; }
  .empty { opacity: .7; padding: 2rem 0; }
  details summary { cursor: pointer; }
  .steps { margin: .4rem 0 0; padding-left: 1rem; list-style: none; }
  .steps li { margin: .15rem 0; }
</style>
</head>
<body>
<h1>engine dashboard — ${runs.length} run${runs.length === 1 ? "" : "s"}</h1>
<p class="hint">Source: ${escapeHtml(sdlc)} · alt-click annotates an element, selecting text comments.</p>
${runs.length === 0
    ? `<p class="empty">No runs yet — <code>engine run new --ticket &lt;ref&gt;</code> creates one.</p>`
    : `<table>
<thead><tr><th>run</th><th>repo</th><th>stage</th><th>status</th><th>pending gates</th><th>steps</th><th>age</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`}
</body>
</html>
`;
}

function cmdDashboard() {
  const root = detentRoot();
  const sdlc = join(root, ".sdlc");
  const runs = assembleDashboard(sdlc);
  const plansDir = join(root, ".plans");
  mkdirSync(plansDir, { recursive: true });
  const artifact = join(plansDir, "engine-dashboard.html");
  writeFileSync(artifact, renderDashboardHtml(runs, sdlc));
  const curatorCli = join(root, "engine", "curator", "cli.mjs");
  let openHint;
  if (existsSync(curatorCli)) {
    openHint = `node ${curatorCli} open ${artifact} — review all runs in curator (delegate the open/poll loop to a subagent)`;
  } else if (curatorOnPath()) {
    openHint = `curator open ${artifact} — review all runs in curator (delegate the open/poll loop to a subagent)`;
  } else {
    openHint = `open ${artifact} in a browser (curator CLI not found at ${curatorCli} and not on PATH)`;
  }
  out({
    ok: true,
    sdlc_home: sdlc,
    runs,
    artifact,
    next_step: runs.length === 0
      ? `no runs under ${sdlc} — engine run new --ticket <ref> creates one; artifact still written: ${openHint}`
      : openHint,
  });
}

// ---------------------------------------------------------------------------
// engine live <run-id> [--watch [--interval-ms 500] [--timeout-s N]] —
// per-run streaming view, completing the live-view MVP (roadmap #6). Reads
// only (D1 untouched): renders the coalesced checklist + streamed answer
// (engine/cli/liveview.mjs) to <DETENT_ROOT>/.plans/engine-live-<run-id>.html.
// A `<meta http-equiv="refresh">` in that file is present only while the run
// is live — curator re-reads the artifact from disk on every GET with
// Cache-Control: no-store (engine/curator/server.mjs), so re-writing this
// file IS the streaming mechanism, through curator and plain `file://` alike.
// `--watch` polls events.jsonl + stage-status.json via statSync size/mtime
// (not fs.watch, which is platform-flaky) and exits 0 the moment the run is
// genuinely complete (isRunComplete). If --timeout-s elapses first on a
// still-incomplete run, it exits 3 instead (never 0 — that would be
// indistinguishable from real completion) after one final render that drops
// the live refresh tag and says so honestly in the footer. Either way it
// always leaves whatever it last rendered in place (a stable, final, static
// artifact once the process is no longer updating it).
// ---------------------------------------------------------------------------

function cmdLive(runId, flags) {
  const id = runId || (flags.run && flags.run !== true ? String(flags.run) : null);
  if (!id) {
    refuse("live requires a run id",
      "engine live <run-id> [--run <id>] [--watch [--interval-ms 500] [--timeout-s N]]  (list runs: engine dashboard)");
  }
  const runDir = join(sdlcHome(), id);
  if (!existsSync(join(runDir, "run.json"))) {
    refuse(`no run '${id}' under ${sdlcHome()}`, "check the run id (engine dashboard lists all runs)");
  }
  const root = detentRoot();
  const plansDir = join(root, ".plans");
  mkdirSync(plansDir, { recursive: true });
  const artifact = join(plansDir, `engine-live-${id}.html`);
  const curatorCli = join(root, "engine", "curator", "cli.mjs");
  const openHint = existsSync(curatorCli)
    ? `node ${curatorCli} open ${artifact} — watch this run live (delegate the open/poll loop to a subagent)`
    : curatorOnPath()
      ? `curator open ${artifact} — watch this run live`
      : `open ${artifact} in a browser (curator CLI not found at ${curatorCli} and not on PATH)`;

  const eventsPath = join(runDir, "events.jsonl");
  const statusPath = join(runDir, "stage-status.json");

  // run.json is guarded the same way stage-status.json is below: in --watch
  // mode render() runs inside a setInterval callback, which fires AFTER
  // main()'s try/catch has already returned (see bottom of this file) — an
  // uncaught SyntaxError/ENOENT here (e.g. the run dir is cleaned up, or
  // run.json is mid-write, while a watcher is attached) would otherwise crash
  // the watcher with a raw stack trace and exit 1, leaving the artifact stuck
  // on its live <meta http-equiv="refresh"> tag forever. Fall back to the
  // last known-good read rather than throw (liveview.mjs's own "skipped,
  // never thrown" doctrine).
  let lastGoodRunJson = null;
  const render = (opts = {}) => {
    let runJson = lastGoodRunJson;
    try {
      runJson = readJson(join(runDir, "run.json"));
      lastGoodRunJson = runJson;
    } catch {
      runJson = lastGoodRunJson; // corrupt/missing this tick — reuse last-known, never throw
    }
    let status = null;
    try {
      status = existsSync(statusPath) ? readJson(statusPath) : null;
    } catch {
      status = null;
    }
    const stage = status
      ? STAGES.find((s) => status.stages[s] && !["done", "skipped"].includes(status.stages[s].status)) || null
      : null;
    const stageStatus = status ? (stage ? status.stages[stage].status : "done") : "unreadable (stage-status.json missing)";
    const complete = status ? isRunComplete(status) : false;
    const { steps, steps_recorded, answer } = readSteps(runDir);
    const timedOut = !!opts.timedOut;
    writeFileSync(artifact, renderLiveHtml({
      run_id: id,
      ticket_ref: (runJson && runJson.ticket_ref) || null,
      stage,
      stage_status: stageStatus,
      complete,
      steps,
      steps_recorded,
      answer,
      timedOut,
      timedOutAt: timedOut ? nowIso() : null,
    }));
    return { stage, stage_status: stageStatus, complete, steps_recorded };
  };

  if (!flags.watch) {
    const r = render();
    out({
      ok: true,
      run_id: id,
      artifact,
      complete: r.complete,
      steps_recorded: r.steps_recorded,
      stage: r.stage,
      stage_status: r.stage_status,
      next_step: openHint,
    });
    return;
  }

  // --watch: long-running (engine's first). Print the start JSON line first —
  // this preserves the one-JSON-line-per-invocation contract (it is the only
  // line this invocation ever writes to stdout) — then poll/re-render
  // silently until the run completes or the timeout elapses.
  const intervalMsRaw = flags["interval-ms"] && flags["interval-ms"] !== true ? flags["interval-ms"] : 500;
  const intervalMs = Number(intervalMsRaw);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    refuse(`invalid --interval-ms '${intervalMsRaw}'`, "--interval-ms must be a finite positive number (milliseconds)");
  }
  let timeoutS = null;
  if (flags["timeout-s"] && flags["timeout-s"] !== true) {
    timeoutS = Number(flags["timeout-s"]);
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
      refuse(`invalid --timeout-s '${flags["timeout-s"]}'`, "--timeout-s must be a finite positive number (seconds)");
    }
  }
  const deadline = timeoutS !== null ? Date.now() + timeoutS * 1000 : null;

  const statOf = (p) => {
    try {
      const st = statSync(p);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  };
  let lastEventsStat = statOf(eventsPath);
  let lastStatusStat = statOf(statusPath);

  let r = render();
  process.stdout.write(JSON.stringify({
    ok: true,
    run_id: id,
    artifact,
    watching: true,
    interval_ms: intervalMs,
    complete: r.complete,
    steps_recorded: r.steps_recorded,
    next_step: openHint,
  }) + "\n");

  let timer = null;
  const finishIfDone = () => {
    // Genuine completion always wins exit 0, even if the deadline also
    // happens to have elapsed on this same tick.
    if (r.complete) {
      if (timer) clearInterval(timer);
      process.exit(0);
    }
    const timedOut = deadline !== null && Date.now() >= deadline;
    if (timedOut) {
      // The run is still INCOMPLETE — do one final honest render that drops
      // the <meta refresh> tag (this process is done watching) and says so
      // in the footer, rather than leaving the artifact looking permanently
      // "live" or (worse) indistinguishable from real completion. Exit 3 —
      // a distinct code from 0 (real completion) and 1/2 (crash/refusal) —
      // so callers can tell "watch gave up" apart from "run finished".
      r = render({ timedOut: true });
      if (timer) clearInterval(timer);
      process.exit(3);
    }
  };

  finishIfDone();
  timer = setInterval(() => {
    // Everything in this tick runs OUTSIDE main()'s try/catch (the callback
    // fires after main() has already returned), so an uncaught throw here
    // would crash the watcher with a raw stack trace and exit 1, permanently
    // stranding the artifact on its live refresh tag. Guard the whole tick:
    // if the run dir itself vanished (e.g. cleaned up while watched), exit
    // cleanly with a structured JSON line instead of throwing; any other
    // unexpected error is swallowed for this tick only, keeping the last
    // good render in place and leaving the watcher polling.
    try {
      if (!existsSync(runDir)) {
        clearInterval(timer);
        process.stdout.write(JSON.stringify({
          ok: false,
          run_id: id,
          reason: `run directory vanished while --watch was attached: ${runDir}`,
          next_step: `the last good render remains at ${artifact} — recreate the run to resume watching`,
        }) + "\n");
        process.exit(1);
      }
      const es = statOf(eventsPath);
      const ss = statOf(statusPath);
      if (es !== lastEventsStat || ss !== lastStatusStat) {
        lastEventsStat = es;
        lastStatusStat = ss;
        r = render();
      }
      finishIfDone();
    } catch (e) {
      if (process.env.ENGINE_VERBOSE) {
        process.stderr.write(`live --watch: render skipped this tick (${e.message})\n`);
      }
    }
  }, intervalMs);
}

// ---------------------------------------------------------------------------
// engine bench <run-id> — compute the run's benchmark, write
// <run>/benchmark.json, and append a one-line summary to
// <DETENT_ROOT>/benchmarks/ledger.jsonl. Derives phase timings, human-gate
// wait, async-external wait, and effective agentic time from events.jsonl
// (plus tokens.jsonl if present). Pure reads of the run; see engine/bench.
// ---------------------------------------------------------------------------

function cmdBench(runId, flags) {
  const id = runId || (flags.run && flags.run !== true ? flags.run : null);
  if (!id) refuse("bench requires a run id", "engine bench <run-id>  (list runs: engine dashboard)");
  const runDir = join(sdlcHome(), id);
  if (!existsSync(join(runDir, "run.json"))) {
    refuse(`no run '${id}' under ${sdlcHome()}`, "check the run id (engine dashboard lists all runs)");
  }
  // Make sure any human answers recorded since the last CLI touch are on the
  // timeline before we measure gate wait.
  syncGateAnsweredEvents(runDir, loadDecisions(runDir));
  const ratesPath = flags.rates && flags.rates !== true ? flags.rates : undefined;

  // --checkpoint: write a PARTIAL benchmark of the work so far. For skills that
  // park on their own async gate (a connector-read wait, a PENDING-EXTERNAL
  // cross-team sign-off) — call this the instant you park, so the benchmark is
  // in place before the wait, not only when the run finally completes.
  if (flags.checkpoint) {
    let res;
    try {
      res = checkpointBenchmark(runDir, {
        detentRoot: detentRoot(),
        ratesPath,
        reason: flags.reason && flags.reason !== true ? flags.reason : "park",
        gateId: flags.gate && flags.gate !== true ? flags.gate : null,
      });
    } catch (e) {
      fail(`bench checkpoint failed for run '${id}': ${e.message}`, "fix the input above and re-run");
    }
    out({
      ok: true,
      run_id: id,
      checkpoint: true,
      ...(res.skipped
        ? { skipped: true, reason: res.reason, next_step: "no new events since the last checkpoint — nothing written" }
        : {
            sequence: res.sequence,
            benchmark_path: res.benchmarkPath,
            checkpoints_path: res.checkpointsPath,
            ledger_path: res.ledgerPath,
            summary: res.ledgerLine,
            next_step: `partial benchmark written to ${res.benchmarkPath}; appended ${res.checkpointsPath} + ${res.ledgerPath}`,
          }),
    });
    return;
  }

  let result;
  try {
    result = runBenchmark(runDir, { detentRoot: detentRoot(), ratesPath });
  } catch (e) {
    fail(`bench failed for run '${id}': ${e.message}`, "fix the input above and re-run engine bench");
  }
  out({
    ok: true,
    run_id: id,
    benchmark_path: result.benchmarkPath,
    ledger_path: result.ledgerPath,
    summary: ledgerLine(result.benchmark),
    next_step: `benchmark written to ${result.benchmarkPath}; summary appended to ${result.ledgerPath}`,
  });
}

// ---------------------------------------------------------------------------
// engine advisor consult — escalate-on-block: an agent stuck on a blocked
// stage/gate may consult a STRONG-tier advisor. RECOMMEND-ONLY by schema
// invariant (engine/routing/routing.mjs's loadRoutingConfig guard, not a
// flag): this verb writes exactly one `advisor_consult` event under the run
// and a `<run>/advisor/` directory for the human-readable recommendation the
// calling agent produces afterward. It never touches decisions.json or
// stage-status.json — the advisor never answers a gate. See
// engine/routing/README.md and docs/model-routing.md for the full doctrine.
// ---------------------------------------------------------------------------

function cmdAdvisorConsult(flags) {
  const trigger = flags.trigger && flags.trigger !== true ? String(flags.trigger) : null;
  if (!trigger) {
    refuse("advisor consult requires --trigger <gate-id|stage|free-text>",
      "engine advisor consult --run <id> [--repo <path>] --trigger <gate-id|stage|free-text> [--model fable]");
  }
  const model = flags.model && flags.model !== true ? String(flags.model) : "fable";

  let routing;
  try {
    routing = loadRoutingConfig(detentRoot());
  } catch (e) {
    fail(`advisor consult: ${e.message}`, "fix engine/routing/routing.json and re-run");
  }

  const tier = tierOf(model, routing.config);
  if (tier !== "strong") {
    refuse(`advisor consult refuses --model '${model}': not in the strong tier`,
      `strong tier models: ${routing.config.tiers.strong.join(", ")}`);
  }

  for (const forbidden of ["apply", "answer", "unblock"]) {
    if (flags[forbidden] !== undefined) {
      refuse(`advisor consult refuses --${forbidden}: routing authority is recommend-only`,
        `the advisor never answers a gate or edits decisions.json/stage-status.json — drop --${forbidden}`);
    }
  }

  if (!flags.run || flags.run === true) {
    refuse("advisor consult requires --run <id>",
      "engine advisor consult --run <id> [--repo <path>] --trigger <gate-id|stage|free-text> [--model fable]");
  }
  const repo = repoOf(flags);
  const { runId, runDir } = findRun(repo, flags);
  const decisions = loadDecisions(runDir);
  const decisionId = decisions.find((d) => d.gate === trigger || d.id === trigger)?.id ?? null;

  mkdirSync(join(runDir, "advisor"), { recursive: true });
  appendEvent(runDir, advisorConsultEvent({ model, tier, trigger, decisionId }));

  out({
    ok: true,
    run_id: runId,
    authority: "recommend-only",
    next_step: "spawn a STRONG-tier subagent over the blocked state; write its recommendation to <run>/advisor/consult-<seq>.md; if its token usage is known, append {phase:'advisor', model, input, output} to <run>/tokens.jsonl — the advisor NEVER answers a gate or edits decisions.json/stage-status.json",
  });
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

const USAGE = "engine <setup|run new|stage begin|stage end|gate open|gate collect|socket call|next|dashboard|live|bench|eval|pack validate|respond|step|advisor consult|handoff|attempt|env|decide-why|spend|help> — see engine/cli/README.md";

/**
 * cmdEval — wraps engine/eval/eval.mjs's runEval() for `engine eval`. An
 * EvalRefusal maps to refuse() (exit 2); any other thrown error is a bug or
 * environment failure and maps to fail() (exit 1); on success the result's
 * own `exit_code` drives the process exit (0 unless a blocking DEGRADE —
 * see engine/eval/eval.mjs), never engine.mjs's default 0.
 */
function cmdEval(flags) {
  try {
    // Root resolution is eval's own (resolveEvalRoots): it enforces the
    // single-root invariant — refusing `--repo`, and refusing a DETENT_ROOT
    // that names a different checkout than the one cwd is in, which otherwise
    // grades the wrong clone silently.
    const { detentRoot: root } = resolveEvalRoots({
      env: process.env,
      cwd: process.cwd(),
      fallbackRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      flags,
    });
    const result = runEval({ detentRoot: root, flags });
    const { exit_code, ...payload } = result;
    return out({ ok: true, ...payload }, exit_code ?? 0);
  } catch (e) {
    if (e instanceof EvalRefusal) return refuse(e.message, e.next_step, e.extra);
    return fail(`eval: ${e.message}`, "this is a bug in engine/eval/eval.mjs or its inputs — read the message above", { stack: e.stack });
  }
}

/**
 * cmdHandoff — close an EPISODE: write the successor-facing note and report
 * whether the run is actually safe to hand over.
 *
 * The case for episodes: a turn that resumes a session past its cache TTL
 * rebuilds the whole cache at many times a warm turn. CONTRACT.md
 * already says stages talk only through files and that a gate can park for
 * "hours or days", so the resume was never load-bearing; it just happened to be
 * the default.
 *
 * This command is the boundary. It never mutates run state — it writes exactly
 * one file, `handoff/<stage>.md`, and exits non-zero if the handoff would lose
 * something, because a boundary that silently drops a dead end costs more in
 * rework than the cold resume it saved.
 *
 * Exit 2 (refusal) on an insufficient handoff is deliberate: `--force` writes
 * the note anyway, clearly marked INCOMPLETE, so a human can still choose to
 * cut the episode — but nothing can do it silently.
 */
function cmdHandoff(runId, flags) {
  const id = runId || (flags.run && flags.run !== true ? flags.run : null);
  if (!id) refuse("handoff requires a run id", "engine handoff <run-id>  (list runs: engine dashboard)");
  const runDir = join(sdlcHome(), id);
  if (!existsSync(join(runDir, "run.json"))) {
    refuse(`no run '${id}' under ${sdlcHome()}`, "check the run id (engine dashboard lists all runs)");
  }

  // --stage lands in a filesystem path below, so it is validated against the
  // known stage list first: "../../x" would otherwise escape the handoff
  // directory and overwrite an unrelated file.
  let wantStage = null;
  if (flags.stage && flags.stage !== true) {
    wantStage = String(flags.stage);
    if (!STAGES.includes(wantStage)) {
      refuse(`--stage must be one of ${STAGES.join("|")} (got ${JSON.stringify(wantStage)})`,
        "the stage name becomes a filename under <run>/handoff/, so it is not free text");
    }
  }
  let state, note;
  try {
    state = loadRunState(runDir);
    note = buildNote(state, { stage: wantStage });
  } catch (e) {
    return fail(`handoff: ${e.message}`, "a run artifact is malformed — fix the named file, then re-run");
  }

  if (!note.sufficient && !flags.force) {
    return refuse(
      `handoff for '${id}' is incomplete: ${note.missing.join("; ")}`,
      `record the missing artifact(s), then re-run — or 'engine handoff ${id} --force' to cut the episode anyway with the note marked INCOMPLETE`,
      { missing: note.missing, warnings: note.warnings, stage: note.stage },
    );
  }

  const dir = join(runDir, "handoff");
  mkdirSync(dir, { recursive: true });
  // Belt and braces: whatever produced note.stage, it must be a known stage
  // before it becomes a filename.
  const stageFile = STAGES.includes(note.stage) ? note.stage : "unknown";
  const path = join(dir, `${stageFile}.md`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, note.text);
  renameSync(tmp, path);

  out({
    ok: true,
    run_id: id,
    stage: note.stage,
    handoff: path,
    sufficient: note.sufficient,
    missing: note.missing,
    warnings: note.warnings,
    estimated_tokens: note.estimated_tokens,
    over_target: note.over_target,
    pending_gates: checkSufficiency(state, { stage: note.stage }).pending_gates.map((g) => g.id),
    next_step: note.sufficient
      ? `end this session; start the next episode fresh with: cat ${path}`
      : `handoff written but INCOMPLETE — the successor will have to rediscover: ${note.missing.join("; ")}`,
  });
}

/**
 * cmdAttempt — record an approach that did NOT work.
 *
 * Without this verb the handoff's most valuable artifact has no producer, so
 * `engine handoff` refuses on every implement-onward run and the episode
 * boundary becomes noise — "a check that cries wolf gets ignored, which is
 * worse than not having one" (engine/handoff/handoff.mjs).
 *
 * Append-only and uncapped by design: long runs accumulate dozens of dead
 * ends, and the whole point is that a dead end stays dead.
 */
function cmdAttempt(approach, flags) {
  const runId = flags.run && flags.run !== true ? flags.run : null;
  if (!runId) refuse("attempt requires --run", 'engine attempt "<approach>" --run <id> --outcome failed');
  const runDir = join(sdlcHome(), runId);
  if (!existsSync(join(runDir, "run.json"))) {
    refuse(`no run '${runId}' under ${sdlcHome()}`, "check the run id (engine dashboard lists all runs)");
  }

  // `--none`: assert that nothing was rejected. Runs created before
  // attempts.jsonl was initialized at birth have no log, and the handoff
  // cannot tell that apart from "nobody recorded one" — this is the honest
  // way to say it, instead of inventing a failure to satisfy the check.
  if (flags.none) {
    if (approach) {
      refuse("--none records that NOTHING was rejected; it takes no approach argument",
        'either: engine attempt "<approach>" --run <id> --outcome failed   or: engine attempt --none --run <id>');
    }
    const ap = join(runDir, "attempts.jsonl");
    const already = existsSync(ap) ? readFileSync(ap, "utf8").trim() : "";
    if (already) {
      refuse(`--none refused: ${runDir}/attempts.jsonl already records ${already.split("\n").filter(Boolean).length} attempt(s)`,
        "the log is append-only — an existing dead end may not be erased by declaring there were none");
    }
    writeFileSync(ap, "");
    appendEvent(runDir, { event: "attempts_none_declared" });
    return out({
      ok: true,
      run_id: runId,
      attempts_file: ap,
      total_attempts: 0,
      next_step: "recorded that no approach was rejected — the handoff can now certify this run",
    });
  }

  if (!approach || typeof approach !== "string" || !approach.trim()) {
    refuse("attempt requires the approach that was tried",
      'engine attempt "<what you tried>" --run <id> --outcome failed|abandoned|superseded [--evidence "<why it failed>"] [--stage <s>]  (or --none if nothing was rejected)');
  }
  const OUTCOMES = ["failed", "abandoned", "superseded"];
  const outcome = flags.outcome && flags.outcome !== true ? flags.outcome : null;
  if (!outcome || !OUTCOMES.includes(outcome)) {
    refuse(`--outcome must be one of ${OUTCOMES.join("|")} (got ${outcome ?? "nothing"})`,
      "failed = tried and it did not work; abandoned = dropped before proving it; superseded = a better approach replaced it");
  }
  // Only read stage-status.json if we actually need to infer the stage: the
  // gate for this command is run.json, and requiring a second file that a run
  // may legitimately not have yet turned a valid call into an internal error.
  let inferred = null;
  if (!(flags.stage && flags.stage !== true)) {
    try { inferred = currentStage(loadStatus(runDir)); } catch { inferred = null; }
  }
  const row = {
    ts: nowIso(),
    stage: (flags.stage && flags.stage !== true ? flags.stage : null) || inferred || "unknown",
    approach: approach.trim(),
    outcome,
    ...(flags.evidence && flags.evidence !== true ? { evidence: flags.evidence } : {}),
  };
  appendFileSync(join(runDir, "attempts.jsonl"), JSON.stringify(row) + "\n");
  appendEvent(runDir, { event: "attempt_recorded", stage: row.stage, outcome });
  const total = readFileSync(join(runDir, "attempts.jsonl"), "utf8").trim().split("\n").filter(Boolean).length;
  out({
    ok: true,
    run_id: runId,
    attempt: row,
    total_attempts: total,
    next_step: "carry on — this is now in the handoff, so a fresh session will not re-try it",
  });
}

/**
 * cmdDecideWhy — record WHY a discarded option lost.
 *
 * Writes to `<run>/decision-rationale.jsonl`, a sidecar, NOT a field on the
 * decision. Two constraints force that shape:
 *   - CONTRACT.md: "never delete or rewrite an answered decision".
 *   - curator is the only thing permitted to write an answer, and it records
 *     just {question, answer} — there is nowhere for a reason to land.
 *
 * So the reason is recorded beside the decision instead of inside it, and the
 * handoff merges the two. This is the agent's account of why an option lost; it
 * is not a human answer and never becomes one — nothing here touches
 * `decisions.json`.
 */
function cmdDecideWhy(flags) {
  const runId = flags.run && flags.run !== true ? flags.run : null;
  if (!runId) refuse("decide-why requires --run", 'engine decide-why --run <id> --decision <D-00N> --option "<opt>" --why "<reason>"');
  const runDir = join(sdlcHome(), runId);
  if (!existsSync(join(runDir, "run.json"))) {
    refuse(`no run '${runId}' under ${sdlcHome()}`, "check the run id (engine dashboard lists all runs)");
  }
  const decision = flags.decision && flags.decision !== true ? String(flags.decision) : null;
  const option = flags.option && flags.option !== true ? String(flags.option) : null;
  const why = flags.why && flags.why !== true ? String(flags.why) : null;
  for (const [name, v] of [["--decision", decision], ["--option", option], ["--why", why]]) {
    if (!v || !v.trim()) {
      refuse(`decide-why requires ${name}`, 'engine decide-why --run <id> --decision <D-00N> --option "<opt>" --why "<reason>"');
    }
  }

  const decisions = loadDecisions(runDir);
  const target = decisions.find((d) => d && d.id === decision);
  if (!target) {
    refuse(`no decision '${decision}' in ${join(runDir, "decisions.json")}`,
      "check the id — a reason for a decision that does not exist would never be read");
  }
  // Recording a reason for the option that WON would be incoherent, and would
  // satisfy the sufficiency check without explaining any discard.
  if (target.answer !== undefined && option === target.answer) {
    refuse(`option ${JSON.stringify(option)} is the ANSWER to ${decision}, not a discard`,
      "record why the REJECTED options lost; the chosen one needs no rejection reason");
  }
  if (Array.isArray(target.options) && target.options.length && !target.options.includes(option)) {
    refuse(`option ${JSON.stringify(option)} is not among ${decision}'s options (${target.options.map((o) => JSON.stringify(o)).join(", ")})`,
      "a reason attached to an option nobody offered would never be shown");
  }

  const path = join(runDir, "decision-rationale.jsonl");
  const row = { ts: nowIso(), decision, option, why: why.trim() };
  appendFileSync(path, JSON.stringify(row) + "\n");
  appendEvent(runDir, { event: "decision_rationale_recorded", decision_id: decision });
  out({
    ok: true,
    run_id: runId,
    rationale_file: path,
    recorded: row,
    next_step: `the handoff will now show why ${JSON.stringify(option)} lost instead of only that it did`,
  });
}

/**
 * cmdEnv — record how to run this repo.
 *
 * `commands.verify` is the one field the handoff treats as mandatory from
 * implement onward: without it a successor cannot close the loop on its own
 * work, which is the single thing no other artifact substitutes for.
 *
 * MERGES into an existing env.json rather than replacing it, so recording a
 * gotcha later does not drop the verify command. The trade-off is real: a
 * command that becomes stale persists until overwritten. Editing the file by
 * hand is the removal path — there is deliberately no --unset, because a verb
 * that can silently delete the successor's only test command is worse than a
 * stale entry a human can see.
 */
function cmdEnv(flags) {
  const runId = flags.run && flags.run !== true ? flags.run : null;
  if (!runId) refuse("env requires --run", 'engine env --run <id> --verify "<test command>" [--build "<cmd>"] [--gotcha "<trap>"]');
  const runDir = join(sdlcHome(), runId);
  if (!existsSync(join(runDir, "run.json"))) {
    refuse(`no run '${runId}' under ${sdlcHome()}`, "check the run id (engine dashboard lists all runs)");
  }
  const path = join(runDir, "env.json");
  let env = { commands: {}, gotchas: [] };
  if (existsSync(path)) {
    try {
      env = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      return fail(`env: existing ${path} is not valid JSON: ${e.message}`, "fix or delete the file, then re-run");
    }
    // Shape, not just syntax. `["a"]` parses fine, then `commands ||= {}` lands
    // on an array and JSON.stringify silently drops it — reporting success
    // while discarding the caller's input.
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      return fail(`env: ${path} is valid JSON but not an object`, "fix or delete the file, then re-run");
    }
    if (env.commands !== undefined && (typeof env.commands !== "object" || env.commands === null || Array.isArray(env.commands))) {
      return fail(`env: ${path} has a non-object 'commands'`, "fix or delete the file, then re-run");
    }
    if (env.gotchas !== undefined && !Array.isArray(env.gotchas)) {
      return fail(`env: ${path} has a non-array 'gotchas'`, "fix or delete the file, then re-run");
    }
    env.commands ||= {};
    env.gotchas ||= [];
  }
  let touched = false;
  // NB: no `run` key — `--run` is the run id, and accepting it here silently
  // recorded the run id as a shell command and defeated the no-flags guard.
  // `--start` is the command that starts the app.
  for (const k of ["verify", "build", "start", "lint"]) {
    if (flags[k] && flags[k] !== true) { env.commands[k] = flags[k]; touched = true; }
  }
  const gotchas = flags.gotcha === undefined ? [] : (Array.isArray(flags.gotcha) ? flags.gotcha : [flags.gotcha]);
  for (const g of gotchas) {
    if (g && g !== true && !env.gotchas.includes(g)) { env.gotchas.push(g); touched = true; }
  }
  if (!touched) {
    refuse("env needs at least one of --verify/--build/--start/--lint/--gotcha",
      'engine env --run <id> --verify "node --test engine/"');
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(env, null, 2) + "\n");
  renameSync(tmp, path);
  out({
    ok: true,
    run_id: runId,
    env_file: path,
    env,
    verify_set: Boolean(env.commands.verify),
    next_step: env.commands.verify
      ? "handoff can now certify this run from implement onward"
      : "set --verify too — the handoff treats it as mandatory once code is being written",
  });
}

/**
 * cmdSpend — what Claude Code actually cost, from the local transcripts.
 *
 * Exists because three separate ad-hoc versions of this analysis each returned
 * a confidently wrong number (stale rates ~3x high; streamed duplicates
 * double-counted; a glob that matched 91 of 1,945 files and excluded every
 * sub-agent transcript). Committing it makes the figure reproducible and its
 * coverage inspectable — see engine/spend/spend.mjs.
 *
 * Always reconcile `total_cost_usd` against the usage console. The transcripts
 * are a lower bound; a material gap means a category of traffic is unrecorded.
 */
function cmdSpend(flags) {
  const days = flags.days && flags.days !== true ? Number(flags.days) : 30;
  if (!Number.isFinite(days) || days <= 0) {
    refuse(`--days must be a positive number (got ${flags.days})`, "engine spend [--days 30]");
  }
  const root = flags.root && flags.root !== true ? flags.root : join(homedir(), ".claude", "projects");
  const sinceMs = Date.now() - days * 86400000;
  let r;
  try {
    r = analyzeSpend({ root, sinceMs });
  } catch (e) {
    return fail(`spend: ${e.message}`, "check --root points at a readable transcripts directory");
  }
  const line = trackingLine(r, { ts: nowIso(), window_days: days, note: flags.note && flags.note !== true ? flags.note : null });

  // --record turns a one-off measurement into a time series. Without it there
  // is no way to tell whether an intervention worked: the interventions here
  // change WHERE work runs and HOW LONG sessions live, and neither shows up in
  // a test — only in the next month's numbers.
  let delta = null, ledger = null;
  if (flags.record) {
    // A scan that found no transcripts is not a measurement of zero spend —
    // it is a broken --root, a moved transcript directory, or a typo. Writing
    // it would put a plausible-looking zero into a series whose whole purpose
    // is trend comparison. Diagnose freely without --record; never record it.
    // A rate row whose promotional pricing lapsed and has no _list fallback is
    // still pricing with the wrong numbers. Reporting that while persisting the
    // figure would put a known-understated measurement into the trend series.
    if (r.expired_rates && r.expired_rates.length) {
      return refuse(
        `refusing to record: rate row(s) expired with no _list fallback — ${r.expired_rates.map((e) => `${e.model} (${e.expires})`).join(", ")}`,
        "update DEFAULT_RATES in engine/bench/bench.mjs, or give the row a _list fallback so expiry corrects itself",
        { expired_rates: r.expired_rates },
      );
    }
    // `files_scanned > 0` is not evidence of a measurement: a directory of
    // unreadable, malformed, or entirely unpriced transcripts scans fine and
    // prices nothing. What must be non-zero is what was actually PRICED.
    // A partially-priced scan is the dangerous case: an unrecognised model's
    // traffic is dropped, the total comes out lower, and the next delta reads
    // that omission as a saving. Models with no billable tokens (e.g. the
    // `<synthetic>` placeholder) are ignored — they drop nothing.
    const dropping = r.coverage.unpriced_models_with_traffic || {};
    if (Object.keys(dropping).length) {
      return refuse(
        `refusing to record: unpriced model(s) carrying real traffic — ${Object.entries(dropping).map(([m, v]) => `${m} (${v.billable_tokens} tokens)`).join(", ")}`,
        "add a rate row for these in engine/bench/bench.mjs DEFAULT_RATES — recording now would omit their spend and the shortfall would read as a saving",
        { unpriced_models_with_traffic: dropping },
      );
    }
    if (r.coverage.records_priced === 0) {
      const why = r.coverage.files_scanned === 0
        ? `no transcript files found under ${root}`
        : `scanned ${r.coverage.files_scanned} file(s) under ${root} but priced 0 records`;
      return refuse(
        `refusing to record: ${why}`,
        "a zero here would corrupt the trend series rather than describe it — the coverage block says what was skipped and why",
        { coverage: r.coverage },
      );
    }
    ledger = join(detentRoot(), "benchmarks", "spend-ledger.jsonl");
    let prev = null;
    if (existsSync(ledger)) {
      const lines = readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { prev = JSON.parse(lines[i]); break; } catch { /* skip a torn tail line */ }
      }
      // Skipping a torn tail line is fine. Finding NOTHING readable in a
      // non-empty ledger is not: reporting "first line recorded — this is the
      // baseline" would fabricate a fresh start on a machine that has history
      // it merely failed to read. Same class of lie as a fabricated 0% delta.
      if (lines.length > 0 && prev === null) {
        return fail(`spend: ${ledger} has ${lines.length} line(s) but none parse as JSON`,
          "the ledger is corrupt — repair or move it aside; refusing to record a new baseline over unreadable history");
      }
    }
    delta = compareTracking(prev, line);
    mkdirSync(join(detentRoot(), "benchmarks"), { recursive: true });
    // The reader tolerates a torn tail line; the writer must not fuse the new
    // measurement onto it. Without this, one truncated write corrupts the next
    // line too, and the corruption compounds silently.
    let prefix = "";
    if (existsSync(ledger)) {
      const raw = readFileSync(ledger, "utf8");
      if (raw.length > 0 && !raw.endsWith("\n")) prefix = "\n";
    }
    appendFileSync(ledger, prefix + JSON.stringify(line) + "\n");
  }

  out({
    ok: true,
    window_days: days,
    ...r,
    strong_tier_share: line.strong_tier_share,
    tracking: line,
    ...(flags.record ? { recorded_to: ledger, delta } : {}),
    next_step: flags.record
      ? (delta
          ? (delta.comparable
              ? "compare `delta` against the intent: main_cost_per_turn down and subagent_share up mean the offload rule is landing"
              : `delta present but NOT comparable — ${delta.incomparable_reason}`)
          : "first line recorded — this is the baseline; re-run with --record in ~30 days to get a delta")
      : "reconcile total_cost_usd against the usage console — these transcripts are a lower bound, not the invoice",
  });
}

/**
 * cmdPackValidate — deterministic gate the skills run before loading a pack
 * (skills/referee, skills/scout). Exit 0 valid, 2 invalid; every error names the
 * pack path and field. See engine/pack/pack.mjs.
 */
function cmdPackValidate(flags) {
  if (flags.pack === true) refuse("--pack needs a path", "engine pack validate [--pack <path>]");
  let file;
  try {
    file = resolvePackPath({ flag: flags.pack, detentRoot: detentRoot() });
  } catch (e) {
    if (!(e instanceof PackPathError)) throw e;
    return refuse(`invalid pack: ${e.message}`, "fix detent.user.yaml, or pass --pack <path>", { errors: [e.message] });
  }
  const { errors, summary } = validatePackFile(file);
  if (errors.length) {
    return refuse(`invalid pack: ${errors.length} error(s) in ${file}`, "fix the fields named in errors[], then re-run engine pack validate", { errors });
  }
  out({ ok: true, ...summary, next_step: "pack is valid — proceed" });
}

// ---------------------------------------------------------------------------
// engine setup — first-run config. Fills empty detent.user.yaml fields from
// git/gh and writes a starter stack.yaml wired to the built-in adapters.
// ---------------------------------------------------------------------------

const PLACEHOLDER_EMAIL = "you@example.com";

function probeValue(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd, timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function shellQuote(p) {
  return /^[A-Za-z0-9_/.:@%+=,-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

// Fills one empty child of the top-level `user:` block; returns the new
// lines, or null when no safely editable line exists there.
function fillUserKey(lines, key, value) {
  const start = lines.findIndex((l) => /^user:[ \t]*(#.*)?\r?$/.test(l));
  if (start === -1) return null;
  const ph = PLACEHOLDER_EMAIL.replace(".", "\\.");
  let indent = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^[ \t]*#/.test(l)) continue;
    const lead = /^ */.exec(l)[0].length;
    if (lead === 0) return null;
    if (indent === null) indent = lead;
    if (lead !== indent) continue;
    const m = new RegExp(`^( {${indent}}${key}:)[ \\t]*(?:""|''|"${ph}"|${ph})?([ \\t]+#.*?)?([ \\t]*\\r?)$`).exec(l);
    if (!m) continue;
    const out = lines.slice();
    out[i] = `${m[1]} ${JSON.stringify(value)}${m[2] || ""}${m[3].includes("\r") ? "\r" : ""}`;
    return out;
  }
  return null;
}

function starterStack(clone) {
  const adapter = (n) => JSON.stringify(join(clone, "engine", "adapters", n));
  return [
    "# Starter stack.yaml written by `detent setup`. Add other sockets from",
    "# engine/stack.example.yaml in the detent clone as you wire more tools.",
    'engine_version: "1"',
    "",
    "sockets:",
    "  ticket:",
    `    command: ${adapter("gh-ticket")}`,
    '    version: "builtin"',
    "",
    "  knowledge:",
    "    providers:",
    '      - name: "repo-docs"',
    `        command: ${adapter("repo-docs-knowledge")}`,
    '        version: "builtin"',
    "",
    "  bot-comments:",
    `    command: ${adapter("gh-bot-comments")}`,
    '    version: "builtin"',
    "",
  ].join("\n");
}

function cmdSetup(flags) {
  if (!flags.repo || flags.repo === true) {
    return refuse("setup needs the work repo", "detent setup --repo <path-to-work-repo>");
  }
  const repo = resolve(flags.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    return refuse(`--repo is not a directory: ${repo}`, "pass the path of the repo you will work in");
  }
  const g = spawnSync("git", ["-C", repo, "rev-parse", "--git-dir"], { encoding: "utf8" });
  if (g.error || g.status !== 0) {
    return refuse(`${repo} is not a git repo`, "run `git init` there, or pass the path of your work repo");
  }
  const stackPath = join(repo, "stack.yaml");
  if (existsSync(stackPath) && flags.force !== true) {
    return refuse(`${stackPath} already exists`, "keep it, or re-run with --force to overwrite it");
  }

  const clone = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const userPath = join(detentRoot(), "detent.user.yaml");
  const wrote = [];
  const leftAlone = [];
  const unresolved = [];
  const unresolvedReasons = {};

  let text;
  if (existsSync(userPath)) {
    text = readFileSync(userPath, "utf8");
  } else {
    const example = join(clone, "detent.user.example.yaml");
    if (!existsSync(example)) {
      return fail(`template missing: ${example}`, "restore detent.user.example.yaml in the detent clone");
    }
    text = readFileSync(example, "utf8");
    wrote.push(userPath);
  }
  let user;
  try {
    user = parseYamlSubset(text, userPath).user || {};
  } catch (e) {
    return refuse(`failed to parse ${userPath}: ${e.message}`, "fix or delete detent.user.yaml, then re-run detent setup");
  }
  const isEmpty = (v) => v === undefined || v === null || v === "" || v === "''" || v === PLACEHOLDER_EMAIL;
  const gitCmd = process.env.DETENT_GIT_CMD || "git";
  const ghCmd = process.env.DETENT_GH_CMD || "gh";
  const probes = [
    ["name", () => probeValue(gitCmd, ["config", "user.name"], repo)],
    ["email", () => probeValue(gitCmd, ["config", "user.email"], repo)],
    ["github_login", () => probeValue(ghCmd, ["api", "user", "--jq", ".login"], repo)],
  ];
  let changed = false;
  for (const [key, probe] of probes) {
    const dotted = `user.${key}`;
    if (!isEmpty(user[key])) { leftAlone.push(dotted); continue; }
    const value = probe();
    if (value === null) { unresolved.push(dotted); continue; }
    const edited = fillUserKey(text.split("\n"), key, value);
    if (edited === null) {
      unresolved.push(dotted);
      unresolvedReasons[dotted] = `no empty ${key}: line found under the top-level user: block`;
      continue;
    }
    text = edited.join("\n");
    changed = true;
  }
  if (!Array.isArray(user.teams) || user.teams.length === 0) unresolved.push("user.teams");
  if (isEmpty(user.jira_account)) unresolved.push("user.jira_account");
  if (changed || wrote.includes(userPath)) writeFileSync(userPath, text);
  if (!wrote.includes(userPath) && changed) wrote.push(userPath);

  writeFileSync(stackPath, starterStack(clone));
  wrote.push(stackPath);

  out({
    ok: true,
    wrote,
    left_alone: leftAlone,
    unresolved,
    ...(Object.keys(unresolvedReasons).length ? { unresolved_reasons: unresolvedReasons } : {}),
    next_step: `detent run new --ticket <owner/repo#N> --repo ${shellQuote(repo)}` +
      (unresolved.length ? `; fill ${unresolved.join(", ")} in ${userPath} (run \`gh auth login\` first for user.github_login)` : ""),
  });
}

function cmdHelp() {
  out({
    ok: true,
    usage: {
      "setup": "engine setup --repo <path> [--force] — first run: create <DETENT_ROOT>/detent.user.yaml and fill empty user.name/email/github_login from git and gh (never overwrites a set value), and write a starter stack.yaml in the work repo wired to the built-in adapters by absolute path. Refuses (exit 2) if --repo is missing or not a git repo, or if stack.yaml exists without --force. Values it cannot detect are listed in `unresolved`",
      "run new": "engine run new --ticket <ref> [--repo <path>] [--slug <slug>] [--no-worktree] — create a run under the centralized <DETENT_ROOT>/.sdlc/ with a dedicated git worktree (the default flow)",
      "stage begin": "engine stage begin <stage> [--run <id>] [--repo <path>] — enter a stage (refuses illegal transitions)",
      "stage end": "engine stage end <stage> [--run <id>] [--repo <path>] — finish a stage (checks artifact + gates). implement: [--tdd-test <name> --tdd-red <sha> --tdd-green <sha> | --tdd-exempt <reason>] records the tdd block (implement records, never judges). recheck: asserts red_sha is an ancestor of green_sha via git cat-file/merge-base, proving ORDER only, never that the test was observed failing.",
      "gate open": "engine gate open <gate-name-or-decision-id> [--run <id>] [--repo <path>] — render a pending human gate; with curator on PATH it writes <DETENT_ROOT>/.plans/<run>-<gate>.html (one data-plan-question block per pending decision, stage artifacts embedded) and prints `curator open` then `engine gate collect`",
      "gate collect": "engine gate collect --run <id> [--file <feedback.json>] — non-blocking: map curator answers into decisions.json (only an exact decision option resolves one; null/other answers stay pending and are listed under `unresolved`); selection/prompt feedback is appended to <run>/review-feedback.jsonl. Without --file it runs `curator drain` for the run's gate pages only.",
      "socket call": "engine socket call <name> [--payload-file <json>] [--stack <path>] — dispatch a socket per stack.yaml",
      "next": "engine next [--run <id>] [--repo <path>] — print the exact next command for the current run",
      "dashboard": "engine dashboard — render ALL runs under <DETENT_ROOT>/.sdlc/ into one curator artifact (stage, status, pending gates, age)",
      "live": "engine live <run-id> [--run <id>] [--watch [--interval-ms 500] [--timeout-s N]] — render ONE run's streaming live view to <DETENT_ROOT>/.plans/engine-live-<run-id>.html: a coalesced checklist (flips todo/doing -> done in place, ordering preserved) plus the streamed answer pane (kind:answer step chunks, concatenated in order). Read-only; refuses (exit 2) without a run id, for an unknown run, or for a non-finite/non-positive --interval-ms or --timeout-s. Without --watch, renders once and exits. --watch prints its start JSON line first (one-JSON-line contract preserved), then polls events.jsonl + stage-status.json (statSync size/mtime, not fs.watch) and re-renders on change; exits 0 the instant the run is genuinely complete (every stage done|skipped). If --timeout-s elapses first on a still-incomplete run, it exits 3 instead — a distinct code from real completion — after one final render that drops the <meta http-equiv=\"refresh\"> tag and shows an honest \"watch ended (timeout)\" footer, so the artifact is never left looking live or indistinguishable from a finished run. curator re-reads the artifact from disk on every GET (Cache-Control: no-store), so this streams through curator AND plain file:// alike, no server changes.",
      "bench": "engine bench <run-id> [--rates <json>] [--checkpoint [--reason <str>] [--gate <id>]] — compute the run's benchmark (phase timings, human-gate & async-external wait, effective agentic time, tokens/models/cost); writes <run>/benchmark.json and appends benchmarks/ledger.jsonl. --checkpoint writes a PARTIAL benchmark of work-so-far (before a human/async wait) and appends <run>/benchmark-checkpoints.jsonl — human gates via the engine auto-checkpoint; call it manually when a skill parks on its own async gate",
      "eval": "engine eval [--suite <S>[,S2]] [--changed] [--pr <N|url>] [--baseline <path>] [--k <N>] [--no-judge] [--rebaseline] [--detent-root <path>] [--quiet] — offline eval harness (evals/config.yaml + evals/baseline.json): runs suites, compares to the committed baseline within a variance band, prints UPGRADE|NEUTRAL|DEGRADE and appends benchmarks/ledger.jsonl (always one JSON line on stdout, no --json flag needed — that IS the machine channel). Unless --quiet, also writes a plain-English human report to stderr (render.mjs's renderHuman/renderRebaseline). --rebaseline atomically rewrites evals/baseline.json instead of emitting a verdict. A DEGRADE exits 2 only once evals/config.yaml's gate is blocking AND its burn-in has armed (EVAL_BLOCKING=on|off overrides); result JSON always carries gate:{mode,burn_in_prs,green_baselines,armed} and selection:{mode,suites}. See engine/eval/README.md",
      "respond": "engine respond --pr <url|number> [--repo <path>] [--slug <slug>] [--no-worktree] — synthetic standalone entry: arm the respond stage directly against an already-open PR (no ticket/brief/plan). Refuses (exit 2) a closed/draft/fork PR; every prior stage is written 'skipped' (never faked 'done') and the run carries synthetic:true + entry:'respond-pr'. Worktree checks out the PR's own head branch (fetch + `git worktree add`, not a new sdlc/ branch); --no-worktree opts out.",
      "step": "engine step <label> --run <id> [--repo <path>] [--kind tool|thinking|plan] [--status todo|doing|done] — record one explicitly-emitted checklist entry for the live-view MVP (see engine/cli/README.md's \"Live-view MVP\" section); additive to events.jsonl only, no stage-status or gate interaction. Refuses (exit 2) without a label or --run.",
      "advisor consult": "engine advisor consult --run <id> [--repo <path>] --trigger <gate-id|stage|free-text> [--model fable] — escalate-on-block: consult a STRONG-tier advisor (engine/routing/routing.json). RECOMMEND-ONLY by schema invariant: refuses (exit 2) a non-strong-tier --model or any of --apply/--answer/--unblock. Appends one advisor_consult event to events.jsonl and creates <run>/advisor/ for the recommendation; never touches decisions.json or stage-status.json. See engine/routing/README.md and docs/model-routing.md.",
      "handoff": "engine handoff <run-id> [--stage <s>] [--force] — close an EPISODE: write <run>/handoff/<stage>.md, the successor-facing index a fresh session reads instead of resuming this one. Refuses (exit 2) if the handoff would lose something a successor needs (no failed-approach log at implement, no recorded verify command, no brief) — --force writes it anyway, marked INCOMPLETE. Read-only apart from that one file. Rationale and the cache-TTL measurement behind it: engine/handoff/handoff.mjs.",
      "spend": "engine spend [--days 30] [--root <dir>] — what Claude Code actually cost, measured from local transcripts under ~/.claude/projects (recursive: sub-agent transcripts nest under <session>/subagents/). Reports by_origin (main vs sub-agent), by_model, by_day, strong_tier_share, and a `coverage` block (files scanned, records deduped, unpriced models) so a silent under-scan is visible. The total is a LOWER BOUND — reconcile against the usage console.",
      "attempt": "engine attempt \"<approach>\" --run <id> --outcome failed|abandoned|superseded [--evidence \"<why>\"] [--stage <s>] | engine attempt --none --run <id> — record an approach that did NOT work, appended to <run>/attempts.jsonl. Uncapped and append-only: this is what stops a fresh session re-walking a dead end, and it is a HARD requirement of the handoff from implement onward.",
      "env": "engine env --run <id> --verify \"<cmd>\" [--build|--start|--lint \"<cmd>\"] [--gotcha \"<trap>\"] — record how this repo is run, into <run>/env.json. `--verify` is mandatory from implement onward: without it a successor cannot check its own work.",
      "decide-why": "engine decide-why --run <id> --decision <D-00N> --option \"<opt>\" --why \"<reason>\" — record WHY a discarded option lost, into <run>/decision-rationale.jsonl. A SIDECAR, never a field on the decision: CONTRACT.md forbids rewriting an answered decision, and curator records only {question, answer}. The handoff treats a discard with no recorded reason as a hard gap, because knowing an option lost does not stop a successor relitigating it. Refuses an unknown decision id, the answer itself, or an option nobody offered.",
      "pack validate": "engine pack validate [--pack <path>] — validate a provider pack (path: --pack, else detent.user.yaml pack.path, else packs/example/stack.yaml) and print which providers/lenses are ON vs OFF; exit 2 with errors[] naming the path and field when invalid",
      "help": "engine help (or --help) — this usage, exit 0",
    },
    stages: STAGES,
    exit_codes: { 0: "ok", 1: "provider/environment failure", 2: "refusal (illegal transition, contract violation)" },
    next_step: "pick a command above — full docs in engine/cli/README.md",
  });
}

function main() {
  const { positional, flags, duplicates } = parseArgs(process.argv.slice(2));
  if (duplicates.length) {
    refuse(
      `flag(s) given more than once: ${duplicates.map((d) => `--${d}`).join(", ")}`,
      `only ${[...REPEATABLE_FLAGS].map((f) => `--${f}`).join(", ")} may repeat — pass the others once, so no value is silently dropped`,
    );
  }
  const [a, b, c] = positional;
  if (a === "help" || flags.help === true) return cmdHelp();
  if (a === "setup") return cmdSetup(flags);
  if (a === "run" && b === "new") return cmdRunNew(flags);
  if (a === "stage" && b === "begin") return cmdStageBegin(c, flags);
  if (a === "stage" && b === "end") return cmdStageEnd(c, flags);
  if (a === "gate" && b === "open") return cmdGateOpen(c, flags);
  if (a === "gate" && b === "collect") return cmdGateCollect(flags);
  if (a === "socket" && b === "call") return cmdSocketCall(c, flags);
  if (a === "next") return cmdNext(flags);
  if (a === "dashboard") return cmdDashboard();
  if (a === "live") return cmdLive(b, flags);
  if (a === "bench") return cmdBench(b, flags);
  if (a === "eval") return cmdEval(flags);
  if (a === "respond") return cmdRespond(flags);
  if (a === "step") return cmdStep(b, flags);
  if (a === "advisor" && b === "consult") return cmdAdvisorConsult(flags);
  if (a === "handoff") return cmdHandoff(b, flags);
  if (a === "spend") return cmdSpend(flags);
  if (a === "pack" && b === "validate") return cmdPackValidate(flags);
  if (a === "attempt") return cmdAttempt(b, flags);
  if (a === "env") return cmdEnv(flags);
  if (a === "decide-why") return cmdDecideWhy(flags);
  refuse(`unknown command: ${positional.join(" ") || "(none)"}`, USAGE);
}

function internalError(e) {
  // Loud, structured, never silent (error-handling rule: no swallowed errors).
  out({ ok: false, reason: `engine internal error: ${e.message}`, next_step: "this is a bug in engine.mjs — read the stack", stack: e.stack }, 1);
}

try {
  const pending = main();
  if (pending && typeof pending.catch === "function") pending.catch(internalError);
} catch (e) {
  internalError(e);
}
