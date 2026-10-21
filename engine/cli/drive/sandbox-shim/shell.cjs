// Claude Code takes the Bash shell from CLAUDE_CODE_SHELL and runs `<shell> -c <cmd>` inside sandbox-exec.
// This shim is that shell, so it runs inside the real sandbox: it probes, logs the call, then runs the real shell.
// Settings come only from ../config.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
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
  try { fs.closeSync(fs.openSync(sh.sentinel, "a")); return false; } catch (e) {
    // Only the sandbox denies this write, so a refusal means we are inside it.
    if (DENIED.has(e.code)) return true;
    throw e;
  }
}

function main() {
  if (!sandboxed()) return runReal();
  let fd;
  try { fd = fs.openSync(sh.callLog, "a"); } catch (e) {
    if (DENIED.has(e.code)) return refuse(`cannot append to the call log ${sh.callLog}: add it to the sandbox allowWrite list`);
    throw e;
  }
  const r = cp.spawnSync(sh.realShell, ["-c", cfg.probe.script, "selfprobe", String(sh.canaryPort), sh.canarySocket], { encoding: "utf8", timeout: cfg.timeoutMs, maxBuffer: 1 << 20 });
  const tokens = lib.parseTokens(r.stdout || "");
  const names = lib.parseNames(r.stdout || "");
  const findings = lib.findingsFrom(tokens, names);
  const ev = lib.evaluateTokens(tokens, cfg.probe.expect, cfg.probe.controls || {}, { names });
  const failures = [...ev.failures];
  if (r.error) failures.push(`probe did not run: ${r.error.code || r.error.message}`);
  const ok = failures.length === 0 && ev.inconclusive.length === 0;
  fs.writeSync(fd, `${JSON.stringify({ ev: "call", mode: "shell", ts: Date.now(), ok, tokens, names, findings, failures, inconclusive: ev.inconclusive })}\n`);
  if (!ok) return refuse(`the sandbox probe failed inside the sandbox: ${[...failures, ...ev.inconclusive].slice(0, 6).join("; ")}`);
  return runReal();
}

try { main(); } catch (e) { refuse(`shim error: ${e && e.stack ? e.stack : e}`); }
