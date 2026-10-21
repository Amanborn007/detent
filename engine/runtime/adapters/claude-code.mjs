// claude-code adapter: pure capabilities(), plan(req) and parse(native, req). It never spawns.
import { RuntimeRequestError } from "../errors.mjs";

const NAME = "claude-code";

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
  budget: false,
  add_dirs: false,
  deny_tools: false,
  containment: false,
  env: false,
  tools_allow: false,
});

function plan(req) {
  const args = ["-p"];
  if (req.output === "json") args.push("--output-format", "json");
  if (req.tools === "none") args.push("--tools", "");
  if (req.mcp === "none") args.push("--strict-mcp-config");
  if (req.persist_session === false) args.push("--no-session-persistence");
  if (req.auth === "api_key") {
    if (req.settings.sources !== "none") {
      throw new RuntimeRequestError("request.auth api_key is passed as --bare, which skips settings, so settings.sources must be none", "auth");
    }
    args.push("--bare");
  } else if (req.settings.sources !== "inherit") {
    args.push("--setting-sources", req.settings.sources === "none" ? "" : req.settings.sources);
  }
  if (req.settings.file !== undefined) args.push("--settings", req.settings.file);
  if (req.model !== undefined) args.push("--model", req.model);
  return { bin: "claude", args, cwd: req.cwd };
}

const fail = (kind, message, extra = {}) => ({ stop: kind === "timeout" ? "timeout" : "error", text: null, cost_usd: null, turns: null, denials: [], error: { kind, message, ...extra } });

function interpret(stdout) {
  let env;
  try { env = JSON.parse(stdout); } catch (e) { return fail("bad_output", "claude stdout is not a JSON envelope: " + e.message); }
  if (Array.isArray(env)) env = env.findLast((m) => m && m.type === "result") || {};
  if (env === null || typeof env !== "object") return fail("bad_output", "claude stdout is not a JSON envelope: not an object");
  const cost_usd = Number.isFinite(env.total_cost_usd) ? env.total_cost_usd : null;
  const turns = Number.isInteger(env.num_turns) ? env.num_turns : null;
  const denials = Array.isArray(env.permission_denials) ? env.permission_denials : [];
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

function parse(native, req) {
  const raw = { stdout: native.stdout ?? "", stderr: native.stderr ?? "", exit_code: native.status ?? null, signal: native.signal ?? null };
  let r;
  if (native.error) r = fail(native.error.code === "ETIMEDOUT" ? "timeout" : "spawn", native.error.message);
  else if (native.status !== 0) {
    r = fail("exit", native.status === null ? `killed by ${native.signal}` : `exited with code ${native.status}`, { exit_code: native.status });
  } else if (req.output === "text") r = { stop: "ok", text: raw.stdout, cost_usd: null, turns: null, denials: [], error: null };
  else r = interpret(raw.stdout);
  return { runtime: NAME, ...r, raw };
}

export default Object.freeze({ name: NAME, capabilities: () => CAPABILITIES, plan, parse });
