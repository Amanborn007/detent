#!/usr/bin/env node
/**
 * blast-radius — mechanizes scout SKILL.md step 3 ("Blast radius") as a
 * plan/merge pure-function pair (module + CLI, like engine/bench/bench.mjs).
 *
 * This helper never talks to a knowledge provider itself — a node script
 * cannot reach an MCP server; only the invoking agent session can. So the
 * shape here is: `planBlastRadius` emits the query text the agent should run
 * against its knowledge provider (agent-side); the agent runs it, collects
 * raw hits, organizes them per neighbor; `mergeBlastRadius` takes that
 * organized result and enforces the honesty rules (attribution required,
 * provider status required, absence stated rather than hidden) and renders
 * the exact "Blast radius" markdown section shape from skills/scout/SKILL.md.
 *
 * Zero dependencies. Node >= 18. Vocabulary is company-neutral — this file
 * never names a specific knowledge provider; that binding lives in
 * engine/stack.example.yaml and skills/scout/SKILL.md.
 *
 * Exit codes (CLI): 0 = ok · 2 = refusal (missing/invalid input, honesty
 * violation). There is no exit 1 here — everything this module refuses is a
 * caller-input problem, never an environment failure.
 */
"use strict";

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// Errors — every refusal is a BlastRadiusError so the CLI can map it to exit 2
// without swallowing the message (error-handling rule: loud, specific, never
// a silent fallback).
// ---------------------------------------------------------------------------

export class BlastRadiusError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlastRadiusError";
  }
}

const VALID_DIRECTIONS = ["caller", "callee", "unknown"];
const VALID_PROVIDER_STATUSES = ["reachable", "blocked", "partial"];

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "neighbor";
}

// ---------------------------------------------------------------------------
// planBlastRadius — the discovery half (no neighbors known yet) or the
// per-neighbor gotcha half (neighbors supplied — the agent already ran
// discovery and is re-planning, per SKILL.md step 3). The helper never
// decides which neighbors are relevant at depth "standard" — that filtering
// is the agent's job per SKILL.md ("keep only what intersects the change");
// this only plans the query text for whichever neighbors it is handed.
// ---------------------------------------------------------------------------

export function planBlastRadius({ service, depth = "standard", neighbors } = {}) {
  if (!service || typeof service !== "string" || !service.trim()) {
    throw new BlastRadiusError("planBlastRadius requires a non-empty 'service'");
  }
  const svc = service.trim();
  const d = depth && typeof depth === "string" ? depth : "standard";

  if (!neighbors || (Array.isArray(neighbors) && neighbors.length === 0)) {
    return {
      service: svc,
      depth: d,
      queries: [
        { id: "discovery-1", purpose: "neighbor-discovery", query: `${svc} dependencies callers callees` },
      ],
      instructions:
        `Run the discovery query above against the knowledge provider (agent-side; this helper cannot ` +
        `reach it). From the raw hits, extract the 1-hop neighbor names (callers and callees). Then call ` +
        `'plan' again with those neighbors to get one 'neighbor-gotchas' query per neighbor ` +
        `("<neighbor> gotchas open concerns"). At depth "deep", pass all neighbors; at "standard", pass ` +
        `only the ones intersecting the change described by the original query — this helper only plans ` +
        `queries, it never decides relevance.`,
    };
  }

  if (!Array.isArray(neighbors)) {
    throw new BlastRadiusError("planBlastRadius: 'neighbors' must be an array of neighbor names");
  }
  const queries = neighbors.map((n, i) => {
    if (typeof n !== "string" || !n.trim()) {
      throw new BlastRadiusError(`planBlastRadius: neighbors[${i}] is not a non-empty string`);
    }
    return { id: `gotcha-${slugify(n)}`, purpose: "neighbor-gotchas", query: `${n.trim()} gotchas open concerns` };
  });
  return {
    service: svc,
    depth: d,
    queries,
    instructions:
      `Run each per-neighbor query above against the knowledge provider (agent-side), then feed the raw ` +
      `results to 'merge' — one entry per neighbor, each gotcha carrying a non-empty 'source' attribution.`,
  };
}

// ---------------------------------------------------------------------------
// mergeBlastRadius — validate + render. HONESTY RULES (non-negotiable):
//  - provider_status is required; missing => throw (never assume reachable).
//  - provider_status !== "reachable" => refuse to emit a neighbors section;
//    return { blocked: true, reason } instead of an empty-but-ok section.
//  - every gotcha MUST carry a non-empty 'source' — an unattributed gotcha
//    throws rather than being silently dropped or fabricated a source.
//  - zero hits (no neighbors, or a neighbor with no gotchas) is recorded as
//    an explicit 'gaps' entry, never omitted.
// ---------------------------------------------------------------------------

export function mergeBlastRadius({ service, provider_status, results } = {}) {
  if (!service || typeof service !== "string" || !service.trim()) {
    throw new BlastRadiusError("mergeBlastRadius requires a non-empty 'service'");
  }
  const svc = service.trim();
  if (provider_status === undefined || provider_status === null || provider_status === "") {
    throw new BlastRadiusError(
      "mergeBlastRadius requires 'provider_status' (reachable|blocked|partial) — never merge without knowing the provider state",
    );
  }
  if (!VALID_PROVIDER_STATUSES.includes(provider_status)) {
    throw new BlastRadiusError(
      `mergeBlastRadius: unknown provider_status '${provider_status}' — expected one of ${VALID_PROVIDER_STATUSES.join("|")}`,
    );
  }

  if (provider_status !== "reachable") {
    return {
      service: svc,
      provider_status,
      blocked: true,
      reason:
        `knowledge provider status is '${provider_status}', not 'reachable' — refusing to emit a neighbors ` +
        `section (never an empty-but-ok section for a down/degraded provider)`,
    };
  }

  const list = Array.isArray(results) ? results : [];
  const gaps = [];
  if (list.length === 0) {
    gaps.push(`no neighbors discovered for ${svc} — zero-hit discovery query`);
  }

  const neighbors = list.map((r, i) => {
    if (!r || typeof r !== "object") {
      throw new BlastRadiusError(`mergeBlastRadius: results[${i}] is not an object`);
    }
    if (typeof r.neighbor !== "string" || !r.neighbor.trim()) {
      throw new BlastRadiusError(`mergeBlastRadius: results[${i}] is missing a non-empty 'neighbor' name`);
    }
    const name = r.neighbor.trim();
    const direction = VALID_DIRECTIONS.includes(r.direction) ? r.direction : "unknown";
    const rawGotchas = Array.isArray(r.gotchas) ? r.gotchas : [];
    const gotchas = rawGotchas.map((g, gi) => {
      if (!g || typeof g !== "object" || typeof g.text !== "string" || !g.text.trim()) {
        throw new BlastRadiusError(`mergeBlastRadius: ${name}.gotchas[${gi}] is missing non-empty 'text'`);
      }
      if (typeof g.source !== "string" || !g.source.trim()) {
        throw new BlastRadiusError(
          `mergeBlastRadius: ${name}.gotchas[${gi}] is missing a non-empty 'source' — never fabricate attribution`,
        );
      }
      return { text: g.text.trim(), source: g.source.trim() };
    });
    if (gotchas.length === 0) {
      gaps.push(`${name}: no gotchas found`);
    }
    return { name, direction, gotchas };
  });

  return { service: svc, provider_status, neighbors, gaps, markdown: renderMarkdown(svc, neighbors) };
}

/** Exact "Blast radius" section shape from skills/scout/SKILL.md's Output format. */
function renderMarkdown(service, neighbors) {
  const lines = [`### Blast radius (1-hop neighbors of ${service})`];
  if (neighbors.length === 0) {
    lines.push("- (no neighbors discovered)");
    return lines.join("\n");
  }
  for (const n of neighbors) {
    if (n.gotchas.length === 0) {
      lines.push(`- ${n.name}: (no gotchas found)`);
      continue;
    }
    for (const g of n.gotchas) {
      lines.push(`- ${n.name}: ${g.text} [${g.source}]`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI: node engine/scout/blast-radius.mjs plan --service X [--depth d] [--neighbors a,b,c]
//      node engine/scout/blast-radius.mjs merge --service X --status reachable   (results JSON on stdin)
// One JSON line to stdout. Exit 0 on success, 2 on refusal.
// ---------------------------------------------------------------------------

const USAGE =
  "node engine/scout/blast-radius.mjs <plan|merge> --service <name> " +
  "[--depth quick|standard|deep] [--neighbors a,b,c] [--status reachable|blocked|partial] " +
  "(merge reads a JSON results array on stdin)";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function refuseCli(reason) {
  process.stdout.write(JSON.stringify({ ok: false, reason, next_step: USAGE }) + "\n");
  process.exit(2);
}

function readStdinText() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function cli(argv) {
  const { positional, flags } = parseArgs(argv);
  const [cmd] = positional;

  if (cmd === "plan") {
    if (!flags.service || flags.service === true) refuseCli("plan requires --service <name>");
    const neighbors = flags.neighbors && flags.neighbors !== true
      ? String(flags.neighbors).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const depth = flags.depth && flags.depth !== true ? String(flags.depth) : undefined;
    let result;
    try {
      result = planBlastRadius({ service: String(flags.service), depth, neighbors });
    } catch (e) {
      refuseCli(e.message);
    }
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
    return;
  }

  if (cmd === "merge") {
    if (!flags.service || flags.service === true) refuseCli("merge requires --service <name>");
    if (!flags.status || flags.status === true) refuseCli("merge requires --status <reachable|blocked|partial>");
    const raw = readStdinText();
    let input;
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
      refuseCli(`merge: stdin is not valid JSON: ${e.message}`);
    }
    const results = Array.isArray(input) ? input : input.results;
    let result;
    try {
      result = mergeBlastRadius({ service: String(flags.service), provider_status: String(flags.status), results });
    } catch (e) {
      refuseCli(e.message);
    }
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
    return;
  }

  refuseCli(`unknown command '${cmd || ""}' — expected 'plan' or 'merge'`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  cli(process.argv.slice(2));
}
