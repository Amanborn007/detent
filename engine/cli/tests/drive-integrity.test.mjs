// drive-integrity.test.mjs — the drive state tracker: a supervisor snapshots
// digests of its run-state files, a hostile child runs, verify() reports every
// change not made through tracker.write()/append(). Detection only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  symlinkSync, chmodSync, renameSync, rmSync, realpathSync, lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createStateTracker } from "../drive/integrity.mjs";

function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), "drive-integrity-")));
}

function tree(root) {
  mkdirSync(join(root, "run", "sub", "deep"), { recursive: true });
  writeFileSync(join(root, "run", "state.json"), '{"step":1}\n');
  writeFileSync(join(root, "run", "sub", "a.txt"), "alpha\n");
  writeFileSync(join(root, "run", "sub", "deep", "b.txt"), "beta\n");
  return join(root, "run");
}

test("verify is ok right after snapshot", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  assert.deepEqual(t.verify(), { ok: true });
});

test("verify and write refuse to run before snapshot", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  assert.throws(() => t.verify(), /snapshot/);
  assert.throws(() => t.write(join(run, "x"), "x"), /snapshot/);
});

test("content change in a tracked file is reported", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  writeFileSync(join(run, "state.json"), '{"step":2}\n');
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "state.json")] });
});

test("a tracked file that is absent at snapshot stays ok while absent", () => {
  const root = scratch();
  const f = join(root, "later.json");
  const t = createStateTracker({ files: [f] });
  t.snapshot();
  assert.deepEqual(t.verify(), { ok: true });
});

test("file created after snapshot is reported", () => {
  const root = scratch();
  const f = join(root, "later.json");
  const t = createStateTracker({ files: [f] });
  t.snapshot();
  writeFileSync(f, "{}");
  assert.deepEqual(t.verify(), { ok: false, changed: [f] });
});

test("file deleted after snapshot is reported", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  rmSync(join(run, "sub", "a.txt"));
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "sub", "a.txt")] });
});

test("file replaced by a symlink with identical content is reported", () => {
  const root = scratch();
  const run = tree(root);
  const copy = join(root, "copy.json");
  writeFileSync(copy, readFileSync(join(run, "state.json")));
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  rmSync(join(run, "state.json"));
  symlinkSync(copy, join(run, "state.json"));
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "state.json")] });
});

test("tracked single file replaced by a symlink with identical content is reported", () => {
  const root = scratch();
  const f = join(root, "state.json");
  const copy = join(root, "copy.json");
  writeFileSync(f, "same\n");
  writeFileSync(copy, "same\n");
  const t = createStateTracker({ files: [f] });
  t.snapshot();
  rmSync(f);
  symlinkSync(copy, f);
  assert.deepEqual(t.verify(), { ok: false, changed: [f] });
});

test("chmod change is reported", () => {
  const root = scratch();
  const run = tree(root);
  const a = join(run, "sub", "a.txt");
  chmodSync(a, 0o644);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  chmodSync(a, 0o600);
  assert.deepEqual(t.verify(), { ok: false, changed: [a] });
});

test("directory chmod is reported", () => {
  const root = scratch();
  const run = tree(root);
  chmodSync(join(run, "sub"), 0o755);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  chmodSync(join(run, "sub"), 0o700);
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "sub")] });
});

test("new file in a nested subdir is reported", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  writeFileSync(join(run, "sub", "deep", "evil.txt"), "x");
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "sub", "deep", "evil.txt")] });
});

test("new subdirectory with files is reported entry by entry", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  mkdirSync(join(run, "new"));
  writeFileSync(join(run, "new", "f.txt"), "x");
  assert.deepEqual(t.verify(), {
    ok: false,
    changed: [join(run, "new"), join(run, "new", "f.txt")],
  });
});

test("rename within a dir reports both the old and the new path", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  renameSync(join(run, "sub", "a.txt"), join(run, "sub", "renamed.txt"));
  assert.deepEqual(t.verify(), {
    ok: false,
    changed: [join(run, "sub", "a.txt"), join(run, "sub", "renamed.txt")],
  });
});

test("removed subdirectory reports the dir and everything under it", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  rmSync(join(run, "sub", "deep"), { recursive: true });
  assert.deepEqual(t.verify(), {
    ok: false,
    changed: [join(run, "sub", "deep"), join(run, "sub", "deep", "b.txt")],
  });
});

test("tracked file replaced by a directory is reported", () => {
  const root = scratch();
  const f = join(root, "state.json");
  writeFileSync(f, "x");
  const t = createStateTracker({ files: [f] });
  t.snapshot();
  rmSync(f);
  mkdirSync(f);
  assert.deepEqual(t.verify(), { ok: false, changed: [f] });
});

test("changed paths are sorted", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  writeFileSync(join(run, "z.txt"), "z");
  writeFileSync(join(run, "a.txt"), "a");
  writeFileSync(join(run, "state.json"), "{}");
  const r = t.verify();
  assert.deepEqual(r.changed, [...r.changed].sort());
  assert.equal(r.changed.length, 3);
});

test("symlinks in a tracked dir are recorded by target and never followed", () => {
  const root = scratch();
  const run = tree(root);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "one");
  symlinkSync(outside, join(run, "link"));
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  writeFileSync(join(outside, "secret.txt"), "two");
  writeFileSync(join(outside, "new.txt"), "n");
  assert.deepEqual(t.verify(), { ok: true });
  rmSync(join(run, "link"));
  symlinkSync(join(root, "elsewhere"), join(run, "link"));
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "link")] });
});

test("a symlink loop inside a tracked dir terminates", () => {
  const root = scratch();
  const run = tree(root);
  symlinkSync(run, join(run, "loop"));
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  assert.deepEqual(t.verify(), { ok: true });
});

test("a tracked dir that is itself a symlink is recorded as a symlink, not followed", () => {
  const root = scratch();
  const real = join(root, "real");
  mkdirSync(real);
  writeFileSync(join(real, "f.txt"), "x");
  const link = join(root, "link");
  symlinkSync(real, link);
  const t = createStateTracker({ dirs: [link] });
  t.snapshot();
  writeFileSync(join(real, "f.txt"), "y");
  assert.deepEqual(t.verify(), { ok: true });
});

test("excluded prefixes are ignored by verify, siblings sharing the string prefix are not", () => {
  const root = scratch();
  const run = tree(root);
  mkdirSync(join(run, "logs"));
  mkdirSync(join(run, "logs2"));
  writeFileSync(join(run, "logs", "out.log"), "a");
  writeFileSync(join(run, "logs2", "out.log"), "a");
  const t = createStateTracker({ dirs: [run], exclude: [join(run, "logs")] });
  t.snapshot();
  writeFileSync(join(run, "logs", "out.log"), "b");
  writeFileSync(join(run, "logs", "new.log"), "b");
  assert.deepEqual(t.verify(), { ok: true });
  writeFileSync(join(run, "logs2", "out.log"), "b");
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "logs2", "out.log")] });
});

test("write to an excluded path throws", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run], exclude: [join(run, "logs")] });
  t.snapshot();
  assert.throws(() => t.write(join(run, "logs", "x.log"), "x"), /exclude/i);
  assert.equal(existsSync(join(run, "logs")), false);
});

test("write outside the tracked set throws and writes nothing", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run], files: [join(root, "one.json")] });
  t.snapshot();
  const stray = join(root, "stray.json");
  assert.throws(() => t.write(stray, "x"), /not (inside|within|in) /i);
  assert.equal(existsSync(stray), false);
  assert.throws(() => t.write(join(root, "run-other", "x"), "x"), /not (inside|within|in) /i);
  assert.throws(() => t.append(stray, "x"), /not (inside|within|in) /i);
});

test("write refuses a relative path and a path with .. escaping the tree", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  assert.throws(() => t.write("state.json", "x"), /absolute/i);
  assert.throws(() => t.write(join(run, "..", "stray.json"), "x"), /not (inside|within|in) /i);
});

test("supervisor write then verify is ok", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  t.write(join(run, "state.json"), '{"step":2}\n');
  assert.equal(readFileSync(join(run, "state.json"), "utf8"), '{"step":2}\n');
  assert.deepEqual(t.verify(), { ok: true });
});

test("supervisor write creating a tracked file that was absent is ok", () => {
  const root = scratch();
  const f = join(root, "later.json");
  const t = createStateTracker({ files: [f] });
  t.snapshot();
  t.write(f, "{}\n");
  assert.deepEqual(t.verify(), { ok: true });
});

test("supervisor write creates missing parent dirs inside a tracked dir and verifies ok", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  t.write(join(run, "n1", "n2", "f.txt"), "x");
  assert.equal(readFileSync(join(run, "n1", "n2", "f.txt"), "utf8"), "x");
  assert.deepEqual(t.verify(), { ok: true });
  writeFileSync(join(run, "n1", "n2", "f.txt"), "y");
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "n1", "n2", "f.txt")] });
});

test("supervisor write creates a tracked dir that was absent at snapshot", () => {
  const root = scratch();
  const run = join(root, "not-yet");
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  t.write(join(run, "a", "f.txt"), "x");
  assert.deepEqual(t.verify(), { ok: true });
});

test("supervisor write followed by a hostile write to the same file is detected", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  t.write(join(run, "state.json"), '{"step":2}\n');
  writeFileSync(join(run, "state.json"), '{"step":99}\n');
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "state.json")] });
});

test("a supervisor write does not absorb a hostile change to another file", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  writeFileSync(join(run, "sub", "a.txt"), "tampered");
  t.write(join(run, "state.json"), '{"step":2}\n');
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "sub", "a.txt")] });
});

test("a supervisor write does not absorb a hostile new file in the same dir", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  writeFileSync(join(run, "evil.txt"), "x");
  t.write(join(run, "state.json"), "{}\n");
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "evil.txt")] });
});

test("write over a path the child already changed throws instead of absorbing it", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  writeFileSync(join(run, "state.json"), "tampered");
  assert.throws(() => t.write(join(run, "state.json"), "{}\n"), /outside the tracker|tamper|modified/i);
  assert.equal(readFileSync(join(run, "state.json"), "utf8"), "tampered");
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "state.json")] });
});

test("write over a file the child created at an absent tracked path throws", () => {
  const root = scratch();
  const f = join(root, "later.json");
  const t = createStateTracker({ files: [f] });
  t.snapshot();
  writeFileSync(f, "planted");
  assert.throws(() => t.write(f, "{}\n"), /outside the tracker|tamper|modified/i);
});

test("write preserves the mode of an existing file", () => {
  const root = scratch();
  const run = tree(root);
  chmodSync(join(run, "state.json"), 0o640);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  t.write(join(run, "state.json"), "new\n");
  assert.equal(lstatSync(join(run, "state.json")).mode & 0o777, 0o640);
  assert.deepEqual(t.verify(), { ok: true });
});

test("write accepts a Buffer and round-trips bytes", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  const bytes = Buffer.from([0, 255, 1, 254, 10]);
  t.write(join(run, "bin.dat"), bytes);
  assert.deepEqual(readFileSync(join(run, "bin.dat")), bytes);
  assert.deepEqual(t.verify(), { ok: true });
});

test("write through a tracked subdir that the child swapped for a symlink throws", () => {
  const root = scratch();
  const run = tree(root);
  const outside = join(root, "outside");
  mkdirSync(outside);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  rmSync(join(run, "sub"), { recursive: true });
  symlinkSync(outside, join(run, "sub"));
  assert.throws(() => t.write(join(run, "sub", "x.txt"), "x"), /symlink|not a directory|outside the tracker/i);
  assert.deepEqual(readdirSync(outside), []);
});

test("a failed write leaves the target unchanged and no temp file behind", () => {
  const root = scratch();
  const run = tree(root);
  mkdirSync(join(run, "d"));
  writeFileSync(join(run, "d", "keep.txt"), "keep");
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  // renaming a file over a non-empty directory fails after the temp is written
  assert.throws(() => t.write(join(run, "d"), "x"));
  assert.equal(readFileSync(join(run, "d", "keep.txt"), "utf8"), "keep");
  assert.deepEqual(readdirSync(run).sort(), ["d", "state.json", "sub"]);
  assert.deepEqual(t.verify(), { ok: true });
});

test("a failed write does not move the baseline", () => {
  const root = scratch();
  const run = tree(root);
  mkdirSync(join(run, "d"));
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  assert.throws(() => t.write(join(run, "d"), "x"));
  rmSync(join(run, "d"), { recursive: true });
  assert.deepEqual(t.verify(), { ok: false, changed: [join(run, "d")] });
});

test("append adds a newline-terminated line, creating the file if absent", () => {
  const root = scratch();
  const run = tree(root);
  const log = join(run, "events.jsonl");
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  t.append(log, '{"n":1}');
  t.append(log, '{"n":2}\n');
  assert.equal(readFileSync(log, "utf8"), '{"n":1}\n{"n":2}\n');
  assert.deepEqual(t.verify(), { ok: true });
});

test("append on a tracked single file", () => {
  const root = scratch();
  const f = join(root, "events.jsonl");
  writeFileSync(f, "a\n");
  const t = createStateTracker({ files: [f] });
  t.snapshot();
  t.append(f, "b");
  assert.equal(readFileSync(f, "utf8"), "a\nb\n");
  assert.deepEqual(t.verify(), { ok: true });
});

test("append after a hostile symlink swap throws and leaves the link target alone", () => {
  const root = scratch();
  const run = tree(root);
  const log = join(run, "events.jsonl");
  const secret = join(root, "secret");
  writeFileSync(secret, "s3cret\n");
  writeFileSync(log, "a\n");
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  rmSync(log);
  symlinkSync(secret, log);
  assert.throws(() => t.append(log, "b"));
  assert.equal(readFileSync(secret, "utf8"), "s3cret\n");
});

test("append then hostile edit is detected", () => {
  const root = scratch();
  const run = tree(root);
  const log = join(run, "events.jsonl");
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  t.append(log, "a");
  writeFileSync(log, "a\nevil\n");
  assert.deepEqual(t.verify(), { ok: false, changed: [log] });
});

test("snapshot() re-baselines to the current state", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  writeFileSync(join(run, "state.json"), "changed");
  assert.equal(t.verify().ok, false);
  t.snapshot();
  assert.deepEqual(t.verify(), { ok: true });
});

test("a fifo in a tracked dir does not hang the scan", () => {
  const root = scratch();
  const run = tree(root);
  if (spawnSync("mkfifo", [join(run, "pipe")]).status !== 0) return;
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  assert.deepEqual(t.verify(), { ok: true });
});

test("overlapping dirs and files are tracked once and report each changed path once", () => {
  const root = scratch();
  const run = tree(root);
  const t = createStateTracker({ dirs: [run, join(run, "sub")], files: [join(run, "state.json")] });
  t.snapshot();
  writeFileSync(join(run, "state.json"), "x");
  writeFileSync(join(run, "sub", "a.txt"), "x");
  assert.deepEqual(t.verify(), {
    ok: false,
    changed: [join(run, "state.json"), join(run, "sub", "a.txt")],
  });
});

test("verify cost scales with tracked files: 300 files verify repeatedly in well under a second each", () => {
  const root = scratch();
  const run = tree(root);
  for (let i = 0; i < 300; i++) writeFileSync(join(run, `f${i}.txt`), String(i));
  const t = createStateTracker({ dirs: [run] });
  t.snapshot();
  const start = Date.now();
  for (let i = 0; i < 10; i++) assert.equal(t.verify().ok, true);
  assert.ok(Date.now() - start < 5000);
});
