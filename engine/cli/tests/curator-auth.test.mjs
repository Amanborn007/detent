// The drive child must not be able to read or write the curator state dir, where the server secret lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { buildChildSettings, buildChildEnv } from "../drive/profile.mjs";
import { setup, drive, throughStage, scratch } from "./drive-kit.mjs";

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
