/**
 * routing — model-tier routing + escalate-on-block config (recommend-only).
 *
 * WHAT IT IS
 *   A zero-dep module (feedback.mjs idiom) that loads and validates
 *   `engine/routing/routing.json` — the committed config mapping model names
 *   to tiers (`strong`/`fast`/`light`, mirroring the CLAUDE.md model-selection
 *   doctrine and `engine/bench/bench.mjs`'s `DEFAULT_RATES`) and declaring the
 *   escalate-on-block convention: when a stage blocks, a STRONG-tier advisor
 *   MAY be consulted, but it never answers on the run's behalf.
 *
 * THE GUARD
 *   `authority` MUST be the literal string `"recommend-only"`. Any other
 *   value (including the absent field) throws loudly — this is a schema
 *   invariant, not a flag, precisely so nobody can "promote" the advisor to
 *   auto-apply by editing one string past a test. Promotion requires a new
 *   schema version (`detent-routing-v2` or later) plus human review; see
 *   `docs/model-routing.md`.
 *
 * PURE. This module never writes a file — `engine/cli/engine.mjs` owns the
 * `events.jsonl` append; `advisorConsultEvent()` only builds the object.
 *
 * Node >= 18. Zero dependencies.
 */
"use strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROUTING_SCHEMA = "detent-routing-v1";

export function routingConfigPath(detentRoot) {
  return join(detentRoot, "engine", "routing", "routing.json");
}

/**
 * Load + validate `engine/routing/routing.json` under `detentRoot`. Throws
 * (loud, never a silent default) on any structural violation:
 *   - missing/unreadable file, or invalid JSON
 *   - `schema` is not the string `ROUTING_SCHEMA`
 *   - `tiers` is missing, empty, or any tier is not a non-empty array of
 *     non-empty strings
 *   - `escalation.authority` is not the literal string `"recommend-only"`
 *     (THE guard — see module docstring)
 */
export function loadRoutingConfig(detentRoot) {
  const path = routingConfigPath(detentRoot);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`routing: cannot read ${path}: ${e.message}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw new Error(`routing: invalid JSON in ${path}: ${e.message}`);
  }

  if (config.schema !== ROUTING_SCHEMA) {
    throw new Error(
      `routing: ${path} has schema "${config.schema}", expected "${ROUTING_SCHEMA}"`,
    );
  }

  const tiers = config.tiers;
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers) || Object.keys(tiers).length === 0) {
    throw new Error(`routing: ${path} tiers must be a non-empty object of tier -> model-name array`);
  }
  for (const [tier, models] of Object.entries(tiers)) {
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error(`routing: ${path} tier "${tier}" must be a non-empty array of model names`);
    }
    for (const m of models) {
      if (typeof m !== "string" || !m.trim()) {
        throw new Error(`routing: ${path} tier "${tier}" has a non-string/empty model entry`);
      }
    }
  }

  const authority = config.escalation && config.escalation.authority;
  if (authority !== "recommend-only") {
    throw new Error(
      `routing: ${path} escalation.authority must be the literal string "recommend-only" (got "${authority}") — ` +
      `this is a schema invariant, not a flag; see docs/model-routing.md for the promotion path`,
    );
  }

  return { path, config };
}

/** Which tier `model` belongs to, per `config.tiers`. `null` if unknown — never guessed. */
export function tierOf(model, config) {
  if (!model) return null;
  for (const [tier, models] of Object.entries(config.tiers)) {
    if (models.includes(model)) return tier;
  }
  return null;
}

/**
 * Build (never append — pure) the `advisor_consult` event object for a
 * STRONG-tier consult. No `id` field: `id` is reserved for
 * external_request/external_response correlation in `engine/bench/bench.mjs`
 * (same rule as `engine step`, see `engine/cli/engine.mjs`). `authority` is
 * always `"recommend-only"` — the caller does not get to override it.
 */
export function advisorConsultEvent({ model, tier, trigger, decisionId = null }) {
  return {
    event: "advisor_consult",
    model,
    tier,
    trigger,
    decision_id: decisionId,
    authority: "recommend-only",
  };
}
