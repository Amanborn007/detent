// drive/outbox: validating reader for the outbox a sandboxed, possibly prompt-injected child writes.
// Zero dependencies. Node >= 18.
"use strict";

import {
  readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SCHEMA = "detent-drive-outbox-v1";
const DEFAULT_STAGES = ["intake", "research", "plan", "implement", "recheck", "ship", "respond"];
const DEFAULT_CAPS = { manifest: 256 * 1024, markdown: 1024 * 1024, other: 1024 * 1024 };
const STATUSES = ["complete", "partial", "needs_human", "blocked"];
const CAUSES = ["judgment", "external", "infra", "capability", "data"];
const OUTCOMES = ["failed", "abandoned", "superseded"];
const FORBIDDEN_DECISION_KEYS = [
  "id", "gate", "status", "answer", "answered_by", "answered_via", "answered_at",
  "exercise_state", "withdrawn", "withdrawn_at", "degraded_assumption", "rejected_options",
];
const DECISION_KEYS = ["key", "question", "options", "blocks", "cause", "context", "kind", "source"];
const MANIFEST_KEYS = [
  "schema", "run_id", "stage", "nonce", "status", "summary", "artifacts", "decisions",
  "env", "attempts", "steps",
];
const MANIFEST_REQUIRED = [
  "schema", "run_id", "stage", "nonce", "status", "summary", "artifacts", "decisions",
];

class Reject extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

const rej = (reason, detail) => { throw new Reject(reason, detail); };

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkKeys(obj, allowed, required, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) rej("unknown_key", `${where}: ${JSON.stringify(k)}`);
  }
  for (const k of required) {
    if (!Object.hasOwn(obj, k)) rej("missing_key", `${where}: ${k}`);
  }
}

function str(v, max, where) {
  if (typeof v !== "string" || v.length > max) {
    rej("bad_field", `${where} must be a string of at most ${max} chars`);
  }
  return v;
}

function strictUtf8(buf, where) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return rej("not_utf8", where);
  }
}

// Open without following links, verify on the descriptor, read exactly once.
function readRegular(path, cap, label) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === "ELOOP") rej("symlink", label);
    if (e.code === "ENOENT") rej("missing_artifact", label);
    return rej("open_failed", `${label}: ${e.code}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) rej("not_regular", label);
    if (st.nlink !== 1) rej("hardlink", label);
    if (st.size > cap) rej("oversize", `${label}: ${st.size} > ${cap}`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) rej("changed_during_read", label);
      off += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

// Relative file paths in the outbox; rejects links, odd file types and stray directories.
function enumerate(dir) {
  const files = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    return rej("missing_outbox", `${e.code}`);
  }
  for (const name of names) {
    const st = lstatSync(join(dir, name));
    if (st.isSymbolicLink()) rej("symlink", name);
    if (st.isDirectory()) {
      if (name !== "plan") rej("unknown_entry", `${name}/`);
      for (const sub of readdirSync(join(dir, name))) {
        const rel = `${name}/${sub}`;
        const sst = lstatSync(join(dir, name, sub));
        if (sst.isSymbolicLink()) rej("symlink", rel);
        if (sst.isDirectory()) rej("unknown_entry", `${rel}/`);
        if (!sst.isFile()) rej("not_regular", rel);
        files.push(rel);
      }
    } else if (st.isFile()) {
      files.push(name);
    } else {
      rej("not_regular", name);
    }
  }
  return files;
}

function validateEnv(env) {
  if (!isObj(env)) rej("bad_field", "env must be an object");
  checkKeys(env, ["commands", "gotchas"], ["commands", "gotchas"], "env");
  if (!isObj(env.commands)) rej("bad_field", "env.commands must be an object");
  checkKeys(env.commands, ["verify", "setup"], [], "env.commands");
  for (const [k, v] of Object.entries(env.commands)) str(v, 2000, `env.commands.${k}`);
  if (!Array.isArray(env.gotchas) || env.gotchas.length > 20) rej("bad_field", "env.gotchas must be an array of at most 20");
  env.gotchas.forEach((g, i) => str(g, 500, `env.gotchas[${i}]`));
}

function validateAttempts(list) {
  if (!Array.isArray(list) || list.length > 20) rej("bad_field", "attempts must be an array of at most 20");
  list.forEach((a, i) => {
    if (!isObj(a)) rej("bad_field", `attempts[${i}] must be an object`);
    checkKeys(a, ["approach", "outcome", "evidence"], ["approach", "outcome", "evidence"], `attempts[${i}]`);
    str(a.approach, 500, `attempts[${i}].approach`);
    str(a.evidence, 2000, `attempts[${i}].evidence`);
    if (!OUTCOMES.includes(a.outcome)) rej("bad_field", `attempts[${i}].outcome`);
  });
}

function validateSteps(list) {
  if (!Array.isArray(list) || list.length > 50) rej("bad_field", "steps must be an array of at most 50");
  list.forEach((s, i) => {
    if (!isObj(s)) rej("bad_field", `steps[${i}] must be an object`);
    checkKeys(s, ["label"], ["label"], `steps[${i}]`);
    str(s.label, 200, `steps[${i}].label`);
  });
}

// A heading inside a code fence does not count.
function hasHeading(text, heading) {
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && line === heading) return true;
  }
  return false;
}

// Returns normalized decisions without ids; the caller assigns those.
export function validateDecisions(list, { stage, stages = DEFAULT_STAGES } = {}) {
  try {
    const stageIdx = stages.indexOf(stage);
    if (stageIdx < 0) rej("bad_stage", String(stage));
    if (!Array.isArray(list)) rej("bad_decision", "decisions must be an array");
    if (list.length > 20) rej("too_many_decisions", `${list.length} > 20`);
    const seen = new Set();
    const out = list.map((d, i) => {
      const w = `decisions[${i}]`;
      if (!isObj(d)) rej("bad_decision", w);
      for (const k of Object.keys(d)) {
        if (FORBIDDEN_DECISION_KEYS.includes(k)) rej("forbidden_key", `${w}.${k}`);
      }
      for (const k of Object.keys(d)) {
        if (!DECISION_KEYS.includes(k)) rej("unknown_key", `${w}: ${JSON.stringify(k)}`);
      }
      if (typeof d.key !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(d.key)) rej("bad_key", w);
      if (seen.has(d.key)) rej("duplicate_key", d.key);
      seen.add(d.key);
      if (typeof d.question !== "string" || d.question.length === 0 || d.question.length > 2000) {
        rej("bad_question", w);
      }
      if (!Array.isArray(d.options) || d.options.length < 2 || d.options.length > 6
        || d.options.some((o) => typeof o !== "string" || o.length === 0 || o.length > 200)
        || new Set(d.options).size !== d.options.length) {
        rej("bad_options", w);
      }
      if (!Array.isArray(d.blocks) || d.blocks.length === 0 || d.blocks.length > 20) rej("bad_blocks", w);
      const blocks = [];
      for (const b of d.blocks) {
        const name = b === "review" || b === "pr" ? "ship" : b;
        const idx = typeof name === "string" ? stages.indexOf(name) : -1;
        if (idx <= stageIdx) rej("bad_blocks", `${w}: ${JSON.stringify(b)} is not after ${stage}`);
        if (!blocks.includes(name)) blocks.push(name);
      }
      if (!CAUSES.includes(d.cause)) rej("bad_cause", w);
      const norm = { key: d.key, question: d.question, options: [...d.options], blocks, cause: d.cause };
      if (Object.hasOwn(d, "context")) {
        if (typeof d.context !== "string" || d.context.length > 4000) rej("bad_context", w);
        norm.context = d.context;
      }
      if (Object.hasOwn(d, "kind")) {
        if (d.kind !== "access-degraded") rej("bad_kind", w);
        norm.kind = d.kind;
      }
      if (Object.hasOwn(d, "source")) {
        if (typeof d.source !== "string" || d.source.length > 200) rej("bad_source", w);
        norm.source = d.source;
      }
      return norm;
    });
    return { ok: true, decisions: out };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.reason, detail: e.detail };
    throw e;
  }
}

// files is a Map<relpath, Buffer>; failures come back as { ok: false, reason, detail }.
export function readOutbox(outboxDir, { runId, stage, nonce, allowedArtifacts, requiredHeadings = {}, caps = {} }) {
  const cap = { ...DEFAULT_CAPS, ...caps };
  try {
    const present = enumerate(outboxDir);
    if (!present.includes("manifest.json")) rej("missing_manifest", "manifest.json");

    const raw = readRegular(join(outboxDir, "manifest.json"), cap.manifest, "manifest.json");
    let m;
    try {
      m = JSON.parse(strictUtf8(raw, "manifest.json"));
    } catch (e) {
      if (e instanceof Reject) throw e;
      rej("bad_json", e.message);
    }
    if (!isObj(m)) rej("bad_json", "manifest must be a JSON object");
    checkKeys(m, MANIFEST_KEYS, MANIFEST_REQUIRED, "manifest");
    if (m.schema !== SCHEMA) rej("bad_schema", String(m.schema));
    if (m.run_id !== runId) rej("identity_mismatch", "run_id");
    if (m.stage !== stage) rej("identity_mismatch", "stage");
    if (m.nonce !== nonce) rej("identity_mismatch", "nonce");
    if (!STATUSES.includes(m.status)) rej("bad_status", String(m.status));
    str(m.summary, 2000, "summary");
    if (!Array.isArray(m.artifacts)) rej("bad_field", "artifacts must be an array");
    if (!Array.isArray(m.decisions)) rej("bad_field", "decisions must be an array");
    if (Object.hasOwn(m, "env")) validateEnv(m.env);
    if (Object.hasOwn(m, "attempts")) validateAttempts(m.attempts);
    if (Object.hasOwn(m, "steps")) validateSteps(m.steps);

    const listed = new Map();
    m.artifacts.forEach((a, i) => {
      if (!isObj(a)) rej("bad_field", `artifacts[${i}] must be an object`);
      checkKeys(a, ["path", "sha256"], ["path", "sha256"], `artifacts[${i}]`);
      if (typeof a.path !== "string" || !allowedArtifacts.includes(a.path)) {
        rej("artifact_not_allowed", String(a.path));
      }
      if (listed.has(a.path)) rej("duplicate_artifact", a.path);
      if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) {
        rej("sha_mismatch", `${a.path}: sha256 is not 64 lowercase hex chars`);
      }
      listed.set(a.path, a.sha256);
    });

    const dv = validateDecisions(m.decisions, { stage, stages: DEFAULT_STAGES });
    if (!dv.ok) return dv;
    if (m.status === "needs_human" && dv.decisions.length === 0) {
      rej("needs_human_without_decision", "needs_human requires at least one decision");
    }

    for (const rel of present) {
      if (rel !== "manifest.json" && !listed.has(rel)) rej("unknown_entry", rel);
    }
    for (const rel of listed.keys()) {
      if (!present.includes(rel)) rej("missing_artifact", rel);
    }

    const files = new Map();
    for (const [rel, want] of listed) {
      const buf = readRegular(join(outboxDir, rel), rel.endsWith(".md") ? cap.markdown : cap.other, rel);
      strictUtf8(buf, rel);
      if (createHash("sha256").update(buf).digest("hex") !== want) rej("sha_mismatch", rel);
      files.set(rel, buf);
    }

    if (m.status === "complete") {
      for (const rel of allowedArtifacts) {
        const want = requiredHeadings[rel];
        if (!want) continue;
        if (!files.has(rel)) rej("missing_artifact", `${rel} is required when status is complete`);
        const text = files.get(rel).toString("utf8");
        for (const h of want) {
          if (!hasHeading(text, h)) rej("missing_heading", `${rel}: ${h}`);
        }
      }
    }

    return { ok: true, manifest: m, files };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.reason, detail: e.detail };
    throw e;
  }
}

const SECRET_PATTERNS = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["github-pat", /github_pat_[A-Za-z0-9_]{20,}/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abp]-[A-Za-z0-9-]{10,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

// Tripwire for obvious credential shapes, not a control: a determined child can encode around it.
export function secretScan(texts, literals = []) {
  const bodies = texts.map((t) => (typeof t === "string" ? t : Buffer.from(t).toString("utf8")));
  for (const body of bodies) {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(body)) return { hit: true, pattern: name };
    }
    for (const lit of literals) {
      if (typeof lit === "string" && lit.length >= 8 && body.includes(lit)) {
        return { hit: true, pattern: "literal" };
      }
    }
  }
  return { hit: false };
}
