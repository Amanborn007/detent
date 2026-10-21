// Zero-dependency Markdown-to-HTML for run artifacts shown on curator pages.
// Raw HTML is never passed through: all input is escaped before formatting.
"use strict";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const SAFE_HREF = /^(https?:\/\/|#|\.{0,2}\/|[\w.-]+(\/|#|$))/i;

/** Inline formatting over one line of raw text. Code spans and link targets are cut out first so emphasis never rewrites them. */
function inline(raw) {
  const spans = [];
  const hold = (html) => `\u0000${spans.push(html) - 1}\u0000`;
  let s = raw.replace(/\u0000/g, "");
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${escape(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s\u0000]+)\)/g, (m, text, href) =>
    SAFE_HREF.test(href) ? `${hold(`<a href="${escape(href)}">`)}${text}${hold("</a>")}` : text);
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
function list(lines, i) {
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
      const [nested, next] = list(lines, i);
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
  const tag = ordered ? "ol" : "ul";
  const body = items.map((it) => `<li>${inline(it.text.join(" "))}${it.children.join("")}</li>`).join("\n");
  return [`<${tag}>\n${body}\n</${tag}>`, i];
}

function blocks(lines) {
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
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ""));
      out.push(`<blockquote>\n${blocks(body)}\n</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [html, next] = list(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    if (isTable(line, lines[i + 1])) {
      const head = cells(line).map((c) => `<th>${inline(c)}</th>`).join("");
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(`<tr>${cells(lines[i++]).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      }
      out.push(`<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table>`);
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

/** Renders Markdown source to safe HTML, demoting headings two levels so they nest under a page's h2. */
export function renderMarkdown(src) {
  return blocks(String(src).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}
