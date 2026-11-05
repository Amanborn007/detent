// Opt-in live test for single-use host boxes; same gating as drive-hostbox-live.test.mjs:
//   DETENT_LIVE_HOSTBOX=1 node --test engine/cli/tests/drive-hostbox-once-live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBox, detectNested } from "../drive/hostbox.mjs";

function skipReason() {
  if (process.env.DETENT_LIVE_HOSTBOX !== "1") return "set DETENT_LIVE_HOSTBOX=1 to run";
  if (process.platform !== "darwin" && process.platform !== "linux") return `unsupported platform ${process.platform}`;
  const n = detectNested({ platform: process.platform });
  if (n.nested) return `this shell is already inside a sandbox (${n.detail}); run from an unsandboxed terminal`;
  return false;
}

const reason = skipReason();
if (reason) process.stderr.write(`[drive-hostbox-once-live] skipped: ${reason}\n`);

test("box refused on reuse", { skip: reason || false }, async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "hostbox-once-live-")));
  const b = createBox({ parent });
  const run = () => b.run({ platform: process.platform, cmd: "/bin/sh", args: ["-c", `echo x > "${b.dir}/out/f"`], net: "none", timeoutMs: 30_000 });
  const first = await run();
  assert.equal(first.code, 0);
  assert.ok(existsSync(join(b.dir, "out", "f")));
  await assert.rejects(run(), (e) => e.code === "hostbox_box_reused");
});
