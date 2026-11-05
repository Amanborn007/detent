// hostbox.mjs — drive's own sandbox for the commands it runs itself against untrusted clone content
// (verify, bundle export, the promoted setup command). macOS uses the deny-default Seatbelt profile,
// Linux uses bubblewrap with no network. It never falls back to an unboxed run.
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { hardEnv } from "./gitsafe.mjs";
import { detectToolchainRoots, implementPathEntries } from "./implement-profile.mjs";
import { buildSeatbeltProfile } from "./seatbelt.mjs";

export class HostboxError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "HostboxError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const bad = (msg) => new HostboxError("hostbox_bad_argument", msg);
const within = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
const SECRET = /TOKEN|SECRET|KEY|PASS|CRED|AUTH|COOKIE|SESSION|^OTEL_/i;
const GIT_IDENTITY = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/;
const EXTRA_ALLOWED = /^(LANG|LC_[A-Z_]+|CI|NODE_ENV)$/;
const OUTPUT_CAP = 1024 * 1024;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const ETC_FILES = [
  "/etc/ssl", "/etc/ca-certificates", "/etc/alternatives", "/etc/ld.so.cache", "/etc/ld.so.conf",
  "/etc/ld.so.conf.d", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime",
];
const ROOT_DIRS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64"];

function absolutes(list, what) {
  for (const p of list) {
    if (typeof p !== "string" || !isAbsolute(p) || posix.normalize(p) !== p) throw bad(`${what} must be normalized absolute paths: ${String(p)}`);
  }
}

// net is "none", or on macOS {port} for the one loopback endpoint (the egress proxy).
function checkNet(net) {
  if (net === "none") return;
  if (net && typeof net === "object" && Number.isInteger(net.port) && net.port >= 1 && net.port <= 65535) return;
  if (net && typeof net === "object" && typeof net.socket === "string") return;
  throw bad(`net must be "none" or {port}: ${JSON.stringify(net)}`);
}

export function bwrapArgv({ roBinds = [], rwBinds = [], net = "none", cwd, cmd, args = [] }) {
  if (net !== "none") {
    if (net && typeof net === "object") throw new HostboxError("setup_egress_unsupported", "the Linux host box has no network; setup egress is not available yet");
    throw bad(`net must be "none": ${JSON.stringify(net)}`);
  }
  absolutes(roBinds, "roBinds");
  absolutes(rwBinds, "rwBinds");
  absolutes([cwd, cmd], "cwd and cmd");
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw bad("args must be an array of strings");
  return [
    "--unshare-all", "--die-with-parent", "--new-session",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    ...ROOT_DIRS.flatMap((p) => ["--ro-bind-try", p, p]),
    ...ETC_FILES.flatMap((p) => ["--ro-bind-try", p, p]),
    ...rwBinds.flatMap((p) => ["--bind", p, p]),
    ...roBinds.flatMap((p) => ["--ro-bind", p, p]),
    "--chdir", cwd,
    "--", cmd, ...args,
  ];
}

export function detectNested({ platform = process.platform, spawn = spawnSync } = {}) {
  if (platform === "linux") {
    return { nested: false, detail: "no separate nested signal on linux; a bwrap probe failure refuses through preflight" };
  }
  if (platform !== "darwin") throw new HostboxError("hostbox_unsupported_platform", `platform ${platform} is not supported`);
  const r = spawn(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 10_000 });
  if (r.error) throw new HostboxError("sandbox_probe_failed", `could not run sandbox-exec: ${r.error.message}`);
  if (r.status === 0) return { nested: false, detail: "sandbox-exec applied a profile" };
  const stderr = String(r.stderr ?? "").trim();
  if (/sandbox_apply/.test(stderr)) return { nested: true, detail: `sandbox-exec could not apply a profile: ${stderr}` };
  throw new HostboxError("sandbox_probe_failed", `sandbox-exec probe exited ${r.status}: ${stderr}`);
}

function xcodeDeveloperDir(parentEnv, developerDir) {
  const d = developerDir ?? parentEnv.DEVELOPER_DIR ?? (() => {
    const r = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 10_000 });
    return r.status === 0 ? r.stdout.trim() : null;
  })();
  if (typeof d !== "string" || !isAbsolute(d)) throw new HostboxError("hostbox_developer_dir", "could not determine DEVELOPER_DIR; install the Xcode command line tools");
  return d;
}

export function buildHostboxEnv({ platform, box, path, parentEnv = process.env, extra = {}, net = "none", developerDir }) {
  const entries = implementPathEntries(path ?? parentEnv.PATH);
  if (!entries.length) throw new HostboxError("hostbox_path_empty", "PATH has no absolute entries");
  for (const e of entries) {
    if (within(e, box)) throw new HostboxError("hostbox_path_in_box", `PATH entry ${e} is inside the box, which the child can write`);
  }
  const identity = {};
  const plain = {};
  for (const [k, v] of Object.entries(extra)) {
    if (GIT_IDENTITY.test(k)) identity[k] = v;
    else if (SECRET.test(k)) throw new HostboxError("hostbox_env_secret", `env ${k} looks like a secret and is never passed into the box`);
    else if (EXTRA_ALLOWED.test(k)) plain[k] = String(v);
    else throw new HostboxError("hostbox_env_forbidden", `env ${k} is not allowed for this command`);
  }
  const env = {
    ...hardEnv(identity),
    PATH: entries.join(":"),
    HOME: join(box, "home"),
    TMPDIR: join(box, "tmp"),
    TERM: "dumb",
    SHELL: "/bin/sh",
  };
  if (parentEnv.LANG) env.LANG = parentEnv.LANG;
  for (const [k, v] of Object.entries(parentEnv)) if (/^LC_[A-Z_]+$/.test(k) && k !== "LC_ALL" && v) env[k] = v;
  Object.assign(env, plain);
  if (platform === "darwin") env.DEVELOPER_DIR = xcodeDeveloperDir(parentEnv, developerDir);
  if (net !== "none" && net.port) {
    const proxy = `http://127.0.0.1:${net.port}`;
    Object.assign(env, { HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: "", npm_config_cache: join(box, "cache"), npm_config_userconfig: "/dev/null" });
  }
  return env;
}

function findOnPath(name) {
  for (const d of implementPathEntries(process.env.PATH)) {
    const f = join(d, name);
    try {
      accessSync(f, constants.X_OK);
      return f;
    } catch {
      continue;
    }
  }
  return null;
}

// Keeps the first and last half of the cap and a sha256 of everything, and keeps draining.
function capture() {
  const half = OUTPUT_CAP / 2;
  const hash = createHash("sha256");
  let buf = Buffer.alloc(0);
  let head = null;
  let tail = null;
  let total = 0;
  return {
    push(chunk) {
      hash.update(chunk);
      total += chunk.length;
      if (tail === null) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length <= OUTPUT_CAP) return;
        head = buf.subarray(0, half);
        tail = buf.subarray(half);
        buf = null;
      } else {
        tail = Buffer.concat([tail, chunk]);
      }
      if (tail.length > half) tail = tail.subarray(tail.length - half);
    },
    done() {
      const truncated = tail !== null;
      const text = truncated
        ? `${head.toString("utf8")}\n[hostbox: ${total - head.length - tail.length} bytes omitted]\n${tail.toString("utf8")}`
        : buf.toString("utf8");
      return { text, truncated, bytes: total, sha256: hash.digest("hex") };
    },
  };
}

export async function runInHostbox({
  platform = process.platform, box, cmd, args = [], cwd, env: extra = {}, path, readOnly = [], writable = [],
  net = "none", timeoutMs, home = homedir(), toolchainRoots, developerDir, parentEnv = process.env,
  spawn = nodeSpawn, which = findOnPath, kill = process.kill.bind(process),
}) {
  if (platform !== "darwin" && platform !== "linux") throw new HostboxError("hostbox_unsupported_platform", `platform ${platform} is not supported`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw bad("timeoutMs must be a positive integer");
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw bad("args must be an array of strings");
  absolutes([box, cmd, cwd], "box, cmd and cwd");
  absolutes(readOnly, "readOnly");
  checkNet(net);
  if (platform === "linux" && net !== "none") throw new HostboxError("setup_egress_unsupported", "the Linux host box has no network; setup egress is not available yet");
  if (platform === "darwin" && net !== "none" && !net.port) throw bad("net on macOS must be \"none\" or {port}");
  let real;
  try {
    real = realpathSync(box);
  } catch (e) {
    throw new HostboxError("hostbox_box_missing", `box dir ${box} does not exist: ${e.message}`);
  }
  if (real !== box) throw bad(`box must be a real path: ${box} resolves to ${real}`);
  for (const w of writable) {
    if (typeof w !== "string" || !within(w, box)) throw new HostboxError("hostbox_writable_outside_box", `writable ${String(w)} is outside the box ${box}`);
  }
  const childEnv = buildHostboxEnv({ platform, box, path, parentEnv, extra, net, developerDir });
  const roots = toolchainRoots ?? detectToolchainRoots(home, { path: implementPathEntries(path ?? parentEnv.PATH) });

  let bin;
  let argv;
  if (platform === "linux") {
    bin = which("bwrap");
    if (!bin) throw new HostboxError("bwrap_missing", "bubblewrap (bwrap) is not on PATH; refusing to run unboxed");
    argv = bwrapArgv({ roBinds: [...readOnly, ...roots], rwBinds: [box], net, cwd, cmd, args });
  } else {
    bin = SANDBOX_EXEC;
    const profile = buildSeatbeltProfile({
      scratch: box, home, readOnly, writable, toolchainRoots: roots, loopbackPort: net === "none" ? null : net.port,
    });
    argv = ["-p", profile, cmd, ...args];
  }
  for (const d of ["home", "tmp", "cache"]) mkdirSync(join(box, d), { recursive: true, mode: 0o700 });

  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, argv, { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = capture();
    const err = capture();
    let timedOut = false;
    let settled = false;
    let killError = null;
    let termTimer = null;
    let exitTimer = null;
    // --new-session defeats kill(-pid) on Linux, and its pid namespace dies with bwrap.
    const killBox = (sig) => {
      try {
        kill(platform === "linux" ? child.pid : -child.pid, sig);
      } catch (e) {
        if (e.code !== "ESRCH") killError = e;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (platform === "linux") killBox("SIGKILL");
      else {
        killBox("SIGTERM");
        termTimer = setTimeout(() => killBox("SIGKILL"), 2000);
      }
    }, timeoutMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(termTimer);
      clearTimeout(exitTimer);
      const o = out.done();
      const e = err.done();
      if (killError) return rejectP(new HostboxError("hostbox_kill_failed", `could not kill the boxed process: ${killError.message}`));
      if (platform === "darwin" && code === 71 && /sandbox_apply/.test(e.text)) {
        return rejectP(new HostboxError("sandbox_unavailable:nested", `sandbox-exec could not apply the profile: ${e.text.trim()}`));
      }
      resolveP({
        code, signal, stdout: o.text, stderr: e.text, timedOut,
        truncated: { stdout: o.truncated, stderr: e.truncated },
        bytes: { stdout: o.bytes, stderr: e.bytes },
        sha256: { stdout: o.sha256, stderr: e.sha256 },
      });
    };
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(termTimer);
      rejectP(new HostboxError("hostbox_spawn_failed", `could not start ${bin}: ${e.message}`));
    });
    // Descendants can hold the pipes open, so the group dies the moment the child itself exits.
    child.on("exit", (code, signal) => {
      if (platform === "darwin") killBox("SIGKILL");
      exitTimer = setTimeout(() => finish(code, signal), 1000);
      exitTimer.unref();
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
