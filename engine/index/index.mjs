#!/usr/bin/env node
// detent index: build and query a per-repo index of what the code defines,
// how files refer to each other, and which files change together.
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";
import { status, hasIndex, readJson, indexDir } from "./lib/store.mjs";
import { query as rankQuery } from "./lib/graph.mjs";
import { partners } from "./lib/history.mjs";

const USAGE = "usage: detent index [build|refresh|status|query <words>|cochange <files...>] [--repo .] [--commit] [--limit N]";

export function loadIndex(repo) {
  const manifest = readJson(repo, "manifest.json");
  const byFile = new Map();
  for (const line of readFileSync(join(indexDir(repo), "symbols.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    const s = JSON.parse(line);
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push({ name: s.name, kind: s.kind, line: s.line });
  }
  const { edges } = readJson(repo, "graph.json");
  return { manifest, byFile, edges, nodes: Object.keys(manifest.files).sort() };
}

export function runQuery(repo, words, limit = 10) {
  const ix = loadIndex(repo);
  return rankQuery(words, ix.nodes, ix.edges, ix.byFile, limit);
}

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commit") flags.commit = true;
    else if (a === "--repo" || a === "--limit") flags[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else pos.push(a);
  }
  return { pos, flags };
}

function warnIfStale(repo) {
  const s = status(repo);
  if (s.state === "stale") process.stderr.write(`detent index: warning: index is stale (${s.reason}); results may be wrong. Run: detent index refresh\n`);
  return s;
}

function needIndex(repo) {
  if (hasIndex(repo)) return true;
  process.stderr.write("detent index: no index for this repo. Run: detent index build\n");
  return false;
}

async function main() {
  let parsed;
  try { parsed = parse(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n${USAGE}\n`); return 2; }
  const { pos, flags } = parsed;
  const repo = resolve(flags.repo || ".");
  const cmd = pos[0] || "status";
  if (cmd === "build" || cmd === "refresh") {
    const r = await build(repo, { incremental: cmd === "refresh", commit: !!flags.commit });
    const m = r.manifest;
    process.stdout.write(`detent index ${cmd}: ${Object.keys(m.files).length} files, ${r.symbols} symbols, tagger ${m.tagger}, ${r.ms}ms -> ${join(repo, ".detent", "index")}\n`);
    if (m.tagger_note) process.stdout.write(`note: ${m.tagger_note}\n`);
    if (m.truncated) process.stdout.write(`note: truncated, ${m.truncated.reason}\n`);
    if (flags.commit) process.stdout.write("note: --commit given, so .detent/ is not excluded and the index will show in git status\n");
    return 0;
  }
  if (cmd === "status") { process.stdout.write(JSON.stringify(status(repo)) + "\n"); return 0; }
  if (cmd === "query") {
    if (pos.length < 2) { process.stderr.write(`query needs words\n${USAGE}\n`); return 2; }
    if (!needIndex(repo)) return 1;
    warnIfStale(repo);
    process.stdout.write(JSON.stringify(runQuery(repo, pos.slice(1), Number(flags.limit) || 10), null, 1) + "\n");
    return 0;
  }
  if (cmd === "cochange") {
    if (pos.length < 2) { process.stderr.write(`cochange needs files\n${USAGE}\n`); return 2; }
    if (!needIndex(repo)) return 1;
    warnIfStale(repo);
    const h = readJson(repo, "history.json");
    process.stdout.write(JSON.stringify(Object.fromEntries(pos.slice(1).map((f) => [f, partners(h, f)])), null, 1) + "\n");
    return 0;
  }
  process.stderr.write(`unknown command ${cmd}\n${USAGE}\n`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { process.stderr.write(`detent index: ${e.message}\n`); process.exit(1); });
}
