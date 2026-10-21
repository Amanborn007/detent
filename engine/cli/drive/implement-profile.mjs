// implement-profile.mjs — settings, argv and env for the `detent drive
// --implement` child. Pure functions: no spawning, no writes.
//
// Settings key names below were read from the Claude Code 2.1.306 bundle:
// sandbox.{enabled,failIfUnavailable,allowUnsandboxedCommands,
// autoAllowBashIfSandboxed,excludedCommands,enableWeakerNestedSandbox,
// enableWeakerNetworkIsolation}, sandbox.network.{allowedDomains,
// strictAllowlist}, sandbox.filesystem.{denyRead,allowRead,denyWrite,
// allowWrite}, plus top-level disableAllHooks, enableAllProjectMcpServers,
// autoMemoryEnabled.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const DATA_TWIN = "/System/Volumes/Data";
const SHARED_TMP = ["/tmp/claude", "/private/tmp/claude"];
const GIT_INDIRECTION = [
  "commondir", "config.worktree", "worktrees", "objects/info/alternates",
  "objects/info/http-alternates", "info/attributes", "config", "hooks",
];
const PERMISSION_DENY = [
  "WebFetch", "WebSearch", "Task", "Agent", "Skill", "NotebookEdit",
  "Read", "Glob", "Grep", "Write", "Edit", "MultiEdit",
];

const isDarwin = (ctx) => (ctx.platform ?? process.platform) === "darwin";

function real(p) {
  try { return realpathSync(p); } catch { return null; }
}

// Literal path first, then its realpath when that differs.
function variants(p) {
  if (!isAbsolute(p)) throw new Error(`implement profile: path must be absolute: ${p}`);
  const r = real(p);
  return r && r !== p ? [p, r] : [p];
}

function withTwins(list, ctx) {
  const out = [];
  for (const p of list) {
    out.push(p);
    if (isDarwin(ctx) && !p.startsWith(DATA_TWIN)) out.push(DATA_TWIN + p);
  }
  return [...new Set(out)];
}

const dedupe = (l) => [...new Set(l)];

export function implementPathEntries(pathString) {
  return String(pathString ?? "").split(":").filter((p) => p.startsWith("/") && p.length > 1);
}

export function detectToolchainRoots(home, opts = {}) {
  const entries = (opts.path ?? implementPathEntries(process.env.PATH)).filter(isAbsolute);
  const roots = [];
  const add = (p) => {
    if (!p.startsWith(home + "/") || !existsSync(p)) return;
    roots.push(p);
    const r = real(p);
    if (r && r !== p) roots.push(r);
  };
  for (const e of entries) {
    if (!e.startsWith(home + "/")) continue;
    const name = basename(e);
    add(e);
    if (name === "bin" || name === "sbin") add(join(dirname(e), "lib"));
  }
  // The cargo shims dispatch into the rustup toolchains, so those need reading too.
  const cargoBin = join(home, ".cargo/bin");
  const toolchains = join(home, ".rustup/toolchains");
  if (roots.includes(cargoBin) && existsSync(toolchains)) {
    for (const t of readdirSync(toolchains)) {
      add(join(toolchains, t, "bin"));
      add(join(toolchains, t, "lib"));
    }
  }
  return dedupe(roots);
}

export function implementDenyRead(ctx) {
  const base = [ctx.home, ctx.sroot, ...SHARED_TMP, ...(ctx.extraDeny ?? [])];
  return withTwins(dedupe(base.flatMap(variants)), ctx);
}

function gitDenyWrite(ctx) {
  return variants(ctx.clone).flatMap((c) => GIT_INDIRECTION.map((f) => `${c}/.git/${f}`));
}

function implementDenyWrite(ctx) {
  return withTwins(dedupe([...gitDenyWrite(ctx), ...SHARED_TMP]), ctx);
}

function implementAllowRead(ctx) {
  const dirs = [ctx.clone, ctx.inputs, ctx.outbox, ctx.tmp].filter(Boolean).flatMap(variants);
  const toolchains = detectToolchainRoots(ctx.home, { path: ctx.path ?? implementPathEntries(process.env.PATH) });
  return dedupe([...toolchains, ...dirs]);
}

export function buildImplementSettings(ctx) {
  return {
    permissions: { defaultMode: "dontAsk", allow: ["Bash"], deny: [...PERMISSION_DENY] },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: implementDenyRead(ctx),
        allowRead: implementAllowRead(ctx),
        denyWrite: implementDenyWrite(ctx),
        allowWrite: [ctx.clone, ctx.outbox, ctx.tmp],
      },
    },
    disableAllHooks: true,
    enableAllProjectMcpServers: false,
    autoMemoryEnabled: false,
  };
}

const ALLOWED = {
  top: ["permissions", "sandbox", "disableAllHooks", "enableAllProjectMcpServers", "autoMemoryEnabled"],
  permissions: ["defaultMode", "allow", "deny"],
  sandbox: [
    "enabled", "failIfUnavailable", "allowUnsandboxedCommands", "autoAllowBashIfSandboxed",
    "excludedCommands", "enableWeakerNestedSandbox", "enableWeakerNetworkIsolation", "network", "filesystem",
  ],
  network: ["allowedDomains", "strictAllowlist"],
  filesystem: ["denyRead", "allowRead", "denyWrite", "allowWrite"],
};

function checkKeys(obj, where, allowed, errs) {
  for (const k of Object.keys(obj ?? {})) {
    if (!allowed.includes(k)) errs.push(`${where}.${k} is not allowed`);
  }
}

export function validateImplementSettings(s, ctx) {
  const errs = [];
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("implement settings: not an object");
  checkKeys(s, "settings", ALLOWED.top, errs);
  const p = s.permissions ?? {};
  const sb = s.sandbox ?? {};
  const net = sb.network ?? {};
  const fs = sb.filesystem ?? {};
  checkKeys(p, "permissions", ALLOWED.permissions, errs);
  checkKeys(sb, "sandbox", ALLOWED.sandbox, errs);
  checkKeys(net, "sandbox.network", ALLOWED.network, errs);
  checkKeys(fs, "sandbox.filesystem", ALLOWED.filesystem, errs);

  if (p.defaultMode !== "dontAsk") errs.push("permissions.defaultMode must be dontAsk");
  if (JSON.stringify(p.allow) !== '["Bash"]') errs.push('permissions.allow must be exactly ["Bash"]');
  if (sb.enabled !== true) errs.push("sandbox.enabled must be true");
  if (sb.failIfUnavailable !== true) errs.push("sandbox.failIfUnavailable must be true");
  if (sb.allowUnsandboxedCommands !== false) errs.push("sandbox.allowUnsandboxedCommands must be false");
  if (!Array.isArray(sb.excludedCommands) || sb.excludedCommands.length) errs.push("sandbox.excludedCommands must be empty");
  for (const k of ["enableWeakerNestedSandbox", "enableWeakerNetworkIsolation"]) {
    if (sb[k] !== undefined && sb[k] !== false) errs.push(`sandbox.${k} must be false`);
  }
  if (!Array.isArray(net.allowedDomains) || net.allowedDomains.length) errs.push("sandbox.network.allowedDomains must be []");
  if (s.disableAllHooks !== true) errs.push("disableAllHooks must be true");

  const list = (k) => (Array.isArray(fs[k]) ? fs[k] : []);
  for (const t of SHARED_TMP) {
    if (!list("denyRead").includes(t)) errs.push(`denyRead must include ${t}`);
    if (!list("denyWrite").includes(t)) errs.push(`denyWrite must include ${t}`);
  }
  for (const f of GIT_INDIRECTION) {
    if (!list("denyWrite").some((x) => x.endsWith(`/.git/${f}`))) errs.push(`denyWrite must include a .git/${f} entry`);
  }
  if (list("allowWrite").length > 3) errs.push("allowWrite may hold only the clone, outbox and tmp");
  for (const w of list("allowWrite")) {
    if (SHARED_TMP.some((t) => w === t || w.startsWith(t + "/"))) errs.push(`allowWrite must not include shared tmp ${w}`);
  }

  if (ctx) {
    if (!list("denyRead").includes(ctx.home)) errs.push("denyRead must include HOME");
    if (ctx.claudeTmp) {
      for (const k of ["allowWrite", "allowRead"]) {
        if (list(k).includes(ctx.claudeTmp)) errs.push(`${k} must not include claude's own tmp ${ctx.claudeTmp}`);
      }
    }
    const want = [ctx.clone, ctx.outbox, ctx.tmp].sort();
    if (JSON.stringify([...list("allowWrite")].sort()) !== JSON.stringify(want)) {
      errs.push("allowWrite must be exactly the clone, outbox and tmp");
    }
    for (const g of gitDenyWrite(ctx)) {
      if (!list("denyWrite").includes(g)) errs.push(`denyWrite must include ${g}`);
    }
    if (isDarwin(ctx)) {
      for (const k of ["denyRead", "denyWrite"]) {
        for (const x of list(k).filter((y) => !y.startsWith(DATA_TWIN))) {
          if (!list(k).includes(DATA_TWIN + x)) errs.push(`${k} entry ${x} has no ${DATA_TWIN} twin`);
        }
      }
    }
  }
  if (errs.length) throw new Error(`implement settings refused:\n- ${errs.join("\n- ")}`);
}

export function buildImplementArgs(ctx) {
  const errs = [];
  if (!(Number.isFinite(ctx.maxBudgetUsd) && ctx.maxBudgetUsd > 0)) errs.push("maxBudgetUsd must be a positive number");
  if (!(Number.isInteger(ctx.maxTurns) && ctx.maxTurns > 0)) errs.push("maxTurns must be a positive integer");
  if (typeof ctx.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(ctx.model)) errs.push("model is empty or malformed");
  if (typeof ctx.settingsPath !== "string" || !isAbsolute(ctx.settingsPath)) errs.push("settingsPath must be absolute");
  if (errs.length) throw new Error(`implement argv refused: ${errs.join("; ")}`);
  // The prompt goes on stdin: --tools and --allowedTools are variadic and would swallow a positional.
  return [
    "-p", "--restricted",
    "--tools", "Bash", "--allowedTools", "Bash",
    "--permission-mode", "dontAsk",
    "--settings", ctx.settingsPath,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-session-persistence",
    "--max-budget-usd", String(ctx.maxBudgetUsd),
    "--max-turns", String(ctx.maxTurns),
    "--output-format", "stream-json", "--verbose",
    "--model", ctx.model,
  ];
}

const under = (p, root) => p === root || p.startsWith(root + "/");

export function buildImplementEnv(parentEnv, ctx) {
  if (!ctx.tmp || !ctx.claudeTmp) throw new Error("implement env: tmp and claudeTmp are required");
  if (under(ctx.claudeTmp, ctx.tmp) || under(ctx.tmp, ctx.claudeTmp)) {
    throw new Error("implement env: the child's TMPDIR and claude's CLAUDE_CODE_TMPDIR must be separate, non-nested dirs");
  }
  const pathEntries = implementPathEntries(parentEnv.PATH);
  if (!pathEntries.length) throw new Error("implement env: parent PATH has no absolute entries");
  for (const e of pathEntries) {
    if ([ctx.sroot, ...SHARED_TMP].some((r) => r && under(e, r))) {
      throw new Error(`implement env: PATH entry ${e} is inside a writable or shared dir`);
    }
  }
  const env = {
    PATH: pathEntries.join(":"),
    HOME: ctx.home,
    TERM: "dumb",
    SHELL: "/bin/sh",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    TMPDIR: ctx.tmp,
    CLAUDE_CODE_TMPDIR: ctx.claudeTmp,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  for (const k of ["USER", "LANG"]) if (parentEnv[k]) env[k] = parentEnv[k];
  for (const [k, v] of Object.entries(parentEnv)) if (/^LC_[A-Z_]+$/.test(k) && v) env[k] = v;
  const secret = Object.keys(env).filter((k) => /TOKEN|SECRET|KEY|PASS|CRED|AUTH|COOKIE|SESSION|^OTEL_/i.test(k));
  if (secret.length) throw new Error(`implement env: secret-looking names built: ${secret.join(", ")}`);
  return env;
}

export function validateManagedSettings(managed) {
  if (!managed || typeof managed !== "object" || Array.isArray(managed)) {
    throw new Error("managed settings: expected a JSON object");
  }
  const why = [];
  if ("sandbox" in managed) why.push("a `sandbox` key (managed arrays merge into drive's and could widen the allowlists)");
  if (managed.env && typeof managed.env === "object" && Object.keys(managed.env).length) {
    why.push(`\`env\` entries (${Object.keys(managed.env).join(", ")}) that the child would inherit, such as telemetry`);
  }
  if (managed.hooks && typeof managed.hooks === "object" && Object.keys(managed.hooks).length) {
    why.push("`hooks`, which run unsandboxed and see every tool input");
  }
  if (why.length) {
    throw new Error(`--implement refused: managed settings contain ${why.join("; ")}. Run on a machine without them.`);
  }
}
