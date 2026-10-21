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

test("run state is placed in DETENT_ROOT/.sdlc, not the work repo's main checkout", () => {
  for (const f of docs) {
    const s = read(f);
    assert.ok(!/main checkout/i.test(s), `${f} still puts run state in the main checkout`);
    assert.ok(!s.includes("--git-common-dir` → its parent"), `${f} derives the run dir from git`);
  }
  assert.match(read("implement/SKILL.md"), /\$\{DETENT_ROOT\}\/\.sdlc\//);
});

const REAL_STAGES = new Set(["intake", "research", "plan", "implement", "recheck", "ship", "respond", "intent_check"]);

test("stage names in blocks literals and stage-status keys are real stages", () => {
  for (const f of docs) {
    const s = read(f);
    for (const m of s.matchAll(/"blocks":\s*\[([^\]]*)\]/g)) {
      for (const name of m[1].match(/"([^"]+)"/g) || []) {
        assert.ok(REAL_STAGES.has(name.slice(1, -1)), `${f}: blocks names pseudo-stage ${name}`);
      }
    }
    for (const m of s.matchAll(/`(\w+): (?:in_progress|done|blocked)(?:\|[a-z_|]+)?`/g)) {
      assert.ok(REAL_STAGES.has(m[1]), `${f}: stage-status key '${m[1]}' is not a real stage`);
    }
  }
  const example = /```json\n(\{\n  "run_id"[\s\S]*?\n\})\n```/.exec(read("CONTRACT.md"));
  assert.ok(example, "CONTRACT.md stage-status example not found");
  for (const key of Object.keys(JSON.parse(example[1]).stages)) {
    assert.ok(REAL_STAGES.has(key), `CONTRACT.md stage-status example has pseudo-stage '${key}'`);
  }
});

test("ship says not to push while a decision blocking ship is pending", () => {
  assert.match(read("ship/SKILL.md"), /must not push[\s\S]{0,200}pending/i);
  assert.match(read("ship/SKILL.md"), /"blocks": \["ship"\]/);
});

test("recheck reads worktree, branch and base_sha from run.json, not the implement entry", () => {
  const recheck = read("recheck/SKILL.md");
  assert.match(recheck, /run\.json/);
  assert.match(recheck, /base_sha/);
  assert.ok(!/from the `implement` entry/.test(recheck), "recheck still reads the range from the implement entry");
  assert.ok(!/recording worktree path, branch, and commit range/.test(read("implement/SKILL.md")),
    "implement still claims stage end records worktree/branch/range");
});

test("plan asks why rejected options lost and implement records dead ends and env", () => {
  const plan = read("plan/SKILL.md");
  assert.match(plan, /detent decide-why --run <id> --decision <D-id> --option "<opt>" --why "<reason>"/);
  assert.match(plan, /never invent/i);
  const impl = read("implement/SKILL.md");
  assert.match(impl, /detent attempt "<approach>" --run <id> --outcome failed\|abandoned\|superseded --evidence "<why>"/);
  assert.match(impl, /detent attempt --none --run <id>/);
  assert.match(impl, /detent env --run <id> --verify "<cmd>"/);
  assert.match(impl, /incomplete/i);
});

test("respond names which sentinel config to use and never touches the personal one", () => {
  const respond = read("respond/SKILL.md");
  assert.ok(!respond.includes("--config <config.json>"), "respond still has the --config <config.json> placeholder");
  assert.match(respond, /config\/sentinel\/default\.json/);
  assert.match(respond, /SENTINEL_CONFIG/);
  assert.match(respond, /~\/\.sentinel/);
});

test("respond runs engine subcommands as detent in shell commands", () => {
  const respond = read("respond/SKILL.md");
  assert.ok(!/`engine (bench|respond)\b/.test(respond), "respond still tells the shell to run `engine <cmd>`");
});
