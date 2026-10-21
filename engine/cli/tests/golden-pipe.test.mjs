// golden-pipe.test.mjs — piped (non-TTY) output is the machine layer and must stay
// byte-identical to origin/main. Set GOLDEN_WRITE=1 to regenerate from an old checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { engine, mkRun, detentHome, writeArtifact } from "./helpers.mjs";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-pipe.json");

function normalize(text, ctx) {
  return text
    .split(ctx.runDir).join("<RUN_DIR>")
    .split(detentHome()).join("<HOME>")
    .split(realpathSync(ctx.repo)).join("<REPO>")
    .split(ctx.repo).join("<REPO>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
}

function capture() {
  const ctx = mkRun({ ticket: "octo/repo#1", slug: "gold" });
  const rec = {};
  const run = (name, args) => {
    const r = engine([...args, "--run", ctx.runId, "--repo", ctx.repo], { cwd: ctx.repo, env: { DETENT_FORCE_TTY: "", CLAUDECODE: "" } });
    rec[name] = { code: r.code, stdout: normalize(r.stdout, ctx) };
  };
  run("unknown", ["frobnicate"]);
  run("next-fresh", ["next"]);
  run("begin-intake", ["stage", "begin", "intake"]);
  run("end-intake-missing-artifact", ["stage", "end", "intake"]);
  run("step", ["step", "reading code"]);
  writeArtifact(ctx.runDir, "brief.md");
  run("next-in-progress", ["next"]);
  run("end-intake", ["stage", "end", "intake"]);
  run("env", ["env", "--verify", "node --test"]);
  return rec;
}

test("piped output matches the golden captured from origin/main", () => {
  const rec = capture();
  if (process.env.GOLDEN_WRITE === "1") {
    writeFileSync(GOLDEN, JSON.stringify(rec, null, 2) + "\n");
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(rec, golden);
});
