// The runtime port: one request shape, one response shape, a closed registry of adapters.
// A request field the runtime did not declare is refused, never dropped. See CONTRACT.md.
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { PORTABLE_TOOLS } from "./portable.mjs";
import claudeCode from "./adapters/claude-code.mjs";
import openaiCompatible from "./adapters/openai-compatible.mjs";
import { RuntimeError, UnknownRuntimeError, RuntimeRequestError, CapabilityError, RuntimeConfigError } from "./errors.mjs";

export { RuntimeError, UnknownRuntimeError, RuntimeRequestError, CapabilityError, RuntimeConfigError };

const REGISTRY = Object.freeze({ [claudeCode.name]: claudeCode, [openaiCompatible.name]: openaiCompatible });
const DEFAULT_RUNTIME = "claude-code";
const MAX_BUFFER = 64 * 1024 * 1024;

/** flag > DETENT_RUNTIME > claude-code. An empty or unregistered name is refused. */
export function resolveRuntimeName({ flag, env = process.env } = {}) {
  const name = flag !== undefined ? flag : env.DETENT_RUNTIME !== undefined ? env.DETENT_RUNTIME : DEFAULT_RUNTIME;
  if (typeof name !== "string" || !Object.hasOwn(REGISTRY, name)) throw new UnknownRuntimeError(name, Object.keys(REGISTRY));
  return name;
}

const ENUMS = {
  output: ["text", "json"], tools: ["none", "inherit"], mcp: ["none", "inherit"], auth: ["session", "api_key"], approvals: ["deny"],
};
const SOURCES = ["none", "project", "inherit"];
const REQUIRED = ["prompt", "cwd", "output", "tools", "mcp", "settings"];
const RESERVED = ["deny_tools", "add_dirs", "budget", "env", "containment"];
const KNOWN = new Set([...REQUIRED, "approvals", "auth", "model", "persist_session", "timeout_ms", ...RESERVED]);

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
  if (req.approvals !== undefined && !ENUMS.approvals.includes(req.approvals)) throw bad("approvals", `must be one of ${ENUMS.approvals.join(" | ")}`);
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
  if (req.approvals !== undefined) need("approvals", caps.approvals.includes(req.approvals), req.approvals);
  if (req.settings.file !== undefined) need("settings_file", caps.settings_file === true, req.settings.file);
  if (req.auth !== undefined) need("auth", caps.auth.includes(req.auth), req.auth);
  if (req.model !== undefined) need("model", caps.model === true, req.model);
  if (req.persist_session !== undefined) need("persist_session", caps.persist_session === true, req.persist_session);
  if (req.timeout_ms !== undefined) need("timeout", caps.timeout === true, req.timeout_ms);
  for (const k of RESERVED) if (req[k] !== undefined) need(k, caps[k] === true, req[k]);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

function checkDenyTools(list) {
  if (!Array.isArray(list) || list.length === 0) throw bad("deny_tools", "must be a non-empty array of { shell_prefix }");
  list.forEach((entry, i) => {
    const at = `deny_tools[${i}]`;
    if (!isObject(entry) || Object.keys(entry).length !== 1 || entry.shell_prefix === undefined) throw bad(at, "must be exactly { shell_prefix: string }");
    const p = entry.shell_prefix;
    if (typeof p !== "string" || !p) throw bad(`${at}.shell_prefix`, "must be a non-empty string");
    if (/[()*\n\0]/.test(p)) throw bad(`${at}.shell_prefix`, "must not contain ( ) *, a newline or NUL");
  });
}

function checkToolsAllow(tools) {
  const keys = Object.keys(tools);
  if (keys.length !== 1 || keys[0] !== "allow") throw bad("tools", "must be exactly { allow: [...] } when an object");
  const { allow } = tools;
  if (!Array.isArray(allow) || allow.length === 0) throw bad("tools.allow", "must be a non-empty array");
  for (const t of allow) if (!PORTABLE_TOOLS.includes(t)) throw bad("tools.allow", `has ${JSON.stringify(t)}; allowed names are ${PORTABLE_TOOLS.join(" | ")}`);
  if (new Set(allow).size !== allow.length) throw bad("tools.allow", "must not repeat a name");
}

function checkAddDirs(dirs) {
  if (!Array.isArray(dirs) || dirs.length === 0) throw bad("add_dirs", "must be a non-empty array of absolute paths");
  dirs.forEach((d, i) => { if (typeof d !== "string" || !isAbsolute(d)) throw bad(`add_dirs[${i}]`, "must be an absolute path"); });
  if (new Set(dirs).size !== dirs.length) throw bad("add_dirs", "must not repeat a path");
}

function checkBudget(budget) {
  if (!isObject(budget)) throw bad("budget", "must be an object { usd?, turns? }");
  for (const k of Object.keys(budget)) if (k !== "usd" && k !== "turns") throw bad(`budget.${k}`, "is not a known budget field");
  if (Object.keys(budget).length === 0) throw bad("budget", "must set usd or turns");
  if (budget.usd !== undefined && !(Number.isFinite(budget.usd) && budget.usd > 0)) throw bad("budget.usd", "must be a positive finite number");
  if (budget.turns !== undefined && !isPositiveInt(budget.turns)) throw bad("budget.turns", "must be a positive integer");
}

function checkEnv(env) {
  if (!isObject(env)) throw bad("env", "must be an object of string values");
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k)) throw bad(`env.${k}`, "is not a valid variable name");
    if (typeof v !== "string" || v.includes("\0")) throw bad(`env.${k}`, "must be a string without NUL");
  }
}

/** Throws RuntimeRequestError for a malformed reserved field. Runs after requireCapabilities, so a runtime that lacks the field refuses it first. */
export function validateDeclared(req) {
  if (req.deny_tools !== undefined) checkDenyTools(req.deny_tools);
  if (isObject(req.tools)) checkToolsAllow(req.tools);
  if (req.add_dirs !== undefined) checkAddDirs(req.add_dirs);
  if (req.budget !== undefined) checkBudget(req.budget);
  if (req.env !== undefined) checkEnv(req.env);
  if (req.containment !== undefined && req.containment !== "strict") throw bad("containment", 'must be "strict"');
  return req;
}

/** Wrap an adapter {name, capabilities(), plan(req, env), parse(native, req)}. `bin` overrides the adapter's binary. */
export function createRuntime(adapter, { bin, env = process.env } = {}) {
  const runtime = {
    name: adapter.name,
    capabilities: () => adapter.capabilities(),
    check(req) {
      validateRequest(req);
      requireCapabilities(adapter.capabilities(), req, adapter.name);
      return validateDeclared(req);
    },
    plan(req) {
      runtime.check(req);
      const planned = adapter.plan(req, env);
      return bin === undefined ? planned : { ...planned, bin };
    },
    parse: (native, req) => adapter.parse(native, req),
    probeContainment({ env: probeEnv = env } = {}) {
      if (adapter.capabilities().containment !== true) throw new CapabilityError(adapter.name, "containment", "strict");
      const { containment } = adapter;
      const native = spawnSync(bin === undefined ? containment.bin : bin, containment.probe_args, { encoding: "utf8", env: probeEnv, timeout: containment.timeout_ms });
      return containment.check(native);
    },
    run(req) {
      const p = runtime.plan(req);
      const native = spawnSync(p.bin, p.args, {
        cwd: p.cwd, input: req.prompt, encoding: "utf8", timeout: req.timeout_ms, maxBuffer: MAX_BUFFER,
        ...(p.env ? { env: p.env } : {}),
      });
      if (p.echo_stderr && native.stderr) process.stderr.write(native.stderr);
      return adapter.parse(native, req);
    },
  };
  return runtime;
}

/** bins maps a runtime name to a binary path and applies only to that runtime. */
export function getRuntime({ name, bins = {}, env = process.env } = {}) {
  const resolved = name === undefined ? resolveRuntimeName({ env }) : resolveRuntimeName({ flag: name, env });
  return createRuntime(REGISTRY[resolved], { bin: bins[resolved], env });
}
