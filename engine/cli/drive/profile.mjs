// drive/profile: what a contained drive child is allowed to be. Pure functions, zero dependencies.
"use strict";

export const MIN_CLAUDE_VERSION = "2.1.306";
export const CHILD_TOOLS = "Read,Glob,Grep,Write,Edit,TodoWrite";
export const STATIC_DENY = ["WebFetch", "WebSearch", "Task", "Agent", "Skill", "NotebookEdit"];

const ENV_ALLOW = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "SHELL", "TMPDIR"]);
const SECRET_NAME = /TOKEN|KEY|SECRET|PASS|CRED|AUTH|COOKIE|SESSION/i;
const OUTBOX_RULE = /^(Write|Edit)\(\/\/[^()]+\/\*\*\)$/;

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(text, min = MIN_CLAUDE_VERSION) {
  const v = parseVersion(text);
  const m = parseVersion(min);
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== m[i]) return v[i] > m[i];
  }
  return true;
}

function bad(label, why) {
  throw new Error(`drive profile ${label}: ${why}`);
}

// Only Write/Edit on the child's own outbox may ever be allowed, so every other allow rule is refused.
export function validateDriveProfile(settings, label) {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) bad(label, "is not a JSON object");
  const walk = (v, path) => {
    if (typeof v === "string") {
      if (/bypassPermissions|dangerously-skip-permissions/i.test(v)) bad(label, `mentions a bypass mode at ${path}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (/bypass|dangerous/i.test(k) && x) bad(label, `sets ${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(settings, "$");
  if (settings.hooks !== undefined) bad(label, "defines hooks");
  if (settings.env !== undefined) bad(label, "defines an env block; the child env is built by drive");
  if (settings.statusLine !== undefined) bad(label, "defines a statusLine command");
  const noKeys = (v, path) => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (/Helper$/.test(k) || k === "awsAuthRefresh" || k === "awsCredentialExport") bad(label, `sets ${path}.${k}, a key that runs a command`);
      if (k === "additionalDirectories") bad(label, `sets ${path}.${k}; the child's directories are fixed by drive`);
      noKeys(x, `${path}.${k}`);
    }
  };
  noKeys(settings, "$");
  if (settings.disableAllHooks !== undefined && settings.disableAllHooks !== true) bad(label, "must keep disableAllHooks true");
  if (settings.enableAllProjectMcpServers === true) bad(label, "enables project MCP servers");
  const perms = settings.permissions;
  if (perms === undefined) return;
  if (perms === null || typeof perms !== "object" || Array.isArray(perms)) bad(label, "permissions is not an object");
  if (perms.defaultMode !== undefined && perms.defaultMode !== "dontAsk") {
    bad(label, `sets permissions.defaultMode to ${JSON.stringify(perms.defaultMode)}; drive requires dontAsk`);
  }
  const allow = perms.allow === undefined ? [] : perms.allow;
  if (!Array.isArray(allow)) bad(label, "permissions.allow is not an array");
  for (const a of allow) {
    if (typeof a !== "string") bad(label, "permissions.allow has a non-string entry");
    if (/^Bash/.test(a) || /^Monitor/.test(a)) bad(label, `allows ${JSON.stringify(a)}; a drive child never gets Bash`);
    if (!OUTBOX_RULE.test(a) || a.includes("..")) {
      bad(label, `allows ${JSON.stringify(a)}; only Write/Edit on the child's own outbox may be allowed`);
    }
  }
}

const shellQuote = (p) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

const ab = (p) => `//${p.replace(/^\/+/, "")}`;

// The settings file one child gets. base comes from profiles/drive.json, or --profile.
export function buildChildSettings(base, { inputs, outbox, apiKeyFile }) {
  const { drive: _drive, $comment: _c, ...rest } = JSON.parse(JSON.stringify(base));
  const settings = {
    ...rest,
    permissions: {
      ...(rest.permissions || {}),
      defaultMode: "dontAsk",
      allow: [`Write(${ab(outbox)}/**)`, `Edit(${ab(outbox)}/**)`],
      deny: [...new Set([
        ...((rest.permissions && rest.permissions.deny) || []),
        ...STATIC_DENY,
        `Write(${ab(inputs)}/**)`, `Edit(${ab(inputs)}/**)`,
        `Write(${ab(outbox)}/.git/**)`, `Edit(${ab(outbox)}/.git/**)`,
      ])],
    },
    disableAllHooks: true,
    enableAllProjectMcpServers: false,
  };
  settings.autoMemoryEnabled = false;
  validateDriveProfile(settings, "settings");
  if (apiKeyFile) settings.apiKeyHelper = `cat ${shellQuote(apiKeyFile)}`;
  return settings;
}

export function buildChildArgs({ model, settingsFile, inputs, outbox, maxBudgetUsd, maxTurns, bare }) {
  return [
    "-p", "--restricted", "--tools", CHILD_TOOLS, "--output-format", "json", "--model", model,
    "--permission-mode", "dontAsk", "--settings", settingsFile,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--add-dir", inputs, "--add-dir", outbox,
    "--max-budget-usd", String(maxBudgetUsd), "--max-turns", String(maxTurns),
    ...(bare ? ["--bare"] : []),
  ];
}

// An allowlist and nothing else. literals are the values of the secret-looking variables it dropped.
export function buildChildEnv(parent, { tmpdir, sandboxRoot }) {
  const env = {};
  const literals = [];
  for (const [k, v] of Object.entries(parent)) {
    if (typeof v !== "string") continue;
    if (ENV_ALLOW.has(k) || k.startsWith("LC_")) env[k] = v;
    else if (SECRET_NAME.test(k) && v.length >= 8) literals.push(v);
  }
  if (!env.HOME) throw new Error("drive needs HOME: the claude child authenticates from the real home directory");
  const under = (p) => p === sandboxRoot || p.startsWith(`${sandboxRoot}/`);
  env.PATH = (parent.PATH || "").split(":").filter((p) => p.startsWith("/") && !under(p)).join(":");
  env.TMPDIR = tmpdir;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DETENT_DRIVE_CHILD = "1";
  return { env, literals };
}
