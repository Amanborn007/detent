import { git, isAncestor } from "./git.mjs";
import { pathExcluded } from "./files.mjs";

export const MAX_COMMIT_FILES = 50;
export const THRESHOLDS = { minRevs: 5, minShared: 5, minCoupling: 30 };

export function emptyState() {
  return { files: {}, pairs: {} };
}

function collect(repo, rangeArgs) {
  const out = git(repo, ["log", "--no-renames", "--numstat", "--format=@@@%H", ...rangeArgs]);
  const commits = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@@")) { cur = new Map(); commits.push(cur); continue; }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m && cur && !pathExcluded(m[3])) cur.set(m[3], [m[1] === "-" ? 0 : +m[1], m[2] === "-" ? 0 : +m[2]]);
  }
  return commits;
}

// Folds the commits since `fromSha` (or the last 12 months when there is no
// usable base) into `state`, so refresh and a full build reach the same totals.
export function updateState(repo, prevState, fromSha) {
  const incremental = prevState && fromSha && isAncestor(repo, fromSha);
  const state = incremental ? prevState : emptyState();
  const rangeArgs = incremental ? [`${fromSha}..HEAD`] : ["--since=12 months ago"];
  for (const files of collect(repo, rangeArgs)) {
    if (!files.size || files.size > MAX_COMMIT_FILES) continue;
    const paths = [...files.keys()].sort();
    for (const p of paths) {
      const f = (state.files[p] ||= [0, 0, 0]);
      f[0] += 1; f[1] += files.get(p)[0]; f[2] += files.get(p)[1];
    }
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const k = `${paths[i]}|${paths[j]}`;
        state.pairs[k] = (state.pairs[k] || 0) + 1;
      }
    }
  }
  return state;
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

export function renderHistory(state, tracked) {
  const keep = new Set(tracked);
  const files = {};
  for (const [p, [commits, added, deleted]] of Object.entries(sortObj(state.files))) {
    if (keep.has(p)) files[p] = { commits, added, deleted };
  }
  const pairs = [];
  for (const [k, shared] of Object.entries(sortObj(state.pairs))) {
    const [a, b] = k.split("|");
    if (!keep.has(a) || !keep.has(b)) continue;
    const ra = state.files[a][0], rb = state.files[b][0];
    const coupling = Math.round((shared / ((ra + rb) / 2)) * 1000) / 10;
    if (ra >= THRESHOLDS.minRevs && rb >= THRESHOLDS.minRevs && shared >= THRESHOLDS.minShared && coupling >= THRESHOLDS.minCoupling) {
      pairs.push({ a, b, shared, coupling });
    }
  }
  return { window_months: 12, thresholds: THRESHOLDS, files, pairs };
}

export function partners(history, file) {
  const out = [];
  for (const p of history.pairs) {
    if (p.a === file) out.push({ partner: p.b, shared: p.shared, coupling: p.coupling });
    else if (p.b === file) out.push({ partner: p.a, shared: p.shared, coupling: p.coupling });
  }
  return out.sort((x, y) => y.coupling - x.coupling || y.shared - x.shared || (x.partner < y.partner ? -1 : 1));
}
