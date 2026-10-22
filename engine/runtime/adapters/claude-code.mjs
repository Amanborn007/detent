// claude-code adapter: pure capabilities(), plan(req) and parse(native, req). It never spawns.
import { RuntimeRequestError } from "../errors.mjs";

const NAME = "claude-code";
export const MIN_CLAUDE_VERSION = "2.1.306";

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(text, min = MIN_CLAUDE_VERSION) {
  const v = parseVersion(text);
  const m = parseVersion(min);
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== m[i]) return v[i] > m[i];
  }
  return true;
}

const TOOL_NAMES = Object.freeze({ read: "Read", glob: "Glob", grep: "Grep", write: "Write", edit: "Edit", todo: "TodoWrite" });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const CAPABILITIES = Object.freeze({
  output: Object.freeze(["text", "json"]),
  tools: Object.freeze(["none", "inherit"]),
  mcp: Object.freeze(["none", "inherit"]),
  settings_sources: Object.freeze(["none", "project", "inherit"]),
  settings_file: true,
  auth: Object.freeze(["session", "api_key"]),
  model: true,
  persist_session: true,
  timeout: true,
  reports: Object.freeze({ cost_usd: "json", turns: "json" }),
  budget: true,
  add_dirs: true,
  deny_tools: true,
  containment: true,
  env: true,
  tools_allow: true,
  approvals: Object.freeze(["deny"]),
});

const allowList = (tools) => tools.allow.map((t) => TOOL_NAMES[t]).join(",");
const withEnv = (p, req) => (req.env === undefined ? p : { ...p, env: { ...req.env } });

function sourcesFlags(req) {
  if (req.auth === "api_key") {
    if (req.settings.sources !== "none") {
      throw new RuntimeRequestError("request.auth api_key is passed as --bare, which skips settings, so settings.sources must be none", "auth");
    }
    return ["--bare"];
  }
  return req.settings.sources === "inherit" ? [] : ["--setting-sources", req.settings.sources === "none" ? "" : req.settings.sources];
}

function planGeneric(req) {
  const args = ["-p"];
  if (req.output === "json") args.push("--output-format", "json");
  if (isObject(req.tools)) args.push("--tools", allowList(req.tools));
  else if (req.tools === "none") args.push("--tools", "");
  if (req.mcp === "none") args.push("--strict-mcp-config");
  if (req.persist_session === false) args.push("--no-session-persistence");
  if (req.approvals === "deny") args.push("--permission-mode", "dontAsk");
  args.push(...sourcesFlags(req));
  if (req.settings.file !== undefined) args.push("--settings", req.settings.file);
  if (req.model !== undefined) args.push("--model", req.model);
  for (const d of req.add_dirs ?? []) args.push("--add-dir", d);
  if (req.budget?.usd !== undefined) args.push("--max-budget-usd", String(req.budget.usd));
  if (req.budget?.turns !== undefined) args.push("--max-turns", String(req.budget.turns));
  if (req.deny_tools !== undefined) args.push("--disallowedTools", ...req.deny_tools.map((d) => `Bash(${d.shell_prefix}*)`));
  return { bin: "claude", args, cwd: req.cwd };
}

const strict = (why) => new RuntimeRequestError(`request.containment strict ${why}`, "containment");

function planStrict(req) {
  if (req.output !== "json") throw strict("needs output json");
  if (!isObject(req.tools)) throw strict("needs tools { allow }");
  if (req.mcp !== "none") throw strict("needs mcp none");
  if (req.approvals !== "deny") throw strict("needs approvals deny");
  if (req.settings.file === undefined) throw strict("needs settings.file");
  if (req.model === undefined) throw strict("needs model");
  if (req.budget?.usd === undefined || req.budget?.turns === undefined) throw strict("needs budget.usd and budget.turns");
  if (req.add_dirs === undefined) throw strict("needs add_dirs");
  if (req.env === undefined) throw strict("needs env");
  if (req.deny_tools !== undefined) throw strict("does not take deny_tools");
  if (req.persist_session !== undefined) throw strict("does not take persist_session");
  const { sources } = req.settings;
  const oauth = sources === "inherit" && req.auth === undefined;
  const bare = sources === "none" && req.auth === "api_key";
  if (!oauth && !bare) throw strict("needs settings.sources inherit with no auth, or settings.sources none with auth api_key");
  const args = [
    "-p", "--restricted", "--tools", allowList(req.tools), "--output-format", "json", "--model", req.model,
    "--permission-mode", "dontAsk", "--settings", req.settings.file,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    ...req.add_dirs.flatMap((d) => ["--add-dir", d]),
    "--max-budget-usd", String(req.budget.usd), "--max-turns", String(req.budget.turns),
    ...(bare ? ["--bare"] : []),
  ];
  return { bin: "claude", args, cwd: req.cwd };
}

function plan(req) {
  return withEnv(req.containment === undefined ? planGeneric(req) : planStrict(req), req);
}

const fail = (kind, message, extra = {}) => ({ stop: kind === "timeout" ? "timeout" : "error", text: null, cost_usd: null, turns: null, denials: [], error: { kind, message, ...extra } });

function figures(env) {
  return {
    cost_usd: Number.isFinite(env.total_cost_usd) ? env.total_cost_usd : null,
    turns: Number.isInteger(env.num_turns) ? env.num_turns : null,
    denials: Array.isArray(env.permission_denials) ? env.permission_denials : [],
  };
}

function envelopeOf(stdout) {
  let env = JSON.parse(stdout);
  if (Array.isArray(env)) env = env.findLast((m) => m && m.type === "result") || {};
  return env;
}

function interpret(stdout) {
  let env;
  try { env = envelopeOf(stdout); } catch (e) { return fail("bad_output", "claude stdout is not a JSON envelope: " + e.message); }
  if (env === null || typeof env !== "object") return fail("bad_output", "claude stdout is not a JSON envelope: not an object");
  const { cost_usd, turns, denials } = figures(env);
  const result = typeof env.result === "string" ? env.result : null;
  const base = { text: result, cost_usd, turns, denials, error: null };
  if (env.subtype === "error_max_budget_usd") return { stop: "budget", ...base };
  if (env.subtype === "error_max_turns") return { stop: "turns", ...base };
  if (env.is_error || String(env.subtype || "").startsWith("error")) {
    return { stop: "error", ...base, text: null, error: { kind: "runtime_error", message: String(env.result) } };
  }
  if (result === null) return { ...fail("bad_output", "envelope has no string .result"), cost_usd, turns, denials };
  return { stop: "ok", ...base };
}

function exitFigures(stdout) {
  let env;
  try { env = envelopeOf(stdout); } catch { return {}; }
  return env !== null && typeof env === "object" ? figures(env) : {};
}

function parse(native, req) {
  const raw = { stdout: native.stdout ?? "", stderr: native.stderr ?? "", exit_code: native.status ?? null, signal: native.signal ?? null };
  let r;
  if (native.error) r = fail(native.error.code === "ETIMEDOUT" ? "timeout" : "spawn", native.error.message);
  else if (native.status !== 0) {
    r = fail("exit", native.status === null ? `killed by ${native.signal}` : `exited with code ${native.status}`, { exit_code: native.status });
    if (req.output === "json") Object.assign(r, exitFigures(raw.stdout));
  } else if (req.output === "text") r = { stop: "ok", text: raw.stdout, cost_usd: null, turns: null, denials: [], error: null };
  else r = interpret(raw.stdout);
  return { runtime: NAME, ...r, raw };
}

const containment = Object.freeze({
  bin: "claude",
  probe_args: Object.freeze(["--version"]),
  timeout_ms: 30000,
  check(native) {
    if (native.error) return { ok: false, kind: "spawn", message: native.error.message };
    const text = (native.stdout ?? "").trim();
    if (!versionAtLeast(text)) return { ok: false, kind: "version", text, min: MIN_CLAUDE_VERSION };
    return { ok: true, version: text };
  },
});

export default Object.freeze({ name: NAME, capabilities: () => CAPABILITIES, plan, parse, containment });
