#!/usr/bin/env node
// Offline stand-in for `claude -p` as detent drive runs it: writes the canned file for the stage it was asked for
// into the outbox and answers with a manifest. The engine's checks on those files are the real ones.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.1.306 (Claude Code)"); process.exit(0); }
const prompt = readFileSync(0, "utf8");
const field = (k) => new RegExp("^" + k + ": (.+)$", "m").exec(prompt)[1].trim();
const stage = field("Stage"), inputs = field("Inputs directory"), outbox = field("Outbox directory");
const step = JSON.parse(readFileSync(join(inputs, "step.json"), "utf8"));
const FILES = {
  intake: { "brief.md": "brief.md" },
  research: { "research.md": "research.md", "access-report.json": "access-report.json" },
  plan: { "plan/plan.md": "plan.md" },
};
const artifacts = [];
for (const [rel, fixture] of Object.entries(FILES[stage] || {})) {
  const body = readFileSync(join(here, "term", fixture), "utf8");
  const p = join(outbox, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  artifacts.push({ path: rel, sha256: createHash("sha256").update(body).digest("hex") });
}
writeFileSync(join(outbox, "manifest.json"), JSON.stringify({
  schema: "detent-drive-outbox-v1", run_id: step.run_id, stage, nonce: step.nonce, status: "complete",
  summary: `${stage} written`, artifacts, decisions: [],
}));
console.log(JSON.stringify([{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, num_turns: 2, permission_denials: [] }]));
