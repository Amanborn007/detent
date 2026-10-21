// Text view of an engine result, for a human at a terminal. The JSON line stays the
// machine layer; this module is pure so it can be tested without a TTY.

const MARKS = { done: "✓", skipped: "-", in_progress: "■", blocked: "■", pending: "·" };

/** Say a next_step command in words. Anything not recognised passes through. */
export function describeNext(step) {
  if (typeof step !== "string") return "";
  const m = /^(?:engine|detent) (stage begin|stage end|gate open|gate collect) ?(\S+)?/.exec(step);
  if (!m) return step;
  const [, verb, arg] = m;
  if (verb === "stage begin") return `Begin the ${arg} stage. (${step})`;
  if (verb === "stage end") return `Finish the ${arg} stage. (${step})`;
  if (verb === "gate open") return `Open the ${arg} gate so a human can answer it. (${step})`;
  return `Collect the answers from the review page. (${step})`;
}

function stageLines(stages) {
  return Object.entries(stages).map(([name, s]) => {
    const note = s.status === "blocked" && s.blocked_on?.length ? `  (waiting on ${s.blocked_on.join(", ")})` : "";
    return `  ${MARKS[s.status] || "?"} ${name}${note}`;
  });
}

export function renderText(obj, ctx = {}) {
  const lines = [];
  if (obj.checks) {
    for (const c of obj.checks) lines.push(`${c.status} ${c.name}: ${c.detail}`);
  } else if (obj.ok === false) lines.push(`Refused: ${obj.reason}`);
  if (obj.run_id) lines.push(`Run ${obj.run_id}${ctx.ticket ? ` (${ctx.ticket})` : ""}`);
  if (ctx.stages) lines.push(...stageLines(ctx.stages));
  else if (obj.stage) lines.push(`  stage ${obj.stage}: ${obj.status}`);
  if (ctx.gates?.length) {
    lines.push("Waiting on a human:");
    for (const g of ctx.gates) {
      lines.push(`  ${g.id}${g.gate ? ` ${g.gate}` : ""}: ${g.question || ""}`.trimEnd());
      if (g.options?.length) lines.push(`    options: ${g.options.join(" | ")}`);
    }
  }
  if (obj.ok !== false && !obj.run_id && !obj.checks) {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "ok" || k === "next_step") continue;
      if (["string", "number", "boolean"].includes(typeof v)) lines.push(`${k}: ${v}`);
      else if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string")) {
        for (const [name, text] of Object.entries(v)) lines.push(`  ${name}: ${text.split(" — ")[0]}`);
      }
    }
  }
  if (obj.next_step) lines.push(`Next: ${describeNext(obj.next_step)}`);
  return lines.join("\n");
}
