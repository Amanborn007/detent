// gitsafe.mjs — the only way drive runs git outside the sandbox. No shell, a
// scrubbed env, hardened config on every call, a timeout on every call, and a
// version floor. It never pushes, checks out, merges or otherwise writes a worktree.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// Floor for the 2024 git CVE fixes (symlink/submodule/hook-on-clone issues).
export const MIN_GIT = Object.freeze([2, 45, 1]);
export const DEFAULT_TIMEOUT_MS = 60_000;

export class GitError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "GitError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const CONFIG = [
  "core.hooksPath=/dev/null",
  "core.attributesFile=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  "core.askPass=/usr/bin/false",
  "core.protectHFS=true",
  "core.protectNTFS=true",
  "diff.external=",
  "gpg.program=/usr/bin/false",
  "log.showSignature=false",
  "transfer.fsckObjects=true",
  "fetch.fsckObjects=true",
  "receive.fsckObjects=true",
  "fsck.zeroPaddedFilemode=error",
  "protocol.allow=never",
  "credential.helper=",
  "gc.auto=0",
  "maintenance.auto=false",
  "fetch.writeCommitGraph=false",
];

export const HARD_GIT = Object.freeze(CONFIG.flatMap((c) => ["-c", c]));

const FORBIDDEN = new Set([
  "push", "checkout", "merge", "pull", "switch", "restore", "reset", "rebase", "cherry-pick", "am", "stash",
]);

let spy = null;
export function setGitSpy(fn) {
  spy = fn;
}

function hardEnv(extra) {
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    LC_ALL: "C",
  };
  for (const [k, v] of Object.entries(extra || {})) {
    if (!/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(k)) {
      throw new GitError("git_forbidden", `env ${k} is not allowed`);
    }
    env[k] = String(v);
  }
  return env;
}

const versions = new Map();

function ensureVersion(bin) {
  if (versions.has(bin)) return versions.get(bin);
  const r = spawnSync(bin, ["--version"], {
    env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C" },
    encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", shell: false,
  });
  if (r.error || r.status !== 0) {
    throw new GitError("git_unavailable", `cannot run ${bin} --version: ${r.error ? r.error.message : r.stderr}`);
  }
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(r.stdout);
  if (!m) throw new GitError("git_unavailable", `unparseable git version: ${r.stdout.trim()}`);
  const have = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  for (let i = 0; i < 3; i++) {
    if (have[i] > MIN_GIT[i]) break;
    if (have[i] < MIN_GIT[i]) {
      throw new GitError("git_too_old", `git ${have.join(".")} is older than the required ${MIN_GIT.join(".")}`);
    }
  }
  versions.set(bin, have);
  return have;
}

// Returns {status, stdout, stderr, truncated} with Buffers. Timeout, spawn
// failure, an old git or a forbidden subcommand throw GitError; a nonzero exit
// is returned for the caller to judge.
export function git(args, opts = {}) {
  const {
    repo, gitDir, input, env, timeoutMs = DEFAULT_TIMEOUT_MS, allowFile = false,
    config = [], gitBin = "git", maxBuffer = 512 * 1024 * 1024, allowTruncate = false, cwd,
  } = opts;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new GitError("git_forbidden", "args must be an array of strings");
  }
  if (repo && gitDir) throw new GitError("git_forbidden", "repo and gitDir are mutually exclusive");
  const sub = args[0];
  if (!sub || (sub.startsWith("-") && sub !== "--version")) {
    throw new GitError("git_forbidden", `args[0] must be a subcommand, got ${sub}`);
  }
  if (FORBIDDEN.has(sub)) throw new GitError("git_forbidden", `git ${sub} is never run by drive`);
  ensureVersion(gitBin);
  const argv = [
    ...(repo ? ["-C", repo] : gitDir ? ["--git-dir", gitDir] : []),
    ...HARD_GIT,
    ...(allowFile ? ["-c", "protocol.file.allow=always"] : []),
    ...config.flatMap((c) => ["-c", c]),
    ...args,
  ];
  if (spy) spy({ argv, bin: gitBin });
  const r = spawnSync(gitBin, argv, {
    input, env: hardEnv(env), timeout: timeoutMs, killSignal: "SIGKILL", shell: false,
    maxBuffer, cwd: cwd || tmpdir(), stdio: ["pipe", "pipe", "pipe"],
  });
  let truncated = false;
  if (r.error) {
    if (r.error.code === "ETIMEDOUT") {
      throw new GitError("git_timeout", `git ${sub} timed out after ${timeoutMs} ms`);
    }
    if (r.error.code === "ENOBUFS" && allowTruncate) truncated = true;
    else throw new GitError("git_unavailable", `git ${sub} failed to run: ${r.error.message}`);
  }
  if (r.status === null && !truncated) {
    throw new GitError("git_killed", `git ${sub} was killed by ${r.signal}`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, truncated };
}

// Like git(), but a nonzero exit throws and the stdout Buffer is returned.
export function gitOk(args, opts = {}) {
  const r = git(args, opts);
  if (r.status !== 0) {
    throw new GitError("git_failed", `git ${args[0]} exited ${r.status}: ${r.stderr.toString("utf8").trim()}`, {
      status: r.status, stderr: r.stderr.toString("utf8"),
    });
  }
  return r.stdout;
}
