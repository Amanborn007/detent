import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createBox } from "../drive/hostbox.mjs";

const PARENT = realpathSync(mkdtempSync(join(tmpdir(), "hostbox-once-")));

function fakeSpawn() {
  const calls = [];
  const spawn = (bin, argv, opts) => {
    const c = new EventEmitter();
    c.pid = 424242;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    calls.push({ bin, argv, opts, child: c });
    setImmediate(() => {
      c.stdout.end(); c.stderr.end();
      c.emit("exit", 0, null);
      c.emit("close", 0, null);
    });
    return c;
  };
  spawn.calls = calls;
  return spawn;
}

const opts = (spawn, o = {}) => ({
  platform: "linux", cmd: "/usr/bin/true", net: "none", timeoutMs: 5000,
  parentEnv: { PATH: "/usr/bin:/bin" }, which: (n) => `/usr/bin/${n}`, kill: () => {}, spawn, ...o,
});
const reused = (e) => e.code === "hostbox_box_reused";

test("createBox makes a real 0700 dir under parent with the five working dirs", () => {
  const b = createBox({ parent: PARENT });
  assert.equal(realpathSync(b.dir), b.dir);
  assert.equal(dirname(b.dir), PARENT);
  assert.equal(statSync(b.dir).mode & 0o777, 0o700);
  for (const d of ["home", "tmp", "cache", "out", "work"]) assert.ok(statSync(join(b.dir, d)).isDirectory(), d);
});

test("two boxes never share a dir", () => {
  assert.notEqual(createBox({ parent: PARENT }).dir, createBox({ parent: PARENT }).dir);
});

test("createBox refuses a relative or missing parent", () => {
  assert.throws(() => createBox({ parent: "rel" }), (e) => e.code === "hostbox_bad_argument");
  assert.throws(() => createBox({ parent: join(PARENT, "nope") }), (e) => e.code === "hostbox_box_missing");
});

test("the first run goes through and defaults cwd to box/work", async () => {
  const b = createBox({ parent: PARENT });
  const spawn = fakeSpawn();
  const r = await b.run(opts(spawn));
  assert.equal(r.code, 0);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].opts.cwd, join(b.dir, "work"));
});

test("a second run on the same box throws hostbox_box_reused and spawns nothing", async () => {
  const b = createBox({ parent: PARENT });
  const spawn = fakeSpawn();
  await b.run(opts(spawn));
  await assert.rejects(b.run(opts(spawn)), reused);
  assert.equal(spawn.calls.length, 1);
});

test("two runs started together: exactly one wins", async () => {
  const b = createBox({ parent: PARENT });
  const spawn = fakeSpawn();
  const settled = await Promise.allSettled([b.run(opts(spawn)), b.run(opts(spawn))]);
  assert.deepEqual(settled.map((s) => s.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(spawn.calls.length, 1);
});

test("the use marker sits next to the box, outside it", async () => {
  const b = createBox({ parent: PARENT });
  await b.run(opts(fakeSpawn()));
  assert.ok(existsSync(`${b.dir}.used`));
  assert.ok(!`${b.dir}.used`.startsWith(b.dir + "/"));
});

test("deleting the marker does not re-arm the box in this process", async () => {
  const b = createBox({ parent: PARENT });
  const spawn = fakeSpawn();
  await b.run(opts(spawn));
  rmSync(`${b.dir}.used`);
  await assert.rejects(b.run(opts(spawn)), reused);
  assert.equal(spawn.calls.length, 1);
});

test("a marker alone refuses a box that this process never ran", async () => {
  const b = createBox({ parent: PARENT });
  writeFileSync(`${b.dir}.used`, "");
  const spawn = fakeSpawn();
  await assert.rejects(b.run(opts(spawn)), reused);
  assert.equal(spawn.calls.length, 0);
});

test("a run that fails to start still uses the box up", async () => {
  const b = createBox({ parent: PARENT });
  await assert.rejects(b.run(opts(fakeSpawn(), { which: () => null })), (e) => e.code === "bwrap_missing");
  await assert.rejects(b.run(opts(fakeSpawn())), reused);
});
