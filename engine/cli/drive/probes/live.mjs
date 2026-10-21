// Opt-in live probes (--live). They spend a few cents on a small model.
// PB2-PB5 run claude inside the probe profile behind a plain-http proxy; the
// alternative run uses claude's own Bash sandbox with OAuth and no outer profile.
import http from "node:http";
import https from "node:https";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProbeProfile, defaultDenyRead } from "./seatbelt-deny-default.mjs";
import { result } from "./report.mjs";
import { run, which } from "./exec.mjs";
import { PROBE_PROMPT, PROCARGS_C, altSettings, liveCommands, probeScript, parseTranscript, explainNoBash } from "./transcript.mjs";
import { ALLOWED_PROXY_PATHS, LIVE_BUDGET_TOTAL_USD, LIVE_MODEL, evalLive, liveCheckScript, parseKv } from "./live-checks.mjs";

const FORWARD_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"];

export function startMessagesProxy({ apiKey, placeholder, upstream = "https://api.anthropic.com" }) {
  const stats = { total: 0, forwarded: 0, refused: 0, bad_token: 0, paths: {} };
  const up = new URL(upstream);
  const server = http.createServer((req, res) => {
    stats.total++;
    const path = (req.url || "").split("?")[0];
    stats.paths[path] = (stats.paths[path] || 0) + 1;
    if (req.headers["x-api-key"] !== placeholder) { stats.bad_token++; res.writeHead(401).end(); req.resume(); return; }
    if (req.method !== "POST" || !ALLOWED_PROXY_PATHS.includes(path)) { stats.refused++; res.writeHead(403).end(); req.resume(); return; }
    const headers = { "x-api-key": apiKey, host: up.host };
    for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
    const out = https.request({ hostname: up.hostname, port: up.port || 443, path: req.url, method: "POST", headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    out.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    stats.forwarded++;
    req.pipe(out);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      stats: () => ({ ...stats, paths: { ...stats.paths } }),
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

// 2.1.306 prints a bare result object, a JSON array of messages, or stream-json lines.
function findResult(stdout) {
  const text = String(stdout).trim();
  const pick = (v) => {
    if (Array.isArray(v)) return [...v].reverse().find((m) => m && m.type === "result") || null;
    return v && typeof v === "object" && v.type === "result" ? v : null;
  };
  try { return pick(JSON.parse(text)) || (JSON.parse(text)?.is_error !== undefined ? JSON.parse(text) : null); } catch { /* try line by line */ }
  for (const line of text.split("\n").reverse()) {
    try { const m = pick(JSON.parse(line)); if (m) return m; } catch { /* not a json line */ }
  }
  return null;
}

export function parseClaudeJson(stdout) {
  const j = findResult(stdout);
  if (!j) return { answered: false, is_error: null, subtype: "no_result", cost: 0, turns: 0, denials: 0, error_text: "" };
  const isError = j.is_error === true;
  return {
    answered: j.is_error === false, is_error: isError, subtype: String(j.subtype ?? ""), cost: Number(j.total_cost_usd) || 0, turns: Number(j.num_turns) || 0,
    denials: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0,
    error_text: isError && typeof j.result === "string" ? j.result.slice(0, 200) : "",
  };
}

// Exit code, flags and counts only; the result text is included solely when claude marked it an error.
export function describeRun(r, c) {
  const first = String(r.stderr || "").split("\n").find((l) => l.trim()) || "";
  const parts = [`exit=${r.code ?? r.signal ?? r.error}`, `timed_out=${Boolean(r.timedOut)}`, `is_error=${c.is_error}`, `subtype=${c.subtype || "none"}`, `denials=${c.denials}`, `turns=${c.turns}`];
  if (c.error_text) parts.push(`error=${JSON.stringify(c.error_text)}`);
  if (first) parts.push(`stderr1=${JSON.stringify(first.slice(0, 200))}`);
  return parts.join(" ").slice(0, 600);
}

export function readKeyFile(path) {
  const k = readFileSync(path, "utf8").trim();
  if (!k) throw new Error("--api-key-file is empty");
  return k;
}

function prompt(script, args) {
  return `Run exactly this command with the Bash tool, wait for it to finish, then reply with the single word DONE: sh ${script} ${args.join(" ")}`;
}

function stage(dir, { canary, loopbackPort, keychainService, writeTest }) {
  for (const d of [dir, join(dir, "home"), join(dir, "tmp"), join(dir, "work")]) mkdirSync(d, { recursive: true });
  const script = join(dir, "live-check.sh");
  writeFileSync(script, liveCheckScript());
  writeFileSync(join(dir, "parent.pid"), String(process.pid));
  writeFileSync(join(dir, "canary.txt"), canary);
  const out = join(dir, "results.txt");
  return { script, out, args: [out, join(dir, "parent.pid"), join(dir, "canary.txt"), "$REAL_HOME", String(loopbackPort), JSON.stringify(keychainService), writeTest] };
}

async function hostControls(realHome) {
  const kc = await run("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"], { timeout: 10000 });
  const net = await run("curl", ["-m", "5", "-sS", "-f", "-o", "/dev/null", "https://example.com"], { timeout: 10000 });
  return {
    sshConfigExists: existsSync(join(realHome, ".ssh", "config")),
    claudeCredsExist: existsSync(join(realHome, ".claude", ".credentials.json")),
    keychainItemFound: kc.code === 0,
    netExternalOk: net.code === 0,
  };
}

export async function runLive({ T, realHome, canary, nonce, log, apiKeyFile }) {
  const results = [];
  let spent = 0;
  const add = (probe, expected, actual, status, note) => results.push(result({ probe, expected, actual, status, note }));
  const claude = which("claude");
  if (!claude) { add("live.claude_binary", "found", "absent", "inconclusive", "claude is not on PATH"); return results; }
  const claudeReal = realpathSync(claude);
  const controls = await hostControls(realHome);
  const affordable = (cap) => spent + cap <= LIVE_BUDGET_TOTAL_USD + 1e-9;
  const writeTest = join(realHome, `.detent-probe-write-${nonce}`);
  const clean = () => rmSync(writeTest, { force: true });
  const managed = "/Library/Application Support/ClaudeCode/managed-settings.json";
  let forced = false;
  try { forced = /"sandbox"/.test(readFileSync(managed, "utf8")); } catch { /* absent or unreadable means not forced */ }
  add("live.pb6_managed_sandbox", "no forced sandbox setting", forced ? "managed settings carry a sandbox key" : "none", forced ? "fail" : "pass", "boolean only; the file is not printed");

  const apiKey = apiKeyFile ? readKeyFile(apiKeyFile) : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    for (const id of ["live.pb2_proxy_only", "live.pb3_fake_home", "live.pb4_binary_dir_only", "live.pb5_bash_under_outer"]) {
      add(id, "claude answers", "not_run", "skipped", "set ANTHROPIC_API_KEY or pass --api-key-file to run the outer-sandbox probes");
    }
  } else if (affordable(0.06)) {
    const placeholder = `probe-${nonce}`;
    const proxy = await startMessagesProxy({ apiKey, placeholder });
    try {
      const dir = join(T, "live-a");
      const st = stage(dir, { canary, loopbackPort: proxy.port, keychainService: "Claude Code-credentials", writeTest });
      const profile = buildProbeProfile({ scratch: dir, loopbackPort: proxy.port, denyRead: defaultDenyRead(realHome) });
      const env = {
        PATH: process.env.PATH, HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), CLAUDE_CODE_TMPDIR: join(dir, "tmp"), LANG: "C",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`, ANTHROPIC_API_KEY: placeholder,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      };
      const args = st.args.map((a) => (a === "$REAL_HOME" ? realHome : a));
      const r = await run("sandbox-exec", ["-p", profile, claudeReal, "-p", "--bare", "--restricted", "--model", LIVE_MODEL,
        "--max-turns", "3", "--max-budget-usd", "0.04", "--output-format", "json", "--tools", "Bash", "--allowedTools", "Bash",
        "--settings", JSON.stringify({ sandbox: { enabled: false } }), "--no-session-persistence"],
      { env, cwd: join(dir, "work"), timeout: 180000, input: prompt(st.script, args) });
      const c = parseClaudeJson(r.stdout);
      spent += c.cost;
      const ps = proxy.stats();
      const onlyMessages = Object.keys(ps.paths).every((p) => ALLOWED_PROXY_PATHS.includes(p));
      add("live.pb2_proxy_only", "answered via proxy, only /v1/messages paths", `answered=${c.answered} forwarded=${ps.forwarded} refused=${ps.refused} bad_token=${ps.bad_token} other_paths=${!onlyMessages}`,
        c.answered && ps.forwarded > 0 && ps.refused === 0 && ps.bad_token === 0 && onlyMessages ? "pass" : "fail");
      add("live.pb3_fake_home", "answered with an empty fake HOME", `answered=${c.answered} subtype=${c.subtype}`, c.answered ? "pass" : "fail");
      const kv = existsSync(st.out) ? parseKv(readFileSync(st.out, "utf8")) : {};
      add("live.pb5_bash_under_outer", "Bash ran with sandbox.enabled=false under --restricted", kv.bash_ran === 1 ? "bash_ran" : `no_bash(subtype=${c.subtype})`, kv.bash_ran === 1 ? "pass" : "fail");
      if (kv.bash_ran === 1) results.push(...evalLive("live.outer", kv, controls, { expectLoopback: true }));
    } finally { await proxy.close(); clean(); }
    if (affordable(0.02)) {
      const proxy2 = await startMessagesProxy({ apiKey, placeholder: `probe-${nonce}` });
      try {
        const dir = join(T, "live-c");
        for (const d of [dir, join(dir, "home"), join(dir, "tmp"), join(dir, "work")]) mkdirSync(d, { recursive: true });
        const profile = buildProbeProfile({
          scratch: dir, loopbackPort: proxy2.port,
          denyRead: [...defaultDenyRead(realHome), "/Users", "/Volumes", "/private/tmp", "/private/var/folders"],
          reallowRead: [dir, dirname(claudeReal)],
        });
        const env = {
          PATH: process.env.PATH, HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), CLAUDE_CODE_TMPDIR: join(dir, "tmp"), LANG: "C",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy2.port}`, ANTHROPIC_API_KEY: `probe-${nonce}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
        };
        const r = await run("sandbox-exec", ["-p", profile, claudeReal, "-p", "--bare", "--restricted", "--model", LIVE_MODEL,
          "--max-turns", "1", "--max-budget-usd", "0.02", "--output-format", "json", "--tools", "", "--no-session-persistence"],
        { env, cwd: join(dir, "work"), timeout: 120000, input: "Reply with the single word OK." });
        const c = parseClaudeJson(r.stdout);
        spent += c.cost;
        add("live.pb4_binary_dir_only", "answered with /Users unreadable except the binary dir and scratch", `answered=${c.answered} exit=${r.code} subtype=${c.subtype}`, c.answered ? "pass" : "fail",
          /Operation not permitted/.test(r.stderr) ? "stderr mentions a sandbox denial" : undefined);
      } finally { await proxy2.close(); }
    } else add("live.pb4_binary_dir_only", "answered", "not_run", "skipped", "budget cap reached");
  } else add("live.pb2_proxy_only", "claude answers", "not_run", "skipped", "budget cap reached");

  const detentRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  for (const variant of ["default", "hardened"]) {
    const prefix = `live.alt_${variant}`;
    if (!affordable(0.03)) { add(`${prefix}.bash_ran`, "ran", "not_run", "skipped", "budget cap reached"); continue; }
    const dir = join(T, `live-alt-${variant}`);
    stage(dir, { canary, loopbackPort: 0, keychainService: "Claude Code-credentials", writeTest });
    const env = { ...process.env };
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "PROBE_CANARY"]) delete env[k];
    const settings = altSettings({ hardened: variant === "hardened", realHome, detentRoot });
    const work = join(dir, "work");
    const helperSrc = join(dir, "procargs2.c");
    writeFileSync(helperSrc, PROCARGS_C);
    const built = (await run("clang", ["-o", join(work, "procargs2"), helperSrc], { env: process.env })).code === 0;
    const cmds = liveCommands({ realHome, parentPidFile: join(dir, "parent.pid"), canaryFile: join(dir, "canary.txt"), writeTest }).filter(([k]) => built || !k.startsWith("ps_"));
    writeFileSync(join(work, "probe.sh"), probeScript(cmds));
    const r = await run(claudeReal, ["-p", "--model", LIVE_MODEL, "--max-turns", "4", "--max-budget-usd", "0.03", "--output-format", "stream-json", "--verbose",
      "--tools", "Bash", "--allowedTools", "Bash", "--permission-mode", "dontAsk", "--settings", JSON.stringify(settings), "--setting-sources", "project",
      "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"],
    { env, cwd: work, timeout: 180000, input: PROBE_PROMPT });
    const c = parseClaudeJson(r.stdout);
    spent += c.cost;
    const t = parseTranscript(r.stdout);
    const tokens = t.tokens;
    const note = (t.bashUses > 0 ? explainNoBash(t) : `model_declined: ${explainNoBash(t)} ${describeRun(r, c)}`) + (built ? "" : " no_compiler");
    const ran = tokens.bash_ran === 1;
    add(`${prefix}.bash_ran`, "Bash ran under claude's own sandbox", ran ? "bash_ran" : "no_bash", ran ? "pass" : "inconclusive", note.slice(0, 300));
    if (ran) results.push(...evalLive(prefix, tokens, controls, { expectLoopback: false }));
    clean();
  }

  add("live.cost", `<= ${LIVE_BUDGET_TOTAL_USD.toFixed(2)} USD`, `${spent.toFixed(4)} USD`, spent <= LIVE_BUDGET_TOTAL_USD ? "pass" : "fail");
  log?.(`live spend ${spent.toFixed(4)} USD`);
  return results;
}
