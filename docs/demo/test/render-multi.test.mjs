// Several transcripts render as one replay, in the order given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "render-transcript.mjs");
const SAMPLE = join(HERE, "fixtures", "sample.jsonl");

test("two transcripts print back to back", () => {
  const r = spawnSync(process.execPath, [BIN, SAMPLE, SAMPLE], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split("\n").filter((l) => l === "> /detent:status").length, 2);
});
