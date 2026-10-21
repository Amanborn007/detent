// --diagnose <tool>: run one toolchain command under the probe profile and list
// the sandbox denials the kernel logged for it. Only operation names and paths
// are reported, never the tool's own output.
import os from "node:os";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildProbeProfile, defaultDenyRead, XCODE_SELECT_LINK, XCODE_LICENSE_PLIST } from "./seatbelt-deny-default.mjs";
import { run } from "./exec.mjs";

export const TOOLS = [
  ["node", ["-v"]], ["npm", ["-v"]], ["git", ["--version"]], ["go", ["version"]],
  ["cargo", ["--version"]], ["python3", ["-V"]], ["make", ["-v"]], ["clang", ["--version"]],
];

export const GIT_COMMIT_SCRIPT = 'cd "$1" && git init -q && git -c user.name=probe -c user.email=probe@example.invalid commit --allow-empty -q -m probe && git rev-parse --verify HEAD';

export function diagnoseCommand(tool, repo) {
  if (tool === "git-commit") return ["/bin/sh", "-c", GIT_COMMIT_SCRIPT, "_", repo];
  const t = TOOLS.find(([n]) => n === tool);
  return t ? [t[0], ...t[1]] : null;
}

const LINE = /([^\s()]+)\((\d+)\)\s+deny\(\d+\)\s+(\S+)\s*(.*)$/;

// A line counts as ours when it carries the tag or comes from one of the pids we spawned.
export function parseDenials(text, tag, pids = []) {
  const rows = [];
  const mine = new Set(pids.map(String));
  for (const line of String(text).split("\n")) {
    const m = LINE.exec(line);
    if (m && line.includes("Sandbox")) rows.push({ process: m[1], operation: m[3], target: m[4].replace(tag, "").trim(), tagged: line.includes(tag) || mine.has(m[2]) });
  }
  const use = rows.some((r) => r.tagged) ? rows.filter((r) => r.tagged) : rows;
  const grouped = new Map();
  for (const r of use) {
    const k = `${r.process}\0${r.operation}\0${r.target}`;
    const g = grouped.get(k) || { process: r.process, operation: r.operation, target: r.target, count: 0 };
    g.count++;
    grouped.set(k, g);
  }
  return { tagged: rows.some((r) => r.tagged), denials: [...grouped.values()] };
}

export async function diagnose({ tool, realHome = realpathSync(os.homedir()) }) {
  const T = realpathSync(mkdtempSync(join(os.tmpdir(), "detent-diag-")));
  const S = join(T, "scratch");
  const repo = join(S, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(S, "tmp"), { recursive: true });
  mkdirSync(join(T, "fakehome"), { recursive: true });
  try {
    const argv = diagnoseCommand(tool, repo);
    if (!argv) return { error: "unknown_tool", message: `--diagnose takes one of: ${[...TOOLS.map(([n]) => n), "git-commit"].join(", ")}` };
    const tag = `detent-diag-${randomBytes(4).toString("hex")}`;
    const profile = buildProbeProfile({ scratch: S, loopbackPort: 9, denyRead: defaultDenyRead(realHome), reallowRead: [XCODE_SELECT_LINK, XCODE_LICENSE_PLIST], logTag: tag });
    const dd = await run("/usr/bin/xcode-select", ["-p"], { env: process.env });
    const devDir = dd.code === 0 && dd.stdout.trim().startsWith("/") ? dd.stdout.trim() : "/Library/Developer/CommandLineTools";
    const env = { DEVELOPER_DIR: devDir, PATH: process.env.PATH, HOME: join(T, "fakehome"), TMPDIR: join(S, "tmp"), LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const r = await run("sandbox-exec", ["-p", profile, ...argv], { env, cwd: S, timeout: 60000 });
    await new Promise((res) => setTimeout(res, 3000));
    const lg = await run("/usr/bin/log", ["show", "--predicate", 'eventMessage CONTAINS "deny"', "--last", "1m", "--style", "compact"], { env: process.env, timeout: 60000 });
    const parsed = parseDenials(lg.stdout, tag, [r.pid]);
    return {
      tool, exit: r.code, signal: r.signal, stderr_first_line: r.stderr.split("\n")[0].slice(0, 200), pid: r.pid, developer_dir: devDir, log_show_exit: lg.code, log_tagged: parsed.tagged,
      note: lg.code !== 0 ? "log show failed; try running it with sudo" : parsed.denials.length ? undefined : "no denials were logged in the last minute",
      denials: parsed.denials,
    };
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
}
