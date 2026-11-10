import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGatePage } from "../gate-page.mjs";
import { checkPage } from "../../curator/contract.mjs";

const STAGES = ["intake", "research", "plan", "implement", "recheck", "ship", "respond"];
const STAGE_ARTIFACTS = { intake: ["brief.md"], research: ["research.md", "access-report.json"], plan: ["plan/plan.md"], recheck: ["recheck.md"] };
const Q = "Does this plan do what the brief asks, and nothing it does not ask for?";
const INTENT = { id: "D-009", gate: "intent", raised_by: "engine", blocks: ["implement"], question: Q, options: ["approve", "revise"], status: "pending" };

const BRIEF = "# Brief\n\n## Goal\nUsers can export a monthly summary as a file.\n\n## Acceptance criteria\n- [ ] alpha export writes a file\n- [ ] beta export lists every month\n- [ ] gamma export fails loudly on bad input\n- [ ] delta export is documented\n";
const plan = (rows) => `# Plan\n\n## Steps\n1. Write the failing tests first. Files: \`a.test.js\`. Verify: \`npm test\`.\n2. Implement the export, then wire it up. Files: \`a.js\`. Verify: \`npm test\`.\n\n## Files touched\n- \`a.js\`\n\n## Risks\n- r one\n\n## Intent check\n| Acceptance criterion | Covered by | Verdict |\n|---|---|---|\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
const ROWS = [
  ["alpha export writes a file", "step 1", "covered"],
  ["beta export lists every month", "step 2", "Partial"],
  ["gamma export fails loudly on bad input", "none", "MISSING"],
  ["delta export is documented", "step 2", "maybe later"],
];
const REACHED = [
  { source: "code host", status: "reachable", criticality: "critical", needed_for: "the code", detail: "ok" },
  { source: "ticket tool", status: "reachable", criticality: "supporting", needed_for: "the ticket", detail: "ok" },
];

function render({ files, decisions = [INTENT], earlier = [], name = "intent" }) {
  const runDir = mkdtempSync(join(tmpdir(), "gate-scannable-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(runDir, rel)), { recursive: true });
    writeFileSync(join(runDir, rel), typeof content === "string" ? content : JSON.stringify(content));
  }
  return buildGatePage({ runId: "run-1", runDir }, { name, stage: "plan", decisions, earlier }, { stages: STAGES, stageArtifacts: STAGE_ARTIFACTS });
}
const full = (rows = ROWS, access = REACHED) => ({ "brief.md": BRIEF, "research.md": "# R\n", "access-report.json": access, "plan/plan.md": plan(rows) });
const answered = (id, q) => ({ id, raised_by: "intake", blocks: ["implement"], question: q, options: ["x", "y"], status: "answered", answer: "x" });
const textOf = (h) => h.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the h1 is the question: an intent gate asks whether the plan is ready, a decision gate asks its own question", () => {
  const h1 = (html) => /<h1>([\s\S]*?)<\/h1>/.exec(html)[1].replace(/<[^>]+>/g, "").trim();
  const intent = h1(render({ files: full() }).html);
  assert.match(intent, /^Is the .+ plan ready to implement\?$/);
  assert.ok(intent.includes("Users can export a monthly summary"), intent);
  const d = { id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which format should the file use", options: ["csv", "json"], status: "pending" };
  assert.equal(h1(render({ files: { "brief.md": BRIEF }, decisions: [d], name: "D-001" }).html), "Which format should the file use?");
  assert.equal(h1(render({ files: { "brief.md": BRIEF }, decisions: [{ ...d, question: "Which format?" }], name: "D-001" }).html), "Which format?");
});

test("the page order is h1, brief, offline banner, jump link, tiles, background, then the decision last", () => {
  const { html } = render({ files: full(), earlier: [answered("D-001", "Pick a thing?")] });
  const at = (s) => html.search(s);
  const order = [at(/<h1>/), at(/<section[^>]*data-plan-brief/), at(/class="curator-offline"/), at(/Jump to the decision/), at(/class="glance"/),
    at(/<section id="background">/), at(/<section id="decide">/)];
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order.join(","));
  assert.match(html, /<a href="#decision-D-009">Jump to the decision/);
  assert.ok(html.includes('id="decision-D-009"'));
  const decide = /<section id="decide">[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(!/<section/.test(decide.slice(10)), "no nested section inside #decide");
  assert.ok(!/<details/.test(html.slice(html.indexOf('<section id="decide">'), html.indexOf('<section id="raw">'))), "nothing folds inside the decision");
});

test("the brief keeps four plain rows and the page has no script", () => {
  const { html } = render({ files: full() });
  for (const k of ["goal", "done", "ask", "next"]) assert.match(html, new RegExp(`<p[^>]*data-brief="${k}"`));
  assert.ok(!/<script/i.test(html));
});

test("tiles show criteria met, sources reached and earlier decisions answered", () => {
  const { html } = render({ files: full(), earlier: [answered("D-001", "First thing?"), answered("D-002", "Second thing?")] });
  const glance = [html.slice(html.indexOf('class="glance"'), html.indexOf('<section id="background">'))];
  const t = textOf(glance[0]);
  assert.match(t, /1 of 4 met/);
  assert.match(t, /2 of 2 reached/);
  assert.match(t, /2 answered/);
  assert.match(glance[0], /class="meter"/);
});

test("a tile with no data is omitted, never shown as 0 of 0", () => {
  const { html } = render({ files: { "brief.md": BRIEF, "research.md": "# R\n", "access-report.json": [], "plan/plan.md": "# Plan\n\n## Steps\n1. Do it. Files: `a`. Verify: `t`.\n" } });
  assert.ok(!/class="glance"/.test(html), "no tiles at all when nothing has data");
  assert.ok(!/\b0 of 0\b/.test(textOf(html)));
  const some = render({ files: full(ROWS, []), earlier: [] }).html;
  assert.match(some, /Criteria/);
  assert.ok(!/Sources/.test(/class="glance"[\s\S]*?<h2/.exec(some)?.[0] ?? ""), "no sources tile without access rows");
});

test("verdicts use a fixed vocabulary and unknown is never shown as missing", () => {
  const { html } = render({ files: full() });
  const marks = [...html.matchAll(/<span class="mark" data-verdict="([a-z]+)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2].trim()]);
  const crit = marks.filter(([v]) => ["met", "partial", "missing", "unknown"].includes(v));
  assert.deepEqual(crit, [["met", "✓ met"], ["partial", "◐ partial"], ["missing", "✕ missing"], ["unknown", "? unknown"]]);
  const mapped = (verdict) => {
    const h = render({ files: full([["alpha export writes a file", "step 1", verdict]]) }).html;
    return /data-verdict="(met|partial|missing|unknown)"/.exec(h)[1];
  };
  for (const [v, want] of [["covered", "met"], ["Met", "met"], ["yes", "met"], ["partial", "partial"], ["missing", "missing"], ["Not covered", "missing"], ["no", "missing"], ["TBD", "unknown"], ["", "unknown"], ["none", "unknown"]]) {
    assert.equal(mapped(v), want, `verdict "${v}"`);
  }
});

test("the summary says what is inside, and a missing criterion opens its section", () => {
  const { html } = render({ files: full() });
  assert.match(html, /<summary[^>]*>\s*<b>Criteria:<\/b>\s*<span>1 of 4 met, 1 partial, 1 missing, 1 unknown<\/span>/);
  assert.match(html, /<details class="sec" open>\s*<summary[^>]*>\s*<b>Criteria:/);
  const calm = render({ files: full([["alpha export writes a file", "step 1", "covered"], ["beta export lists every month", "step 2", "covered"], ["gamma export fails loudly on bad input", "step 2", "covered"], ["delta export is documented", "step 2", "covered"]]) }).html;
  assert.match(calm, /<details class="sec">\s*<summary[^>]*>\s*<b>Criteria:<\/b>\s*<span>4 of 4 met/);
  assert.ok(!/<details class="sec" open>/.test(calm), "nothing opens when nothing is missing or blocked");
});

test("plan steps are a numbered stepper with one folded detail per step", () => {
  const { html } = render({ files: full() });
  assert.match(html, /<ol class="stepper">[\s\S]*?<\/ol>/);
  assert.equal((html.match(/<li><span class="dot">/g) || []).length, 2);
  const subs = [...html.matchAll(/<details class="sub">/g)].length;
  assert.equal(subs, 2);
  assert.match(html, /Write the failing tests first/);
  assert.match(html, /<b>Files<\/b>/);
  assert.match(html, /<b>Verify<\/b>/);
  let depth = 0;
  let max = 0;
  for (const m of html.matchAll(/<(\/?)details\b/g)) { depth += m[1] ? -1 : 1; max = Math.max(max, depth); }
  assert.ok(max <= 2, `details nest ${max} deep`);
});

test("access is a status grid with glyph and word, and a blocked source auto-opens it", () => {
  const ok = render({ files: full() }).html;
  assert.equal((ok.match(/<span class="mark" data-verdict="reached">/g) || []).length, 2);
  assert.match(ok, /<span class="mark" data-verdict="reached">✓ reached<\/span>/);
  const blocked = render({ files: full(ROWS, [...REACHED, { source: "metrics store", status: "blocked", criticality: "supporting", needed_for: "counts", blocked_reason: "no token", enable_action: "register it" }]) }).html;
  assert.match(blocked, /<span class="mark" data-verdict="blocked">✕ blocked<\/span>/);
  const sec = /<section id="access">[\s\S]*?<\/section>/.exec(blocked)[0];
  assert.match(sec, /<details class="sec" open>/);
  assert.ok(sec.includes("no token") && sec.includes("register it"));
  assert.match(/<section id="access">[\s\S]*?<\/section>/.exec(ok)[0], /<details class="sec">/);
});

test("the recommended option comes first and the page adds no badge of its own", () => {
  const d = { id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which one?", options: ["a", "b", "c"], recommended: { key: "c", reason: "c keeps the old behaviour for callers" }, status: "pending" };
  const { html } = render({ files: { "brief.md": BRIEF }, decisions: [d], name: "D-001" });
  assert.deepEqual([...html.matchAll(/data-plan-option="([^"]*)"/g)].map((m) => m[1]), ["c", "a", "b"]);
  assert.ok(!/recommended<\/|rec-badge/i.test(html.replace(/data-plan-recommended/g, "")));
});

test("raw evidence is marked data-plan-raw", () => {
  const { html } = render({ files: full() });
  assert.match(html, /data-plan-raw/);
});

test("no element carries a banned status class", () => {
  const { html } = render({ files: full(ROWS, [...REACHED, { source: "x", status: "blocked", criticality: "critical", needed_for: "y" }]) });
  const banned = new Set(["ok", "no", "pill", "badge", "chip", "severity"]);
  for (const m of html.matchAll(/\bclass="([^"]*)"/g)) for (const t of m[1].split(/\s+/)) assert.ok(!banned.has(t), `banned class ${t}`);
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  for (const b of banned) assert.ok(!new RegExp(`\\.${b}\\b(?![-\\w])`).test(css.replace(/\.\d/g, "")), `css uses .${b}`);
});

test("the rendered page passes the decision-page contract with no C1-C7 or C11-C13 warning", () => {
  const { html, warnings } = render({ files: full(), earlier: [answered("D-001", "Pick a thing?")] });
  const { errors, warnings: ws } = checkPage(html);
  const bad = [...errors, ...ws].filter((r) => /^C(1|2|3|4|5|6|7|11|12|13)$/.test(r.id));
  assert.deepEqual(bad, []);
  assert.deepEqual(warnings.filter((w) => w.code === "gate_page_contract").filter((w) => /^C(1|2|3|4|5|6|7|11|12|13)\b/.test(w.check)), []);
});

test("pointer cursors sit under html[data-curator=connected], and motion sits in the no-preference media query", () => {
  const { html } = render({ files: full() });
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  for (const m of css.matchAll(/([^{}]+)\{[^{}]*cursor:\s*pointer[^{}]*\}/g)) {
    assert.ok(m[1].split(",").every((s) => /html\[data-curator=connected\]/.test(s)), `cursor:pointer outside connected: ${m[1].trim()}`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/);
  const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  assert.ok(!/\b(animation|transition)\s*:/.test(outside), "motion outside the media query");
  for (const m of css.matchAll(/(?:animation|transition)[^;{}]*?(\d+)ms/g)) assert.ok(Number(m[1]) >= 100 && Number(m[1]) <= 300, m[0]);
});

test("an engine-worded intent question is shown as a reader question, with the decision id unchanged", () => {
  const stored = "Intent gate: does plan/plan.md faithfully implement brief.md? Approve to unlock implement; revise to loop back to plan.";
  const { html } = render({ files: full(), decisions: [{ ...INTENT, question: stored }] });
  assert.match(html, /<div data-plan-question="D-009"/);
  assert.match(html, /<h3[^>]*>\s*Does the plan build what the brief asks for\?\s*<\/h3>/);
  assert.ok(!html.includes("Intent gate:") && !html.includes("loop back to plan"));
  const asked = render({ files: full(), decisions: [INTENT] }).html;
  assert.ok(asked.includes(`>${Q}</h3>`), "a stored reader question is kept as written");
  assert.deepEqual(checkPage(html).warnings.filter((w) => w.id === "C3"), []);
});

test("the h1 never cuts the goal mid-phrase with an ellipsis, and prefers the ticket title", () => {
  const h1 = (html) => /<h1>([\s\S]*?)<\/h1>/.exec(html)[1];
  const long = BRIEF.replace("Users can export a monthly summary as a file.", "Users can export a monthly summary of every account as a single file from a scheduled job that runs nightly.");
  const cut = h1(render({ files: { ...full(), "brief.md": long } }).html);
  assert.ok(!cut.includes("…") && cut.endsWith("plan ready to implement?"), cut);
  const subject = /“(.*)”/.exec(cut)[1];
  assert.ok(subject.length <= 70 && long.includes(subject), subject);
  assert.ok(!/\b(a|an|the|of|to|from|and|or|with)$/i.test(subject), subject);
  const titled = h1(render({ files: { ...full(), "ticket.json": { title: "Monthly export" } } }).html);
  assert.equal(titled, "Is the “Monthly export” plan ready to implement?");
});

test("blocked sources keep the access section open but show only glyph, word and name until a cell is opened", () => {
  const blocked = { source: "metrics store", status: "blocked", criticality: "important", needed_for: "counts", blocked_reason: "no token ".repeat(150), enable_action: "register it" };
  const { html } = render({ files: full(ROWS, [...REACHED, blocked, { ...blocked, source: "skill tracker" }]) });
  const sec = /<section id="access">[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(sec, /<details class="sec" open>/);
  assert.match(sec, /<details class="sub cell-more">\s*<summary>[^<]+<\/summary>/);
  assert.ok(sec.includes("metrics store") && sec.includes("register it"));
  assert.deepEqual(checkPage(html).warnings.filter((w) => w.id === "C2"), []);
});
