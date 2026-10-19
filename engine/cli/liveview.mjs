/**
 * engine/cli/liveview.mjs — pure, zero-dependency helpers for the completed
 * live view (`engine live`, roadmap #6, completes 530aaf0's deferred half).
 *
 * D1 (files authoritative, events.jsonl additive-only) is untouched by this
 * module: it only READS the log the engine itself already writes at
 * `engine step` / `stage_begin` / `stage_end` / `gate_raised` /
 * `gate_answered` call sites. The one additive schema change is a new `step`
 * `kind` value, `"answer"` — a streamed final-answer chunk, never a
 * checklist item.
 *
 * Coalescing (the flip semantics the MVP was missing): each checklist item
 * has an identity key —
 *   - `step` events (kind tool|thinking|plan): `<kind>\0<label>`
 *   - `stage_begin`/`stage_end`: `stage:<stage>` (doing -> done)
 *   - `gate_raised`/`gate_answered`: `gate:<gate-or-decision-id>` (raise
 *     writes `gate: gateDef.name`, answer writes `gate: d.gate || d.id` —
 *     labels match, verified against engine.mjs's cmdStageEnd/cmdGateOpen)
 * The FIRST occurrence of a key fixes the item's position in the list
 * (ordering preserved); every later occurrence updates `status` + `ts_last`
 * only — last-wins, honest to the log, never a fabricated monotonic
 * progression (see docs/benchmarking.md's `{recorded:false}` doctrine —
 * same spirit: report what's real, never smooth it over).
 */
"use strict";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Kept here (not duplicated in engine.mjs) since this module is the schema
// authority for `step` events; engine.mjs's `cmdStep` imports these for its
// own --kind/--status flag validation.
export const STEP_KINDS = ["tool", "thinking", "plan", "answer"];
export const STEP_STATUSES = ["todo", "doing", "done"];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Derive the ordered, coalesced checklist + streamed answer text from a run's
 * events.jsonl *text* (pure — no I/O). Tolerates an absent/corrupt log: a bad
 * line is skipped, never thrown. `steps_recorded` is always `true` here
 * (text was supplied); the absent-log case lives in `readSteps()` below, per
 * the honesty rule (never render an empty-but-complete checklist as if the
 * log were simply empty).
 */
export function deriveSteps(text) {
  const steps = [];
  const indexByKey = new Map();
  const answerParts = [];

  const upsert = (key, kind, label, status, ts) => {
    if (indexByKey.has(key)) {
      const item = steps[indexByKey.get(key)];
      item.status = status;
      item.ts_last = ts;
    } else {
      indexByKey.set(key, steps.length);
      steps.push({ kind, label, status, ts, ts_last: ts });
    }
  };

  if (typeof text === "string") {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // corrupt line — skip, never throw
      }
      if (!e || typeof e.event !== "string") continue;
      const ts = e.ts || null;

      if (e.event === "step") {
        const kind = STEP_KINDS.includes(e.kind) ? e.kind : "tool";
        const label = typeof e.label === "string" ? e.label : "";
        if (kind === "answer") {
          // A streamed final-answer chunk — NOT a checklist item. Chunks
          // concatenate in event order (append-only log = arrival order).
          answerParts.push(label);
          continue;
        }
        const status = STEP_STATUSES.includes(e.status) ? e.status : "todo";
        upsert(`${kind}\0${label}`, kind, label, status, ts);
      } else if (e.event === "stage_begin" && typeof e.stage === "string") {
        upsert(`stage:${e.stage}`, "stage", `stage: ${e.stage}`, "doing", ts);
      } else if (e.event === "stage_end" && typeof e.stage === "string") {
        upsert(`stage:${e.stage}`, "stage", `stage: ${e.stage}`, "done", ts);
      } else if (e.event === "gate_raised") {
        const name = e.gate || e.decision_id || "?";
        upsert(`gate:${name}`, "gate", `gate: ${name}`, "todo", ts);
      } else if (e.event === "gate_answered") {
        const name = e.gate || e.decision_id || "?";
        upsert(`gate:${name}`, "gate", `gate: ${name}`, "done", ts);
      }
      // Any other event kind is outside the checklist's concern — ignored.
    }
  }

  return {
    steps,
    answer: { recorded: answerParts.length > 0, text: answerParts.join("") },
    steps_recorded: true,
  };
}

/**
 * File wrapper over deriveSteps(): an absent or unreadable events.jsonl is
 * distinguished from a real-but-empty log via `steps_recorded:false` (D1
 * honesty rule — never render an empty-but-checked-off checklist as if it
 * were simply an empty, valid log).
 */
export function readSteps(runDir) {
  const p = join(runDir, "events.jsonl");
  if (!existsSync(p)) {
    return { steps: [], answer: { recorded: false, text: "" }, steps_recorded: false };
  }
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return { steps: [], answer: { recorded: false, text: "" }, steps_recorded: false };
  }
  return deriveSteps(text);
}

/** Every stage in stage-status.json is `done` or `skipped` -> the run is complete. */
export function isRunComplete(status) {
  if (!status || typeof status !== "object" || !status.stages || typeof status.stages !== "object") {
    return false;
  }
  const entries = Object.values(status.stages);
  if (entries.length === 0) return false;
  return entries.every((s) => s && (s.status === "done" || s.status === "skipped"));
}

const STEP_MARK = { done: "&#9745;", doing: "&#9655;", todo: "&#9744;" };

function renderChecklist(steps, stepsRecorded) {
  if (!stepsRecorded || !steps || steps.length === 0) {
    return `<p class="none">no steps recorded</p>`;
  }
  const items = steps.map((s) =>
    `<li>${STEP_MARK[s.status] || STEP_MARK.todo} ${escapeHtml(s.label)} <span class="sub">[${escapeHtml(s.kind)}]</span></li>`,
  ).join("");
  return `<ul class="steps">${items}</ul>`;
}

function renderAnswerPane(answer) {
  if (!answer || !answer.recorded) return ""; // honesty: no chunks -> pane omitted entirely
  return `<h2>answer</h2><pre class="answer">${escapeHtml(answer.text)}</pre>`;
}

function badge(status) {
  const cls = { pending: "b-pending", in_progress: "b-progress", blocked: "b-blocked", done: "b-done", skipped: "b-skipped" }[status] || "b-pending";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

/**
 * Render the self-contained per-run live-view artifact. Zero external URLs;
 * inline CSS matching engine dashboard's (system fonts, `color-scheme: light
 * dark`). The mechanism that makes this stream through curator AND plain
 * `file://` alike: curator re-reads the artifact from disk on every GET with
 * `Cache-Control: no-store` (engine/curator/server.mjs) — a per-run watch
 * loop just keeps rewriting this file, and a `<meta http-equiv="refresh">`
 * (present ONLY while the run is live) reloads the page. On completion the
 * refresh tag is dropped — the final render is stable for curator annotation.
 * The refresh tag is also dropped when a --watch process gives up on its
 * `--timeout-s` deadline (`timedOut: true`) even though the run itself is
 * still incomplete: nothing is left rewriting the file, so leaving the tag
 * in place would spin forever, and the footer says so honestly rather than
 * looking like real completion.
 */
export function renderLiveHtml({
  run_id, ticket_ref = null, stage = null, stage_status = null, complete = false,
  steps = [], steps_recorded = false, answer = { recorded: false, text: "" },
  refreshSeconds = 2, timedOut = false, timedOutAt = null,
}) {
  // The refresh tag means "this process is still rewriting the artifact" —
  // that's false once genuinely complete AND once a --watch process has
  // given up on a timeout (timedOut), even though the run itself is still
  // incomplete in the timedOut case. Never leave a stale "live" tag ticking
  // forever with nothing left rewriting the file.
  const refreshTag = complete || timedOut ? "" : `<meta http-equiv="refresh" content="${refreshSeconds}">`;
  const footer = timedOut
    ? `<p class="footer">watch ended (timeout) — run still in progress as of ${escapeHtml(timedOutAt || "")}</p>`
    : complete
      ? `<p class="footer">run complete</p>`
      : `<p class="footer live">live — auto-refreshes every ${refreshSeconds}s</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshTag}
<title>engine live — ${escapeHtml(run_id)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; min-width: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 2rem auto; max-width: 56rem; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.05rem; margin-top: 1.5rem; }
  .hint { opacity: .7; font-size: .85rem; margin-bottom: 1rem; word-break: break-all; }
  table.meta { border-collapse: collapse; margin-bottom: 1rem; }
  table.meta th, table.meta td { text-align: left; padding: .25rem .6rem .25rem 0; vertical-align: top; }
  table.meta th { opacity: .65; font-weight: 600; white-space: nowrap; }
  code { font-size: .85em; }
  .sub { opacity: .65; font-size: .8rem; }
  .badge { padding: .1rem .5rem; border-radius: .6rem; font-size: .78rem; white-space: nowrap; }
  .b-pending  { background: rgba(128,128,128,.22); }
  .b-progress { background: rgba( 70,130,240,.28); }
  .b-blocked  { background: rgba(220, 80, 60,.30); }
  .b-done     { background: rgba( 60,170, 90,.28); }
  .b-skipped  { background: rgba(128,128,128,.28); }
  .none { opacity: .5; }
  .steps { margin: .4rem 0 0; padding-left: 1.2rem; list-style: none; }
  .steps li { margin: .25rem 0; }
  .answer { white-space: pre-wrap; word-break: break-word; background: rgba(128,128,128,.12);
            border-radius: .5rem; padding: .75rem 1rem; font-family: inherit; }
  .footer { margin-top: 1.75rem; opacity: .7; font-size: .85rem; }
  .footer.live::before { content: "\\25CF "; color: rgb(60,170,90); }
</style>
</head>
<body>
<h1>engine live — <code>${escapeHtml(run_id)}</code></h1>
${ticket_ref ? `<p class="hint">${escapeHtml(ticket_ref)}</p>` : ""}
<table class="meta">
  <tr><th>stage</th><td>${stage ? escapeHtml(stage) : (complete ? "complete" : "unknown")}</td></tr>
  <tr><th>status</th><td>${stage_status ? badge(stage_status) : ""}</td></tr>
</table>
<h2>steps</h2>
${renderChecklist(steps, steps_recorded)}
${renderAnswerPane(answer)}
${footer}
</body>
</html>
`;
}
