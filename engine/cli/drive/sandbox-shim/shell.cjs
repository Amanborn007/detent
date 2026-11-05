// Claude Code takes the Bash shell from CLAUDE_CODE_SHELL and runs `<shell> -c <cmd>` inside sandbox-exec.
// This shim is that shell, so it runs inside the real sandbox: it probes, logs the call, then runs the real shell.
// Settings come only from ../config.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const lib = require("./lib.cjs");

const here = path.dirname(fs.realpathSync(__filename));
const cfg = JSON.parse(fs.readFileSync(path.join(here, "..", "config.json"), "utf8"));
const sh = cfg.shell;
const argv = process.argv.slice(2);

function refuse(reason) {
  process.stderr.write(`${lib.REFUSED}: ${reason}\n`);
  process.exit(lib.REFUSE_EXIT);
}

function runReal() {
  const child = cp.spawn(sh.realShell, argv, { stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  child.on("error", (e) => refuse(`cannot start ${sh.realShell}: ${e.code}`));
  child.on("close", (code, sig) => {
    if (sig) { process.removeAllListeners(sig); process.kill(process.pid, sig); return; }
    process.exit(code ?? 1);
  });
}

const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

function sandboxed() {
  try { fs.appendFileSync(sh.sentinel, "x"); return false; } catch (e) {
    // Only the sandbox denies this write, so a refusal means we are inside it.
    if (DENIED.has(e.code)) return true;
    throw e;
  }
}

// Measured on claude 2.1.x: before any tool call it runs `-c env` and `-c -l <snapshot script>` through the shell.
const SNAPSHOT_CREATE = 'echo "# Snapshot file" >| "$SNAPSHOT_FILE"';

function setupKind() {
  if (argv.length === 2 && argv[0] === "-c" && argv[1] === "env") return "env";
  if (argv.length === 3 && argv[0] === "-c" && argv[1] === "-l" && argv[2].startsWith("SNAPSHOT_FILE=") && argv[2].includes(SNAPSHOT_CREATE)) return "snapshot";
  return null;
}

// A setup call is accepted once per kind and only before the first tool call, so a command cannot borrow its shape.
function logSetup(kind) {
  let prior;
  let fd;
  try {
    prior = fs.readFileSync(sh.callLog, "utf8");
    fd = fs.openSync(sh.callLog, "a");
  } catch (e) { return refuse(`cannot read and append to the call log ${sh.callLog}: ${e.code || e.message}`); }
  for (const raw of prior.split("\n")) {
    if (!raw.trim()) continue;
    let o;
    try { o = JSON.parse(raw); } catch { return refuse("the call log holds an unreadable line"); }
    if (o && o.ev === "call") return refuse(`a ${kind} setup call after a tool call`);
    if (o && o.ev === "setup" && o.kind === kind) return refuse(`a second ${kind} setup call`);
  }
  fs.writeSync(fd, `${JSON.stringify({ ev: "setup", kind, ts: Date.now() })}\n`);
  fs.closeSync(fd);
}

function main() {
  const kind = setupKind();
  if (kind) { logSetup(kind); return runReal(); }
  if (!sandboxed()) return runReal();
  const ci = argv.indexOf("-c");
  if (ci < 0 || typeof argv[ci + 1] !== "string") return refuse("the shim shell only runs `-c <command>`");
  const cmd = argv[ci + 1];
  let fd;
  try { fd = fs.openSync(sh.callLog, "a"); } catch (e) {
    if (DENIED.has(e.code)) return refuse(`cannot append to the call log ${sh.callLog}: add it to the sandbox allowWrite list`);
    throw e;
  }
  // Claude exports its TMPDIR inside the command string, so the probe must see that value, not ours.
  const expect = { ...cfg.probe.expect };
  const failures = [];
  let script = cfg.probe.script;
  if (expect.claude_tmpdir_matches) {
    const t = lib.tmpdirFromCommand(cmd);
    if (t.reason) { failures.push(`${t.reason}: ${t.detail}`); delete expect.claude_tmpdir_matches; } else script = `export TMPDIR='${t.value.replaceAll("'", "'\\''")}'\n${script}`;
  }
  const r = cp.spawnSync(sh.realShell, ["-c", script, "selfprobe", String(sh.canaryPort), sh.canarySocket], { encoding: "utf8", timeout: cfg.timeoutMs, maxBuffer: 1 << 20 });
  const tokens = lib.parseTokens(r.stdout || "");
  const names = lib.parseNames(r.stdout || "");
  const details = lib.parseDetails(r.stdout || "");
  const findings = lib.findingsFrom(tokens, names);
  const ev = lib.evaluateTokens(tokens, expect, cfg.probe.controls || {}, { names, details });
  failures.push(...ev.failures);
  if (r.error) failures.push(`probe did not run: ${r.error.code || r.error.message}`);
  const ok = failures.length === 0 && ev.inconclusive.length === 0;
  fs.writeSync(fd, `${JSON.stringify({ ev: "call", mode: "shell", ts: Date.now(), ok, cmd, cmd_sha256: crypto.createHash("sha256").update(cmd).digest("hex"), tokens, names, findings, failures, inconclusive: ev.inconclusive })}\n`);
  if (!ok) return refuse(`the sandbox probe failed inside the sandbox: ${[...failures, ...ev.inconclusive].slice(0, 6).join("; ")}`);
  return runReal();
}

try { main(); } catch (e) { refuse(`shim error: ${e && e.stack ? e.stack : e}`); }
