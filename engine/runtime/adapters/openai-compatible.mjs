// openai-compatible adapter: pure capabilities(), plan(req, env) and parse(native, req). It never spawns.
// The child is openai-compatible-call.mjs, which makes the HTTP call; config comes from env only.
import { fileURLToPath } from "node:url";
import { RuntimeConfigError } from "../errors.mjs";

const NAME = "openai-compatible";
const PROTOCOL = "detent-openai-call-v1";
const CALL_PATH = fileURLToPath(new URL("./openai-compatible-call.mjs", import.meta.url));
const BASE_URL = "DETENT_OPENAI_BASE_URL";
const MODEL = "DETENT_OPENAI_MODEL";
const KEY_ENV = "DETENT_OPENAI_API_KEY_ENV";

const CAPABILITIES = Object.freeze({
  output: Object.freeze(["text", "json"]),
  tools: Object.freeze(["none"]),
  mcp: Object.freeze(["none"]),
  settings_sources: Object.freeze(["none"]),
  settings_file: false,
  auth: Object.freeze(["api_key"]),
  model: true,
  persist_session: true,
  timeout: true,
  reports: Object.freeze({}),
  budget: false,
  add_dirs: false,
  deny_tools: false,
  containment: false,
  env: false,
  tools_allow: false,
  approvals: Object.freeze([]),
});

const isLoopback = (host) => host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);

function baseUrl(env) {
  const raw = env[BASE_URL];
  if (!raw) throw new RuntimeConfigError(`${BASE_URL} is not set; it is the endpoint root, e.g. http://127.0.0.1:11434/v1`, BASE_URL);
  let url;
  try { url = new URL(raw); } catch {
    throw new RuntimeConfigError(`${BASE_URL} is not a URL: ${JSON.stringify(raw)}`, BASE_URL);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeConfigError(`${BASE_URL} must be an http: or https: URL, got ${url.protocol}`, BASE_URL);
  }
  if (url.username || url.password) {
    throw new RuntimeConfigError(`${BASE_URL} must not carry credentials in the URL; send the key through ${KEY_ENV}`, BASE_URL);
  }
  return { base: raw.replace(/\/+$/, ""), url };
}

function keyEnvName(env, url) {
  const name = env[KEY_ENV];
  if (!name) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new RuntimeConfigError(`${KEY_ENV} must be the NAME of the environment variable that holds the key, not the key itself`, KEY_ENV);
  }
  if (!env[name]) throw new RuntimeConfigError(`the variable named by ${KEY_ENV} is empty or unset`, KEY_ENV);
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new RuntimeConfigError(`${BASE_URL} is plain http to a non-loopback host, which would send the key unencrypted; use https`, BASE_URL);
  }
  return name;
}

function plan(req, env) {
  const { base, url } = baseUrl(env);
  const model = req.model ?? (env[MODEL] || undefined);
  if (model === undefined) throw new RuntimeConfigError(`no model: set request.model or ${MODEL}`, MODEL);
  const keyEnv = keyEnvName(env, url);
  if (req.auth === "api_key" && keyEnv === undefined) {
    throw new RuntimeConfigError(`request.auth is api_key but no key is configured; set ${KEY_ENV} to the name of the variable that holds it`, KEY_ENV);
  }
  const args = [CALL_PATH, "--base-url", base, "--model", model, ...(keyEnv ? ["--api-key-env", keyEnv] : [])];
  return { bin: process.execPath, args, cwd: req.cwd, env: { ...env }, echo_stderr: true };
}

const fail = (kind, message, extra = {}) => ({ stop: kind === "timeout" ? "timeout" : "error", text: null, cost_usd: null, turns: null, denials: [], error: { kind, message, ...extra } });

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function interpretBody(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (choice === null || typeof choice !== "object") return fail("bad_output", "response has no choices");
  const reason = choice.finish_reason;
  if (reason === "length") return fail("runtime_error", "output truncated (finish_reason length)");
  if (reason !== "stop") {
    return fail("runtime_error", reason === undefined || reason === null ? "provider response has no finish_reason" : `provider stopped with finish_reason ${reason}`);
  }
  const content = choice.message && choice.message.content;
  if (typeof content !== "string") return fail("bad_output", "choices[0].message.content is not a string");
  return { stop: "ok", text: content, cost_usd: null, turns: null, denials: [], error: null };
}

function interpret(stdout) {
  const notProtocol = (why) => fail("bad_output", `helper stdout is not a ${PROTOCOL} line: ${why}`);
  let o;
  try { o = JSON.parse(stdout); } catch (e) { return notProtocol(e.message); }
  if (o === null || typeof o !== "object" || o.protocol !== PROTOCOL || typeof o.ok !== "boolean") return notProtocol("missing protocol or ok");
  if (o.ok) return interpretBody(o.body);
  if (o.class === "http") return fail("runtime_error", `HTTP ${o.http_status} after ${plural(o.attempts, "attempt")}: ${o.message}`);
  if (o.class === "network") return fail("runtime_error", `network error after ${plural(o.attempts, "attempt")}: ${o.message}`);
  if (o.class === "bad_body") return fail("bad_output", o.message);
  return notProtocol(`unknown class ${JSON.stringify(o.class)}`);
}

function parse(native, req) {
  const raw = { stdout: native.stdout ?? "", stderr: native.stderr ?? "", exit_code: native.status ?? null, signal: native.signal ?? null };
  let r;
  if (native.error) r = fail(native.error.code === "ETIMEDOUT" ? "timeout" : "spawn", native.error.message);
  else if (native.status !== 0) {
    r = fail("exit", native.status === null ? `killed by ${native.signal}` : `exited with code ${native.status}`, { exit_code: native.status });
  } else r = interpret(raw.stdout);
  return { runtime: NAME, ...r, raw };
}

export default Object.freeze({ name: NAME, capabilities: () => CAPABILITIES, plan, parse });
