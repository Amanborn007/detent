// drive-implement-profile-user.test.mjs — claude's keychain lookup is keyed by
// $USER, so the child must get the parent's USER and LOGNAME verbatim.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const load = () => import("../drive/implement-profile.mjs");
const { createClaudeTmp, removeClaudeTmp } = await load();
const madeTmps = [];
const freshClaudeTmp = () => { const d = createClaudeTmp(); madeTmps.push(d); return d; };
after(() => { for (const d of madeTmps) removeClaudeTmp(d); });

function mkCtx() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "impl-user-")));
  const step = join(home, "S", "1");
  return {
    home, sroot: join(home, "S"), clone: join(step, "clone"), inputs: join(step, "inputs"),
    outbox: join(step, "outbox"), tmp: join(step, "tmp"), claudeTmp: freshClaudeTmp(),
    platform: "darwin", uid: 501, userTmp: "/private/var/folders/zz/T",
  };
}

test("USER and LOGNAME are passed verbatim from the parent env", async () => {
  const { buildImplementEnv } = await load();
  const env = buildImplementEnv({ PATH: "/usr/bin", USER: "parent.name", LOGNAME: "other.name" }, mkCtx());
  assert.equal(env.USER, "parent.name");
  assert.equal(env.LOGNAME, "other.name");
});

test("LOGNAME is omitted when the parent has none", async () => {
  const { buildImplementEnv } = await load();
  const env = buildImplementEnv({ PATH: "/usr/bin", USER: "u" }, mkCtx());
  assert.ok(!("LOGNAME" in env));
});

test("an unset or empty USER fails loudly", async () => {
  const { buildImplementEnv } = await load();
  assert.throws(() => buildImplementEnv({ PATH: "/usr/bin" }, mkCtx()), /USER/);
  assert.throws(() => buildImplementEnv({ PATH: "/usr/bin", USER: "" }, mkCtx()), /USER/);
});
