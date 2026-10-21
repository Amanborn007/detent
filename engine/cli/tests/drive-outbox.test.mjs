import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readOutbox, validateDecisions, secretScan } from "../drive/outbox.mjs";

const STAGES = ["intake", "research", "plan", "implement", "recheck", "ship", "respond"];
const sha = (b) => createHash("sha256").update(b).digest("hex");

const BRIEF = "# Brief\n\n## Goal\nx\n\n## Unknowns & open questions\ny\n";
const PLAN = "# Plan\n\n## Steps\n1. go\n";

function opts(over = {}) {
  return {
    runId: "run-1", stage: "plan", nonce: "n0nce",
    allowedArtifacts: ["brief.md", "plan/plan.md", "access-report.json"],
    requiredHeadings: { "brief.md": ["## Goal", "## Unknowns & open questions"] },
    ...over,
  };
}

function put(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// Builds an outbox in a fresh temp dir. files: {rel: content}; manifest overrides merge in.
function fixture({ files = { "brief.md": BRIEF }, manifest = {}, raw, list } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  for (const [rel, c] of Object.entries(files)) put(dir, rel, c);
  const m = {
    schema: "detent-drive-outbox-v1", run_id: "run-1", stage: "plan", nonce: "n0nce",
    status: "complete", summary: "done",
    artifacts: (list ?? Object.keys(files)).map((p) => ({ path: p, sha256: sha(Buffer.from(files[p] ?? "")) })),
    decisions: [],
    ...manifest,
  };
  writeFileSync(join(dir, "manifest.json"), raw ?? JSON.stringify(m));
  return dir;
}

function reason(dir, over) {
  const r = readOutbox(dir, opts(over));
  assert.equal(r.ok, false, "expected rejection");
  return r.reason;
}

const dec = (over = {}) => ({
  key: "u1", question: "Which?", options: ["a", "b"], blocks: ["implement"], cause: "judgment", ...over,
});

test("happy path returns manifest and a Map of Buffers", () => {
  const dir = fixture({ files: { "brief.md": BRIEF, "plan/plan.md": PLAN } });
  const r = readOutbox(dir, opts());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.manifest.status, "complete");
  assert.ok(r.files instanceof Map);
  assert.ok(Buffer.isBuffer(r.files.get("plan/plan.md")));
  assert.equal(r.files.get("brief.md").toString("utf8"), BRIEF);
  assert.deepEqual([...r.files.keys()].sort(), ["brief.md", "plan/plan.md"]);
});

test("optional fields env, attempts, steps are accepted", () => {
  const dir = fixture({ manifest: {
    env: { commands: { verify: "npm test", setup: "npm ci" }, gotchas: ["slow"] },
    attempts: [{ approach: "a", outcome: "failed", evidence: "e" }],
    steps: [{ label: "read" }],
  } });
  assert.equal(readOutbox(dir, opts()).ok, true);
});

test("partial status skips the required-artifact and heading checks", () => {
  const dir = fixture({ files: { "brief.md": "no headings" }, manifest: { status: "partial" } });
  assert.equal(readOutbox(dir, opts()).ok, true);
});

test("missing manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  assert.equal(reason(dir), "missing_manifest");
});

test("bad_json", () => {
  assert.equal(reason(fixture({ raw: "{nope" })), "bad_json");
  assert.equal(reason(fixture({ raw: "[]" })), "bad_json");
});

test("bad_schema and missing_key", () => {
  assert.equal(reason(fixture({ manifest: { schema: "other" } })), "bad_schema");
  assert.equal(reason(fixture({ raw: JSON.stringify({ schema: "detent-drive-outbox-v1" }) })), "missing_key");
});

test("unknown_key at top level and nested", () => {
  assert.equal(reason(fixture({ manifest: { extra: 1 } })), "unknown_key");
  assert.equal(reason(fixture({ manifest: { env: { commands: {}, gotchas: [], x: 1 } } })), "unknown_key");
  assert.equal(reason(fixture({ manifest: { env: { commands: { run: "x" }, gotchas: [] } } })), "unknown_key");
  assert.equal(reason(fixture({ manifest: { steps: [{ label: "a", more: 1 }] } })), "unknown_key");
  assert.equal(reason(fixture({ manifest: { attempts: [{ approach: "a", outcome: "failed", evidence: "e", z: 1 }] } })), "unknown_key");
  assert.equal(reason(fixture({ manifest: { artifacts: [{ path: "brief.md", sha256: sha(Buffer.from(BRIEF)), z: 1 }] } })), "unknown_key");
  assert.equal(reason(fixture({ raw: `{"__proto__":{"a":1},"schema":"detent-drive-outbox-v1"}` })), "unknown_key");
});

test("bad_field on wrong types and limits", () => {
  assert.equal(reason(fixture({ manifest: { summary: "x".repeat(2001) } })), "bad_field");
  assert.equal(reason(fixture({ manifest: { summary: 5 } })), "bad_field");
  assert.equal(reason(fixture({ manifest: { artifacts: "no" } })), "bad_field");
  assert.equal(reason(fixture({ manifest: { attempts: [{ approach: "a", outcome: "weird", evidence: "e" }] } })), "bad_field");
  assert.equal(reason(fixture({ manifest: { decisions: {} } })), "bad_field");
});

test("identity_mismatch on run_id, stage, nonce", () => {
  assert.equal(reason(fixture({ manifest: { run_id: "other" } })), "identity_mismatch");
  assert.equal(reason(fixture({ manifest: { stage: "ship" } })), "identity_mismatch");
  assert.equal(reason(fixture({ manifest: { nonce: "bad" } })), "identity_mismatch");
});

test("bad_status", () => {
  assert.equal(reason(fixture({ manifest: { status: "done" } })), "bad_status");
  assert.equal(reason(fixture({ manifest: { status: "needs_data" } })), "bad_status");
});

test("needs_human_without_decision, and accepted with one", () => {
  assert.equal(reason(fixture({ manifest: { status: "needs_human" } })), "needs_human_without_decision");
  const ok = fixture({ manifest: { status: "needs_human", decisions: [dec()] } });
  assert.equal(readOutbox(ok, opts()).ok, true);
});

test("decision codes propagate from readOutbox", () => {
  assert.equal(reason(fixture({ manifest: { decisions: [dec({ gate: "x" })] } })), "forbidden_key");
});

test("artifact_not_allowed", () => {
  assert.equal(reason(fixture({ files: { "evil.md": "x" } })), "artifact_not_allowed");
  assert.equal(reason(fixture({ files: { "brief.md": BRIEF }, list: ["../brief.md"] })), "artifact_not_allowed");
});

test("duplicate_artifact", () => {
  assert.equal(reason(fixture({ list: ["brief.md", "brief.md"] })), "duplicate_artifact");
});

test("sha_mismatch", () => {
  const dir = fixture({ manifest: { artifacts: [{ path: "brief.md", sha256: "0".repeat(64) }] } });
  assert.equal(reason(dir), "sha_mismatch");
  const bad = fixture({ manifest: { artifacts: [{ path: "brief.md", sha256: "xyz" }] } });
  assert.equal(reason(bad), "sha_mismatch");
});

test("missing_artifact when a listed file is absent", () => {
  const dir = fixture({ files: { "brief.md": BRIEF }, list: ["brief.md", "access-report.json"] });
  assert.equal(reason(dir), "missing_artifact");
});

test("missing_artifact when complete and a heading-bearing artifact is absent", () => {
  const dir = fixture({ files: { "access-report.json": "{}" } });
  assert.equal(reason(dir), "missing_artifact");
});

test("missing_heading, including a heading hidden inside a code fence", () => {
  assert.equal(reason(fixture({ files: { "brief.md": "## Goal\n" } })), "missing_heading");
  const fenced = "## Goal\n```\n## Unknowns & open questions\n```\n";
  assert.equal(reason(fixture({ files: { "brief.md": fenced } })), "missing_heading");
});

test("symlink: entry, manifest, inside plan/, and plan itself", () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const target = join(outside, "secret");
  writeFileSync(target, "s");

  const dir = fixture();
  symlinkSync(target, join(dir, "access-report.json"));
  assert.equal(reason(dir), "symlink");

  const d2 = mkdtempSync(join(tmpdir(), "outbox-"));
  symlinkSync(target, join(d2, "manifest.json"));
  assert.equal(reason(d2), "symlink");

  const d3 = fixture({ files: { "brief.md": BRIEF, "plan/plan.md": PLAN } });
  rmSync(join(d3, "plan", "plan.md"));
  symlinkSync(target, join(d3, "plan", "plan.md"));
  assert.equal(reason(d3), "symlink");

  const d4 = fixture();
  symlinkSync(outside, join(d4, "plan"));
  assert.equal(reason(d4), "symlink");
});

test("hardlink", () => {
  const dir = fixture();
  const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "f");
  writeFileSync(outside, BRIEF);
  rmSync(join(dir, "brief.md"));
  linkSync(outside, join(dir, "brief.md"));
  assert.equal(reason(dir), "hardlink");
});

test("unknown_entry: stray file, unlisted allowed file, subdir, nested plan dir", () => {
  const stray = fixture();
  writeFileSync(join(stray, "notes.txt"), "x");
  assert.equal(reason(stray), "unknown_entry");

  const unlisted = fixture();
  writeFileSync(join(unlisted, "access-report.json"), "{}");
  assert.equal(reason(unlisted), "unknown_entry");

  const sub = fixture();
  mkdirSync(join(sub, "other"));
  assert.equal(reason(sub), "unknown_entry");

  const nested = fixture({ files: { "brief.md": BRIEF, "plan/plan.md": PLAN } });
  mkdirSync(join(nested, "plan", "deep"));
  assert.equal(reason(nested), "unknown_entry");
});

test("not_regular for a fifo entry", (t) => {
  const dir = fixture();
  const r = spawnSync("mkfifo", [join(dir, "access-report.json")]);
  if (r.status !== 0) return t.skip("mkfifo unavailable");
  assert.equal(reason(dir), "not_regular");
});

test("oversize: manifest, markdown, other, default and custom caps", () => {
  const big = fixture({ raw: JSON.stringify({ summary: "x".repeat(300 * 1024) }) });
  assert.equal(reason(big), "oversize");
  const md = fixture({ files: { "brief.md": BRIEF + "x".repeat(1024 * 1024) } });
  assert.equal(reason(md), "oversize");
  const oth = fixture({ files: { "brief.md": BRIEF, "access-report.json": "x".repeat(100) } });
  assert.equal(reason(oth, { caps: { other: 50 } }), "oversize");
  assert.equal(reason(fixture(), { caps: { markdown: 10 } }), "oversize");
});

test("not_utf8 for an artifact and for the manifest", () => {
  const bytes = Buffer.from([0xff, 0xfe, 0x41]);
  const dir = fixture({ manifest: { status: "partial" } });
  writeFileSync(join(dir, "brief.md"), bytes);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schema: "detent-drive-outbox-v1", run_id: "run-1", stage: "plan", nonce: "n0nce",
    status: "partial", summary: "s", decisions: [],
    artifacts: [{ path: "brief.md", sha256: sha(bytes) }],
  }));
  assert.equal(reason(dir), "not_utf8");
  assert.equal(reason(fixture({ raw: Buffer.from([0x7b, 0xff, 0x7d]) })), "not_utf8");
});

test("validateDecisions: normalizes and maps review/pr to ship", () => {
  const r = validateDecisions(
    [dec({ blocks: ["review", "pr", "ship", "implement"], context: "c", kind: "access-degraded", source: "s" })],
    { stage: "plan", stages: STAGES },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.decisions[0].blocks, ["ship", "implement"]);
  assert.equal(r.decisions[0].kind, "access-degraded");
  assert.equal(r.decisions[0].id, undefined);
  assert.equal(validateDecisions([], { stage: "plan", stages: STAGES }).ok, true);
});

function dReason(list, stage = "plan") {
  const r = validateDecisions(list, { stage, stages: STAGES });
  assert.equal(r.ok, false);
  return r.reason;
}

test("validateDecisions: rejection codes", () => {
  assert.equal(dReason("x"), "bad_decision");
  assert.equal(dReason(["x"]), "bad_decision");
  assert.equal(dReason(Array.from({ length: 21 }, (_, i) => dec({ key: `k${i}` }))), "too_many_decisions");
  assert.equal(dReason([dec({ bogus: 1 })]), "unknown_key");
  assert.equal(dReason([{ question: "q", options: ["a", "b"], blocks: ["ship"], cause: "data" }]), "bad_key");
  assert.equal(dReason([dec({ key: "" })]), "bad_key");
  assert.equal(dReason([dec(), dec()]), "duplicate_key");
  assert.equal(dReason([dec({ question: "" })]), "bad_question");
  assert.equal(dReason([dec({ question: "q".repeat(2001) })]), "bad_question");
  assert.equal(dReason([dec({ options: ["a"] })]), "bad_options");
  assert.equal(dReason([dec({ options: ["a", "b", "c", "d", "e", "f", "g"] })]), "bad_options");
  assert.equal(dReason([dec({ options: ["a", "a"] })]), "bad_options");
  assert.equal(dReason([dec({ options: ["a", ""] })]), "bad_options");
  assert.equal(dReason([dec({ options: ["a", "b".repeat(201)] })]), "bad_options");
  assert.equal(dReason([dec({ blocks: [] })]), "bad_blocks");
  assert.equal(dReason([dec({ blocks: ["plan"] })]), "bad_blocks");
  assert.equal(dReason([dec({ blocks: ["research"] })]), "bad_blocks");
  assert.equal(dReason([dec({ blocks: ["nonsense"] })]), "bad_blocks");
  assert.equal(dReason([dec({ blocks: ["review"] })], "ship"), "bad_blocks");
  assert.equal(dReason([dec({ cause: "vibes" })]), "bad_cause");
  assert.equal(dReason([dec({ context: "c".repeat(4001) })]), "bad_context");
  assert.equal(dReason([dec({ kind: "other" })]), "bad_kind");
  assert.equal(dReason([dec({ source: "s".repeat(201) })]), "bad_source");
  assert.equal(validateDecisions([dec()], { stage: "bogus", stages: STAGES }).reason, "bad_stage");
});

test("validateDecisions: every forbidden key is refused", () => {
  const forbidden = ["id", "gate", "status", "answer", "answered_by", "answered_via", "answered_at",
    "exercise_state", "withdrawn", "withdrawn_at", "degraded_assumption", "rejected_options"];
  for (const k of forbidden) assert.equal(dReason([dec({ [k]: "x" })]), "forbidden_key", k);
});

test("secretScan: each pattern hits and never echoes the secret", () => {
  const samples = {
    anthropic: "sk-ant-" + "a".repeat(20),
    github: "ghp_" + "A".repeat(24),
    pat: "github_pat_" + "B".repeat(24),
    aws: "AKIA" + "ABCDEFGHIJKLMNOP",
    slack: "xoxb-" + "1234567890",
    key: "-----BEGIN RSA PRIVATE KEY-----",
  };
  for (const [name, s] of Object.entries(samples)) {
    const r = secretScan(["hello", `x ${s} y`], []);
    assert.equal(r.hit, true, name);
    assert.ok(typeof r.pattern === "string" && !r.pattern.includes(s), name);
  }
});

test("secretScan: clean text, literals, short literals ignored", () => {
  assert.deepEqual(secretScan(["nothing here"], []), { hit: false });
  const lit = "hunter2-hunter2";
  const r = secretScan([`pw=${lit}`], [lit]);
  assert.equal(r.hit, true);
  assert.ok(!r.pattern.includes(lit));
  assert.deepEqual(secretScan(["abc short"], ["short"]), { hit: false });
});
