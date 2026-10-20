// The stage prompts tell an agent which CLI forms to use, so they must match what
// the engine and curator actually accept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "stages");
const read = (rel) => readFileSync(join(STAGES, rel), "utf8");
const docs = [
  ...readdirSync(STAGES).filter((d) => existsSync(join(STAGES, d, "SKILL.md"))).map((d) => `${d}/SKILL.md`),
  "README.md", "WALKTHROUGH.md", "CONTRACT.md",
];

test("no stage doc describes the old templated socket form", () => {
  for (const f of docs) {
    const s = read(f);
    for (const stale of ["sockets.ticket.fetch", "{ticket_ref}", "{query}", "skill_discovery"]) {
      assert.ok(!s.includes(stale), `${f} still mentions ${stale}`);
    }
  }
});

test("intake and research call sockets through the engine", () => {
  for (const f of ["intake/SKILL.md", "research/SKILL.md"]) {
    assert.match(read(f), /socket call/, `${f} never says to use socket call`);
  }
});

test("plan uses the engine's intent gate instead of filing a second approval", () => {
  for (const f of docs) assert.ok(!read(f).includes("Approve plan v1"), `${f} files its own approval gate`);
  assert.match(read("plan/SKILL.md"), /gate open intent/);
});

test("plan does not ask for status badges, which curator's check refuses", () => {
  assert.ok(!/badge/i.test(read("plan/SKILL.md")));
});
