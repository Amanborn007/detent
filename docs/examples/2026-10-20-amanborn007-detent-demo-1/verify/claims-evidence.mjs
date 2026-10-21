// Evidence command for cmd-verifier: reads the verifier request on stdin, runs slugify
// for each claim in the repo under test, prints one JSON evidence line per claim.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const req = JSON.parse(readFileSync(0, "utf8"));
const { slugify } = await import(pathToFileURL(join(req.repo_path, "src/index.js")).href);
const run = (fn) => { try { return JSON.stringify(fn()); } catch (e) { return `${e.constructor.name}: ${e.message}`; } };
const t = "Hello brave new world";
const checks = [
  ["slugify(input, { maxLength })", (c) => /returns a string of at most/.test(c), () => [5, 11, 12, 13].map((n) => `cap ${n} -> length ${slugify(t, { maxLength: n }).length}`).join("; ")],
  ["cut on separator", (c) => /cut lands on a separator/.test(c), () => `cap 13 -> ${run(() => slugify(t, { maxLength: 13 }))}; "--" cap 7 -> ${run(() => slugify("ab cd ef", { separator: "--", maxLength: 7 }))}`],
  ["first word", (c) => /first word alone/.test(c), () => `cap 5 -> ${run(() => slugify("Supercalifragilistic expialidocious", { maxLength: 5 }))}`],
  ["no trailing separator", (c) => /never ends in the separator/.test(c), () => `cap 12 -> ${run(() => slugify(t, { maxLength: 12 }))}; "--" cap 3 -> ${run(() => slugify("ab cd", { separator: "--", maxLength: 3 }))}`],
  ["RangeError", (c) => /RangeError/.test(c), () => [0, -1, 2.5, "10", Number.NaN].map((v) => `${typeof v === "string" ? JSON.stringify(v) : String(v)} -> ${run(() => slugify("Hello World", { maxLength: v }))}`).join("; ")],
  ["unchanged", (c) => /without `maxLength`/.test(c), () => `no options -> ${run(() => slugify(t))}; null -> ${run(() => slugify(t, { maxLength: null }))}`],
  ["tests", (c) => /Tests cover/.test(c), () => "see test-output.txt: npm test in the repo under test"],
];
const outDir = process.env.EVIDENCE_DIR || join(req.repo_path, ".verify");
for (const claim of req.claims) {
  const hit = checks.find(([, match]) => match(claim));
  if (!hit) continue;
  const observed = hit[2]();
  const artifact = join(outDir, `claim-${checks.indexOf(hit) + 1}.txt`);
  writeFileSync(artifact, `${claim}\n${observed}\n`);
  console.log(JSON.stringify({ claim, kind: hit[0] === "tests" ? "integration" : "e2e-run", artifact, note: observed }));
}
