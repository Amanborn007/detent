// The page a human reads before answering a gate. Pure: reads the run directory, returns html and the
// warnings the caller records. Page order follows engine/stages/plan/SKILL.md step 6.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, renderInline, slugify } from "./markdown.mjs";
import { checkPage } from "../curator/contract.mjs";

const THEME_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "curator", "theme.html");
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const INTENT_LABEL = { approve: "Approve the plan", revise: "Send it back" };
const INTENT_EXPLAIN = {
  approve: "Unlocks implementation of the approved plan steps.",
  revise: "Sends the plan back to planning with your note.",
};
const INTENT_THEN = {
  approve: "Then the implement stage runs the plan steps.",
  revise: "Then the plan stage reruns with your note.",
};
const INTENT_NO_RECOMMENDATION = "the engine has no recommendation here, you are the check on whether the plan matches the brief";

const EXTRA_CSS = `
  :root { color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; } }
  :root[data-theme="dark"] { color-scheme: dark; --paper:#14181c; --paper-2:#1b2026; --ink:#e8e6e2;
    --muted:#98a2af; --soft:#b8c2cf; --rule:#2b3037; --accent:#7fc3cd; --accent-tint:#1d3a40; }
  h1 { font-size:26px; }
  h2 { margin-top:48px; }
  .small { font-family:var(--mono); font-size:11px; color:var(--muted); letter-spacing:.02em; }
  .dref { color:var(--muted); font-size:.9em; }
  .box.notice { border-left-color:var(--accent); }
  .checks { list-style:none; padding-left:0; }
  .checks li { display:flex; gap:.5rem; }
  .tick { font-family:var(--mono); color:var(--accent); flex:none; }
  .steps li { margin:.9rem 0; }
  .step-meta { font-size:14px; color:var(--soft); margin-top:.15rem; }
  .step-meta .k { font-family:var(--mono); font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .earlier { list-style:none; padding-left:0; }
  .earlier li { padding:.5rem 0; border-bottom:1px solid var(--rule); }
  .brief { border-left:3px solid var(--accent); padding:.1rem 0 .1rem 1rem; margin:1rem 0 2rem; }
  .brief p { margin:.35rem 0; }
  .q-label { font-size:1.15rem; margin:.2rem 0; }
  .o-then { color:var(--muted); }
  .option strong { font-weight:600; }
  .options { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:.7rem; margin:.8rem 0 .4rem; }
  .option { border:1px solid var(--rule); border-radius:6px; padding:.7rem 1rem; cursor:pointer; background:var(--paper-2); }
  .option:hover { border-color:var(--accent); }
  .o-name { font-weight:600; }
  .o-note { margin-top:.25rem; font-size:14px; color:var(--soft); }
  [data-curator-chosen] { border-color:var(--accent); background:var(--accent-tint); }
  details { margin:.8rem 0; }
  summary { cursor:pointer; font-family:var(--mono); font-size:13px; }
  .doc { border-left:3px solid var(--rule); padding:.2rem 0 .2rem 1.2rem; margin:.5rem 0 1.5rem; font-size:15px; }
  .doc h3 { font-size:1.15rem; margin:1.2rem 0 .4rem; }
  .doc h4 { font-size:1rem; margin:1.4rem 0 .4rem; }
  .doc h5, .doc h6 { font-size:.95rem; margin:1rem 0 .3rem; }
`;

function themeCss() {
  if (!existsSync(THEME_FILE)) throw new Error(`gate page needs the curator theme at ${THEME_FILE}, and it is missing`);
  const m = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(THEME_FILE, "utf8"));
  if (!m) throw new Error(`no <style> block in ${THEME_FILE}`);
  return m[1];
}

// The text under the first heading matching titleRe, up to the next heading of the same or higher level.
function sectionOf(md, titleRe) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!h) continue;
    if (start < 0) {
      if (titleRe.test(h[2])) { start = i + 1; level = h[1].length; }
    } else if (h[1].length <= level) {
      return lines.slice(start, i).join("\n").trim();
    }
  }
  return start < 0 ? null : lines.slice(start).join("\n").trim();
}

function parseSteps(body) {
  const steps = [];
  for (const line of String(body).split("\n")) {
    const m = /^\s{0,3}(\d+)[.)]\s+(.*)$/.exec(line);
    if (m) steps.push(m[2].trim());
    else if (steps.length && /^\s{2,}\S/.test(line)) steps[steps.length - 1] += ` ${line.trim()}`;
  }
  return steps.map((text) => {
    const v = /\bVerify:\s*(.+)$/.exec(text);
    const head = v ? text.slice(0, v.index) : text;
    const f = /\bFiles?:\s*(.+?)\s*$/.exec(head);
    const trim = (x) => x.replace(/\s+$/, "").replace(/\.$/, "");
    return {
      text: (f ? head.slice(0, f.index) : head).trim(),
      files: f ? trim(f[1]) : null,
      verify: v ? trim(v[1]) : null,
    };
  });
}

function parseCriteria(body) {
  const items = [];
  for (const line of String(body).split("\n")) {
    const m = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (m) items.push(m[1].trim());
    else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.map((t) => t.replace(/\s*\(from [^)]*\)\s*$/, ""));
}

const words = (t) => new Set(String(t).toLowerCase().replace(/[`*_]/g, "").match(/[a-z0-9]{3,}/g) || []);

// Equal counts pair by order, the way the plan template lists them; otherwise by word overlap.
function matchCriteria(criteria, rows) {
  if (criteria.length === rows.length) return criteria.map((criterion, i) => ({ criterion, row: rows[i] }));
  const used = new Set();
  return criteria.map((criterion) => {
    const cw = words(criterion);
    let best = -1;
    let score = 0;
    rows.forEach((r, i) => {
      if (used.has(i)) return;
      const rw = words(r[0] || "");
      const shared = [...cw].filter((w) => rw.has(w)).length;
      const s = shared / (Math.min(cw.size, rw.size) || 1);
      if (s > score) { score = s; best = i; }
    });
    if (best >= 0 && score >= 0.5) { used.add(best); return { criterion, row: rows[best] }; }
    return { criterion, row: null };
  });
}

// A decision can block a name that is not a stage ("pr"); it belongs to the stage that pushes.
const STAGE_FOR_BLOCK = { pr: "ship" };

function resolveStage(gate, stages) {
  const candidates = [gate.stage, ...gate.decisions.flatMap((d) => [...(d.blocks || []), d.raised_by])];
  for (const c of candidates) {
    const stage = STAGE_FOR_BLOCK[c] || c;
    if (stages.includes(stage)) return stage;
  }
  return null;
}

// Contract results are warn-level: reported as warning events, never blocking the page.
export function contractWarnings(html) {
  const { errors, warnings } = checkPage(html);
  const mk = (level) => (r) => ({ code: "gate_page_contract", file: null, section: null, check: r.id, level, line: r.line, detail: `${r.id}: ${r.msg}` });
  return [...errors.map(mk("error")), ...warnings.map(mk("warning"))];
}

// Returns { html, warnings }; the caller writes the file and records each warning.
export function buildGatePage(run, gate, model) {
  const { runId, runDir } = run;
  const { stages, stageArtifacts } = model;
  const warnings = [];
  const read = (rel) => (existsSync(join(runDir, rel)) ? readFileSync(join(runDir, rel), "utf8") : null);
  const resolved = resolveStage(gate, stages);
  if (!resolved) {
    warnings.push({ code: "gate_page_stage_unknown", file: "decisions.json", section: null,
      detail: `gate '${gate.name}' names no known stage (${gate.stage}); every artifact is shown` });
  }
  const stage = resolved || stages[stages.length - 1];
  const stageIdx = stages.indexOf(stage);
  const atPlan = stageIdx >= stages.indexOf("plan");
  const atResearch = stageIdx >= stages.indexOf("research");

  let runJson = {};
  try { runJson = JSON.parse(read("run.json") || "{}"); } catch { warnings.push({ code: "gate_page_unreadable", file: "run.json", section: null, detail: "run.json is not valid JSON; the page names the run id instead of the ticket" }); }
  const ref = runJson.ticket_ref || runId;
  const brief = read("brief.md");
  const plan = read("plan/plan.md");

  let title = null;
  const ticketJson = read("ticket.json");
  if (ticketJson) {
    try { title = JSON.parse(ticketJson).title || null; } catch { warnings.push({ code: "gate_page_unreadable", file: "ticket.json", section: null, detail: "ticket.json is not valid JSON" }); }
  }
  if (!title && brief) {
    const h = /^#\s+Brief:\s*\S+?\s+(?:-|:|—)\s+(.+)$/m.exec(brief);
    if (h) title = h[1].trim();
  }
  const ticketLabel = title ? `${esc(ref)}, “${esc(title)}”,` : esc(ref);

  const known = new Map();
  for (const d of [...(gate.earlier || []), ...gate.decisions]) known.set(d.id, d);
  // A decision raised by a later stage cannot be "earlier"; engine-raised ones carry no stage and stay.
  const earlier = (gate.earlier || []).filter((d) => stages.indexOf(d.raised_by) <= stageIdx);
  const onPage = new Set([...earlier, ...gate.decisions].map((d) => d.id));
  const idLink = (id) => (onPage.has(id) ? `<a href="#decision-${esc(id)}">${esc(id)}</a>` : esc(id));
  // One mention per render carries the answer; repeats in the same text are just the link.
  const freshRefs = () => {
    const seen = new Set();
    return (id) => {
      const d = known.get(id);
      if (!d) return null;
      if (seen.has(id)) return idLink(id);
      seen.add(id);
      if (d.status === "answered") return `${idLink(id)} (answered: ${esc(d.answer)})`;
      return `${idLink(id)} (open${onPage.has(id) ? ", below" : ""})`;
    };
  };
  const rawRefs = (id) => (onPage.has(id) ? idLink(id) : null);

  // Only stages at or before the gate's; the access report is a table, never a dump.
  const docs = [];
  for (const s of stages.slice(0, stageIdx + 1)) {
    for (const rel of stageArtifacts[s] || []) {
      if (rel === "access-report.json") continue;
      const src = read(rel);
      if (src !== null) docs.push({ rel, src, open: false, prefix: `doc-${slugify(rel.replace(/[./]/g, "-"))}-`, anchors: new Set() });
    }
  }
  const mdBase = { breaks: true, tasks: true };
  for (const d of docs) renderMarkdown(d.src, { ...mdBase, idPrefix: d.prefix, onAnchor: (a) => d.anchors.add(a) });
  const cite = (file, anchor) => {
    const d = docs.find((x) => x.rel === file || basename(x.rel) === file);
    const a = anchor.toLowerCase();
    return d && d.anchors.has(a) ? `#${d.prefix}${a}` : null;
  };
  const md = (src, extra = {}) => renderMarkdown(src, { ...mdBase, cite, refs: freshRefs(), ...extra });
  const inl = (raw) => renderInline(raw, { refs: freshRefs(), cite });

  const notice = (rel, section, text) => {
    const doc = docs.find((d) => d.rel === rel);
    if (doc) doc.open = true;
    warnings.push({ code: "gate_page_section_missing", file: rel, section, detail: text });
    return `<div class="box notice" role="note"><p>${esc(text)}</p></div>`;
  };
  const missingFile = (rel, why) => {
    warnings.push({ code: "gate_page_file_missing", file: rel, section: null, detail: why });
    return `<div class="box notice" role="note"><p>${esc(why)}</p></div>`;
  };

  const isIntent = gate.name === "intent";
  const n = gate.decisions.length;
  let verdict;
  let ask;
  let next;
  if (isIntent) {
    verdict = `You are deciding whether the plan for ${ticketLabel} is ready to implement.`;
    ask = "Decide whether the plan is ready to implement. Approve the plan unlocks implementation; Send it back returns the plan to planning with your note.";
    next = "If you approve, the implement stage runs the plan steps; if you send it back, the plan stage reruns with your note.";
  } else if (stage === "ship") {
    verdict = `You are deciding whether ${ticketLabel} may be pushed as a draft pull request.`;
    ask = "Answer every question below; your answers decide whether the engine will push the branch and open a draft pull request.";
    next = "Nothing is pushed until every question here is answered, then the engine pushes the branch and opens a draft pull request.";
  } else {
    verdict = `You are answering ${n} open question${n === 1 ? "" : "s"} that block the ${esc(stage)} stage for ${ticketLabel}.`;
    ask = `Answer the ${n === 1 ? "question" : `${n} questions`} below so the ${stage} stage can start.`;
    next = `The ${stage} stage does not start until every question on this page is answered, then the run continues.`;
  }

  let access = "";
  let accessBlocked = false;
  if (atResearch) {
    const raw = read("access-report.json");
    if (raw === null) {
      access = missingFile("access-report.json", "access-report.json is missing, so the page cannot say which sources were reachable.");
    } else {
      let rows = null;
      try { rows = JSON.parse(raw); } catch { rows = null; }
      if (!Array.isArray(rows)) {
        warnings.push({ code: "gate_page_unreadable", file: "access-report.json", section: null, detail: "access-report.json is not a JSON list" });
        access = `<div class="box notice" role="note"><p>access-report.json could not be read as JSON, so the raw file is shown here.</p></div>\n<pre>${esc(raw)}</pre>`;
      } else if (rows.length === 0) {
        access = "<p>The access report lists no sources.</p>";
      } else {
        const trs = rows.map((r) => {
          const detail = [r.detail, r.blocked_reason && `Blocked: ${r.blocked_reason}`, r.enable_action && `To unblock: ${r.enable_action}`,
            r.criticality === "critical" && r.status === "blocked" && "Hard-blocking: implementation cannot start until this is resolved."]
            .filter(Boolean).join(" ");
          return `<tr><td>${esc(r.source ?? "")}</td><td>${esc(r.status ?? "")}</td><td>${esc(r.criticality ?? "")}</td><td>${esc(r.needed_for ?? "")}</td><td>${esc(detail)}</td></tr>`;
        }).join("\n");
        const bad = rows.filter((r) => r.status !== "reachable").length;
        const table = `<table>\n<thead><tr><th>Source</th><th>Status</th><th>Criticality</th><th>Needed for</th><th>Detail</th></tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table>`;
        accessBlocked = bad > 0;
        access = bad === 0
          ? `<p>All ${rows.length} sources were reachable, so nothing blocks this decision.</p>\n<details><summary>Source table</summary>\n${table}\n</details>`
          : `${table}\n<p>${bad} of ${rows.length} sources were not fully reachable; conclusions that rest on them carry degraded confidence.</p>`;
      }
    }
  }
  const accessSection = access ? `<section id="access">\n<h2>Access and data completeness</h2>\n${access}\n</section>` : "";

  const intentCheck = isIntent && plan !== null ? sectionOf(plan, /^intent check$/i) : null;
  let goalText;
  let goal = "";
  if (brief === null) {
    goalText = "The brief is missing, so this page cannot state the goal.";
    goal = missingFile("brief.md", "brief.md is missing, so the goal and acceptance criteria cannot be shown.");
  } else {
    const g = sectionOf(brief, /^goal$/i);
    const a = sectionOf(brief, /^acceptance criteria$/i);
    if (g) goalText = g.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
    else {
      goalText = "The brief has no Goal section, so the goal is not stated here.";
      goal = notice("brief.md", "## Goal", "brief.md has no ## Goal section; the raw file is shown below");
    }
    if (a) goal += intentCheck !== null ? "" : `\n<h3>Acceptance criteria</h3>\n${md(a, { tasks: "all" })}`;
    else goal += `\n${notice("brief.md", "## Acceptance criteria", "brief.md has no ## Acceptance criteria section; the raw file is shown below")}`;
  }
  goal = goal.trim() ? `<h2>The brief</h2>\n${goal}` : "";

  let planHtml = "";
  if (atPlan) {
    if (plan === null) {
      planHtml = `<h2>The plan</h2>\n${missingFile("plan/plan.md", "plan/plan.md is missing, so the plan cannot be shown.")}`;
    } else {
      let inner = "";
      const stepsBody = sectionOf(plan, /^(plan )?steps$/i);
      const steps = stepsBody ? parseSteps(stepsBody) : [];
      if (steps.length) {
        const lis = steps.map((st) => `<li>${inl(st.text.replace(/\bCONDITIONAL on (D-\d{3,})/, (m, id) =>
          (known.has(id) ? `${known.get(id).status === "answered" ? "Depends on" : "Waits on"} ${id}` : m)))}${st.files ? `<div class="step-meta"><span class="k">Files:</span> ${inl(st.files)}</div>` : ""}${st.verify ? `<div class="step-meta"><span class="k">Verify:</span> ${inl(st.verify)}</div>` : ""}</li>`).join("\n");
        inner += `<h3>Steps</h3>\n<ol class="steps">\n${lis}\n</ol>`;
      } else {
        inner += notice("plan/plan.md", "## Steps", stepsBody === null
          ? "plan/plan.md has no ## Steps section; the raw file is shown below"
          : "plan/plan.md has a ## Steps section with no numbered steps; the raw file is shown below");
      }
      const filesBody = sectionOf(plan, /^files touched$/i);
      if (filesBody) inner += `\n<h3>Files touched</h3>\n${md(filesBody)}`;
      else if (steps.some((s) => s.files)) {
        const all = [...new Set(steps.filter((s) => s.files).map((s) => s.files))];
        inner += `\n<h3>Files touched</h3>\n<ul>${all.map((f) => `<li>${inl(f)}</li>`).join("")}</ul>`;
      } else inner += `\n${notice("plan/plan.md", "## Files touched", "plan/plan.md has no ## Files touched section; the raw file is shown below")}`;
      const risks = sectionOf(plan, /^risks/i);
      if (risks) inner += `\n<h3>Risks</h3>\n${md(risks)}`;
      else inner += `\n${notice("plan/plan.md", "## Risks", "plan/plan.md has no ## Risks section; the raw file is shown below")}`;
      planHtml = `<h2>The plan</h2>\n${inner}`;
    }
  }

  let coverHtml = "";
  if (isIntent && plan !== null) {
    if (intentCheck === null) {
      coverHtml = `<h2>Does the plan cover the brief?</h2>\n${notice("plan/plan.md", "## Intent check", "plan/plan.md has no ## Intent check section; the raw file is shown below")}`;
    } else {
      const lines = intentCheck.split("\n");
      const isRow = (l) => /^\s*\|/.test(l);
      const first = lines.findIndex(isRow);
      const last = first < 0 ? -1 : lines.length - 1 - [...lines].reverse().findIndex(isRow);
      const before = first < 0 ? lines : lines.slice(0, first);
      const after = first < 0 ? [] : lines.slice(last + 1);
      const rows = first < 0 ? [] : lines.slice(first, last + 1).filter(isRow).slice(2)
        .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
      const accBody = brief ? sectionOf(brief, /^acceptance criteria$/i) : null;
      const criteria = accBody ? parseCriteria(accBody) : [];
      const pairs = criteria.length ? matchCriteria(criteria, rows) : rows.map((r) => ({ criterion: r[0] || "", row: r }));
      const trs = pairs.map(({ criterion, row }) =>
        `<tr><td>${inl(criterion)}</td><td>${row ? inl(row[1] || "") : "none"}</td><td>${row ? inl(row[2] || "") : "not checked"}</td></tr>`).join("\n");
      const prose = (ls) => (ls.join("\n").trim() ? md(ls.join("\n")) : "");
      coverHtml = `<h2>Does the plan cover the brief?</h2>\n${prose(before)}\n<table>\n<thead><tr><th>Acceptance criterion</th><th>Covered by</th><th>Verdict</th></tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table>\n${prose(after)}`;
    }
  }

  const earlierHtml = earlier.length ? `<h2>Already answered</h2>\n<ul class="earlier">\n${earlier.map((d) =>
    `<li id="decision-${esc(d.id)}">${inl(d.question || "")} → <strong>${esc(d.answer)}</strong>${d.note ? ` (${esc(d.note)})` : ""} <span class="small"><abbr title="decision ${esc(d.id)}">${esc(d.id)}</abbr></span></li>`).join("\n")}\n</ul>` : "";

  const pending = gate.decisions.map((d) => {
    const intentOpts = isIntent && d.gate === "intent";
    const recObj = d.recommended;
    if (recObj && !(d.options || []).includes(recObj.key)) throw new Error(`${d.id}: recommended.key ${JSON.stringify(recObj.key)} is not one of the options`);
    const rec = recObj ? recObj.key : null;
    const details = d.option_details || {};
    const blocks = [...new Set((d.blocks || []).map((b) => STAGE_FOR_BLOCK[b] || b))];
    const whyNow = intentOpts ? "Implementation cannot start until the plan is approved or sent back."
      : d.why_now ? d.why_now
      : blocks.length ? `The ${blocks.join(" and ")} stage cannot start until this is answered.` : "The run is waiting on this answer.";
    const attrs = rec ? `data-plan-recommended="${esc(rec)}"`
      : `data-plan-no-recommendation="${esc(intentOpts ? INTENT_NO_RECOMMENDATION : d.no_recommendation || "the engine has no recommendation for this question")}"`;
    const cards = (d.options || []).map((o) => {
      const det = details[o] || {};
      const explain = intentOpts ? INTENT_EXPLAIN[o] : det.consequence;
      const then = intentOpts ? INTENT_THEN[o] : det.then;
      const label = (intentOpts && INTENT_LABEL[o]) || det.label || o;
      return `<div class="option" data-plan-option="${esc(o)}"><strong>${esc(label)}</strong>${explain ? `\n<p class="o-note" data-plan-consequence>${esc(explain)}</p>` : ""}${then ? `\n<p class="o-note o-then" data-plan-then>${esc(then)}</p>` : ""}</div>`;
    }).join("\n");
    return `<div id="decision-${esc(d.id)}" data-plan-question="${esc(d.id)}" data-plan-required data-plan-shape="pick-one" ${attrs}>
<h3 class="q-label">${inl(d.question || "")}</h3>
<p class="small" data-plan-why-now>${esc(whyNow)}</p>
${rec || intentOpts ? "" : `<p class="small">recommended option: no recommendation given</p>`}
${rec && recObj.reason ? `<p data-plan-reason>${esc(recObj.reason)}</p>` : ""}
<div class="options">
${cards}
</div>
</div>`;
  }).join("\n");

  const doneParts = [];
  if (brief !== null) doneParts.push("the brief is written");
  if (atResearch && read("research.md") !== null) doneParts.push("research is done");
  if (atPlan && plan !== null) doneParts.push("the plan is written");
  const answeredBefore = earlier.filter((d) => d.status === "answered").length;
  if (answeredBefore) doneParts.push(`${answeredBefore} earlier decision${answeredBefore === 1 ? "" : "s"} answered`);
  const done = doneParts.length ? `So far ${doneParts.join(", ")}.` : "Nothing earlier in this run has finished yet.";

  const rawHtml = docs.map((d) => {
    const body = md(d.src, { idPrefix: d.prefix, refs: rawRefs });
    return `<details${d.open ? " open" : ""}><summary>${esc(d.rel)}</summary>\n<article class="doc">\n${body}\n</article></details>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gate ${esc(gate.name)}</title>
<style>${themeCss()}${EXTRA_CSS}</style>
</head>
<body>
<main>
<h1>${verdict}</h1>
<section class="brief" data-plan-brief>
<p data-brief="goal"><strong>Goal.</strong> ${esc(goalText)}</p>
<p data-brief="done"><strong>Done so far.</strong> ${esc(done)}</p>
<p data-brief="ask"><strong>We need from you.</strong> ${esc(ask)}</p>
<p data-brief="next"><strong>Then.</strong> ${esc(next)}</p>
</section>
<section id="decide">
${pending}
</section>
<section id="background">
<h2>Background</h2>
${gate.noteHtml || ""}
${accessBlocked ? accessSection : ""}
${goal ? `<section id="goal">\n${goal}\n</section>` : ""}
${planHtml ? `<section id="plan">\n${planHtml}\n</section>` : ""}
${earlierHtml ? `<section id="earlier">\n${earlierHtml}\n</section>` : ""}
${coverHtml ? `<section id="cover">\n${coverHtml}\n</section>` : ""}
${accessBlocked ? "" : accessSection}
</section>
${rawHtml ? `<section id="raw">\n<h2>Run artifacts</h2>\n<p class="small">Everything above is drawn from these files, as written.</p>\n${rawHtml}\n</section>` : ""}
<footer>run ${esc(runId)} · gate ${/^D-\d+$/.test(gate.name) ? `<abbr title="decision ${esc(gate.name)}">${esc(gate.name)}</abbr>` : esc(gate.name)} · stage ${esc(stage)}</footer>
</main>
</body>
</html>
`;
  warnings.push(...contractWarnings(html));
  return { html, warnings };
}
