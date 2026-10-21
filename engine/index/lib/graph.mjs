// File graph: an edge A->B means A mentions a name that B defines.
const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
export const MIN_NAME = 4;
export const MAX_DEFINERS = 3;
// Aider-style: generic words and language builtins say nothing about which file is meant.
export const STOPLIST = new Set((
  "path node name data value values result results type types key keys index args options config error errors file files list item items " +
  "init main test tests self this info text line lines string number object array map set size count state props params param context " +
  "input output response request message event handler callback default class const function return import export from async await " +
  "true false null undefined void static public private protected interface enum struct impl trait super extends implements " +
  "break continue switch case catch throw try finally while else elif yield lambda print None True False dict tuple bool int float " +
  "len str range open read write close load save parse build make create update delete get put post run start stop next prev"
).split(/\s+/));
const SPECIFIC_BOOST = 10;
const AMBIGUOUS_FACTOR = 0.1;
const isSpecific = (n) => n.length >= 8 || /[a-z][A-Z]/.test(n) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(n);
const round = (x, p = 1e6) => Math.round(x * p) / p;

export function buildEdges(files, symbols) {
  const definers = new Map();
  for (const s of symbols) {
    if (s.name.length < MIN_NAME || STOPLIST.has(s.name.toLowerCase())) continue;
    if (!definers.has(s.name)) definers.set(s.name, new Set());
    definers.get(s.name).add(s.file);
  }
  for (const [name, set] of definers) if (set.size > MAX_DEFINERS) definers.delete(name);
  const edges = {};
  for (const [path, text] of files) {
    const counts = new Map();
    for (const tok of text.match(TOKEN) || []) if (definers.has(tok)) counts.set(tok, (counts.get(tok) || 0) + 1);
    const to = new Map();
    for (const [name, n] of counts) {
      // A definer mentioning its own name is not a reference (also stops duplicate definers forming a rank-hoarding cycle).
      if (definers.get(name).has(path)) continue;
      const w = (isSpecific(name) ? SPECIFIC_BOOST : 1) * (definers.get(name).size > 1 ? AMBIGUOUS_FACTOR : 1);
      for (const d of definers.get(name)) to.set(d, (to.get(d) || 0) + n * w);
    }
    if (to.size) {
      edges[path] = Object.fromEntries([...to].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([d, n]) => [d, round(Math.sqrt(n), 1000)]));
    }
  }
  return edges;
}

// Personalised PageRank; with no personalisation it is plain PageRank.
export function pageRank(nodes, edges, personal = null, iterations = 20, damping = 0.85) {
  const n = nodes.length;
  if (!n) return new Map();
  const pv = nodes.map((p) => (personal ? personal.get(p) ?? 0 : 1));
  const total = pv.reduce((a, b) => a + b, 0) || 1;
  const tele = pv.map((x) => x / total);
  const index = new Map(nodes.map((p, i) => [p, i]));
  const out = nodes.map((p) => {
    const e = Object.entries(edges[p] || {}).filter(([d]) => index.has(d)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { e, sum: e.reduce((a, [, w]) => a + w, 0) };
  });
  let r = tele.slice();
  for (let it = 0; it < iterations; it++) {
    const next = tele.map((t) => (1 - damping) * t);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!out[i].sum) { dangling += r[i]; continue; }
      for (const [d, w] of out[i].e) next[index.get(d)] += damping * r[i] * (w / out[i].sum);
    }
    for (let i = 0; i < n; i++) next[i] += damping * dangling * tele[i];
    r = next;
  }
  return new Map(nodes.map((p, i) => [p, round(r[i])]));
}

export function rankOrder(scores) {
  return [...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

export function query(words, nodes, edges, symbolsByFile, limit = 10) {
  const ws = words.map((w) => w.toLowerCase()).filter(Boolean);
  const personal = new Map();
  const hits = new Map();
  for (const p of nodes) {
    const defs = symbolsByFile.get(p) || [];
    const matched = defs.filter((s) => ws.some((w) => s.name.toLowerCase().includes(w))).map((s) => s.name);
    const pathHit = ws.some((w) => p.toLowerCase().includes(w));
    personal.set(p, matched.length || pathHit ? 10 : 1);
    if (matched.length || pathHit) hits.set(p, matched);
  }
  return rankOrder(pageRank(nodes, edges, personal)).slice(0, limit).map(([path, score]) => ({
    path, score, matches: (hits.get(path) || []).slice(0, 5),
  }));
}
