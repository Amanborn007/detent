// Decision-page contract: what a curator page must carry so a person can read it and decide.
// Used by artifact-check.py (via --page) and by anything that builds a decision record in code.
// No dependencies: curator ships without any, so the HTML scan below is a small tolerant one.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 'warn' reports every E-level check as a warning. Flip to 'error' once existing pages comply.
export const CONTRACT_LEVEL = 'warn';

// An option that is an escape hatch rather than a real alternative. Matched whole, never as a
// prefix or substring, so "No change to API; migrate storage" stays a real approach.
export const HATCH = new Set(['other', 'none', 'dismiss', 'snooze', 'skip', 'later', 'cancel',
  'no change', 'do nothing', 'not now', 'no action', 'defer', 'park']);

export function isHatch(label) {
  const text = String(label).trim().toLowerCase().replace(/[\s.!—-]+$/, '');
  return text.includes('(specify)') || HATCH.has(text);
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr']);
const SKIP_TEXT = new Set(['head', 'title', 'style', 'script', 'template', 'noscript']);
const BLOCK_OPENERS = new Set(['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul',
  'ol', 'table', 'blockquote', 'pre', 'header', 'footer', 'main']);

const words = (s) => (String(s).match(/\S+/g) || []).length;
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

// Ticket-style IDs only (ACME-35, D-001); UTF-8 and SHA-256 are names a reader knows.
const ID_TOKEN = /\b(?:[A-Z]{2,10}-\d+|D-\d+)\b/g;
const NOT_AN_ID = new Set(['UTF-8', 'UTF-16', 'UTF-32', 'SHA-1', 'SHA-256', 'SHA-512', 'ISO-8601', 'TLS-1']);
const idsIn = (text) => (String(text).match(ID_TOKEN) || []).filter((t) => !NOT_AN_ID.has(t));

// A path, URL or bare ID carries no context for someone who has not opened it.
const POINTER_TOKEN = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|[~.]?\/?[\w@.-]+(?:\/[\w@.%-]+)+\/?(?::\d+)?|[\w-]+\.(?:mjs|js|ts|tsx|py|go|md|json|ya?ml|html|java|sh)(?::\d+)?|[A-Za-z]{1,10}-\d+)$/;
export const isPointer = (text) => {
  const toks = String(text).replace(/[`"'()[\]]/g, '').match(/\S+/g) || [];
  return toks.length > 0 && toks.every((t) => POINTER_TOKEN.test(t.replace(/[.,;:]+$/, '')));
};

// Blank out what the browser never renders as markup, keeping offsets so line numbers stay true.
function blank(html) {
  const keep = (m) => m.replace(/[^\n]/g, ' ');
  return html
    .replace(/<!--[\s\S]*?-->/g, keep)
    .replace(/(<(script|style|textarea|template)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
      (m, open, _t, body, close) => open + keep(body) + close);
}

const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, d, h, n) => {
  if (n) return Object.hasOwn(NAMED, n.toLowerCase()) ? NAMED[n.toLowerCase()] : m;
  const cp = d ? Number(d) : parseInt(h, 16);
  return cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ? m : String.fromCodePoint(cp);
});

function parse(html) {
  const src = blank(html);
  const root = { tag: '#root', attrs: {}, kids: [], parent: null, start: 0 };
  let cur = root;
  let last = 0;
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const text = (to) => {
    if (to > last) cur.kids.push({ text: decode(src.slice(last, to)), start: last });
  };
  let m;
  while ((m = re.exec(src))) {
    text(m.index);
    last = re.lastIndex;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let n = cur; n && n !== root; n = n.parent) {
        if (n.tag === tag) { cur = n.parent; break; }
      }
      continue;
    }
    if (cur.tag === 'p' && BLOCK_OPENERS.has(tag)) cur = cur.parent;
    const attrs = {};
    const ar = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = ar.exec(m[3]))) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const node = { tag, attrs, kids: [], parent: cur, start: m.index };
    cur.kids.push(node);
    if (!VOID.has(tag) && !m[3].trimEnd().endsWith('/')) cur = node;
  }
  text(src.length);
  return { root, src };
}

const lineOf = (src, off) => src.slice(0, off).split('\n').length;
const isEl = (n) => n.tag !== undefined;

function* walk(node) {
  for (const k of node.kids) {
    if (isEl(k)) { yield k; yield* walk(k); }
  }
}

function textOf(node) {
  if (!isEl(node)) return node.text;
  if (SKIP_TEXT.has(node.tag)) return '';
  return node.kids.map(textOf).join(' ');
}
const visible = (node) => squash(textOf(node));
const has = (node, attr) => Object.hasOwn(node.attrs, attr);
const find = (node, pred) => { for (const n of walk(node)) if (pred(n)) return n; return null; };
const findAll = (node, pred) => [...walk(node)].filter(pred);

// Text of a part with its leading <b>/<strong> label removed.
function bodyText(node) {
  const label = find(node, (n) => n.tag === 'b' || n.tag === 'strong');
  const full = visible(node);
  if (!label) return full;
  const lab = visible(label);
  return squash(full.startsWith(lab) ? full.slice(lab.length) : full.replace(lab, ''));
}

function makeIssues(level) {
  const errors = [];
  const warnings = [];
  const demote = level !== 'error';
  return {
    errors,
    warnings,
    E: (id, line, msg) => (demote ? warnings : errors).push({ id, line, msg }),
    W: (id, line, msg) => warnings.push({ id, line, msg }),
  };
}

const lvl = (opts) => (opts && opts.level) || CONTRACT_LEVEL;
const words5 = (t) => words(t) >= 5;

// C3 to C7 for one question, shared by the page scan and the record check.
function checkQuestion(q, report) {
  const { E, line } = report;
  const heading = q.heading;
  if (heading === null || heading === undefined) E('C3', line, 'the question has no h2-h4 heading; state the decision as a question');
  else if (words(heading) > 40) E('C3', line, `the question runs ${words(heading)} words; keep it to 40 or fewer`);
  else if (!heading.trim().endsWith('?')) E('C3', line, 'the question heading does not end with "?"');

  const keys = q.options.map((o) => o.key);
  if (q.recommendedKey !== null && q.recommendedKey !== undefined) {
    if (!keys.includes(q.recommendedKey)) E('C4', line, `recommended "${q.recommendedKey}" matches no option; name one of: ${keys.join(', ')}`);
    else if (!words5(q.reason || '')) E('C4', line, 'the recommendation needs a reason of at least 5 words');
  } else if (q.noRecommendation !== null && q.noRecommendation !== undefined) {
    if (!words5(q.noRecommendation)) E('C4', line, 'the no-recommendation note needs at least 5 words saying why');
  } else {
    E('C4', line, 'recommend an option with a reason, or say in 5+ words why you do not');
  }

  for (const o of q.options) {
    const where = o.line || line;
    if (isHatchOption(o)) continue;
    if (words(o.consequence || '') < 4) E('C5', where, `option "${o.key}" needs a consequence of at least 4 words`);
    if (!o.label || !o.label.trim()) E('C6', where, `option "${o.key}" has no label; add a <strong> that reads as words`);
    else if (norm(o.label) === norm(o.key)) E('C6', where, `option "${o.key}" has a label identical to its key; write the label for a reader`);
  }

  const ctx = [['why-now', q.whyNow], ['context', q.context]];
  for (const o of q.options) if (!isHatchOption(o)) ctx.push([`consequence of "${o.key}"`, o.consequence]);
  for (const [name, text] of ctx) {
    if (text === null || text === undefined || text === '') continue;
    const body = squash(String(text).replace(/^\s*why now\s*:/i, ''));
    if (isPointer(body) || words(body) < 3) E('C7', line, `the ${name} is a bare pointer or fragment; write the excerpt itself in 3+ words`);
  }
}

const isHatchOption = (o) => isHatch(o.key) || isHatch(o.label || '');

function emptyResult() { return { errors: [], warnings: [] }; }

export function checkPage(html, opts) {
  const { root, src } = parse(String(html));
  const questions = findAll(root, (n) => has(n, 'data-plan-question'));
  if (questions.length === 0) return emptyResult();
  const rep = makeIssues(lvl(opts));
  const { E, W } = rep;
  const all = [...walk(root)];

  // C1: brief
  const h1 = find(root, (n) => n.tag === 'h1');
  const brief = find(root, (n) => has(n, 'data-plan-brief'));
  if (!h1) E('C1', 1, 'the page has no <h1>; open with the finding in one line');
  if (!brief) E('C1', h1 ? lineOf(src, h1.start) : 1, 'no [data-plan-brief] section; add the four-part brief right after the <h1>');
  else {
    const line = lineOf(src, brief.start);
    if (h1) {
      const inH1 = new Set([h1, ...walk(h1)]);
      const next = all.slice(all.indexOf(h1) + 1).find((n) => !inH1.has(n));
      if (next !== brief) E('C1', line, 'the brief is not the first element after the <h1>; move it up');
    }
    for (const part of ['goal', 'done', 'ask', 'next']) {
      const p = find(brief, (n) => n.attrs['data-brief'] === part);
      if (!p) { E('C1', line, `the brief has no data-brief="${part}" part`); continue; }
      const body = bodyText(p);
      const pl = lineOf(src, p.start);
      if (words(body) < 5) E('C1', pl, `brief "${part}" is ${words(body)} words; write at least 5`);
      else if (isPointer(body)) E('C1', pl, `brief "${part}" is only a path or URL; say it in words`);
      if (isPointer(body) || (words(body) >= 1 && words(body) < 3)) E('C7', pl, `brief "${part}" is a bare pointer or fragment; write the context itself`);
    }
  }

  // C2: words before the first question
  const first = questions[0];
  let count = 0;
  (function scan(n) {
    for (const k of n.kids) {
      if (k === first) return true;
      if (!isEl(k)) count += words(k.text);
      else if (!SKIP_TEXT.has(k.tag) && scan(k)) return true;
    }
    return false;
  })(root);
  if (count > 250) E('C2', lineOf(src, first.start), `${count} words come before the first decision; keep it to 250 or fewer`);

  // C3 to C7 per question
  for (const qEl of questions) {
    const headEl = find(qEl, (n) => /^h[2-4]$/.test(n.tag));
    const optEls = findAll(qEl, (n) => has(n, 'data-plan-option'));
    const reasonEl = find(qEl, (n) => has(n, 'data-plan-reason'));
    const whyEl = find(qEl, (n) => has(n, 'data-plan-why-now'));
    checkQuestion({
      heading: headEl ? visible(headEl) : null,
      recommendedKey: has(qEl, 'data-plan-recommended') ? qEl.attrs['data-plan-recommended'] : null,
      reason: reasonEl ? visible(reasonEl) : '',
      noRecommendation: has(qEl, 'data-plan-no-recommendation') ? qEl.attrs['data-plan-no-recommendation'] : null,
      whyNow: whyEl ? visible(whyEl) : null,
      options: optEls.map((o) => {
        const strong = find(o, (n) => n.tag === 'strong');
        const cons = find(o, (n) => has(n, 'data-plan-consequence'));
        return { key: o.attrs['data-plan-option'], label: strong ? visible(strong) : '', consequence: cons ? visible(cons) : '', line: lineOf(src, o.start) };
      }),
    }, { E, line: lineOf(src, qEl.start) });
  }

  // C8: IDs a reader cannot decode
  const covered = new Set();
  const covText = [...all.filter((n) => n.tag === 'abbr' && n.attrs.title).map(visible),
    ...all.filter((n) => has(n, 'data-plan-glossary')).map(visible)].join(' ');
  for (const t of idsIn(covText)) covered.add(t);
  const seen = new Set();
  (function scan(n, inLink) {
    for (const k of n.kids) {
      if (!isEl(k)) {
        if (inLink) continue;
        for (const m of k.text.matchAll(ID_TOKEN)) {
          if (!NOT_AN_ID.has(m[0]) && !covered.has(m[0]) && !seen.has(m[0])) {
            seen.add(m[0]);
            W('C8', lineOf(src, k.start + m.index), `"${m[0]}" is an ID with no explanation; wrap it in <abbr title="..."> or add a [data-plan-glossary] entry`);
          }
        }
      } else if (!SKIP_TEXT.has(k.tag)) scan(k, inLink || (k.tag === 'a' && has(k, 'href')));
    }
  })(root, false);

  // C9, C10
  if (questions.length > 7) W('C9', lineOf(src, questions[7].start), `${questions.length} decisions on one page; 7 or fewer, or split the page`);
  const all_text = visible(root);
  const ins = /alt[- ]click|click (an|the) option/i.exec(all_text);
  if (ins) {
    const n = all.find((e) => !SKIP_TEXT.has(e.tag) && e.kids.some((k) => !isEl(k) && /alt[- ]click|click (an|the) option/i.test(squash(k.text))));
    W('C10', n ? lineOf(src, n.start) : 1, `the page tells the reader how to annotate or click ("${ins[0]}"); the shell owns those instructions`);
  }

  return { errors: rep.errors, warnings: rep.warnings };
}

export function checkDecisionRecord(obj, opts) {
  const rep = makeIssues(lvl(opts));
  const o = obj || {};
  const details = o.option_details || {};
  const raw = Array.isArray(o.options) ? o.options : [];
  const keys = raw.map((x) => (typeof x === 'string' ? x : x.key));
  for (const k of Object.keys(details)) if (!keys.includes(k)) throw new Error(`option_details names "${k}", which is not one of the options`);
  const options = raw.map((x) => {
    const key = typeof x === 'string' ? x : x.key;
    const d = typeof x === 'string' ? details[x] || {} : x;
    return { key, label: d.label, consequence: d.consequence };
  });
  checkQuestion({
    heading: typeof o.question === 'string' ? o.question : null,
    recommendedKey: o.recommended ? o.recommended.key : null,
    reason: o.recommended ? o.recommended.reason : '',
    noRecommendation: o.no_recommendation ?? null,
    whyNow: o.why_now ?? null,
    context: o.context_excerpt ?? null,
    options,
  }, { E: rep.E, line: 0 });
  return { errors: rep.errors, warnings: rep.warnings };
}

// artifact-check.py needs the page's own hatch options for its diagram rule, so they ride along.
function pageReport(file) {
  const html = fs.readFileSync(file, 'utf8');
  const result = checkPage(html);
  const { root } = parse(html);
  const hatch = findAll(root, (n) => has(n, 'data-plan-option'))
    .map((n) => n.attrs['data-plan-option']).filter((k) => isHatch(k));
  return { ...result, hatch };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--page');
  if (i < 0 || !process.argv[i + 1]) {
    process.stderr.write('usage: node contract.mjs --page <file.html>\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(pageReport(process.argv[i + 1])) + '\n');
}
