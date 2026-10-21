// One chat-completions call with retries, run as a child of the openai-compatible adapter.
// Prompt on stdin, config in argv, the key read from the env var named by --api-key-env.
// Prints one protocol line and exits 0 whenever it classified the outcome; any other exit is a crash.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROTOCOL = "detent-openai-call-v1";
const ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000];
const RETRY_AFTER_CAP_MS = 10000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SNIPPET = 300;
const MIN_REDACT_KEY = 8;

/** A status number, or an error thrown by fetch (always a network failure). */
export function retryable(statusOrErr) {
  if (typeof statusOrErr === "number") return RETRYABLE_STATUS.has(statusOrErr);
  return statusOrErr instanceof Error;
}

/** Delay before retrying after failed attempt `attempt` (1-based). Retry-After counts only as seconds. */
export function backoffMs(attempt, retryAfter) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > BACKOFF_MS.length) throw new RangeError(`no backoff after attempt ${attempt}`);
  const secs = retryAfter === undefined || retryAfter === null || String(retryAfter).trim() === "" ? NaN : Number(retryAfter);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  return BACKOFF_MS[attempt - 1];
}

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));
const errorCode = (e) => e?.cause?.code || e?.code || e?.message || String(e);

// Redacts the key in free text only: a message, or the strings inside a body. The envelope is never touched.
function scrubber(apiKey) {
  if (!apiKey || apiKey.length < MIN_REDACT_KEY) return { text: (t) => t, deep: (v) => v };
  const forms = [...new Set([apiKey, JSON.stringify(apiKey).slice(1, -1)])];
  const text = (t) => forms.reduce((acc, f) => acc.split(f).join("[redacted]"), t);
  const deep = (v) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
  };
  return { text, deep };
}

/** Resolves to the protocol object. Never throws for a provider or network outcome. */
export async function complete({ baseUrl, model, prompt, apiKey, fetch = globalThis.fetch, sleep = sleepFor, warn = () => {} }) {
  const scrub = scrubber(apiKey);
  const failed = (f) => ({ protocol: PROTOCOL, ok: false, ...f, message: scrub.text(f.message) });
  const url = `${baseUrl}/chat/completions`;
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
  };
  let failure;
  for (let attempt = 1; ; attempt++) {
    let retryAfter;
    let why;
    let again = true;
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      if (res.ok) {
        let body;
        try { body = JSON.parse(text); } catch (e) {
          return failed({ class: "bad_body", http_status: res.status, attempts: attempt, message: `response body is not JSON: ${e.message}: ${scrub.text(text).slice(0, SNIPPET)}` });
        }
        return { protocol: PROTOCOL, ok: true, http_status: res.status, attempts: attempt, body: scrub.deep(body) };
      }
      failure = { class: "http", http_status: res.status, attempts: attempt, message: scrub.text(text).slice(0, SNIPPET) };
      why = `HTTP ${res.status}`;
      retryAfter = res.headers.get("retry-after");
      again = retryable(res.status);
    } catch (e) {
      failure = { class: "network", attempts: attempt, message: errorCode(e) };
      why = failure.message;
    }
    if (!again || attempt === ATTEMPTS) return failed(failure);
    const delay = backoffMs(attempt, retryAfter);
    warn(scrub.text(`openai-compatible: attempt ${attempt}/${ATTEMPTS} failed (${why}); retrying in ${delay}ms`));
    await sleep(delay);
  }
}

function parseArgv(argv) {
  const flags = { "--base-url": "baseUrl", "--model": "model", "--api-key-env": "keyEnv" };
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key) throw new Error(`unknown argument '${argv[i]}'`);
    if (out[key] !== undefined) throw new Error(`${argv[i]} given twice`);
    if (i + 1 >= argv.length || !argv[i + 1]) throw new Error(`${argv[i]} needs a value`);
    out[key] = argv[i + 1];
  }
  if (!out.baseUrl) throw new Error("--base-url is required");
  if (!out.model) throw new Error("--model is required");
  return out;
}

/** Returns the exit code. A crash is any nonzero code, with the reason on stderr. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let a;
  let apiKey;
  try {
    a = parseArgv(argv);
    if (a.keyEnv !== undefined) {
      apiKey = env[a.keyEnv];
      if (!apiKey) throw new Error(`environment variable ${a.keyEnv} is empty or unset`);
    }
  } catch (e) {
    process.stderr.write(`openai-compatible-call: ${e.message}\n`);
    return 2;
  }
  const prompt = readFileSync(0, "utf8");
  if (!prompt) {
    process.stderr.write("openai-compatible-call: stdin prompt is empty\n");
    return 2;
  }
  const out = await complete({ baseUrl: a.baseUrl, model: a.model, prompt, apiKey, warn: (l) => process.stderr.write(l + "\n") });
  process.stdout.write(JSON.stringify(out) + "\n");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
