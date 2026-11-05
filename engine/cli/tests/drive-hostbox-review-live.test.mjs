// Opt-in live test for the host box review fixes; same gating as drive-hostbox-live.test.mjs:
//   DETENT_LIVE_HOSTBOX=1 node --test engine/cli/tests/drive-hostbox-review-live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInHostbox, detectNested } from "../drive/hostbox.mjs";

function skipReason() {
  if (process.env.DETENT_LIVE_HOSTBOX !== "1") return "set DETENT_LIVE_HOSTBOX=1 to run";
  if (process.platform !== "darwin" && process.platform !== "linux") return `unsupported platform ${process.platform}`;
  const n = detectNested({ platform: process.platform });
  if (n.nested) return `this shell is already inside a sandbox (${n.detail}); run from an unsandboxed terminal`;
  return false;
}

const reason = skipReason();
if (reason) process.stderr.write(`[drive-hostbox-review-live] skipped: ${reason}\n`);
const live = (name, o, fn) => test(name, { skip: reason || o.skip || false }, fn);
const darwin = { skip: process.platform !== "darwin" && "macOS only" };

const platform = process.platform;
const mkBox = () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "hostbox-review-live-")));
  for (const d of ["work", "tmp", "home", "cache", "out"]) mkdirSync(join(box, d));
  return box;
};
const sh = (box, script, o = {}) => runInHostbox({ platform, box, cmd: "/bin/sh", args: ["-c", script], cwd: join(box, "work"), net: "none", timeoutMs: 30_000, ...o });

live("a setsid child cannot outlive the run to touch a file", darwin, async () => {
  const box = mkBox();
  const marker = join(box, "out", "survivor");
  const script = `/usr/bin/perl -e 'use POSIX; if (POSIX::setsid() == -1) { exit 0 } fork() and exit 0; sleep 1; open(F, ">${marker}"); close F' & sleep 300`;
  const r = await sh(box, script, { timeoutMs: 1000 });
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(existsSync(marker), false);
});

live("a canary in realpath(tmpdir()) outside the box is unreadable", darwin, async () => {
  const box = mkBox();
  const canary = join(realpathSync(tmpdir()), `hostbox-canary-${process.pid}`);
  writeFileSync(canary, "secret\n");
  try {
    const r = await sh(box, `cat "${canary}"`);
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stdout, /secret/);
  } finally { rmSync(canary, { force: true }); }
});

live("with writable limited to box/out a write to box/work fails", {}, async () => {
  const box = mkBox();
  await sh(box, `echo x > "${box}/work/f"; echo y > "${box}/out/f"`, { writable: [join(box, "out")] });
  assert.equal(existsSync(join(box, "work", "f")), false);
  assert.equal(existsSync(join(box, "out", "f")), true);
});
