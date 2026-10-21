// The drive child must not be able to read or write the curator state dir, where the server secret lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync, mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildChildSettings, buildChildEnv } from "../drive/profile.mjs";
import { setup, drive, throughStage, scratch } from "./drive-kit.mjs";
import { engine, mkRun, throughResearch, writeArtifact } from "./helpers.mjs";

test("gate open and collect run the sibling curator CLI, never a curator found on PATH", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2);
  const bin = mkdtempSync(join(tmpdir(), "foreign-curator-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "curator"), `#!/bin/sh\necho "$@" >> "${log}"\n`);
  chmodSync(join(bin, "curator"), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, CURATOR_STATE_DIR: join(bin, "state") };
  const open = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId], { env });
  assert.equal(open.code, 0, open.stdout + open.stderr);
  assert.equal(open.json.mode, "curator");
  assert.match(open.json.next_step, /engine\/curator\/cli\.mjs open /, "the printed command is the sibling CLI");
  const collect = engine(["gate", "collect", "--run", ctx.runId], { env });
  assert.equal(collect.code, 0, collect.stdout + collect.stderr);
  assert.ok(!existsSync(log), `the PATH curator was run: ${existsSync(log) ? readFileSync(log, "utf8") : ""}`);
});

const rules = (dir) => ["Read", "Edit", "Write"].map((t) => `${t}(//${dir.replace(/^\/+/, "")}/**)`);

test("buildChildSettings denies Read, Edit and Write on the curator state dir", () => {
  const s = buildChildSettings({ permissions: { deny: [] } }, { inputs: "/x/in", outbox: "/x/out", apiKeyFile: null, curatorStateDir: "/x/cstate" });
  for (const r of rules("/x/cstate")) assert.ok(s.permissions.deny.includes(r), `missing ${r}`);
});

test("a real drive step carries the deny rules for CURATOR_STATE_DIR", () => {
  const t = setup();
  throughStage(t, "intake");
  const state = join(scratch(), "cstate");
  const r = drive(t, {}, ["--max-steps", "1"], { CURATOR_STATE_DIR: state });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const deny = r.calls[0].settings.permissions.deny;
  for (const rule of rules(state)) assert.ok(deny.includes(rule), `missing ${rule} in ${JSON.stringify(deny)}`);
});

test("without CURATOR_STATE_DIR the default state dir under the detent root is denied", () => {
  const t = setup();
  throughStage(t, "intake");
  const r = drive(t, {}, ["--max-steps", "1"], { DETENT_ROOT: t.home });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const deny = r.calls[0].settings.permissions.deny;
  for (const rule of rules(join(realpathSync(t.home), ".local", "curator"))) assert.ok(deny.includes(rule), `missing ${rule} in ${JSON.stringify(deny)}`);
});

test("regression guard (passes on main): the child env never carries CURATOR_*", () => {
  const { env } = buildChildEnv({ HOME: "/h", PATH: "/usr/bin", CURATOR_STATE_DIR: "/x/cstate", CURATOR_NO_BROWSER: "1" }, { tmpdir: "/t", sandboxRoot: "/s" });
  assert.equal(env.CURATOR_STATE_DIR, undefined);
  assert.equal(env.CURATOR_NO_BROWSER, undefined);
});
