// The runtime port: one request shape, one response shape, a closed registry of adapters.
// A request field the runtime did not declare is refused, never dropped. See CONTRACT.md.
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import claudeCode from "./adapters/claude-code.mjs";
import { RuntimeError, UnknownRuntimeError, RuntimeRequestError, CapabilityError } from "./errors.mjs";

export { RuntimeError, UnknownRuntimeError, RuntimeRequestError, CapabilityError };

const REGISTRY = Object.freeze({ [claudeCode.name]: claudeCode });
const DEFAULT_RUNTIME = "claude-code";
const MAX_BUFFER = 64 * 1024 * 1024;

/** flag > DETENT_RUNTIME > claude-code. An empty or unregistered name is refused. */
export function resolveRuntimeName({ flag, env = process.env } = {}) {
  const name = flag !== undefined ? flag : env.DETENT_RUNTIME !== undefined ? env.DETENT_RUNTIME : DEFAULT_RUNTIME;
  if (typeof name !== "string" || !Object.hasOwn(REGISTRY, name)) throw new UnknownRuntimeError(name, Object.keys(REGISTRY));
  return name;
}

const ENUMS = {
  output: ["text", "json"], tools: ["none", "inherit"], mcp: ["none", "inherit"], auth: ["session", "api_key"],
};
const SOURCES = ["none", "project", "inherit"];
const REQUIRED = ["prompt", "cwd", "output", "tools", "mcp", "settings"];
const RESERVED = ["deny_tools", "add_dirs", "budget", "env", "containment"];
const KNOWN = new Set([...REQUIRED, "auth", "model", "persist_session", "timeout_ms", ...RESERVED]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (field, why) => new RuntimeRequestError(`request.${field} ${why}`, field);

/** Throws RuntimeRequestError for unknown keys, missing required fields and malformed values. Fills nothing. */
export function validateRequest(req) {
  if (!isObject(req)) throw bad("request", "must be a JSON object");
  for (const k of Object.keys(req)) if (!KNOWN.has(k)) throw bad(k, "is not a known request field");
  for (const k of REQUIRED) if (req[k] === undefined) throw bad(k, "is required");
  if (typeof req.prompt !== "string" || !req.prompt) throw bad("prompt", "must be a non-empty string");
  if (typeof req.cwd !== "string" || !isAbsolute(req.cwd)) throw bad("cwd", "must be an absolute path");
  for (const k of ["output", "mcp"]) if (!ENUMS[k].includes(req[k])) throw bad(k, `must be one of ${ENUMS[k].join(" | ")}`);
  if (!ENUMS.tools.includes(req.tools) && !isObject(req.tools)) throw bad("tools", `must be one of ${ENUMS.tools.join(" | ")}`);
  if (!isObject(req.settings)) throw bad("settings", "must be an object");
  for (const k of Object.keys(req.settings)) if (k !== "sources" && k !== "file") throw bad(`settings.${k}`, "is not a known settings field");
  if (!SOURCES.includes(req.settings.sources)) throw bad("settings.sources", `must be one of ${SOURCES.join(" | ")}`);
  if (req.settings.file !== undefined && (typeof req.settings.file !== "string" || !isAbsolute(req.settings.file))) throw bad("settings.file", "must be an absolute path");
  if (req.auth !== undefined && !ENUMS.auth.includes(req.auth)) throw bad("auth", `must be one of ${ENUMS.auth.join(" | ")}`);
  if (req.model !== undefined && (typeof req.model !== "string" || !req.model)) throw bad("model", "must be a non-empty string");
  if (req.persist_session !== undefined && req.persist_session !== false) throw bad("persist_session", "must be false when present");
  if (req.timeout_ms !== undefined && !(Number.isInteger(req.timeout_ms) && req.timeout_ms > 0)) throw bad("timeout_ms", "must be a positive integer");
  return req;
}

/** Throws CapabilityError for the first field or value the runtime did not declare. */
export function requireCapabilities(caps, req, runtime) {
  const need = (capability, ok, requested) => { if (!ok) throw new CapabilityError(runtime, capability, requested); };
  need("output", caps.output.includes(req.output), req.output);
  if (isObject(req.tools)) need("tools_allow", caps.tools_allow === true, req.tools);
  else need("tools", caps.tools.includes(req.tools), req.tools);
  need("mcp", caps.mcp.includes(req.mcp), req.mcp);
  need("settings_sources", caps.settings_sources.includes(req.settings.sources), req.settings.sources);
  if (req.settings.file !== undefined) need("settings_file", caps.settings_file === true, req.settings.file);
  if (req.auth !== undefined) need("auth", caps.auth.includes(req.auth), req.auth);
  if (req.model !== undefined) need("model", caps.model === true, req.model);
  if (req.persist_session !== undefined) need("persist_session", caps.persist_session === true, req.persist_session);
  if (req.timeout_ms !== undefined) need("timeout", caps.timeout === true, req.timeout_ms);
  for (const k of RESERVED) if (req[k] !== undefined) need(k, caps[k] === true, req[k]);
}

/** Wrap an adapter {name, bin, capabilities(), plan(req), parse(native, req)}. `bin` overrides the adapter's binary. */
export function createRuntime(adapter, { bin } = {}) {
  const runtime = {
    name: adapter.name,
    capabilities: () => adapter.capabilities(),
    plan(req) {
      validateRequest(req);
      requireCapabilities(adapter.capabilities(), req, adapter.name);
      const planned = adapter.plan(req);
      return bin === undefined ? planned : { ...planned, bin };
    },
    parse: (native, req) => adapter.parse(native, req),
    run(req) {
      const p = runtime.plan(req);
      const native = spawnSync(p.bin, p.args, {
        cwd: p.cwd, input: req.prompt, encoding: "utf8", timeout: req.timeout_ms, maxBuffer: MAX_BUFFER,
      });
      return adapter.parse(native, req);
    },
  };
  return runtime;
}

/** bins maps a runtime name to a binary path and applies only to that runtime. */
export function getRuntime({ name, bins = {} } = {}) {
  const resolved = name === undefined ? resolveRuntimeName() : resolveRuntimeName({ flag: name });
  return createRuntime(REGISTRY[resolved], { bin: bins[resolved] });
}
