// The start, continue and status skills must call real CLI verbs and keep gate answers with the human.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const read = (n) => readFileSync(join(SKILLS, n, "SKILL.md"), "utf8");
const CLI = "node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs";

for (const [name, verb] of [["start", "start"], ["continue", "continue"], ["status", "status"]]) {
  test(`${name} skill has frontmatter and calls detent ${verb}`, () => {
    const s = read(name);
    assert.match(s, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(s, /\ndescription: >-\n(?:  .+\n)+/);
    assert.ok(s.includes(`${CLI} ${verb}`), `${name} never calls ${CLI} ${verb}`);
  });
}

test("start takes owner/repo#N", () => {
  assert.match(read("start"), /owner\/repo#N/);
});

test("continue reads the stage SKILL.md under CLAUDECODE and never answers gates itself", () => {
  const s = read("continue");
  assert.match(s, /CLAUDECODE/);
  assert.match(s, /SKILL\.md/);
  assert.match(s, /detent\.mjs decide/);
  assert.match(s, /curator/);
  assert.match(s, /never answer/i);
  assert.match(s, /approve/);
  assert.match(s, /revise/);
});

test("skill descriptions say when to trigger", () => {
  for (const n of ["start", "continue", "status"]) assert.match(read(n), /description: >-\n[\s\S]*?\b(Use|Run) (this )?when\b/i, n);
});
