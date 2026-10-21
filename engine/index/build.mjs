import { readFileSync } from "node:fs";
import { join } from "node:path";
import { head, lsFiles, blobSizes, readBlobs } from "./lib/git.mjs";
import { pathExcluded, looksBinary, MAX_FILE_BYTES, MAX_FILES } from "./lib/files.mjs";
import { pickTagger } from "./lib/tagger.mjs";
import { buildEdges, pageRank } from "./lib/graph.mjs";
import { renderMap } from "./lib/map.mjs";
import { buildProfile } from "./lib/profile.mjs";
import { updateState, renderHistory } from "./lib/history.mjs";
import { indexDir, writeAtomic, readJson, hasIndex, addExclude } from "./lib/store.mjs";
import { clean } from "./lib/sanitize.mjs";

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const CHUNK = 200;
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

function previous(repo, incremental) {
  if (!incremental || !hasIndex(repo)) return null;
  const manifest = readJson(repo, "manifest.json");
  const symbols = new Map();
  for (const line of readFileSync(join(indexDir(repo), "symbols.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    const s = JSON.parse(line);
    if (!symbols.has(s.file)) symbols.set(s.file, []);
    symbols.get(s.file).push({ name: s.name, kind: s.kind, line: s.line });
  }
  let state = null;
  try { state = readJson(repo, "history-state.json"); } catch { state = null; }
  return { manifest, symbols, state };
}

export async function build(repo, { incremental = false, commit = false, env = process.env } = {}) {
  const start = Date.now();
  const budget = env.DETENT_INDEX_BUDGET_MS !== undefined ? Number(env.DETENT_INDEX_BUDGET_MS) : 60000;
  const headSha = head(repo);
  const prev = previous(repo, incremental);
  const tagger = await pickTagger(env);
  const reuse = prev && prev.manifest.tagger === tagger.name && prev.manifest.generator_version === VERSION;

  const tracked = lsFiles(repo).filter((f) => !pathExcluded(f.path));
  const skipped = {};
  const candidates = tracked.slice(0, MAX_FILES);
  for (const f of tracked.slice(MAX_FILES)) skipped[f.path] = f.sha;

  const contents = new Map();
  const files = {};
  let truncated = null;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    if (Date.now() - start >= budget) {
      for (const f of candidates.slice(i)) skipped[f.path] = f.sha;
      truncated = { reason: `time budget of ${budget}ms reached`, deferred: candidates.length - i };
      break;
    }
    const sizes = blobSizes(repo, chunk.map((f) => f.sha));
    const wanted = chunk.filter((f) => (sizes.get(f.sha) ?? Infinity) <= MAX_FILE_BYTES);
    const blobs = wanted.length ? readBlobs(repo, [...new Set(wanted.map((f) => f.sha))]) : new Map();
    for (const f of chunk) {
      const buf = blobs.get(f.sha);
      if (!buf || looksBinary(buf)) { skipped[f.path] = f.sha; continue; }
      files[f.path] = f.sha;
      contents.set(f.path, buf.toString("utf8"));
    }
  }
  if (Object.keys(tracked).length > MAX_FILES && !truncated) {
    truncated = { reason: `file cap of ${MAX_FILES} reached`, deferred: tracked.length - MAX_FILES };
  }

  const paths = Object.keys(files).sort();
  const symbols = [];
  for (const p of paths) {
    const unchanged = reuse && prev.manifest.files[p] === files[p] && prev.symbols.has(p);
    const syms = unchanged ? prev.symbols.get(p) : await tagger.tag(p, contents.get(p));
    for (const s of syms) symbols.push({ file: p, name: s.name, kind: s.kind, line: s.line });
  }
  symbols.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const byFile = new Map();
  for (const s of symbols) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }

  const edges = buildEdges(contents, symbols);
  const scores = pageRank(paths, edges);

  const ext = new Map();
  const dirs = new Map();
  for (const p of paths) {
    const m = /\.([A-Za-z0-9]+)$/.exec(p);
    if (m) ext.set("." + m[1].toLowerCase(), (ext.get("." + m[1].toLowerCase()) || 0) + 1);
    const top = p.includes("/") ? p.slice(0, p.indexOf("/") + 1) : "(root)";
    dirs.set(top, (dirs.get(top) || 0) + 1);
  }
  const byCount = (m) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const profile = buildProfile(paths, (p) => contents.get(p), byCount(ext).slice(0, 10), byCount(dirs).slice(0, 15));

  const histState = updateState(repo, reuse ? prev.state : null, reuse && prev.state ? prev.manifest.head_sha : null);
  const history = renderHistory(histState, paths);

  const manifest = {
    generator_version: VERSION, tagger: tagger.name, ...(tagger.note ? { tagger_note: clean(tagger.note, 200) } : {}),
    head_sha: headSha, built_at: new Date().toISOString(),
    files: sortKeys(files), skipped: sortKeys(skipped),
    ...(truncated ? { truncated } : {}),
    suggested_verify: profile.verify,
  };

  const dir = indexDir(repo);
  writeAtomic(join(dir, "symbols.jsonl"), symbols.map((s) => JSON.stringify(s)).join("\n") + (symbols.length ? "\n" : ""));
  writeAtomic(join(dir, "graph.json"), JSON.stringify({ edges }) + "\n");
  writeAtomic(join(dir, "history.json"), JSON.stringify(history, null, 1) + "\n");
  writeAtomic(join(dir, "history-state.json"), JSON.stringify(histState) + "\n");
  writeAtomic(join(dir, "profile.md"), profile.text + "\n");
  writeAtomic(join(dir, "map.md"), renderMap(scores, byFile));
  writeAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

  const excluded = commit ? null : addExclude(repo);
  return { manifest, symbols: symbols.length, excluded, ms: Date.now() - start };
}
