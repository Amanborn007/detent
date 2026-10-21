// Refusal checks run before `detent drive --implement` touches an untrusted clone.
// Values of env vars and managed settings are never copied into a refusal.
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { SECRET_NAME } from "./profile.mjs";

export const FLOORS = { claude: "2.1.306", git: "2.45.1", node: "20.0.0" };
const MIN_SECRET_LEN = 8;

const SECRET = new RegExp(`${SECRET_NAME.source}|(^|_)(PAT|DSN)(_|$)|WEBHOOK`, "i");
const SECRET_EXEMPT = /^(SSH_AUTH_SOCK|GIT_ASKPASS|SSH_ASKPASS|KEYBOARD|SECURITYSESSIONID|TERM_SESSION_ID|ITERM_SESSION_ID|DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_\w+)$/i;
const URL_USERINFO = /:\/\/[^/\s@]+:[^@\s]+@/;

const SAFE_MANAGED_KEYS = new Set([
  "$schema", "model", "availableModels", "permissions", "promptSuggestionEnabled", "cleanupPeriodDays",
  "includeCoAuthoredBy", "attribution", "language", "outputStyle", "forceLoginMethod", "forceLoginOrgUUID",
  "companyAnnouncements", "feedbackSurveyRate", "spinnerTipsEnabled", "verbose", "theme",
  "allowManagedHooksOnly", "allowManagedPermissionRulesOnly", "allowManagedMcpServersOnly",
]);
const SAFE_PERMISSION_KEYS = new Set(["deny", "ask", "disableBypassPermissionsMode"]);

const MANAGED = {
  darwin: { file: "/Library/Application Support/ClaudeCode/managed-settings.json", dir: "/Library/Application Support/ClaudeCode/managed-settings.d", mcp: "/Library/Application Support/ClaudeCode/managed-mcp.json" },
  linux: { file: "/etc/claude-code/managed-settings.json", dir: "/etc/claude-code/managed-settings.d", mcp: "/etc/claude-code/managed-mcp.json" },
};

// Anchored to what each tool prints; any suffix after the patch number counts as a pre-release.
const VERSION_FORMS = {
  claude: /^v?(\d+)\.(\d+)\.(\d+)((?:-[0-9A-Za-z.-]+)?)(?: \(Claude Code\))?$/,
  git: /^(?:git version )?(\d+)\.(\d+)\.(\d+)((?:[-.][0-9A-Za-z]+)*)(?: \([^)]*\))?$/,
  node: /^v?(\d+)\.(\d+)\.(\d+)((?:-[0-9A-Za-z.-]+)?)$/,
};

function parseVersion(tool, s) {
  const m = VERSION_FORMS[tool].exec(String(s ?? "").trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== "" } : null;
}
function atLeast(have, floor) {
  for (let i = 0; i < 3; i++) if (have.nums[i] !== floor[i]) return have.nums[i] > floor[i];
  return !have.pre;
}

const readError = (e) => `unreadable (${e.code ?? "error"})`;

export function readManagedSettings({ platform = process.platform, readFile = (p) => readFileSync(p, "utf8"), readdir = (p) => readdirSync(p) } = {}) {
  const loc = MANAGED[platform];
  if (!loc) return [];
  const out = [];
  const load = (path) => {
    let text;
    try {
      text = readFile(path);
    } catch (e) {
      if (e.code !== "ENOENT") out.push({ path, error: readError(e) });
      return;
    }
    try {
      out.push({ path, json: JSON.parse(text) });
    } catch {
      out.push({ path, error: "not valid JSON" });
    }
  };
  load(loc.file);
  let names = [];
  try {
    names = readdir(loc.dir);
  } catch (e) {
    if (e.code !== "ENOENT") out.push({ path: loc.dir, error: readError(e) });
  }
  for (const n of names.filter((x) => x.endsWith(".json")).sort()) load(`${loc.dir}/${n}`);
  return out;
}

const defaultRun = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, timeout: 10_000 });
  return r.status === 0 ? r.stdout : null;
};

// Everything that can feed Claude Code managed settings: files, managed-mcp.json, the
// server-managed cache under ~/.claude, and the macOS MDM preference domain.
export function readAllManagedSettings({
  platform = process.platform,
  home = homedir(),
  readFile = (p) => readFileSync(p, "utf8"),
  readdir = (p) => readdirSync(p),
  exists = existsSync,
  run = defaultRun,
} = {}) {
  const loc = MANAGED[platform];
  if (!loc) return [];
  const out = [];
  if (exists(loc.mcp)) out.push({ path: loc.mcp, kind: "mcp" });
  out.push(...readManagedSettings({ platform, readFile, readdir }));

  const remote = join(home, ".claude", "remote-settings.json");
  try {
    out.push({ path: remote, json: JSON.parse(readFile(remote)) });
  } catch (e) {
    if (e instanceof SyntaxError) out.push({ path: remote, error: "not valid JSON" });
    else if (e.code !== "ENOENT") out.push({ path: remote, error: readError(e) });
  }

  if (platform === "darwin") {
    const dom = "com.anthropic.claudecode";
    const plist = run("defaults", ["export", dom, "-"]);
    if (plist) {
      const json = run("plutil", ["-convert", "json", "-o", "-", "-"], plist);
      try {
        const parsed = JSON.parse(json ?? "");
        const empty = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
        if (!empty) out.push({ path: `MDM:${dom}`, json: parsed });
      } catch {
        out.push({ path: `MDM:${dom}`, error: "could not be converted to JSON" });
      }
    }
  }
  return out;
}

export function detectVersions({
  run = (cmd) => { const r = spawnSync(cmd, ["--version"], { encoding: "utf8" }); return r.status === 0 ? r.stdout : null; },
  nodeVersion = process.version,
} = {}) {
  return { claude: run("claude")?.trim() ?? null, git: run("git")?.trim() ?? null, node: nodeVersion };
}

export function findOnPath(name, { pathEnv = process.env.PATH ?? "" } = {}) {
  if (!name || name.includes("/")) return null;
  for (const d of pathEnv.split(delimiter)) {
    if (!d) continue;
    const p = join(d, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

const defaultSpawn = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000 });

function managedRefusals(m, refuse) {
  if (m.error) return refuse("managed_unreadable", `managed settings at ${m.path} could not be read: ${m.error}`, "Fix the file permissions or contents, or run on a machine without that managed source.");
  if (m.kind === "mcp") return refuse("managed_mcp", `${m.path} exists`, "Run --implement on a machine without managed MCP servers; they start outside the sandbox.");
  const j = m.json;
  if (!j || typeof j !== "object" || Array.isArray(j)) return refuse("managed_unreadable", `managed settings at ${m.path} are not a JSON object`, "Fix the file contents, or run on a machine without that managed source.");
  const names = (v) => (v && typeof v === "object" ? Object.keys(v).sort() : []);
  if (j.sandbox !== undefined) refuse("managed_sandbox", `managed settings at ${m.path} set a sandbox key`, "Remove the sandbox key from managed settings, or ask the admin who owns it; drive cannot merge its own sandbox with it.");
  if (names(j.env).length) refuse("managed_env", `managed settings at ${m.path} inject env: ${names(j.env).join(", ")}`, "Run --implement on a machine without managed env (it can ship tool content to a collector or run BASH_ENV outside the sandbox).");
  if (names(j.hooks).length) refuse("managed_hooks", `managed settings at ${m.path} define hooks: ${names(j.hooks).join(", ")}`, "Run --implement on a machine without managed hooks; they execute outside the sandbox.");
  const extra = Object.keys(j).filter((k) => !SAFE_MANAGED_KEYS.has(k) && !["sandbox", "env", "hooks"].includes(k));
  for (const k of names(j.permissions)) if (!SAFE_PERMISSION_KEYS.has(k)) extra.push(`permissions.${k}`);
  if (extra.length) refuse("managed_setting_key", `managed settings at ${m.path} set keys drive does not allow: ${extra.sort().join(", ")}`, "Run --implement on a machine whose managed settings only use allowlisted keys.");
}

export function implementPreflight({
  env = process.env,
  platform = process.platform,
  managedSettings = readAllManagedSettings({ platform }),
  versions = detectVersions(),
  which = findOnPath,
  nested,
  userns,
  exists = existsSync,
  spawn = defaultSpawn,
} = {}) {
  const refusals = [];
  const refuse = (code, detail, next_step) => refusals.push({ code, detail, next_step });

  const secrets = Object.keys(env).filter((k) => {
    const v = String(env[k] ?? "");
    if (SECRET_EXEMPT.test(k)) return false;
    return (SECRET.test(k) && v.length >= MIN_SECRET_LEN) || URL_USERINFO.test(v);
  });
  if (secrets.length) {
    refuse("env_secret", `drive's own environment holds secret-looking variables: ${secrets.sort().join(", ")}`,
      `Unset them for this run, for example env -u ${secrets[0]} detent drive ..., or start from a clean shell.`);
  }

  for (const m of managedSettings) managedRefusals(m, refuse);

  const probe = (cmd, args) => {
    const r = spawn(cmd, args);
    if (r?.error) return "error";
    return r?.status === 0 ? "ok" : "fail";
  };
  const probeFailed = (what) => refuse("sandbox_probe_failed", `could not run the ${what} probe`, "Check that the tool is executable and not blocked by the environment, then retry.");

  let nestedResult = false;
  if (platform === "linux") {
    const bwrap = which("bwrap");
    if (!bwrap) refuse("bwrap_missing", "bubblewrap (bwrap) is not on PATH", "Install bubblewrap, for example apt install bubblewrap.");
    if (!which("socat")) refuse("socat_missing", "socat is not on PATH", "Install socat, for example apt install socat.");
    const userNsFix = "Enable unprivileged user namespaces, for example sysctl kernel.unprivileged_userns_clone=1, or run on a host that allows them.";
    if (userns) {
      if (!userns()) refuse("userns_disabled", "unprivileged user namespaces are disabled", userNsFix);
    } else if (bwrap) {
      const r = probe(bwrap, ["--ro-bind", "/", "/", "--unshare-user", "true"]);
      if (r === "error") probeFailed("bwrap");
      else if (r === "fail") refuse("userns_disabled", "bwrap could not create a user namespace", userNsFix);
    }
  } else if (platform === "darwin") {
    if (!exists("/usr/bin/sandbox-exec")) refuse("sandbox_exec_missing", "/usr/bin/sandbox-exec is missing", "Run on a macOS install that ships /usr/bin/sandbox-exec.");
    else if (!nested) {
      const r = probe("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
      if (r === "error") probeFailed("sandbox-exec");
      else nestedResult = r === "fail";
    }
  } else {
    refuse("unsupported_platform", `platform ${platform} is not supported`, "Run --implement on macOS or Linux.");
  }

  for (const [tool, floor] of Object.entries(FLOORS)) {
    const have = parseVersion(tool, versions?.[tool]);
    if (!have) {
      refuse("version_unknown", `could not read the ${tool} version`, `Make sure ${tool} is installed and prints a version with --version.`);
    } else if (!atLeast(have, floor.split(".").map(Number))) {
      refuse(`${tool}_version`, `${tool} ${have.nums.join(".")}${have.pre ? " (pre-release)" : ""} is below the floor ${floor}`, `Upgrade ${tool} to ${floor} or newer.`);
    }
  }

  const n = nested ? nested() : nestedResult;
  if (n === true || n?.nested) {
    refuse("sandbox_unavailable:nested", n?.detail ?? "drive is running inside another sandbox", "Run drive from an unsandboxed shell; a sandbox cannot be started inside another one.");
  }

  return { ok: refusals.length === 0, refusals };
}
