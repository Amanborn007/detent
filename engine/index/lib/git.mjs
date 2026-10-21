import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const BIG = 512 * 1024 * 1024;

export function git(repo, args, opts = {}) {
  const r = spawnSync("git", ["-C", repo, "-c", "core.quotepath=false", ...args], {
    maxBuffer: BIG, encoding: opts.buffer ? null : "utf8", input: opts.input,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed in ${repo}: ${String(r.stderr).trim()}`);
  }
  return opts.allowFail ? r : r.stdout;
}

export function head(repo) {
  return git(repo, ["rev-parse", "--verify", "HEAD"]).trim();
}

export function lsFiles(repo) {
  const out = git(repo, ["ls-files", "-s", "-z"]);
  const files = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const m = /^(\d+) ([0-9a-f]{40}) (\d+)\t(.*)$/s.exec(rec);
    if (m && m[1] !== "160000" && m[3] === "0") files.push({ path: m[4], sha: m[2] });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function commonDir(repo) {
  return resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]).trim());
}

export function isAncestor(repo, sha) {
  return git(repo, ["merge-base", "--is-ancestor", sha, "HEAD"], { allowFail: true }).status === 0;
}

// Blob sizes, then contents for the ones worth reading. Reading blobs (not the
// worktree) keeps the index consistent with the shas it records.
export function blobSizes(repo, shas) {
  const out = git(repo, ["cat-file", "--batch-check"], { input: shas.join("\n") + "\n" });
  const sizes = new Map();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(line);
    if (m) sizes.set(m[1], Number(m[2]));
  }
  return sizes;
}

export function readBlobs(repo, shas) {
  const buf = git(repo, ["cat-file", "--batch"], { input: shas.join("\n") + "\n", buffer: true });
  const blobs = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(buf.toString("latin1", pos, nl));
    if (!m) { pos = nl + 1; continue; }
    const size = Number(m[2]);
    blobs.set(m[1], buf.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return blobs;
}
