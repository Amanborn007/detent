import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { commonDir, head, lsFiles } from "./git.mjs";
import { pathExcluded } from "./files.mjs";

export const indexDir = (repo) => join(repo, ".detent", "index");

export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export const readJson = (repo, name) => JSON.parse(readFileSync(join(indexDir(repo), name), "utf8"));
export const hasIndex = (repo) => existsSync(join(indexDir(repo), "manifest.json"));

export function addExclude(repo) {
  const file = join(commonDir(repo), "info", "exclude");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.split("\n").includes(".detent/")) return file;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + ".detent/\n");
  return file;
}

export function status(repo) {
  if (!hasIndex(repo)) return { state: "missing", reason: "no .detent/index/manifest.json" };
  const m = readJson(repo, "manifest.json");
  const now = head(repo);
  const reasons = [];
  if (m.head_sha !== now) reasons.push(`HEAD moved from ${m.head_sha.slice(0, 8)} to ${now.slice(0, 8)}`);
  const known = { ...m.skipped, ...m.files };
  const live = lsFiles(repo).filter((f) => !pathExcluded(f.path));
  const liveMap = new Map(live.map((f) => [f.path, f.sha]));
  let changed = 0, added = 0;
  for (const [p, sha] of liveMap) { if (!(p in known)) added++; else if (known[p] !== sha) changed++; }
  const removed = Object.keys(known).filter((p) => !liveMap.has(p)).length;
  if (changed || added || removed) reasons.push(`${changed} changed, ${added} added, ${removed} removed files`);
  return reasons.length
    ? { state: "stale", reason: reasons.join("; "), head_sha: m.head_sha, built_at: m.built_at }
    : { state: "fresh", head_sha: m.head_sha, built_at: m.built_at, tagger: m.tagger };
}
