#!/usr/bin/env node
// One engine JSON line on stdin -> one human line on stdout. Usage: engine ... | node say.mjs <kind>
// Every value printed comes from that JSON. The `ok` value is also appended to $DEMO_TMP/oks.log for smoke.sh.
import { appendFileSync, readFileSync } from "node:fs";

const kind = process.argv[2];
const j = JSON.parse(readFileSync(0, "utf8"));
const tmp = process.env.DEMO_TMP || "\0";
const root = process.env.DETENT_ROOT || "\0";
const short = (p) => String(p).split(root).join("$DETENT_ROOT").split(tmp).join("~");
const base = (p) => String(p).split("/").pop();
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", Z = "\x1b[0m";
const pad = (s) => s.padEnd(9);
const line = (mark, colour, label, text) => console.log(`${colour}${mark}${Z} ${pad(label)}${text}`);

if (process.env.DEMO_TMP) appendFileSync(`${tmp}/oks.log`, `${kind} ${j.ok}\n`);

if (!j.ok && kind !== "plan") {
  line("x", R, kind, j.reason);
  console.log(`  ${D}${j.next_step}${Z}`);
} else if (kind === "setup") {
  line("✓", G, "setup", `wrote ${j.wrote.map(base).join(", ")}`);
  if (j.unresolved.length) console.log(`  ${D}still yours to fill: ${j.unresolved.join(", ")}${Z}`);
} else if (kind === "run") {
  line("✓", G, "run", `${j.run_id} created`);
  console.log(`  ${D}next stage: ${j.stage}${Z}`);
} else if (kind === "ticket") {
  line("✓", G, "ticket", `${j.response.id}  "${j.response.title}"`);
} else if (kind === "plan" && !j.ok) {
  line("■", Y, "plan", `written, held at the ${j.gate} gate (${j.decision_id} pending)`);
} else if (kind === "gate") {
  line("■", Y, "gate", "waiting on you: plan approval");
  console.log(`  page: ${short(j.html)}`);
} else {
  const files = process.argv[3] ? `  (${process.argv[3]} on disk)` : "";
  line("✓", G, kind, `${j.status}${files}`);
}
