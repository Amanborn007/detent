#!/usr/bin/env node
/**
 * cold-resume-warn — SessionStart hook. Warns BEFORE the first turn of a
 * resumed session, while the choice can still be made.
 *
 * WHY
 *   A prompt cache expires after roughly an hour. Resuming past that re-uploads
 *   the whole conversation on the next turn, so a cold turn costs many times a
 *   warm one. Starting fresh avoids that excess; `detent spend` reports the
 *   current cold-turn share for your own traffic.
 *
 * WHY A WARNING AND NOT A REFUSAL
 *   Resuming is sometimes right — a long debugging thread where the context IS
 *   the work. The hook states the cost and leaves the call, because a gate
 *   that blocks a legitimate resume gets disabled, and then it protects nothing.
 *
 * Set COLD_RESUME_WARN=off to disable.
 *
 * Reads the hook payload on stdin, prints to stdout (SessionStart stdout becomes
 * session context). Never fails the session: any error exits 0 silently, since
 * a broken advisory must not stop work.
 */
"use strict";

import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";

const COLD_MS = 60 * 60 * 1000;
const TAIL_BYTES = 512 * 1024; // enough for the last records of a big transcript

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Last assistant timestamp in a transcript, without reading the whole file. */
function lastAssistantMs(path) {
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"timestamp"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // a partial first line from the tail cut, or a torn write
    }
    const t = Date.parse(d.timestamp || "");
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function humanGap(ms) {
  const h = ms / 3600000;
  if (h < 24) return `${h.toFixed(1)} hours`;
  return `${(h / 24).toFixed(1)} days`;
}

function main() {
  if (process.env.COLD_RESUME_WARN === "off") return;
  const raw = readStdin();
  if (!raw.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  // `startup` and `clear` are already fresh contexts; only a resume can be cold.
  if (payload.source && !["resume", "compact"].includes(payload.source)) return;
  const path = payload.transcript_path;
  if (!path) return;

  let last;
  try {
    last = lastAssistantMs(path);
  } catch {
    return; // no transcript yet, or unreadable — nothing to warn about
  }
  if (last === null) return;

  const gap = Date.now() - last;
  if (gap < COLD_MS) return;

  process.stdout.write(
    `COLD RESUME — this session's last turn was ${humanGap(gap)} ago, so its prompt cache has expired.\n` +
    `The next turn re-uploads the whole conversation, which costs many times a warm turn for no extra work.\n` +
    `Starting a fresh session instead avoids it. Resuming is still right when the accumulated context IS the task ` +
    `(a long debugging thread); it is waste when the next step could start from files.\n` +
    `Run \`detent spend --days 30\` for your own cold-turn figures.\n`,
  );
}

try {
  main();
} catch {
  // An advisory that breaks the session is worse than no advisory.
}
