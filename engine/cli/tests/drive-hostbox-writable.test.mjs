import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInHostbox } from "../drive/hostbox.mjs";

const BOX = realpathSync(mkdtempSync(join(tmpdir(), "hostbox-writable-")));

function argvFor(writable) {
  let argv;
  const spawn = (bin, a) => {
    argv = a;
    const c = new EventEmitter();
    c.pid = 424242;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    setImmediate(() => { c.stdout.end(); c.stderr.end(); c.emit("exit", 0, null); c.emit("close", 0, null); });
    return c;
  };
  return runInHostbox({
    platform: "linux", box: BOX, cmd: "/usr/bin/true", cwd: BOX, net: "none", timeoutMs: 5000, writable,
    parentEnv: { PATH: "/usr/bin:/bin" }, which: (n) => `/usr/bin/${n}`, kill: () => {}, spawn, toolchainRoots: [],
  }).then(() => argv);
}

const mountAt = (argv, flag, p) => argv.findIndex((x, i) => x === flag && argv[i + 1] === p && argv[i + 2] === p);

test("linux: with no writable the whole box is bound read-write", async () => {
  const a = await argvFor(undefined);
  assert.notEqual(mountAt(a, "--bind", BOX), -1);
  assert.equal(mountAt(a, "--ro-bind", BOX), -1);
});

test("linux: with writable the box is read-only and only the entries, home and tmp are read-write", async () => {
  const a = await argvFor([join(BOX, "out")]);
  const ro = mountAt(a, "--ro-bind", BOX);
  assert.notEqual(ro, -1);
  assert.equal(mountAt(a, "--bind", BOX), -1);
  for (const d of ["out", "home", "tmp"]) assert.ok(mountAt(a, "--bind", join(BOX, d)) > ro, d);
  assert.equal(mountAt(a, "--bind", join(BOX, "work")), -1);
});
