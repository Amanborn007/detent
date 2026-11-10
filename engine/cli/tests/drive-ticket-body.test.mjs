// The driven intake child reads inputs/ticket.json, so the full ticket body has to reach it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setup, drive, scratch } from "./drive-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HERE, "..", "..", "adapters", "gh-ticket");
const SOCKET_DOC = join(HERE, "..", "..", "sockets", "ticket.md");
const FULL_BODY = "Line one of the ticket.\n\n" + "Detail paragraph with repro steps. ".repeat(40);

// Copies what the child sees in inputs/ticket.json, then delegates to the kit's stub.
function capturingStub(t, captureTo) {
  const dir = scratch();
  const bin = join(dir, "capture-claude.mjs");
  writeFileSync(bin, `#!${process.execPath}
import { readFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
const run = (input) => spawnSync(${JSON.stringify(t.stub)}, argv, { input, encoding: "utf8", env: process.env });
if (argv[0] === "--version") { process.stdout.write(run("").stdout); process.exit(0); }
const prompt = readFileSync(0, "utf8");
const inputs = /^Inputs directory: (.+)$/m.exec(prompt)[1].trim();
copyFileSync(inputs + "/ticket.json", ${JSON.stringify(captureTo)});
const r = run(prompt);
process.stdout.write(r.stdout);
process.exit(r.status);
`);
  chmodSync(bin, 0o755);
  return bin;
}

function stackWithTicket(dir, response) {
  const ticket = join(dir, "full-ticket.mjs");
  writeFileSync(ticket, `#!${process.execPath}
import { readFileSync } from "node:fs";
const req = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify({ id: req.ticket_ref, ...${JSON.stringify(response)} }));
`);
  chmodSync(ticket, 0o755);
  const stack = join(dir, "full-stack.yaml");
  writeFileSync(stack, `engine_version: "1"\nsockets:\n  ticket:\n    command: "${ticket}"\n    version: "1"\n`);
  return stack;
}

test("the intake child gets the full ticket body, not just the 400-char excerpt", () => {
  const t = setup();
  t.stack = stackWithTicket(t.d, {
    title: "t", status: "open", body_excerpt: FULL_BODY.replace(/\s+/g, " ").slice(0, 400), body: FULL_BODY,
    url: "http://x.invalid/1", next_step: "go",
  });
  const seen = join(t.d, "seen-ticket.json");
  t.stub = capturingStub(t, seen);
  const r = drive(t, {}, ["--max-steps", "1"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const ticket = JSON.parse(readFileSync(seen, "utf8"));
  assert.ok(ticket.body.length > 400, `body is ${ticket.body.length} chars`);
  assert.equal(ticket.body, FULL_BODY);
});

function ghAdapter(body) {
  const dir = scratch();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ number: 7, title: "T", body, state: "OPEN", labels: [], url: "https://github.com/o/r/issues/7" }))});\n`);
  chmodSync(gh, 0o755);
  const r = spawnSync(ADAPTER, [], {
    input: JSON.stringify({ ticket_ref: "o/r#7" }), encoding: "utf8",
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

test("gh-ticket emits the whole body, capped at 20000 chars with body_truncated when it is cut", () => {
  const out = ghAdapter("a".repeat(30000));
  assert.equal(out.body.length, 20000);
  assert.equal(out.body_truncated, true);
  assert.ok(out.body_excerpt.length <= 400);
});

test("gh-ticket keeps whitespace in body and omits body_truncated when nothing was cut", () => {
  const body = "first line\n\n  indented second line\n";
  const out = ghAdapter(body);
  assert.equal(out.body, body);
  assert.ok(!("body_truncated" in out));
  assert.equal(out.body_excerpt, "first line indented second line");
});

test("the ticket socket contract documents body and body_truncated", () => {
  const doc = readFileSync(SOCKET_DOC, "utf8");
  assert.match(doc, /"body":/);
  assert.match(doc, /"body_truncated":/);
});
