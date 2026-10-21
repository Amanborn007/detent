// Refusal checks run before `detent drive --implement` touches an untrusted clone.
// Values of env vars and managed settings are never copied into a refusal.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

export const FLOORS = { claude: "2.1.306", git: "2.45.1", node: "20.0.0" };
const MIN_SECRET_LEN = 8;

const SECRET_NAME = /(_TOKEN|_SECRET|_KEY)$|PASSWORD|^AWS_|^(GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|NPM_TOKEN)$/;

const MANAGED = {
  darwin: { file: "/Library/Application Support/ClaudeCode/managed-settings.json", dir: "/Library/Application Support/ClaudeCode/managed-settings.d" },
  linux: { file: "/etc/claude-code/managed-settings.json", dir: "/etc/claude-code/managed-settings.d" },
};

function parseVersion(s) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(s ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
function atLeast(have, floor) {
  for (let i = 0; i < 3; i++) if (have[i] !== floor[i]) return have[i] > floor[i];
  return true;
}

export function readManagedSettings({ platform = process.platform, readFile = (p) => readFileSync(p, "utf8"), readdir = (p) => readdirSync(p) } = {}) {
  const loc = MANAGED[platform];
  if (!loc) return [];
  const out = [];
  const load = (path) => {
    let text;
    try {
      text = readFile(path);
    } catch (e) {
      if (e.code === "ENOENT") return;
      out.push({ path, error: `unreadable (${e.code ?? "error"})` });
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
    if (e.code !== "ENOENT") out.push({ path: loc.dir, error: `unreadable (${e.code ?? "error"})` });
  }
  for (const n of names.filter((x) => x.endsWith(".json")).sort()) load(`${loc.dir}/${n}`);
  return out;
}

export function detectVersions({
  run = (cmd) => { const r = spawnSync(cmd, ["--version"], { encoding: "utf8" }); return r.status === 0 ? r.stdout : null; },
  nodeVersion = process.version,
} = {}) {
  return { claude: run("claude")?.trim() ?? null, git: run("git")?.trim() ?? null, node: nodeVersion };
}

const defaultWhich = (name) => {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (d && existsSync(join(d, name))) return join(d, name);
  }
  return null;
};

function defaultUserns() {
  const read = (p) => { try { return readFileSync(p, "utf8").trim(); } catch { return null; } };
  return read("/proc/sys/kernel/unprivileged_userns_clone") !== "0" &&
    read("/proc/sys/user/max_user_namespaces") !== "0" &&
    read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") !== "1";
}

export function implementPreflight({
  env = process.env,
  platform = process.platform,
  managedSettings = readManagedSettings({ platform }),
  versions = detectVersions(),
  which = defaultWhich,
  nested = () => false,
  userns = defaultUserns,
  exists = existsSync,
} = {}) {
  const refusals = [];
  const refuse = (code, detail, next_step) => refusals.push({ code, detail, next_step });

  const secrets = Object.keys(env).filter((k) => SECRET_NAME.test(k.toUpperCase()) && String(env[k] ?? "").length >= MIN_SECRET_LEN);
  if (secrets.length) {
    refuse("env_secret", `drive's own environment holds secret-looking variables: ${secrets.sort().join(", ")}`,
      `Unset them for this run, for example env -u ${secrets[0]} detent drive ..., or start from a clean shell.`);
  }

  for (const m of managedSettings) {
    if (m.error) {
      refuse("managed_unreadable", `managed settings at ${m.path} could not be read: ${m.error}`, "Fix the file permissions or contents, or run on a machine without that managed file.");
      continue;
    }
    const j = m.json ?? {};
    if (j.sandbox !== undefined) {
      refuse("managed_sandbox", `managed settings at ${m.path} set a sandbox key`, "Remove the sandbox key from managed settings, or ask the admin who owns it; drive cannot merge its own sandbox with it.");
    }
    const envKeys = j.env && typeof j.env === "object" ? Object.keys(j.env) : [];
    if (envKeys.length) {
      refuse("managed_env", `managed settings at ${m.path} inject env: ${envKeys.sort().join(", ")}`, "Run --implement on a machine without managed env (it can ship tool content to a collector or run BASH_ENV outside the sandbox).");
    }
    const hookKeys = j.hooks && typeof j.hooks === "object" ? Object.keys(j.hooks) : [];
    if (hookKeys.length) {
      refuse("managed_hooks", `managed settings at ${m.path} define hooks: ${hookKeys.sort().join(", ")}`, "Run --implement on a machine without managed hooks; they execute outside the sandbox.");
    }
  }

  if (platform === "linux") {
    if (!which("bwrap")) refuse("bwrap_missing", "bubblewrap (bwrap) is not on PATH", "Install bubblewrap, for example apt install bubblewrap.");
    if (!which("socat")) refuse("socat_missing", "socat is not on PATH", "Install socat, for example apt install socat.");
    if (!userns()) refuse("userns_disabled", "unprivileged user namespaces are disabled", "Enable them, for example sysctl kernel.unprivileged_userns_clone=1, or run on a host that allows them.");
  } else if (platform === "darwin") {
    if (!exists("/usr/bin/sandbox-exec")) refuse("sandbox_exec_missing", "/usr/bin/sandbox-exec is missing", "Run on a macOS install that ships /usr/bin/sandbox-exec.");
  } else {
    refuse("unsupported_platform", `platform ${platform} is not supported`, "Run --implement on macOS or Linux.");
  }

  for (const [tool, floor] of Object.entries(FLOORS)) {
    const have = parseVersion(versions?.[tool]);
    if (!have) {
      refuse("version_unknown", `could not read the ${tool} version`, `Make sure ${tool} is installed and prints a version with --version.`);
    } else if (!atLeast(have, parseVersion(floor))) {
      refuse(`${tool}_version`, `${tool} ${have.join(".")} is below the floor ${floor}`, `Upgrade ${tool} to ${floor} or newer.`);
    }
  }

  const n = nested();
  if (n === true || n?.nested) {
    refuse("sandbox_unavailable:nested", n?.detail ?? "drive is running inside another sandbox", "Run drive from an unsandboxed shell; a sandbox cannot be started inside another one.");
  }

  return { ok: refusals.length === 0, refusals };
}
