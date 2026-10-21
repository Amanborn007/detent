// Shared fixtures for the runtime tests: a stub claude, request builders, the claude-code conformance fixture.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "runtime-")));

export const ENVELOPE = Object.freeze({
  type: "result", subtype: "success", is_error: false, result: "hi",
  total_cost_usd: 0.0123, num_turns: 2, permission_denials: [],
});

// Modes: ok | exit1 | garbage | sleep | nobin. Every start leaves <dir>/spawned and <dir>/log.json (argv, stdin, cwd).
export function makeFake(dir, mode) {
  const bin = join(dir, "claude");
  if (mode === "nobin") return { bin: join(dir, "no-such-claude") };
  writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(join(dir, "spawned"))}, "");
fs.writeFileSync(${JSON.stringify(join(dir, "log.json"))}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: fs.realpathSync(process.cwd()) }));
const mode = ${JSON.stringify(mode)};
const json = process.argv.includes("--output-format");
if (mode === "exit1") { process.stderr.write("boom\\n"); process.exit(1); }
if (mode === "garbage") { process.stdout.write("not json at all"); process.exit(0); }
if (mode === "sleep") setTimeout(() => {}, 10000);
else if (json) process.stdout.write(JSON.stringify(${JSON.stringify(ENVELOPE)}));
else process.stdout.write("hello\\n");
`);
  chmodSync(bin, 0o755);
  return { bin };
}

export const readLog = (dir) => JSON.parse(readFileSync(join(dir, "log.json"), "utf8"));
export const spawned = (dir) => existsSync(join(dir, "spawned"));

export function baseRequest(cwd, over = {}) {
  return {
    prompt: "say hi", cwd, output: "json", tools: "none", mcp: "none",
    settings: { sources: "none" }, ...over,
  };
}
