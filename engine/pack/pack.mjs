// pack.mjs — deterministic validator for provider packs (packs/<name>/stack.yaml).
// Semantics live in skills/referee/SKILL.md "Pack config" and skills/scout/SKILL.md
// step 0: an invalid pack is an error, never a fallback to built-in defaults.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { parseYaml, YamlError } from "./yaml.mjs";

export const PROVIDER_KINDS = ["mcp", "skill", "command", "local"];
export const LENS_KINDS = ["skill", "builtin"];
export const NETWORKS = ["public", "private"];
export const DEFAULT_PACK = join("packs", "example", "stack.yaml");

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isBlank = (v) => v === null || v === undefined || v === "";

/** Flag, else detent.user.yaml pack.path, else the shipped example pack. */
export function resolvePackPath({ flag, detentRoot }) {
  if (flag !== undefined) return resolve(flag);
  const userFile = join(detentRoot, "detent.user.yaml");
  if (existsSync(userFile)) {
    let user;
    try {
      user = parseYaml(readFileSync(userFile, "utf8"), userFile);
    } catch (e) {
      const where = e instanceof YamlError ? `: ${e.message}` : `: cannot read (${e.message})`;
      throw new PackPathError(`${userFile}${where}`);
    }
    const p = isMap(user) && isMap(user.pack) ? user.pack.path : null;
    if (!isBlank(p)) {
      if (typeof p !== "string") throw new PackPathError(`${userFile}: pack.path must be a string, got ${JSON.stringify(p)}`);
      return isAbsolute(p) ? p : resolve(detentRoot, p);
    }
  }
  return join(detentRoot, DEFAULT_PACK);
}

export class PackPathError extends Error {}

// A feature is OFF when the field that makes it runnable is null or empty.
function providerState(p) {
  const need = { mcp: ["server", "tool"], skill: ["skill"], command: ["command"] }[p.kind];
  if (need) {
    const missing = need.filter((f) => isBlank(p[f]));
    if (missing.length) return { state: "OFF", reason: `${missing.join(" and ")} not set` };
  }
  if (p.kind === "local" && (!Array.isArray(p.paths) || p.paths.length === 0)) {
    return { state: "OFF", reason: "paths not set" };
  }
  return { state: "ON" };
}

function lensState(l, providers) {
  if (l.kind === "skill" && isBlank(l.skill)) return { state: "OFF", reason: "skill not set" };
  if (isMap(l.probe)) {
    if (isBlank(l.probe.provider)) return { state: "OFF", reason: "probe provider not set" };
    const target = providers.find((p) => p.id === l.probe.provider);
    if (target && target.state === "OFF") return { state: "OFF", reason: `probe provider ${target.id} is OFF` };
  }
  return { state: "ON" };
}

function checkList(doc, listPath, kinds, errors, file, extra) {
  const [section, key] = listPath.split(".");
  const list = isMap(doc[section]) ? doc[section][key] : undefined;
  if (!Array.isArray(list)) {
    errors.push(`${file}: ${listPath} is required and must be a list`);
    return [];
  }
  const seen = new Set();
  const items = [];
  list.forEach((item, i) => {
    const at = `${listPath}[${i}]`;
    if (!isMap(item)) {
      errors.push(`${file}: ${at} must be a map`);
      return;
    }
    if (typeof item.id !== "string" || !item.id) {
      errors.push(`${file}: ${at}.id is required and must be a non-empty string`);
    } else if (seen.has(item.id)) {
      errors.push(`${file}: ${listPath} has duplicate id '${item.id}' (at ${at})`);
    } else seen.add(item.id);
    if (!kinds.includes(item.kind)) {
      errors.push(`${file}: ${at}.kind '${item.kind}' is not one of ${kinds.join("|")}`);
    }
    extra(item, at);
    items.push(item);
  });
  return items;
}

export function validatePack(doc, file) {
  const errors = [];
  if (!isMap(doc)) return { errors: [`${file}: top level must be a map`] };

  if (!isMap(doc.pack) || typeof doc.pack.name !== "string" || !doc.pack.name.trim()) {
    errors.push(`${file}: pack.name is required and must be a non-empty string`);
  }

  const providers = checkList(doc, "knowledge.providers", PROVIDER_KINDS, errors, file, (p, at) => {
    if ("requires_network" in p && !NETWORKS.includes(p.requires_network)) {
      errors.push(`${file}: ${at}.requires_network '${p.requires_network}' is not one of ${NETWORKS.join("|")}`);
    }
  });
  const providerIds = new Set(providers.map((p) => p.id));

  const lenses = checkList(doc, "review.lenses", LENS_KINDS, errors, file, (l, at) => {
    if (isMap(l.probe) && !isBlank(l.probe.provider) && !providerIds.has(l.probe.provider)) {
      errors.push(`${file}: ${at}.probe.provider '${l.probe.provider}' is not a knowledge.providers id`);
    }
  });

  const br = isMap(doc.knowledge) ? doc.knowledge.blast_radius : undefined;
  if (br !== undefined && br !== null) {
    if (!isMap(br)) {
      errors.push(`${file}: knowledge.blast_radius must be a map`);
    } else if (!isBlank(br.neighbor_source) && !providerIds.has(br.neighbor_source)) {
      errors.push(`${file}: knowledge.blast_radius.neighbor_source '${br.neighbor_source}' is not a knowledge.providers id`);
    } else if (br.enabled === true && isBlank(br.neighbor_source)) {
      errors.push(`${file}: knowledge.blast_radius.neighbor_source is required when enabled is true`);
    }
  }

  if (errors.length) return { errors };

  const provSummary = providers.map((p) => ({ id: p.id, kind: p.kind, ...providerState(p) }));
  const lensSummary = lenses.map((l) => ({ id: l.id, kind: l.kind, ...lensState(l, provSummary) }));
  const brOn = isMap(br) && br.enabled === true;
  const section = (s, field) => (isMap(s) && !isBlank(s[field]) ? { state: "ON" } : { state: "OFF", reason: `${field} not set` });
  return {
    errors,
    summary: {
      pack: { name: doc.pack.name, version: doc.pack.version ?? null, path: file },
      providers: provSummary,
      lenses: lensSummary,
      blast_radius: brOn
        ? { enabled: true, service_manifest: br.service_manifest ?? null, neighbor_source: br.neighbor_source }
        : { enabled: false },
      incident: section(doc.incident, "skill"),
      analytics: section(doc.analytics, "server"),
      network: { check_cmd: isMap(doc.network) && !isBlank(doc.network.check_cmd) ? doc.network.check_cmd : null },
    },
  };
}

/** Read, parse and validate one pack file. Never throws on a bad pack; returns errors. */
export function validatePackFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { errors: [`${file}: cannot read pack file (${e.code || e.message})`] };
  }
  let doc;
  try {
    doc = parseYaml(text, file);
  } catch (e) {
    if (e instanceof YamlError) return { errors: [`${file}: ${e.message}`] };
    throw e;
  }
  return validatePack(doc, file);
}
