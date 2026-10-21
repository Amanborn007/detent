// integrity — tamper detection for supervisor-owned run-state files. Only the
// tracker's write()/append() may change a tracked path; anything else shows up
// in verify(). Detection only, no restore. Zero dependencies, Node >= 18.
"use strict";

import {
  openSync, closeSync, writeSync, fsyncSync, fchmodSync, fstatSync, readFileSync,
  lstatSync, readdirSync, readlinkSync, mkdirSync, renameSync, unlinkSync, rmdirSync,
  constants,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, dirname, basename, join, sep, isAbsolute } from "node:path";

const ABSENT = "absent";
const MODE_MASK = 0o7777;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function within(path, prefix) {
  return path === prefix || path.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}

// O_NOFOLLOW and O_NONBLOCK stop a symlink or fifo swapped in after the lstat
// from redirecting or hanging the read.
function readRegular(p) {
  const fd = openSync(p, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error(`not a regular file: ${p}`), { code: "ENOTREG" });
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// One comparable string per path: type, mode, and content digest or link target.
function signature(p) {
  const st = lstatOrNull(p);
  if (!st) return ABSENT;
  if (st.isSymbolicLink()) return `symlink|${readlinkSync(p)}`;
  const mode = (st.mode & MODE_MASK).toString(8);
  if (st.isDirectory()) return `dir|${mode}`;
  if (st.isFile()) {
    try {
      return `file|${mode}|${sha256(readRegular(p))}`;
    } catch (e) {
      if (["ELOOP", "ENOENT", "ENOTREG", "ENXIO"].includes(e.code)) return `raced|${e.code}`;
      throw e;
    }
  }
  return `other|${mode}`;
}

// files: absolute paths, may not exist yet. dirs: absolute dirs tracked
// recursively, symlinks recorded by target and never followed. exclude:
// absolute path prefixes skipped.
export function createStateTracker({ files = [], dirs = [], exclude = [] } = {}) {
  for (const p of [...files, ...dirs, ...exclude]) {
    if (!isAbsolute(p)) throw new Error(`tracked path must be absolute: ${p}`);
  }
  const fileSet = files.map((p) => resolve(p));
  const dirSet = dirs.map((p) => resolve(p));
  const excluded = exclude.map((p) => resolve(p));
  const isExcluded = (p) => excluded.some((e) => within(p, e));

  let baseline = null;

  function scan() {
    const seen = new Map();
    const walk = (p) => {
      if (seen.has(p) || isExcluded(p)) return;
      const sig = signature(p);
      seen.set(p, sig);
      if (!sig.startsWith("dir|")) return;
      for (const name of readdirSync(p).sort()) walk(join(p, name));
    };
    for (const f of fileSet) walk(f);
    for (const d of dirSet) walk(d);
    return seen;
  }

  function requireSnapshot() {
    if (!baseline) throw new Error("snapshot() has not been called");
  }

  const base = (p) => baseline.get(p) ?? ABSENT;

  function tampered(p) {
    return new Error(`tracked path was modified outside the tracker: ${p}`);
  }

  // Also checks p and its ancestors still match the baseline, so a write can
  // neither absorb a child's change nor follow a swapped-in symlink.
  function prepare(p) {
    requireSnapshot();
    if (!isAbsolute(p)) throw new Error(`path must be absolute: ${p}`);
    const abs = resolve(p);
    if (isExcluded(abs)) throw new Error(`path is excluded from tracking: ${abs}`);
    const root = dirSet.find((d) => abs !== d && within(abs, d)) ?? null;
    if (!root && !fileSet.includes(abs)) {
      throw new Error(`path is not inside a tracked file or dir: ${abs}`);
    }
    const ancestors = [];
    if (root) {
      for (let d = dirname(abs); ; d = dirname(d)) {
        ancestors.unshift(d);
        if (d === root) break;
      }
      for (const d of ancestors) {
        const st = lstatOrNull(d);
        if (st && !st.isDirectory()) {
          throw new Error(`ancestor is a symlink or not a directory: ${d}`);
        }
        if (signature(d) !== base(d)) throw tampered(d);
      }
    }
    if (signature(abs) !== base(abs)) throw tampered(abs);
    return { abs, ancestors };
  }

  function write(p, data) {
    const { abs, ancestors } = prepare(p);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    const dir = dirname(abs);
    const prev = lstatOrNull(abs);
    const missing = ancestors.filter((d) => lstatOrNull(d) === null);
    mkdirSync(dir, { recursive: true });

    const tmp = join(dir, `.${basename(abs)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    let fd = -1;
    let mode;
    try {
      fd = openSync(tmp, "wx");
      if (prev && prev.isFile()) fchmodSync(fd, prev.mode & MODE_MASK);
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
      mode = fstatSync(fd).mode & MODE_MASK;
      closeSync(fd);
      fd = -1;
      renameSync(tmp, abs);
    } catch (e) {
      if (fd !== -1) closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch (u) {
        if (u.code !== "ENOENT") throw u;
      }
      for (const d of [...missing].reverse()) {
        try {
          rmdirSync(d);
        } catch (r) {
          if (r.code !== "ENOENT" && r.code !== "ENOTEMPTY") throw r;
        }
      }
      throw e;
    }

    for (const d of missing) baseline.set(d, signature(d));
    baseline.set(abs, `file|${mode.toString(8)}|${sha256(buf)}`);
  }

  function append(p, line) {
    const { abs } = prepare(p);
    const sig = base(abs);
    let existing = Buffer.alloc(0);
    if (sig !== ABSENT) {
      if (!sig.startsWith("file|")) throw new Error(`cannot append to a non-file: ${abs}`);
      existing = readRegular(abs);
      if (sig.split("|")[2] !== sha256(existing)) throw tampered(abs);
    }
    const text = String(line);
    write(abs, Buffer.concat([existing, Buffer.from(text.endsWith("\n") ? text : text + "\n", "utf8")]));
  }

  return {
    snapshot() {
      baseline = scan();
    },
    verify() {
      requireSnapshot();
      const current = scan();
      const changed = [];
      for (const p of new Set([...baseline.keys(), ...current.keys()])) {
        if (base(p) !== (current.get(p) ?? ABSENT)) changed.push(p);
      }
      return changed.length ? { ok: false, changed: changed.sort() } : { ok: true };
    },
    write,
    append,
  };
}
