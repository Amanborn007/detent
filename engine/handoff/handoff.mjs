/**
 * handoff — make a run survive the end of the session that started it.
 *
 * WHY THIS EXISTS
 *   A turn that resumes a session whose prompt cache has expired re-uploads the
 *   whole conversation, so it costs many times a warm turn. `engine spend`
 *   reports that cold share for your own traffic.
 *
 *   The cheap fix is to stop resuming: end the session at a gate and start the
 *   next stage fresh. CONTRACT.md already mandates that shape ("Stages
 *   communicate ONLY through these files") and already warns that a gate can
 *   park for "hours or days" — well past any cache TTL.
 *
 *   The reason nobody does it is quality, not cost. A successor that has to
 *   rediscover what its predecessor already knew is slower, and worse, it
 *   re-tries approaches that were already ruled out and re-derives conclusions
 *   with subtly different premises. Cost always argues for a shorter session;
 *   quality is the binding constraint. So the artifacts below exist to make the
 *   boundary lossless, and `checkSufficiency()` refuses to certify a boundary
 *   that isn't.
 *
 * WHAT A SUCCESSOR NEEDS — the six questions, and where each is answered
 *   1. What are we doing?            brief.md              (existing)
 *   2. What did we decide, and why?  decisions.json        (existing, extended
 *                                    with `rejected_options`)
 *   3. What was tried and failed?    attempts.jsonl        (NEW)
 *   4. How do I run things here?     env.json              (NEW)
 *   5. Where are we?                 stage-status.json     (existing)
 *   6. What is still open?           decisions.json pending (existing)
 *
 *   Only 3 and 4 are new. The rest already exist and are simply unread at a
 *   boundary today. The dominant handoff failure is not a missing brief — it is
 *   a successor confidently re-walking a dead end, so 3 carries the most weight.
 *
 * TWO CAPS, AND WHY THEY DIFFER
 *   `attempts.jsonl` is UNCAPPED. A long run accumulates dozens of distinct
 *   failed approaches, so any fixed cap would silently discard most of the
 *   record, and the whole point is that a dead end stays dead.
 *
 *   The generated NOTE projects at most `NOTE_ATTEMPTS` (5) of them. That is a
 *   different question — not "what should we keep" but "how many can a reader
 *   act on". Relevance-ranked guidance peaks at k=3 and is already degrading by
 *   k=5, so 5 is the top of the useful band, not a storage budget. The full log
 *   is one file read away and the note says so.
 *
 * PURE. Reads a run directory; never writes. Callers own all writes, matching
 * the bench.mjs / routing.mjs idiom. Node >= 18. Zero dependencies.
 */
"use strict";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const HANDOFF_SCHEMA = "detent-handoff-v1";

/** Attempts to project into a generated note. See "TWO CAPS" above. */
export const NOTE_ATTEMPTS = 5;

/**
 * Target size for a generated note, in tokens (~4 chars/token).
 *
 * Sized against the stage artifacts it sits beside (brief, plan, research):
 * a note read at the START of every episode belongs at the small end of that
 * range — an index into the run, not a summary of it. The cost of trimming it
 * further is noise, so the number is set by readability.
 *
 * ADVISORY, not enforced: truncating a handoff to hit a byte budget is exactly
 * the silent quality loss this module exists to prevent. `buildNote()` reports
 * `over_target` and lets the caller decide.
 */
export const NOTE_TARGET_TOKENS = 1000;

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`handoff: invalid JSON in ${path}: ${e.message}`);
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const rows = [];
  raw.split("\n").forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      rows.push(JSON.parse(s));
    } catch (e) {
      throw new Error(`handoff: invalid JSON on line ${i + 1} of ${path}: ${e.message}`);
    }
  });
  return rows;
}

/**
 * Load every handoff-relevant artifact from a run directory.
 *
 * A missing file reads as `null`, never as an empty default: "no attempts were
 * recorded" and "nothing was ever tried" are different claims, and collapsing
 * them is how a successor concludes a dead end is unexplored.
 */
export function loadRunState(runDir) {
  return {
    run: readJsonIfPresent(join(runDir, "run.json")),
    decisions: readJsonIfPresent(join(runDir, "decisions.json")),
    stageStatus: readJsonIfPresent(join(runDir, "stage-status.json")),
    attempts: readJsonl(join(runDir, "attempts.jsonl")),
    // Why each discarded option lost. A SIDECAR, not a field on the decision:
    // CONTRACT.md forbids rewriting an answered decision, and curator — the only
    // thing permitted to write an answer — records just {question, answer}.
    rationale: readJsonl(join(runDir, "decision-rationale.jsonl")),
    env: readJsonIfPresent(join(runDir, "env.json")),
    hasBrief: existsSync(join(runDir, "brief.md")),
    hasResearch: existsSync(join(runDir, "research.md")),
    hasPlan: existsSync(join(runDir, "plan", "plan.md")),
  };
}

/**
 * Which stages are blocked by a still-pending decision.
 * Mirrors the gate rule in CONTRACT.md; a decision with no explicit `blocks`
 * defaults to blocking `implement`.
 */
export function pendingGates(decisions) {
  if (!Array.isArray(decisions)) return [];
  return decisions
    .filter((d) => d && d.status === "pending")
    .map((d) => ({ id: d.id, question: d.question, blocks: d.blocks || ["implement"] }));
}

/**
 * A well-formed `rejected_options` entry: an option AND why it lost.
 *
 * Any truthy value used to pass — `{}`, `""`, `[]` — while `buildNote` renders
 * only non-empty arrays, so a decision could certify a handoff and then show a
 * successor nothing at all.
 */
function validRejectedOptions(v) {
  if (!Array.isArray(v) || v.length === 0) return false;
  // The documented shape only. A bare string cannot say WHICH option it refers
  // to, so accepting one meant validating an entry that then produced no reason
  // — passing the check and failing the reader.
  return v.every((r) => r && typeof r === "object" && !Array.isArray(r) &&
    typeof r.option === "string" && r.option.trim() &&
    typeof r.why_not === "string" && r.why_not.trim());
}

/** Reasons recorded in the sidecar for one decision: option -> why. */
function rationaleFor(state, decisionId) {
  const out = {};
  for (const r of state.rationale || []) {
    if (r && r.decision === decisionId && typeof r.option === "string" && typeof r.why === "string") {
      out[r.option] = r.why;
    }
  }
  return out;
}

/**
 * The discards for an answered decision, and whether each carries a reason.
 * Explicit `rejected_options` wins; otherwise options-minus-answer, annotated
 * from the rationale sidecar where available.
 */
export function discardsFor(state, d) {
  if (validRejectedOptions(d.rejected_options)) {
    return d.rejected_options.map((r) => ({ option: r.option, why_not: r.why_not, source: "rejected_options" }));
  }
  const why = rationaleFor(state, d.id);
  const opts = Array.isArray(d.options) ? d.options.filter((o) => o !== d.answer) : [];
  return opts.map((o) => ({ option: o, why_not: why[o] ?? null, source: why[o] ? "rationale" : "derived" }));
}

/**
 * Is this run safe to hand to a fresh session?
 *
 * Returns `{ sufficient, missing[], warnings[], stage }`. `missing` is a hard
 * gap — a successor would have to rediscover something that was already known,
 * which is the failure mode that makes episodes cost more than they save.
 * `warnings` are soft: real but not disqualifying.
 *
 * Requirements are stage-aware. Demanding an implementation environment before
 * intake has run would make the check noise, and a check that cries wolf gets
 * ignored, which is worse than not having one.
 */
export function checkSufficiency(state, { stage = null } = {}) {
  const missing = [];
  const warnings = [];
  const s = stage || currentStage(state.stageStatus);

  // 1. What are we doing. Required always: without it a successor cannot even
  //    judge whether the rest is relevant.
  if (!state.run) missing.push("run.json — run identity (ticket, repos, branch) is absent");
  // `engine respond --pr` deliberately creates no brief: the PR itself IS the
  // task statement, and run.json records which one. Demanding a brief there
  // would make every synthetic run permanently incomplete — the check would be
  // wrong, not the run.
  const syntheticFromPr = state.run && (state.run.entry === "respond-pr" || state.run.synthetic === true);
  if (!state.hasBrief) {
    if (!syntheticFromPr) {
      missing.push("brief.md — the successor has no statement of the task");
    } else if (!state.run.pr && !state.run.pr_url && !state.run.pr_number) {
      missing.push("brief.md absent and run.json names no PR — a respond run must point at the PR that IS its task statement");
    } else {
      warnings.push("no brief.md — this is a respond-pr run, so the PR in run.json stands as the task statement");
    }
  }

  // 2/6. Decisions, and what is still open. `null` is distinct from `[]`:
  //      "no decisions file" means the gate record was never established.
  if (state.decisions === null) {
    missing.push("decisions.json — no record of what was decided or what is still open");
  } else if (!Array.isArray(state.decisions)) {
    missing.push("decisions.json — must be an array of decision blocks");
  } else {
    for (const d of state.decisions) {
      if (!d || d.status !== "answered") continue;
      const discards = discardsFor(state, d);
      // An answered decision with no alternatives has nothing to relitigate.
      if (discards.length === 0) {
        if (!Array.isArray(d.options) && !d.rejected_options) {
          missing.push(`decision ${d.id} records an answer with no options list and no rejected_options — a successor cannot tell what was already ruled out`);
        }
        continue;
      }
      // HARD, not a warning. Knowing an option lost does not stop a successor
      // relitigating it; only the reason does, and the boundary claims to be
      // lossless. `engine decide-why` is the producer, so this is satisfiable
      // without amending an answered decision (which CONTRACT.md forbids).
      const unreasoned = discards.filter((x) => !x.why_not).map((x) => x.option);
      if (unreasoned.length) {
        missing.push(`decision ${d.id} discarded ${unreasoned.map((o) => JSON.stringify(o)).join(", ")} with no recorded reason — record why with: engine decide-why --run <id> --decision ${d.id} --option <opt> --why "<reason>"`);
      }
    }
  }

  // 3. What was tried and failed. The highest-value artifact at a boundary.
  // Must match engine/cli/engine.mjs STAGES. "review"/"pr" are prose names
  // from the CONTRACT header, not real stage keys — they never match.
  const postResearch = ["implement", "recheck", "ship", "respond"].includes(s);
  if (state.attempts === null) {
    if (postResearch) {
      missing.push("attempts.jsonl — no failed-approach log; a successor will re-try dead ends");
    } else {
      warnings.push("attempts.jsonl absent — acceptable this early, required from implement onward");
    }
  }

  // 4. How to run things here. Only meaningful once code gets touched, but by
  //    then rediscovering the test command is a guaranteed repeated cost.
  if (postResearch) {
    if (!state.env) {
      missing.push("env.json — no recorded verify/build commands; a successor must rediscover how to run this repo");
    } else if (!state.env.commands || !state.env.commands.verify) {
      missing.push("env.json — `commands.verify` is unset; the successor cannot close the loop on its own work");
    }
  }

  // 5. Where are we.
  if (!state.stageStatus) {
    missing.push("stage-status.json — the successor cannot tell which stage is live");
  }

  // A run parking on a gate must say so explicitly; a successor that misses a
  // pending gate will walk straight through it, which the gate rule forbids.
  const gates = pendingGates(state.decisions);
  if (gates.length) {
    warnings.push(`${gates.length} pending decision(s) block: ${[...new Set(gates.flatMap((g) => g.blocks))].join(", ")}`);
  }

  return { sufficient: missing.length === 0, missing, warnings, stage: s, pending_gates: gates };
}

/**
 * Best-effort guess at the live stage: `in_progress`, else `blocked`, else the
 * last `done`.
 *
 * `blocked` MUST be checked — a run parked on a gate has just been set to
 * `blocked`, and without this the guess falls through to the previous `done`
 * stage and names the wrong one.
 *
 * This is a FALLBACK. Any caller that already knows the stage must pass it
 * explicitly: after a stage completes, every earlier stage is also `done`, so
 * no inspection of the file can recover which one just finished.
 */
export function currentStage(stageStatus) {
  if (!stageStatus || !stageStatus.stages) return null;
  const entries = Object.entries(stageStatus.stages);
  const running = entries.find(([, v]) => v && v.status === "in_progress");
  if (running) return running[0];
  const blocked = entries.find(([, v]) => v && v.status === "blocked");
  if (blocked) return blocked[0];
  let last = null;
  for (const [k, v] of entries) if (v && v.status === "done") last = k;
  return last;
}

/**
 * Rank attempts for projection into a note.
 *
 * Recency last-wins on ties: the most recent dead ends are the ones a successor
 * is most likely to walk back into, because they are the ones closest to the
 * current state of the code.
 */
export function rankAttempts(attempts, limit = NOTE_ATTEMPTS) {
  if (!Array.isArray(attempts)) return [];
  const weight = { failed: 3, abandoned: 2, superseded: 1 };
  return attempts
    .map((a, i) => ({ a, i, w: weight[a && a.outcome] ?? 0 }))
    .sort((x, y) => (y.w - x.w) || (y.i - x.i))
    .slice(0, limit)
    .map((x) => x.a);
}

/**
 * Render the successor-facing note.
 *
 * Deliberately an INDEX, not a summary: every section points at the file that
 * holds the full record. Summarizing here would create a second, lossy copy of
 * state that already exists in the run directory, and the two would drift.
 */
export function buildNote(state, { stage = null } = {}) {
  const s = stage || currentStage(state.stageStatus);
  const suff = checkSufficiency(state, { stage: s });
  const L = [];

  L.push(`# Handoff — ${state.run?.run_id ?? "(unknown run)"}`);
  L.push("");
  L.push(`Stage: **${s ?? "unknown"}**${state.run?.ticket_ref ? ` · Ticket: ${state.run.ticket_ref}` : ""}`);
  L.push("");
  L.push("You are resuming a run you did not start. Everything below is a pointer");
  L.push("into `.sdlc/<run-id>/` — read the file, do not trust this summary alone.");
  L.push("");

  if (!suff.sufficient) {
    L.push("## ⚠ This handoff is INCOMPLETE");
    L.push("");
    L.push("The following would have to be rediscovered. Treat any conclusion that");
    L.push("depends on them as degraded, and say so rather than papering over it:");
    L.push("");
    for (const m of suff.missing) L.push(`- ${m}`);
    L.push("");
  }

  if (suff.pending_gates.length) {
    L.push("## Open gates — do NOT proceed past these");
    L.push("");
    for (const g of suff.pending_gates) {
      L.push(`- **${g.id}** (blocks: ${g.blocks.join(", ")}) — ${g.question}`);
    }
    L.push("");
  }

  const answered = (state.decisions || []).filter((d) => d && d.status === "answered");
  if (answered.length) {
    L.push("## Settled — do not relitigate");
    L.push("");
    for (const d of answered) {
      L.push(`- **${d.id}**: ${d.answer}`);
      for (const x of discardsFor(state, d)) {
        // Provenance matters to a reader: a recorded reason can be trusted, a
        // derived discard only tells them the option lost.
        L.push(x.why_not
          ? `  - rejected: ${x.option} — ${x.why_not}`
          : `  - rejected (no reason recorded): ${x.option}`);
      }
    }
    L.push("");
  }

  const ranked = rankAttempts(state.attempts);
  if (ranked.length) {
    const total = state.attempts.length;
    L.push("## Already tried — these did not work");
    L.push("");
    for (const a of ranked) {
      L.push(`- [${a.outcome}] ${a.approach}${a.evidence ? ` — ${a.evidence}` : ""}`);
    }
    if (total > ranked.length) {
      L.push("");
      L.push(`_${total - ranked.length} further attempt(s) in \`attempts.jsonl\` — read it before proposing an approach._`);
    }
    L.push("");
  }

  if (state.env?.commands) {
    L.push("## How to run things here");
    L.push("");
    for (const [k, v] of Object.entries(state.env.commands)) L.push(`- \`${k}\`: \`${v}\``);
    if (Array.isArray(state.env.gotchas) && state.env.gotchas.length) {
      L.push("");
      for (const g of state.env.gotchas) L.push(`- ⚠ ${g}`);
    }
    L.push("");
  }

  L.push("## Read next");
  L.push("");
  if (state.hasBrief) L.push("- `brief.md` — what this run is for");
  if (state.hasResearch) L.push("- `research.md` — what the codebase already does");
  if (state.hasPlan) L.push("- `plan/plan.md` — the approved approach");
  L.push("- `decisions.json` — full decision record");
  if (state.attempts) L.push("- `attempts.jsonl` — full failed-approach log");

  const text = L.join("\n") + "\n";
  const tokens = Math.round(text.length / 4);
  return {
    schema: HANDOFF_SCHEMA,
    stage: s,
    text,
    estimated_tokens: tokens,
    over_target: tokens > NOTE_TARGET_TOKENS,
    sufficient: suff.sufficient,
    missing: suff.missing,
    warnings: suff.warnings,
  };
}
