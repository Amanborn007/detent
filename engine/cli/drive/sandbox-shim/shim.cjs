// Claude Code 2.1.306 wraps each sandboxed Bash call as `env [-u N] [K=V] /usr/bin/sandbox-exec -p <profile> <shell> -c <cmd>`.
// This shim is that `env`; it is one CommonJS file because it is copied to disk as an executable.
// Settings come only from ../config.json, never from the environment the child's claude process owns.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const REFUSED = "DETENT_SELFPROBE_REFUSED";
const REFUSE_EXIT = 97;

function parseSbpl(text) {
  const root = [];
  const stack = [root];
  let i = 0;
  const n = text.length;
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ";") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "(") {
      const l = { t: "list", items: [] };
      top().push(l);
      stack.push(l.items);
      i++;
      continue;
    }
    if (c === ")") {
      if (stack.length === 1) throw new Error("unbalanced )");
      stack.pop();
      i++;
      continue;
    }
    if (c === '"' || (c === "#" && text[i + 1] === '"')) {
      const rawStr = c === "#";
      let j = i + (rawStr ? 2 : 1);
      while (j < n && text[j] !== '"') j += rawStr ? 1 : text[j] === "\\" ? 2 : 1;
      if (j >= n) throw new Error("unterminated string");
      const body = text.slice(i + (rawStr ? 1 : 0), j + 1);
      let v;
      if (rawStr) v = body.slice(1, -1);
      else { try { v = JSON.parse(body); } catch { v = body.slice(1, -1).replace(/\\(.)/g, "$1"); } }
      top().push({ t: "str", v, raw: rawStr });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !/[\s()";]/.test(text[j])) j++;
    top().push({ t: "atom", v: text.slice(i, j) });
    i = j;
  }
  if (stack.length !== 1) throw new Error("unbalanced (");
  return root;
}

function walkStrings(node, out, inNot, kind) {
  if (node.t === "str") { if (!inNot) out.push({ v: node.v, kind }); return; }
  if (node.t !== "list") return;
  const head = node.items[0];
  const k = head && head.t === "atom" ? head.v : kind;
  const not = inNot || k === "require-not" || k === "with";
  for (const it of node.items) walkStrings(it, out, not, k);
}

const strs = (nodes) => { const out = []; for (const x of nodes) walkStrings(x, out, false, ""); return out; };
const isRegexKind = (k) => k === "regex" || k === "path-regex";

const KNOWN_MACH = new Set([
  "com.apple.audio.systemsoundserver", "com.apple.distributed_notifications@Uv3", "com.apple.FontObjectsServer",
  "com.apple.fonts", "com.apple.logd", "com.apple.lsd.mapdb", "com.apple.PowerManagement.control",
  "com.apple.system.logger", "com.apple.system.notification_center", "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership", "com.apple.bsd.dirhelper", "com.apple.securityd.xpc",
  "com.apple.coreservices.launchservicesd", "com.apple.SecurityServer",
]);

const ALLOWED_OPS = new Set([
  "process-exec", "process-fork", "process-info*", "signal", "mach-priv-task-port", "user-preference-read",
  "mach-lookup", "ipc-posix-shm", "ipc-posix-sem", "iokit-open", "iokit-get-properties", "system-socket",
  "sysctl-read", "sysctl-write", "distributed-notification-post", "file-ioctl", "file-read-data", "file-write-data",
  "file-read*", "file-read-metadata", "file-write*", "file-write-unlink", "file-write-create",
  "network-bind", "network-inbound", "network-outbound",
]);

const BUILTIN_WRITE = ["/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait", "/tmp/claude", "/private/tmp/claude"];

function twins(p, syntactic = true) {
  const out = new Set([p]);
  try { out.add(fs.realpathSync(p)); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; }
  if (!syntactic) return [...out];
  for (const q of [...out]) {
    if (q.startsWith("/private/")) out.add(q.slice(8));
    else if (/^\/(var|tmp|etc)(\/|$)/.test(q)) out.add(`/private${q}`);
    if (q.startsWith("/Users/")) out.add(`/System/Volumes/Data${q}`);
  }
  return [...out];
}

const covers = (root, p) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

function denyCovers(denySet, requirement) {
  const glob = requirement.includes("*");
  const candidates = glob ? [requirement.replace(/^\*\*\//, "/probe-root/")] : twins(requirement, false);
  const tail = glob ? requirement.replace(/^\*\*\//, "") : null;
  for (const c of candidates) {
    for (const d of denySet.literal) if (covers(d, c)) return true;
    for (const rx of denySet.regex) {
      try { if (new RegExp(rx).test(c)) return true; } catch { /* a regex this engine cannot compile proves no coverage */ }
      if (tail && rx.replace(/\\/g, "").includes(tail)) return true;
    }
  }
  return false;
}

// exp: { home?, readDeny[], writeAllow[], readAllow?[], writeDenyRequired[] }
function validateProfile(text, exp) {
  const violations = [];
  const v = (code) => { if (!violations.includes(code)) violations.push(code); };
  let forms;
  try { forms = parseSbpl(text); } catch (e) { return { ok: false, violations: [`profile_unparseable:${e.message}`], ports: [] }; }

  const allowedWrite = new Set(BUILTIN_WRITE);
  if (exp.home) { allowedWrite.add(`${exp.home}/.npm/_logs`); allowedWrite.add(`${exp.home}/.claude/debug`); }
  for (const p of exp.writeAllow || []) for (const t of twins(p)) allowedWrite.add(t);
  const allowedRead = new Set(allowedWrite);
  for (const p of exp.readAllow || []) for (const t of twins(p)) allowedRead.add(t);
  const within = (set, p) => [...set].some((r) => covers(r, p));

  const ports = new Set();
  const denyRead = { literal: [], regex: [] };
  const denyWrite = { literal: [], regex: [] };
  let sawDenyDefault = false;
  let sawVersion = false;

  for (const f of forms) {
    if (f.t !== "list" || !f.items.length || f.items[0].t !== "atom") continue;
    const kind = f.items[0].v;
    if (kind === "version") { sawVersion = true; continue; }
    const rest = f.items.slice(1);
    const ops = [];
    for (const it of rest) { if (it.t === "atom") ops.push(it.v); else break; }
    const filters = rest.slice(ops.length);
    if (kind === "deny") {
      if (ops.includes("default")) sawDenyDefault = true;
      const target = ops.some((o) => o.startsWith("file-read")) ? denyRead : ops.some((o) => o.startsWith("file-write")) ? denyWrite : null;
      if (target) for (const s of strs(filters)) (isRegexKind(s.kind) ? target.regex : target.literal).push(s.v);
      continue;
    }
    if (kind !== "allow") continue;
    if (ops.includes("default")) { v("allow_default"); continue; }
    for (const op of ops) if (!ALLOWED_OPS.has(op)) v(`unknown_allow_op:${op}`);
    const flat = JSON.stringify(filters);

    if (ops.some((o) => o.startsWith("network"))) {
      if (!ops.every((o) => ["network-bind", "network-inbound", "network-outbound"].includes(o)) || filters.length === 0) v("network_open");
      else {
        for (const fl of filters) {
          if (JSON.stringify(fl).includes("unix-socket")) { v("network_unix_socket"); continue; }
          const val = strs([fl])[0] ? strs([fl])[0].v : "";
          const m = /^localhost:(\d{1,5})$/.exec(val);
          if (m) ports.add(Number(m[1]));
          else v(val.includes("*") ? "network_wildcard" : "network_not_loopback");
        }
      }
    }
    if (ops.includes("system-socket")) {
      if (flat.includes("AF_UNIX")) v("system_socket_unix");
      else if (!(flat.includes("AF_SYSTEM") && flat.includes('"2"'))) v("system_socket_other");
    }
    if (ops.includes("mach-lookup")) {
      for (const s of strs(filters)) {
        if (s.kind !== "global-name") v("mach_unknown_pattern");
        else if (!KNOWN_MACH.has(s.v)) v(`mach_unknown:${s.v}`);
      }
    }
    if (ops.some((o) => o.startsWith("file-write"))) {
      for (const s of strs(filters)) {
        if (isRegexKind(s.kind)) v("write_regex_allow");
        else if (!within(allowedWrite, s.v)) v(`write_outside_expected:${s.v}`);
      }
    }
    if (ops.some((o) => o.startsWith("file-read")) && !ops.some((o) => o.startsWith("file-write"))) {
      for (const s of strs(filters)) if (s.v !== "/" && !within(allowedRead, s.v)) v(`read_reallow:${s.v}`);
    }
  }
  if (!sawVersion) v("no_version");
  if (!sawDenyDefault) v("no_deny_default");
  if (ports.size > 2) v(`network_ports_gt2:${[...ports].join(",")}`);
  for (const p of exp.readDeny || []) if (!denyCovers(denyRead, p)) v(`deny_read_missing:${p}`);
  for (const p of exp.writeDenyRequired || []) if (!denyCovers(denyWrite, p)) v(`deny_write_missing:${p}`);
  return { ok: violations.length === 0, violations, ports: [...ports].sort((a, b) => a - b) };
}

function normaliseProfile(text) {
  return text
    .replace(/\(with message "[^"]*"\)/g, '(with message "TAG")')
    .replace(/^; LogTag: .*$/gm, "; LogTag: TAG")
    .replace(/CMD64_[A-Za-z0-9+/=_-]*?_END_[a-z0-9]+_SBX/g, "TAG");
}

const profileHash = (text) => crypto.createHash("sha256").update(normaliseProfile(text)).digest("hex");

function parseTokens(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = /^([a-z0-9_]+)=(-?\d{1,9})$/.exec(line.trim());
    if (m && out[m[1]] === undefined) out[m[1]] = Number(m[2]);
  }
  return out;
}

function evaluateTokens(tokens, expect, controls, { canaryHits = 0 } = {}) {
  const failures = [];
  const inconclusive = [];
  for (const [key, e] of Object.entries(expect || {})) {
    if (e.control) {
      const want = e.controlWant ?? 0;
      if (controls?.[e.control] !== want) { inconclusive.push(`${key}: control ${e.control}=${controls?.[e.control]} (needs ${want}), so the result proves nothing`); continue; }
    }
    if (e.requires) {
      const rv = tokens[e.requires.key];
      if (rv === undefined || rv < e.requires.min) { inconclusive.push(`${key}: control ${e.requires.key}=${rv} (needs >=${e.requires.min})`); continue; }
    }
    const t = tokens[key];
    if (t === undefined) { inconclusive.push(`${key}: no token`); continue; }
    if (e.k === "eq") { if (t !== e.v) failures.push(`${key}: expected ${e.v}, got ${t}`); }
    else if (e.k === "rc0") { if (t !== 0) failures.push(`${key}: expected rc 0, got ${t}`); }
    else if (e.k === "rcNot0") { if (t === 0 || t === 127) failures.push(`${key}: expected a refusal (rc other than 0 or 127), got ${t}`); }
    else if (e.k === "zero") { if (t !== 0) failures.push(`${key}: expected 0, got ${t}`); }
    else if (e.k === "ge1") { if (t < 1) inconclusive.push(`${key}: expected >=1, got ${t}`); }
    else if (e.k === "sameAsControl") {
      const c = controls?.[e.control];
      if (c === undefined) inconclusive.push(`${key}: no control ${e.control}`);
      else if (t !== c) failures.push(`${key}: sandboxed rc ${t} differs from unsandboxed rc ${c}`);
    } else failures.push(`${key}: unknown expectation ${e.k}`);
  }
  if (canaryHits > 0) failures.push(`canary_listener: ${canaryHits} connection(s) reached drive's listener`);
  return { failures, inconclusive };
}

function startCanaryListener({ socketPath } = {}) {
  let hits = 0;
  const servers = [];
  const mk = () => net.createServer((s) => { hits++; s.destroy(); });
  const listen = (srv, ...args) => new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(...args, () => resolve()); });
  return (async () => {
    const v4 = mk();
    await listen(v4, 0, "127.0.0.1");
    servers.push(v4);
    const port = v4.address().port;
    const v6 = mk();
    try { await listen(v6, port, "::1"); servers.push(v6); } catch (e) { if (e.code !== "EADDRNOTAVAIL" && e.code !== "EADDRINUSE" && e.code !== "EAFNOSUPPORT") throw e; }
    if (socketPath) { const u = mk(); await listen(u, socketPath); servers.push(u); }
    return {
      port,
      socketPath: socketPath ?? null,
      hits: () => hits,
      close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r())))).then(() => undefined),
    };
  })();
}

function parseWrapper(argv, sandboxExec) {
  let i = 0;
  const envArgs = [];
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-u" && i + 1 < argv.length) { envArgs.push(a, argv[i + 1]); i += 2; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { envArgs.push(a); i++; continue; }
    break;
  }
  if (argv[i] !== sandboxExec) return null;
  const shape = argv.length === i + 6 && argv[i + 1] === "-p" && argv[i + 4] === "-c";
  if (!shape) return { envArgs, shapeError: true };
  return { envArgs, profile: argv[i + 2], shell: argv[i + 3], command: argv[i + 5] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function refuse(reason) {
  process.stderr.write(`${REFUSED}: ${reason}\n`);
  process.exit(REFUSE_EXIT);
}

function relay(child) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  child.on("error", (e) => refuse(`cannot start ${e.path}: ${e.code}`));
  child.on("close", (code, sig) => {
    if (sig) { process.removeAllListeners(sig); process.kill(process.pid, sig); return; }
    process.exit(code ?? 1);
  });
}

function loadConfig() {
  const here = path.dirname(fs.realpathSync(__filename));
  return JSON.parse(fs.readFileSync(path.join(here, "..", "config.json"), "utf8"));
}

function replay(cfg, p, canary) {
  return new Promise((resolve) => {
    const args = [...p.envArgs, cfg.sandboxExec, "-p", p.profile, p.shell, "-c", cfg.probe.script, "selfprobe", String(canary.port), canary.socketPath ?? ""];
    const child = cp.spawn(cfg.envBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, cfg.timeoutMs);
    child.stdout.on("data", (d) => { if (out.length < 1 << 20) out += d; });
    child.stderr.on("data", () => {});
    child.on("error", (e) => { clearTimeout(t); resolve({ out, code: null, error: e.code || "error", timedOut }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ out, code, timedOut }); });
  });
}

async function capture(cfg, logDir, p) {
  const state = { hash: profileHash(p.profile), ts: Date.now(), violations: [], tokens: {}, failures: [], inconclusive: [], canaryHits: 0, expect: cfg.probe.expect, controls: cfg.probe.controls || {} };
  const v = validateProfile(p.profile, cfg.validate);
  state.violations = v.violations;
  state.ports = v.ports;
  if (!v.ok) { state.ok = false; state.stage = "static"; return state; }
  const canary = await startCanaryListener({ socketPath: path.join(logDir, "canary.sock") });
  let r;
  try { r = await replay(cfg, p, canary); } finally { await sleep(100); state.canaryHits = canary.hits(); await canary.close(); }
  state.tokens = parseTokens(r.out);
  state.replayCode = r.code;
  state.stage = "replay";
  if (r.timedOut || r.error) { state.ok = false; state.failures.push(`replay ${r.timedOut ? "timed out" : `failed to start: ${r.error}`}`); return state; }
  const ev = evaluateTokens(state.tokens, state.expect, state.controls, { canaryHits: state.canaryHits });
  state.failures = ev.failures;
  state.inconclusive = ev.inconclusive;
  state.ok = ev.failures.length === 0 && ev.inconclusive.length === 0;
  return state;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function ensureState(cfg, logDir, p) {
  const stateFile = path.join(logDir, "state.json");
  let won = false;
  try { fs.mkdirSync(path.join(logDir, "capture.lock")); won = true; } catch (e) { if (e.code !== "EEXIST") throw e; }
  if (won) {
    let s;
    try { s = await capture(cfg, logDir, p); } catch (e) {
      s = { ok: false, stage: "error", hash: profileHash(p.profile), violations: [], tokens: {}, failures: [`capture_error: ${e.message}`], inconclusive: [], canaryHits: 0, expect: cfg.probe.expect, controls: cfg.probe.controls || {} };
    }
    writeAtomic(stateFile, JSON.stringify(s));
    return s;
  }
  const deadline = Date.now() + cfg.timeoutMs + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    await sleep(50);
  }
  return refuse("capture_timeout: another call never finished capturing the profile");
}

async function main(argv) {
  const cfg = loadConfig();
  const p = parseWrapper(argv, cfg.sandboxExec);
  const run = () => relay(cp.spawn(cfg.envBin, argv, { stdio: "inherit" }));
  if (!p) return run();

  const logDir = path.join(path.dirname(fs.realpathSync(__filename)), "..", "log");
  let fd;
  try { fd = fs.openSync(path.join(logDir, "calls.jsonl"), "a"); } catch (e) {
    // The log is write-denied inside the sandbox, so this is the child's own use of `env`.
    if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS") return run();
    throw e;
  }
  const log = (ev) => fs.writeSync(fd, `${JSON.stringify({ ts: Date.now(), ...ev })}\n`);
  if (p.shapeError) { log({ ev: "call", ok: false, reason: "unexpected_shape" }); return refuse("unexpected_shape: the sandbox wrapper no longer has the -p <profile> <shell> -c <cmd> form"); }

  const state = await ensureState(cfg, logDir, p);
  const hash = profileHash(p.profile);
  if (!state.ok) {
    log({ ev: "call", ok: false, reason: "capture_failed", hash });
    return refuse(`the captured sandbox profile or its replayed probe failed: ${[...state.violations, ...state.failures, ...state.inconclusive].slice(0, 6).join("; ")}`);
  }
  if (hash !== state.hash) {
    log({ ev: "call", ok: false, reason: "profile_changed", hash });
    return refuse("profile_changed: this command's sandbox profile differs from the one that was probed");
  }
  log({ ev: "call", ok: true, hash });
  return run();
}

module.exports = { parseSbpl, validateProfile, normaliseProfile, profileHash, parseTokens, evaluateTokens, startCanaryListener, parseWrapper, REFUSED, REFUSE_EXIT, BUILTIN_WRITE, KNOWN_MACH };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${REFUSED}: shim error: ${e && e.stack ? e.stack : e}\n`); process.exit(REFUSE_EXIT); });
}
