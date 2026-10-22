// Zero-dependency Markdown-to-HTML for run artifacts shown on curator pages.
// Raw HTML is never passed through: all input is escaped before formatting.
"use strict";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const SAFE_HREF = /^(https?:\/\/|#|\.{0,2}\/|[\w.-]+(\/|#|$))/i;

const CITATION = /\[([\w./-]+#[\w-]+(?:\s*,\s*[\w./-]+#[\w-]+)*)\]/g;
const DECISION_REF = /\bD-\d{3,}\b/g;

/** GFM-style heading anchor, so `[brief.md#acceptance-criteria]` finds the heading it names. */
export function slugify(text) {
  return String(text).replace(/[`*_]/g, "").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
}

const LEAD_ID = /^([A-Z]\d{1,3})(?![\w])/;

/** Inline formatting over one line of raw text. Code spans and link targets are cut out first so emphasis never rewrites them. */
function inline(raw, opts = {}) {
  const spans = [];
  const hold = (html) => `\u0000${spans.push(html) - 1}\u0000`;
  let s = raw.replace(/\u0000/g, "");
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${escape(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s\u0000]+)\)/g, (m, text, href) =>
    SAFE_HREF.test(href) ? `${hold(`<a href="${escape(href)}">`)}${text}${hold("</a>")}` : text);
  if (opts.cite) {
    s = s.replace(CITATION, (m, list) => {
      const parts = list.split(/\s*,\s*/).map((ref) => {
        const [file, anchor] = ref.split("#");
        const href = opts.cite(file, anchor);
        return href ? `<a href="${escape(href)}">${escape(ref)}</a>` : escape(ref);
      });
      return hold(`[${parts.join(", ")}]`);
    });
  }
  if (opts.refs) {
    s = s.replace(DECISION_REF, (id) => {
      const note = opts.refs(id);
      return note ? hold(`${id}<span class="dref"> (${note})</span>`) : id;
    });
  }
  s = escape(s);
  s = s.replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/;
const FENCE = /^ {0,3}(```+|~~~+)/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isTable = (line, next) => line.includes("|") && next !== undefined && next.includes("|") && TABLE_SEP.test(next);

function isBlockStart(line, next) {
  return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line) ||
    LIST_ITEM.test(line) || isTable(line, next);
}

/** Parses the list starting at lines[i]; returns [html, nextIndex]. Deeper-indented items nest. */
function list(lines, i, ctx) {
  const first = LIST_ITEM.exec(lines[i]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      let j = i;
      while (j < lines.length && lines[j].trim() === "") j++;
      const n = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
      if (!n || n[1].length < indent) break;
      i = j;
    }
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || m[1].length < indent) break;
    if (m[1].length > indent && items.length) {
      const [nested, next] = list(lines, i, ctx);
      items[items.length - 1].children.push(nested);
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    const item = { text: [m[3]], children: [] };
    items.push(item);
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i], lines[i + 1])) {
      item.text.push(lines[i++].trim());
    }
  }
  const ticks = Boolean(ctx.opts.tasks) && (ctx.opts.tasks === "all" || items.some((it) => TASK.test(it.text[0])));
  const tag = ordered && !ticks ? "ol" : "ul";
  const body = items.map((it) => {
    let text = it.text.join(" ");
    let tick = "";
    if (ticks) {
      const t = TASK.exec(text);
      const done = t ? t[1] !== " " : false;
      if (t) text = text.slice(t[0].length);
      tick = `<span class="tick">${done ? "\u2611" : "\u2610"}</span> `;
    }
    return `<li${ticks ? ' class="task"' : ""}>${anchorFor(text, ctx)}${tick}${inline(text, ctx.opts)}${it.children.join("")}</li>`;
  }).join("\n");
  return [`<${tag}${ticks ? ' class="checks"' : ""}>\n${body}\n</${tag}>`, i];
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escape(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      out.push(`${headingAnchor(h[2], ctx)}<h${level}>${inline(h[2], ctx.opts)}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ""));
      out.push(`<blockquote>\n${blocks(body, ctx)}\n</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [html, next] = list(lines, i, ctx);
      out.push(html);
      i = next;
      continue;
    }
    if (isTable(line, lines[i + 1])) {
      const head = cells(line).map((c) => `<th>${inline(c, ctx.opts)}</th>`).join("");
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(`<tr>${cells(lines[i++]).map((c) => `<td>${inline(c, ctx.opts)}</td>`).join("")}</tr>`);
      }
      out.push(`<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table>`);
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    out.push(ctx.opts.breaks
      ? `<p>${para.map((l) => anchorFor(l, ctx) + inline(l, ctx.opts)).join("<br>\n")}</p>`
      : `<p>${inline(para.join(" "), ctx.opts)}</p>`);
  }
  return out.join("\n");
}

const TASK = /^\[( |x|X)\]\s+/;

/** Claims a unique anchor id for this render and reports it; emits the id span only when a prefix is set. */
function claim(id, ctx) {
  const n = ctx.seen.get(id) ?? 0;
  ctx.seen.set(id, n + 1);
  const unique = n ? `${id}-${n}` : id;
  if (ctx.opts.onAnchor) ctx.opts.onAnchor(unique);
  return ctx.opts.idPrefix ? `<span id="${escape(ctx.opts.idPrefix + unique)}"></span>` : "";
}
const headingAnchor = (raw, ctx) => claim(slugify(raw), ctx);
function anchorFor(text, ctx) {
  const m = LEAD_ID.exec(text);
  return m ? claim(m[1].toLowerCase(), ctx) : "";
}

/**
 * Renders Markdown source to safe HTML, demoting headings two levels so they nest under a page's h2.
 * Options (all off by default): `breaks` keeps line breaks inside a paragraph; `tasks` turns GFM task
 * items into ticks (`"all"` ticks every list item); `idPrefix` and `onAnchor` publish heading and
 * leading-id anchors (F2, R1); `cite(file, anchor)` returns an href for `[file#anchor]` or null;
 * `refs(id)` returns safe HTML that follows a `D-nnn` mention.
 */
export function renderMarkdown(src, opts = {}) {
  const ctx = { opts, seen: new Map() };
  return blocks(String(src).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), ctx);
}

/** Inline-only rendering of one line, for callers that lay out the block themselves. */
export function renderInline(raw, opts = {}) {
  return inline(String(raw), opts);
}
