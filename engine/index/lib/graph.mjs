// File graph: an edge A->B means A mentions a name that B defines.
const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
export const MIN_NAME = 4;
export const MAX_DEFINERS = 3;
const round = (x, p = 1e6) => Math.round(x * p) / p;

export function buildEdges(files, symbols) {
  const definers = new Map();
  for (const s of symbols) {
    if (s.name.length < MIN_NAME) continue;
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
      for (const d of definers.get(name)) if (d !== path) to.set(d, (to.get(d) || 0) + n);
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
