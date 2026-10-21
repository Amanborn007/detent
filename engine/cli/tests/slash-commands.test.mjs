// Docs must only tell a user to type slash commands that exist as skills in skills/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS = new Set(readdirSync(join(ROOT, "skills")).filter((d) => existsSync(join(ROOT, "skills", d, "SKILL.md"))));
const CLAUDE_CODE_BUILTINS = new Set(["plugin", "help", "reload-plugins", "clear", "verify"]);
const FILESYSTEM_DIRS = new Set(["tmp", "private", "etc", "usr", "var"]);

const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => f && !f.startsWith(".sdlc/") && !f.startsWith("benchmarks/"));

function slashCommands(text) {
  const found = [];
  for (const m of text.matchAll(/(?<![^\s(\[])`\/([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?)(?=[\s`])/g)) found.push(m[1]);
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    const m = fenced && /^\/([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?)(?=\s|$)/.exec(line);
    if (m) found.push(m[1]);
  }
  return found;
}

test("the skills directory is not empty", () => {
  assert.ok(SKILLS.size > 0);
});

test("every slash command in the docs is a real skill or a Claude Code built-in", () => {
  const bad = [];
  for (const f of files) {
    for (const cmd of slashCommands(readFileSync(join(ROOT, f), "utf8"))) {
      const name = cmd.startsWith("detent:") ? cmd.slice("detent:".length) : cmd;
      if (!SKILLS.has(name) && !CLAUDE_CODE_BUILTINS.has(cmd) && !FILESYSTEM_DIRS.has(cmd)) bad.push(`${f}: /${cmd}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("stage skill descriptions do not tell the user to type a trigger", () => {
  const dir = join(ROOT, "engine", "stages");
  for (const d of readdirSync(dir)) {
    const p = join(dir, d, "SKILL.md");
    if (!existsSync(p)) continue;
    const desc = /^description:(.*)$/m.exec(readFileSync(p, "utf8"))?.[1] ?? "";
    assert.ok(!/Trigger:\s*\//.test(desc), `${d}/SKILL.md description still carries a slash trigger`);
  }
});
