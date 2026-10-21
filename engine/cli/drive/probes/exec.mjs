// Async process runner plus the tiny helpers the probes share. Output is
// captured for classification only; callers never print it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const CAP = 256 * 1024;

export function run(cmd, args, { env, cwd, timeout = 20000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (d) => { if (stdout.length < CAP) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < CAP) stderr += d; });
    child.on("error", (e) => { clearTimeout(t); resolve({ pid: child.pid, code: null, signal: null, stdout, stderr, error: e.code || "error", timedOut }); });
    child.on("close", (code, signal) => { clearTimeout(t); resolve({ pid: child.pid, code, signal, stdout, stderr, timedOut }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export function which(name, pathVar = process.env.PATH || "") {
  for (const d of pathVar.split(delimiter)) {
    const p = join(d, name);
    if (d && existsSync(p)) return p;
  }
  return null;
}

// sandbox-exec exits 71 when it is already inside a Seatbelt sandbox.
export function classifyPreflight({ platform, error, status }) {
  if (platform !== "darwin") return { ok: false, code: "unsupported_platform", message: `these probes need macOS Seatbelt; platform is ${platform}` };
  if (error === "ENOENT") return { ok: false, code: "missing_binary", message: "sandbox-exec was not found on PATH" };
  if (status === 71) {
    return { ok: false, code: "nested", message: "sandbox-exec failed with exit 71: this shell is already inside a Seatbelt sandbox. Run the probes from an unsandboxed terminal." };
  }
  if (status !== 0) return { ok: false, code: "preflight_failed", message: `sandbox-exec self-test exited ${status}` };
  return { ok: true };
}

export async function preflight(platform = process.platform) {
  if (platform !== "darwin") return classifyPreflight({ platform });
  const r = await run("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 10000 });
  return classifyPreflight({ platform, error: r.error, status: r.code });
}
