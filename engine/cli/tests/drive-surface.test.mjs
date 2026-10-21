// drive-surface.test.mjs — everything around `detent drive` that is not the engine
// itself: umbrella routing, the in-session skill, driven-mode prompts, docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DETENT = join(REPO, "engine", "cli", "detent.mjs");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

test("detent help lists drive and its scope", () => {
  const r = spawnSync(process.execPath, [DETENT, "help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /detent drive/);
  assert.match(r.stdout, /intake.*research.*plan/i);
});

test("detent drive routes to the engine (an invalid run id is refused there)", () => {
  const r = spawnSync(process.execPath, [DETENT, "drive", "--run", "../x"], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /run id/i);
});

test("the drive skill has exact allowed-tools and the safe launch protocol", () => {
  const text = read("skills/drive/SKILL.md");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fm, "frontmatter");
  assert.match(fm[1], /^name: drive$/m);
  const tools = /allowed-tools:\s*>?-?\s*([\s\S]*?)(?:\n[a-z-]+:|$)/.exec(fm[1])[1].replace(/\s+/g, " ").trim();
  assert.equal(tools, "Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs drive --run *), Read, AskUserQuestion");
  assert.match(text, /run_in_background/);
  assert.match(text, /drive-last\.json/);
  assert.match(text, /never relay/i);
  assert.match(text, /re-run drive|run drive again|relaunch/i);
  assert.ok(!/--allow-ship/.test(text.replace(/never[^\n]*--allow-ship[^\n]*/gi, "")), "no --allow-ship instructions");
  assert.ok(!/curator open/.test(text) && !/gate collect/.test(text) && !/cat \*|tail \*/.test(text));
});

test("DRIVEN.md carries the driven-mode rules the child must follow", () => {
  const t = read("engine/stages/DRIVEN.md");
  for (const w of ["manifest.json", "detent-drive-outbox-v1", "nonce", "read-only", "never"]) assert.ok(t.includes(w), `DRIVEN.md lacks ${w}`);
  assert.match(t, /engine|curator|gh/);
  assert.match(t, /decisions\.json/);
  assert.match(t, /Intent check/);
});

test("plan SKILL step 7 (curator transcription) is interactive-only", () => {
  const t = read("engine/stages/plan/SKILL.md");
  const i = t.indexOf("7. **Open the gate.**");
  assert.ok(i > 0);
  assert.match(t.slice(i, i + 600), /interactive/i);
  assert.match(t.slice(i, i + 600), /DRIVEN\.md/);
});

test("docs describe the contained model, slice A scope and the residual risks", () => {
  for (const rel of ["engine/cli/README.md", "GUIDE.md", "docs/REFERENCE.md", "SECURITY.md"]) {
    const t = read(rel);
    assert.match(t, /detent drive|drive/i, rel);
    assert.ok(t.includes("--restricted"), `${rel}: --restricted`);
    assert.ok(!t.includes("only drive repos you trust"), `${rel}: stale trust warning`);
    assert.ok(!t.includes("--setting-sources project"), `${rel}: stale flag`);
  }
  for (const rel of ["engine/cli/README.md", "GUIDE.md", "docs/REFERENCE.md"]) {
    const t = read(rel);
    for (const w of ["macOS", "Linux", "--budget", "intake", "plan"]) assert.ok(t.includes(w), `${rel}: ${w}`);
    assert.ok(!t.includes("--allow-ship") || /refus/i.test(t), `${rel}: --allow-ship only as refused`);
  }
  const sec = read("SECURITY.md");
  for (const w of ["overshoot", "managed", "curator", "slice"]) assert.ok(sec.toLowerCase().includes(w), `SECURITY.md lacks ${w}`);
});

test("the engine no longer carries the old permission model", () => {
  const e = read("engine/cli/engine.mjs");
  for (const dead of ["DRIVE_DENY_ALWAYS", "PUSH_BLOCK_PREFIXES", "VERIFY_RUNNERS", "--setting-sources", "bypassPermissions\"] "]) {
    assert.ok(!e.includes(dead), `engine.mjs still has ${dead}`);
  }
  assert.ok(existsSync(join(REPO, "engine", "cli", "drive", "profile.mjs")));
});
