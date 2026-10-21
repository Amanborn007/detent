// The stage prompts must tell the agent about the repo index, using forms the CLI accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "stages");
const read = (rel) => readFileSync(join(STAGES, rel), "utf8");

test("research checks index status first, refreshes when needed, and reads profile.md before anything else", () => {
  const s = read("research/SKILL.md");
  assert.match(s, /detent index status/);
  assert.match(s, /detent index (build|refresh)/);
  assert.match(s, /profile\.md/);
  assert.match(s, /repo-index/);
});

test("plan and recheck use detent index cochange for usual-partner checks", () => {
  assert.match(read("plan/SKILL.md"), /detent index cochange/);
  const r = read("recheck/SKILL.md");
  assert.match(r, /detent index cochange/);
  assert.match(r, /usual partner/i);
});
