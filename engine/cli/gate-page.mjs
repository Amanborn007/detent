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
// The engine words its intent question as an instruction; the option cards already say approve or revise.
const INTENT_READER_QUESTION = "Does the plan build what the brief asks for?";
const INTENT_NO_RECOMMENDATION = "the engine has no recommendation here, you are the check on whether the plan matches the brief";

const EXTRA_CSS = `
  :root { color-scheme: light; --ok:#3d7a4f; --ok-tint:#dcefe0; --warn:#9a6a12; --warn-tint:#f6e9cc;
    --bad:#a2412f; --bad-tint:#f5ddd7; --shadow:rgba(22,39,60,.10); }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
    --ok:#7cc493; --ok-tint:#1c3324; --warn:#e2b35c; --warn-tint:#3a2e15; --bad:#e98b78; --bad-tint:#3d211b; --shadow:rgba(0,0,0,.35); } }
  :root[data-theme="dark"] { color-scheme: dark; --paper:#14181c; --paper-2:#1b2026; --ink:#e8e6e2;
    --muted:#98a2af; --soft:#b8c2cf; --rule:#2b3037; --accent:#7fc3cd; --accent-tint:#1d3a40;
    --ok:#7cc493; --ok-tint:#1c3324; --warn:#e2b35c; --warn-tint:#3a2e15; --bad:#e98b78; --bad-tint:#3d211b; --shadow:rgba(0,0,0,.35); }
  body { padding-inline:max(20px,env(safe-area-inset-left)); }
  h1 { font-size:30px; margin:0 0 16px; overflow-wrap:anywhere; }
  h2 { margin-top:48px; }
  h2.bg { font-size:20px; margin:40px 0 8px; }
  .small { font-family:var(--mono); font-size:11px; color:var(--muted); letter-spacing:.02em; }
  .dref { color:var(--muted); font-size:.9em; }
  .box.notice { border-left-color:var(--accent); }
  .checks { list-style:none; padding-left:0; }
  .checks li { display:flex; gap:.5rem; }
  .tick { font-family:var(--mono); color:var(--accent); flex:none; }
  .earlier { list-style:none; padding-left:0; margin:.4rem 0; }
  .earlier li { padding:.5rem 0; border-bottom:1px solid var(--rule); }
  .q-label { font-size:1.15rem; margin:.2rem 0; }
  .o-then { color:var(--soft); }
  .jump { margin:.25rem 0 1.25rem; font-size:.9rem; }
  .jump a { color:var(--accent); }

  [data-plan-brief] { margin:0 0 20px; padding:4px 18px; background:var(--paper-2); border-radius:8px; }
  [data-plan-brief] [data-brief] { display:grid; grid-template-columns:9.5rem 1fr; gap:12px; margin:0; padding:9px 0; border-bottom:1px solid var(--rule); }
  [data-plan-brief] [data-brief]:last-child { border-bottom:0; }
  [data-plan-brief] strong { font:11px var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); padding-top:3px; font-weight:400; }
  @media (max-width:520px) { [data-plan-brief] [data-brief] { grid-template-columns:1fr; gap:0; } }

  .glance { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:12px; margin:24px 0 8px; }
  .tile { padding:12px 14px; border:1px solid var(--rule); border-radius:8px; }
  .tile .k { font:10px var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  .tile .v { font-family:var(--serif); font-size:24px; line-height:1.2; }
  .tile .s { font-size:13px; color:var(--soft); }
  .meter { height:8px; border-radius:999px; background:var(--paper-2); overflow:hidden; margin:6px 0 4px; display:flex; }
  .meter i { display:block; height:100%; }
  .meter .m-met { background:var(--ok); }
  .meter .m-part { background:var(--warn); }
  .meter .m-bad { background:var(--bad); }
  .meter .m-unk { background:var(--muted); }

  details.sec { border:1px solid var(--rule); border-radius:8px; margin:10px 0; background:var(--paper); }
  details.sec > summary { padding:12px 16px; list-style:none; display:flex; flex-wrap:wrap; gap:4px 10px; align-items:baseline; font-family:var(--sans); font-size:16px; }
  details.sec > summary::-webkit-details-marker { display:none; }
  details.sec > summary::before { content:"▸"; color:var(--muted); display:inline-block; width:1em; }
  details.sec[open] > summary::before { content:"▾"; }
  details.sec > summary b { font-weight:600; }
  details.sec > summary span { color:var(--soft); }
  .body { padding:0 16px 14px; }
  .take { font-weight:600; margin:2px 0 12px; }
  .body ul { margin:.4rem 0; padding-left:1.1rem; }
  .body li { margin:.25rem 0; }
  details.sub { border-top:1px solid var(--rule); margin:0; }
  details.sub > summary { padding:8px 0; font-family:var(--sans); font-size:15px; }
  details.sub .inner { padding:0 0 10px 1.2rem; font-size:14px; }
  .inner .row { margin:.2rem 0; }
  .inner .row b { font:10px var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--muted); font-weight:400; margin-right:6px; }
  .doc { border-left:3px solid var(--rule); padding:.2rem 0 .2rem 1.2rem; margin:.5rem 0 1.5rem; font-size:15px; overflow-wrap:anywhere; }
  .doc h3 { font-size:1.15rem; margin:1.2rem 0 .4rem; }
  .doc h4 { font-size:1rem; margin:1.4rem 0 .4rem; }
  .doc h5, .doc h6 { font-size:.95rem; margin:1rem 0 .3rem; }
  details { margin:.8rem 0; }
  summary { font-family:var(--mono); font-size:13px; }
  .raw-table { overflow-x:auto; }

  .mark { font:11px var(--mono); letter-spacing:.06em; white-space:nowrap; }
  .mark[data-verdict=met], .mark[data-verdict=reached] { color:var(--ok); }
  .mark[data-verdict=partial] { color:var(--warn); }
  .mark[data-verdict=missing], .mark[data-verdict=blocked] { color:var(--bad); }
  .mark[data-verdict=unknown] { color:var(--muted); }
  .crit { list-style:none; padding:0 !important; margin:0; }
  .crit li { display:grid; grid-template-columns:6rem 1fr; gap:10px; padding:7px 0; border-bottom:1px solid var(--rule); margin:0 !important; }
  .crit li:last-child { border-bottom:0; }
  .crit .why { display:block; font-size:13px; color:var(--soft); }
  @media (max-width:520px) { .crit li { grid-template-columns:1fr; gap:2px; } }

  .stepper-wrap { overflow-x:auto; margin:4px 0 14px; padding-bottom:4px; }
  .stepper { display:flex; list-style:none; padding:0 !important; margin:0; min-width:calc(var(--n,4) * 6rem); }
  .stepper li { flex:1; position:relative; text-align:center; font-size:12px; line-height:1.3; color:var(--soft); margin:0 !important; padding:0 3px; }
  .stepper li::before { content:""; position:absolute; top:13px; left:-50%; width:100%; height:2px; background:var(--rule); z-index:0; }
  .stepper li:first-child::before { display:none; }
  .stepper .dot { position:relative; z-index:1; display:inline-grid; place-items:center; width:28px; height:28px; border-radius:50%;
    background:var(--paper); border:2px solid var(--accent); color:var(--ink); font:12px var(--mono); margin-bottom:4px; }
  .stepper .st { display:block; }

  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:8px; }
  .cell { border:1px solid var(--rule); border-left-width:4px; border-radius:6px; padding:8px 10px; font-size:14px; overflow-wrap:anywhere; }
  .cell[data-verdict=reached] { border-left-color:var(--ok); }
  .cell[data-verdict=blocked] { border-left-color:var(--bad); background:var(--bad-tint); }
  .cell[data-verdict=partial] { border-left-color:var(--warn); }
  .cell .n { font-weight:600; display:block; }
  .cell .d { color:var(--soft); font-size:13px; }

  .options { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(15rem,100%),1fr)); gap:14px; margin:.8rem 0 .4rem; }
  .option { position:relative; border:1px solid var(--rule); border-radius:10px; padding:16px 18px 14px; background:var(--paper); }
  .option strong { display:block; font-size:18px; font-weight:600; margin-bottom:4px; }
  .opt-rec { border:2px solid var(--accent); box-shadow:0 0 0 4px var(--accent-tint); }
  .o-note { margin:.3rem 0; font-size:15px; color:var(--soft); }
  [data-plan-why-now] { color:var(--soft); }
  html[data-curator=connected] .option, html[data-curator=connected] [data-plan-option] { cursor:pointer; }
  .option[aria-checked="true"] { border-color:var(--ink); box-shadow:0 0 0 3px var(--ink); }
  [data-curator-chosen] { border-color:var(--accent); background:var(--accent-tint); }

  @keyframes fill { from { transform:scaleX(0); } to { transform:scaleX(1); } }
  @keyframes open { from { opacity:0; transform:translateY(-3px); } to { opacity:1; transform:none; } }
  @media (prefers-reduced-motion: no-preference) {
    .meter i { transform-origin:left; animation:fill 300ms ease-out both; }
    details[open] > .body, details[open] > .inner { animation:open 200ms ease-out; }
    .option { transition:transform 150ms ease-out, box-shadow 150ms ease-out, border-color 150ms ease-out; }
    html[data-curator=connected] .option:hover { transform:translateY(-2px); box-shadow:0 6px 16px var(--shadow); }
    details.sec > summary::before { transition:transform 150ms ease-out; }
  }
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

// Pairs by word overlap only; ties go to exact text, then Jaccard, then order, so a reordered table never moves a verdict.
const normText = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function matchCriteria(criteria, rows) {
  const cands = [];
  criteria.forEach((criterion, ci) => {
    const cw = words(criterion);
    rows.forEach((r, ri) => {
      const rw = words(r[0] || "");
      const shared = [...cw].filter((w) => rw.has(w)).length;
      const score = shared / (Math.min(cw.size, rw.size) || 1);
      const jaccard = shared / (new Set([...cw, ...rw]).size || 1);
      if (score >= 0.5) cands.push({ ci, ri, score, exact: normText(criterion) === normText(r[0] || ""), jaccard });
    });
  });
  cands.sort((x, y) => y.score - x.score || Number(y.exact) - Number(x.exact) || y.jaccard - x.jaccard || x.ci - y.ci || x.ri - y.ri);
  const rowOf = new Map();
  const taken = new Set();
  for (const c of cands) {
    if (rowOf.has(c.ci) || taken.has(c.ri)) continue;
    rowOf.set(c.ci, c.ri);
    taken.add(c.ri);
  }
  return { rowOf, taken };
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

function humanNotesHtml(d) {
  if (!Array.isArray(d.human_notes) || d.human_notes.length === 0) return "";
  const items = d.human_notes.map((n) =>
    `<li>${esc(n.at || "")}${n.answer_if_any ? ` (leaning ${esc(n.answer_if_any)})` : ""}: ${esc(n.note || "")}</li>`).join("");
  return `<div class="human-notes"><p class="small">Notes you left on this decision</p><ul>${items}</ul></div>`;
}

const GLYPH = { met: "✓", partial: "◐", missing: "✕", unknown: "?", reached: "✓", blocked: "✕" };
const mark = (v) => `<span class="mark" data-verdict="${v}">${GLYPH[v]} ${v}</span>`;
const hasNotice = (html) => html.includes('class="box notice"');

// Fixed vocabulary; an unrecognised verdict is unknown, never missing.
function verdictOf(text) {
  const t = String(text || "").toLowerCase().replace(/[`*_]/g, "").trim();
  if (/^(covered|met|yes)\b/.test(t)) return "met";
  if (/^partial/.test(t)) return "partial";
  if (/^(missing|not covered|no)\b/.test(t)) return "missing";
  return "unknown";
}

function capWords(text, max) {
  const w = String(text).split(/\s+/).filter(Boolean);
  return w.length <= max ? w.join(" ") : `${w.slice(0, max).join(" ")}…`;
}

// First clause of a sentence, for a name where the source has no title.
function clause(text, max) {
  const first = String(text).replace(/[`*_]/g, "").trim().split(/[.;:]\s|,\s|\s—\s|\.$/)[0].trim();
  return first.length <= max ? first : `${first.slice(0, max).replace(/\s+\S*$/, "")}…`;
}
const stepTitle = (text) => clause(text.replace(/^CONDITIONAL on D-\d{3,}[.,]?\s*/, ""), 60);
// A subject for the h1: whole words only, no trailing joiner, no ellipsis.
function shortGoal(text) {
  const first = String(text).replace(/[`*_]/g, "").trim().split(/[.;:]\s|,\s|\s—\s|\.$/)[0].trim();
  let s = first;
  if (s.length > 70) s = s.slice(0, 71).replace(/\s+\S*$/, "");
  return s.replace(/(?:\s+(?:a|an|the|of|to|from|in|on|for|and|or|with|by|at))+$/i, "");
}

function meter(parts, label) {
  const total = parts.reduce((s, [, k]) => s + k, 0);
  if (!total) return "";
  const segs = parts.filter(([, k]) => k).map(([cls, k]) => `<i class="${cls}" style="width:${((k / total) * 100).toFixed(1)}%"></i>`).join("");
  return `<div class="meter" role="img" aria-label="${esc(label)}">${segs}</div>`;
}

// Each background section opens with one takeaway; the summary says what is inside.
function fold(title, summary, take, body, open) {
  return `<details class="sec"${open ? " open" : ""}>\n<summary><b>${esc(title)}:</b> <span>${esc(summary)}</span></summary>\n<div class="body">\n<p class="take">${esc(take)}</p>\n${body}\n</div>\n</details>`;
}
const secBlock = (id, title, summary, take, body, open) => `<section id="${id}">\n${fold(title, summary, take, body, open)}\n</section>`;

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
  let ask;
  let next;
  if (isIntent) {
    ask = "Decide whether the plan is ready to implement. Approve unlocks implementation; Send it back returns the plan to planning with your note.";
    next = "If you approve, the implement stage runs the plan steps; if you send it back, the plan stage reruns with your note.";
  } else if (stage === "ship") {
    ask = "Answer every question below; your answers decide whether the engine will push the branch and open a draft pull request.";
    next = "Nothing is pushed until every question here is answered, then the engine pushes the branch and opens a draft pull request.";
  } else {
    ask = `Answer the ${n === 1 ? "question" : `${n} questions`} below so the ${stage} stage can start.`;
    next = `The ${stage} stage does not start until every question on this page is answered, then the run continues.`;
  }

  let accessRows = null;
  let accessBlocked = false;
  let accessSection = "";
  if (atResearch) {
    const raw = read("access-report.json");
    if (raw === null) {
      accessSection = secBlock("access", "Access", "report missing", "The page cannot say which sources were reachable.",
        missingFile("access-report.json", "access-report.json is missing, so the page cannot say which sources were reachable."), true);
    } else {
      let rows = null;
      try { rows = JSON.parse(raw); } catch { rows = null; }
      if (!Array.isArray(rows)) {
        warnings.push({ code: "gate_page_unreadable", file: "access-report.json", section: null, detail: "access-report.json is not a JSON list" });
        accessSection = secBlock("access", "Access", "report unreadable", "The raw file is shown instead of a status grid.",
          `<div class="box notice" role="note"><p>access-report.json could not be read as JSON, so the raw file is shown here.</p></div>\n<pre>${esc(raw)}</pre>`, true);
      } else if (rows.length === 0) {
        accessSection = secBlock("access", "Access", "no sources listed", "The access report lists no sources.", "", false);
      } else {
        accessRows = rows;
        const accessWord = { reachable: "reached", blocked: "blocked", partial: "partial" };
        const cells = rows.map((r) => {
          const v = accessWord[r.status] || "unknown";
          const detail = [r.criticality && `${String(r.criticality).replace(/^./, (c) => c.toUpperCase())}.`, r.needed_for && `Needed for ${r.needed_for}.`, r.detail,
            r.blocked_reason && `Blocked: ${r.blocked_reason}`, r.enable_action && `To unblock: ${r.enable_action}`,
            r.criticality === "critical" && r.status === "blocked" && "Hard-blocking: implementation cannot start until this is resolved."]
            .filter(Boolean).join(" ");
          return `<div class="cell" data-verdict="${v}"><span class="n">${mark(v)} ${esc(r.source ?? "")}</span>${detail ? `\n<details class="sub cell-more"><summary>Details</summary><p class="d">${esc(detail)}</p></details>` : ""}</div>`;
        }).join("\n");
        const bad = rows.filter((r) => r.status !== "reachable").length;
        accessBlocked = bad > 0;
        accessSection = secBlock("access", "Access", `${rows.length - bad} of ${rows.length} sources reached`,
          bad === 0 ? `All ${rows.length} sources were reachable, so nothing blocks this decision.`
            : `${bad} of ${rows.length} sources were not fully reachable; conclusions that rest on them carry degraded confidence.`,
          `<div class="grid">\n${cells}\n</div>`, bad > 0);
      }
    }
  }

  const intentCheck = isIntent && plan !== null ? sectionOf(plan, /^intent check$/i) : null;
  let goalText;
  let goal = "";
  let goalCount = 0;
  let hasGoal = false;
  if (brief === null) {
    goalText = "The brief is missing, so this page cannot state the goal.";
    goal = missingFile("brief.md", "brief.md is missing, so the goal and acceptance criteria cannot be shown.");
  } else {
    const g = sectionOf(brief, /^goal$/i);
    const a = sectionOf(brief, /^acceptance criteria$/i);
    if (g) {
      hasGoal = true;
      goalText = g.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
    } else {
      goalText = "The brief has no Goal section, so the goal is not stated here.";
      goal = notice("brief.md", "## Goal", "brief.md has no ## Goal section; the raw file is shown below");
    }
    if (a) {
      goalCount = parseCriteria(a).length;
      goal += intentCheck !== null ? "" : `\n<h3>Acceptance criteria</h3>\n${md(a, { tasks: "all" })}`;
    } else goal += `\n${notice("brief.md", "## Acceptance criteria", "brief.md has no ## Acceptance criteria section; the raw file is shown below")}`;
  }
  const goalSection = goal.trim()
    ? `<section id="goal">\n${fold("The brief", hasNotice(goal) ? "a section is missing" : `${goalCount} acceptance criteri${goalCount === 1 ? "on" : "a"}`,
      hasNotice(goal) ? "Part of the brief is missing; the raw file is shown below." : "These are the criteria the plan is checked against.", goal, hasNotice(goal))}\n</section>` : "";

  let planSection = "";
  if (atPlan) {
    if (plan === null) {
      planSection = secBlock("plan", "Plan", "file missing", "The plan file is missing, so the plan cannot be shown.", missingFile("plan/plan.md", "plan/plan.md is missing, so the plan cannot be shown."), true);
    } else {
      let inner = "";
      let open = false;
      const stepsBody = sectionOf(plan, /^(plan )?steps$/i);
      const steps = stepsBody ? parseSteps(stepsBody) : [];
      if (steps.length) {
        const dep = (t) => t.replace(/\bCONDITIONAL on (D-\d{3,})/, (m, id) => (known.has(id) ? `${known.get(id).status === "answered" ? "Depends on" : "Waits on"} ${id}` : m));
        const titles = steps.map((st) => stepTitle(st.text));
        const lis = titles.map((t, i) => `<li><span class="dot">${i + 1}</span><span class="st">${esc(t)}</span></li>`).join("\n");
        const subs = steps.map((st, i) => `<details class="sub">\n<summary><b>${i + 1} · ${esc(titles[i])}</b></summary>\n<div class="inner">\n<p class="row">${inl(dep(st.text))}</p>${st.files ? `\n<p class="row"><b>Files</b> ${inl(st.files)}</p>` : ""}${st.verify ? `\n<p class="row"><b>Verify</b> ${inl(st.verify)}</p>` : ""}\n</div>\n</details>`).join("\n");
        inner += `<div class="stepper-wrap" style="--n:${steps.length}"><ol class="stepper">\n${lis}\n</ol></div>\n${subs}`;
      } else {
        open = true;
        inner += notice("plan/plan.md", "## Steps", stepsBody === null
          ? "plan/plan.md has no ## Steps section; the raw file is shown below"
          : "plan/plan.md has a ## Steps section with no numbered steps; the raw file is shown below");
      }
      const filesBody = sectionOf(plan, /^files touched$/i);
      if (filesBody) inner += `\n<h3>Files touched</h3>\n${md(filesBody)}`;
      else if (steps.some((s) => s.files)) {
        const all = [...new Set(steps.filter((s) => s.files).map((s) => s.files))];
        inner += `\n<h3>Files touched</h3>\n<ul>${all.map((f) => `<li>${inl(f)}</li>`).join("")}</ul>`;
      } else {
        open = true;
        inner += `\n${notice("plan/plan.md", "## Files touched", "plan/plan.md has no ## Files touched section; the raw file is shown below")}`;
      }
      const verified = steps.filter((s) => s.verify).length;
      planSection = fold("Plan", steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}, ${verified} with a verify command` : "no numbered steps",
        steps.length ? "Open a step to see its files and how it is checked." : "The plan has no numbered steps to show.", inner, open);
      const risks = sectionOf(plan, /^risks/i);
      let riskBody;
      let riskSummary;
      if (risks) {
        const count = (risks.match(/^\s{0,3}(?:[-*+]|\d+[.)])\s/gm) || []).length;
        riskBody = md(risks);
        riskSummary = count ? `${count} listed` : "see below";
      } else {
        riskBody = notice("plan/plan.md", "## Risks", "plan/plan.md has no ## Risks section; the raw file is shown below");
        riskSummary = "none stated";
      }
      planSection += `\n${fold("Risks", riskSummary, risks ? "Each risk below names the step that answers it." : "The plan states no risks.", riskBody, !risks)}`;
      planSection = `<section id="plan">\n${planSection}\n</section>`;
    }
  }

  let coverSection = "";
  let coverSummary = null;
  let critCounts = null;
  if (isIntent && plan !== null) {
    if (intentCheck === null) {
      coverSection = secBlock("cover", "Criteria", "the plan has no intent check", "Nothing checked the plan against the brief.",
        notice("plan/plan.md", "## Intent check", "plan/plan.md has no ## Intent check section; the raw file is shown below"), true);
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
      const prose = (ls) => (ls.join("\n").trim() ? md(ls.join("\n")) : "");
      if (rows.length === 0) {
        coverSection = secBlock("cover", "Criteria", criteria.length ? `${criteria.length} in the brief, none checked against the plan` : "none listed",
          "The plan's intent check has no verdict table.",
          `${prose(before)}${accBody ? `\n<h3>Acceptance criteria</h3>\n${md(accBody, { tasks: "all" })}` : ""}\n${prose(after)}`, false);
      } else {
        const { rowOf } = matchCriteria(criteria, rows);
        const byRow = new Map([...rowOf].map(([ci, ri]) => [ri, criteria[ci]]));
        const pairs = rows.map((row, ri) => ({ criterion: byRow.get(ri) ?? row[0] ?? "", row, matched: !criteria.length || byRow.has(ri) }));
        criteria.forEach((criterion, ci) => { if (!rowOf.has(ci)) pairs.push({ criterion, row: null, matched: true }); });
        const tr = ({ criterion, row }) =>
          `<tr><td>${inl(criterion)}</td><td>${row ? inl(row[1] || "") : "none"}</td><td>${row ? inl(row[2] || "") : "not checked"}</td></tr>`;
        const trs = pairs.filter((p) => p.matched).map(tr).join("\n");
        const loose = pairs.filter((p) => !p.matched);
        const looseHtml = loose.length
          ? `\n<h3>Plan rows that match no brief criterion</h3>\n<table>\n<thead><tr><th>Plan row</th><th>Covered by</th><th>Verdict</th></tr></thead>\n<tbody>\n${loose.map(tr).join("\n")}\n</tbody>\n</table>` : "";
        const items = pairs.filter((p) => p.matched).map((p) => ({ ...p, v: p.row ? verdictOf(p.row[2]) : "unknown" }));
        const total = criteria.length || rows.length;
        const count = (v) => items.filter((i) => i.v === v).length;
        critCounts = { met: count("met"), partial: count("partial"), missing: count("missing"), unknown: count("unknown"), total: items.length };
        const addition = /\b(step \d+)\b[^.]*\b(?:not asked for|addition)/i.exec(after.join(" ")) || /Additions?:\s*(step \d+)/i.exec(after.join(" "));
        const filed = /Filed as (D-\d+)/.exec(after.join(" "));
        coverSummary = `The plan covers ${critCounts.met} of ${total} ${total === 1 ? "criterion" : "criteria"}${addition && filed ? `; ${addition[1]} is an addition, kept as ${filed[1]}${known.has(filed[1]) ? `, which asks “${capWords(String(known.get(filed[1]).question || "").trim(), 14)}”` : ""}` : ""}.`;
        const why = (i) => {
          if (!i.row) return "The plan's intent check does not mention it.";
          const by = i.row[1] && !/^none$/i.test(i.row[1]) ? `Covered by ${inl(i.row[1])}.` : "No step covers it.";
          return i.v === "unknown" && i.row[2] ? `${by} Verdict as written: “${esc(i.row[2])}”.` : by;
        };
        const li = (i) => `<li>${mark(i.v)}<span>${inl(i.criterion)}<span class="why">${why(i)}</span></span></li>`;
        const bar = [["m-met", critCounts.met], ["m-part", critCounts.partial], ["m-bad", critCounts.missing], ["m-unk", critCounts.unknown]];
        const summary = [`${critCounts.met} of ${critCounts.total} met`, ...["partial", "missing", "unknown"].filter((k) => critCounts[k]).map((k) => `${critCounts[k]} ${k}`)].join(", ");
        const take = critCounts.missing ? `${critCounts.missing} ${critCounts.missing === 1 ? "criterion is" : "criteria are"} missing from the plan.`
          : critCounts.met === critCounts.total ? "Every criterion is covered by the plan."
            : "No criterion is missing; the rest are partial or unknown.";
        const body = `${prose(before)}\n${meter(bar, summary)}\n<ul class="crit">\n${items.map(li).join("\n")}\n</ul>\n<details class="sub raw" data-plan-raw>\n<summary>Coverage table as written</summary>\n<div class="inner raw-table">\n<table>\n<thead><tr><th>Acceptance criterion</th><th>Covered by</th><th>Verdict</th></tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table>${looseHtml}\n</div>\n</details>\n${prose(after)}`;
        coverSection = secBlock("cover", "Criteria", summary, take, body, critCounts.missing > 0);
      }
    }
  }

  const earlierSection = earlier.length ? secBlock("earlier", "Earlier decisions", `${earlier.length} answered`,
    "Each earlier answer below shaped this plan.", `<ul class="earlier">\n${earlier.map((d) =>
      `<li id="decision-${esc(d.id)}">${inl(d.question || "")} → <strong>${esc(d.answer)}</strong>${d.note ? ` (${esc(d.note)})` : ""} <span class="small"><abbr title="decision ${esc(d.id)}">${esc(d.id)}</abbr></span></li>`).join("\n")}\n</ul>`, false) : "";

  const pending = gate.decisions.map((d) => {
    const intentOpts = isIntent && d.gate === "intent";
    const recObj = d.recommended;
    if (recObj && !(d.options || []).includes(recObj.key)) throw new Error(`${d.id}: recommended.key ${JSON.stringify(recObj.key)} is not one of the options`);
    const rec = recObj ? recObj.key : null;
    const optionDetails = d.option_details || {};
    const blocks = [...new Set((d.blocks || []).map((b) => STAGE_FOR_BLOCK[b] || b))];
    const whyNow = intentOpts ? "Implementation cannot start until the plan is approved or sent back."
      : d.why_now ? d.why_now
      : blocks.length ? `The ${blocks.join(" and ")} stage cannot start until this is answered.` : "The run is waiting on this answer.";
    const attrs = rec ? `data-plan-recommended="${esc(rec)}"`
      : `data-plan-no-recommendation="${esc(intentOpts ? INTENT_NO_RECOMMENDATION : d.no_recommendation || "the engine has no recommendation for this question")}"`;
    const ordered = rec ? [rec, ...(d.options || []).filter((o) => o !== rec)] : d.options || [];
    const cards = ordered.map((o) => {
      const det = optionDetails[o] || {};
      const explain = intentOpts ? INTENT_EXPLAIN[o] : det.consequence;
      const then = intentOpts ? INTENT_THEN[o] : det.then;
      const label = (intentOpts && INTENT_LABEL[o]) || det.label || o;
      return `<div class="option${o === rec ? " opt-rec" : ""}" data-plan-option="${esc(o)}"><strong>${esc(label)}</strong>${explain ? `\n<p class="o-note" data-plan-consequence>${esc(explain)}</p>` : ""}${then ? `\n<p class="o-note o-then" data-plan-then>${esc(then)}</p>` : ""}</div>`;
    }).join("\n");
    return `<div data-plan-question="${esc(d.id)}" id="decision-${esc(d.id)}" data-plan-required data-plan-shape="pick-one" ${attrs}>
<h3 class="q-label">${intentOpts && !/\?\s*$/.test(d.question || "") ? INTENT_READER_QUESTION : inl(d.question || "")}</h3>
<p class="small" data-plan-why-now>${esc(whyNow)}</p>
${intentOpts ? "" : d.context_excerpt ? `<div class="q-context" data-plan-context>\n${md(d.context_excerpt)}\n</div>` : d.context ? `<p class="small">Context: ${esc(d.context)}</p>` : ""}
${rec || intentOpts ? "" : `<p class="small">recommended option: no recommendation given</p>`}
${rec && recObj.reason ? `<p data-plan-reason>${esc(recObj.reason)}</p>` : ""}
${humanNotesHtml(d)}
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
  const done = (doneParts.length ? `So far ${doneParts.join(", ")}.` : "Nothing earlier in this run has finished yet.") + (coverSummary ? ` ${coverSummary}` : "");
  const doneHtml = esc(done).replace(/\bD-\d+\b/g, (id) => `<abbr title="decision ${id}">${id}</abbr>`);

  let h1;
  if (isIntent) h1 = `Is the “${esc(shortGoal(title || (hasGoal ? goalText : ref)))}” plan ready to implement?`;
  else if (n === 1) {
    const q = String(gate.decisions[0].question || "").trim();
    h1 = inl(/\?$/.test(q) ? q : `${q.replace(/[.!:\s]+$/, "")}?`);
  } else h1 = `Can the ${esc(stage)} stage start once these ${n} questions are answered?`;

  const tiles = [];
  if (critCounts) {
    const c = critCounts;
    const sub = [c.partial && `${c.partial} partial`, c.missing && `${c.missing} missing`, c.unknown && `${c.unknown} unknown`].filter(Boolean).join(", ") || "none partial or missing";
    tiles.push(["Criteria", `${c.met} of ${c.total} met`, meter([["m-met", c.met], ["m-part", c.partial], ["m-bad", c.missing], ["m-unk", c.unknown]], `${c.met} met, ${c.partial} partial, ${c.missing} missing, ${c.unknown} unknown`), sub]);
  }
  if (accessRows) {
    const r = accessRows.filter((x) => x.status === "reachable").length;
    const b = accessRows.length - r;
    tiles.push(["Sources", `${r} of ${accessRows.length} reached`, meter([["m-met", r], ["m-bad", b]], `${r} reached, ${b} not reached`), b ? `${b} not fully reached` : "none blocked"]);
  }
  if (answeredBefore) tiles.push(["Earlier decisions", `${answeredBefore} answered`, "", "each one shaped this plan"]);
  const glance = tiles.length ? `<div class="glance" aria-label="At a glance">\n${tiles.map(([k, v, bar, s]) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div>${bar}<div class="s">${esc(s)}</div></div>`).join("\n")}\n</div>` : "";

  const rawHtml = docs.map((d) => {
    const body = md(d.src, { idPrefix: d.prefix, refs: rawRefs });
    return `<details${d.open ? " open" : ""}><summary>${esc(d.rel)}</summary>\n<article class="doc" data-plan-raw>\n${body}\n</article></details>`;
  }).join("\n");

  const background = [gate.noteHtml || "", accessBlocked ? accessSection : "", goalSection, coverSection, planSection, accessBlocked ? "" : accessSection, earlierSection]
    .filter((s) => s.trim()).join("\n");
  const jump = n ? `<p class="jump"><a href="#decision-${esc(gate.decisions[0].id)}">Jump to the decision ↓</a></p>` : "";

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
<h1>${h1}</h1>
<section class="brief" data-plan-brief>
<p data-brief="goal"><strong>Goal</strong> <span>${esc(capWords(goalText, 40))}</span></p>
<p data-brief="done"><strong>Done so far</strong> <span>${doneHtml}</span></p>
<p data-brief="ask"><strong>We need from you</strong> <span>${esc(ask)}</span></p>
<p data-brief="next"><strong>Next</strong> <span>${esc(next)}</span></p>
</section>
<p class="curator-offline">Not connected: open this page with <code>curator open &lt;file&gt;</code> to send a decision.</p>
${jump}
${glance}
${background ? `<section id="background">\n<h2 class="bg">Background</h2>\n${background}\n</section>` : ""}
<section id="decide">
<h2 class="bg">Your decision</h2>
${pending}
</section>
${rawHtml ? `<section id="raw">\n<h2 class="bg">Run artifacts</h2>\n<p class="small">Everything above is drawn from these files, as written.</p>\n${rawHtml}\n</section>` : ""}
<footer>run ${esc(runId)} · gate ${/^D-\d+$/.test(gate.name) ? `<abbr title="decision ${esc(gate.name)}">${esc(gate.name)}</abbr>` : esc(gate.name)} · stage ${esc(stage)}</footer>
</main>
</body>
</html>
`;
  warnings.push(...contractWarnings(html));
  return { html, warnings };
}
