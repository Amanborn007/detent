// Model-free sandbox gate for `detent drive --implement`. An `env` shim on the
// child's PATH captures the profile Claude Code hands to sandbox-exec, validates it,
// replays drive's probe under it, and refuses every command if anything fails.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_SRC = join(dirname(fileURLToPath(import.meta.url)), "sandbox-shim", "shim.cjs");
const SHELL_SRC = join(dirname(fileURLToPath(import.meta.url)), "sandbox-shim", "shell.cjs");
const shim = createRequire(import.meta.url)(SHIM_SRC);

export const validateCapturedProfile = shim.validateProfile;
export const profileHash = shim.profileHash;
export const startCanaryListener = shim.startCanaryListener;
export const parseTokens = shim.parseTokens;
export const parseNames = shim.parseNames;
export const parseDetails = shim.parseDetails;
export const tmpdirFromCommand = shim.tmpdirFromCommand;
export const evaluateTokens = shim.evaluateTokens;
export const SHIM_REFUSED_MARKER = shim.REFUSED;

const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const SECRET_NAMES = "TOKEN|KEY|SECRET|PASS|CRED|AUTH|COOKIE|SESSION";
const VERSION_FLAG = { node: "-v", npm: "-v", go: "version" };
// Names Claude Code 2.1.306 injects into every sandboxed Bash env; reported as findings, never silent.
export const RUNTIME_ENV_NAMES = ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLOUDSDK_PROXY_PASSWORD", "GIT_CONFIG_COUNT"];
const RUNTIME_ENV_RE = `^(${RUNTIME_ENV_NAMES.join("|")}|GIT_CONFIG_(KEY|VALUE)_[0-9]+)$`;
const RUNTIME_ENV ="PWD|OLDPWD|SHLVL|_|HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|SANDBOX_RUNTIME";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const E = {
  eq: (v) => ({ k: "eq", v }),
  rc0: () => ({ k: "rc0" }),
  rcNot0: (extra = {}) => ({ k: "rcNot0", ...extra }),
  zero: () => ({ k: "zero" }),
};

// opts: platform, clone, drivePid, denyTargets[], canaries[{path, nonce, volPath?}], writeAllowed[],
// writeDenied[], toolchain[], envAllow?[]. The script reads $1 (canary tcp port) and $2 (canary unix socket).
export function buildSelfProbe(opts) {
  const { platform, clone, drivePid, denyTargets = [], canaries = [], writeAllowed = [], writeDenied = [], toolchain = [], envAllow, claudeTmp, denyClaudeUidTmp = false } = opts;
  if (platform !== "darwin") throw new Error(`selfprobe: no probe for platform ${platform}; the capture-and-replay gate covers macOS only`);
  if (!isAbsolute(clone)) throw new Error("selfprobe: clone must be an absolute path");
  if (!Number.isInteger(drivePid)) throw new Error("selfprobe: drivePid must be an integer");
  const nonce = randomBytes(6).toString("hex");
  const L = ['PORT="$1"; SOCK="$2"', 'r() { echo "$1=$2"; }'];
  const expect = {};
  let envScript;
  const add = (key, line, exp) => { L.push(line); expect[key] = exp; };
  const rc = (key, cmd, exp) => add(key, `${cmd} >/dev/null 2>&1; r ${key} $?`, exp);
  const count = (key, expr, exp) => add(key, `N=$(${expr}); r ${key} "$N"`, exp);
  const firm = (p) => (p.startsWith("/Users/") ? `/System/Volumes/Data${p}` : null);

  add("bash_ran", "r bash_ran 1", E.eq(1));
  denyTargets.forEach((p, i) => {
    rc(`read_deny_${i}`, `ls -- ${sq(p)}`, E.rcNot0());
    if (firm(p)) rc(`read_firmlink_${i}`, `ls -- ${sq(firm(p))}`, E.rcNot0());
  });
  canaries.forEach((c, i) => {
    const grep = `grep -cF -- ${sq(c.nonce)}`;
    count(`read_canary_${i}`, `cat -- ${sq(c.path)} 2>/dev/null | ${grep}`, E.zero());
    if (firm(c.path)) count(`read_canary_fl_${i}`, `cat -- ${sq(firm(c.path))} 2>/dev/null | ${grep}`, E.zero());
    if (c.volPath) count(`vol_read_${i}`, `cat -- ${sq(c.volPath)} 2>/dev/null | ${grep}`, E.zero());
    L.push(`HL=${sq(clone)}/.detent-hl-${nonce}-${i}-$$; ln -- ${sq(c.path)} "$HL" >/dev/null 2>&1; r hardlink_${i} $?; N=$(cat -- "$HL" 2>/dev/null | ${grep}); r hardlink_read_${i} "$N"; rm -f "$HL" >/dev/null 2>&1`);
    expect[`hardlink_${i}`] = E.rcNot0();
    expect[`hardlink_read_${i}`] = E.zero();
  });
  add("keychain", `security find-generic-password -s ${sq(KEYCHAIN_SERVICE)} >/dev/null 2>&1; r keychain $?`, E.rcNot0({ control: "keychain_rc", controlWant: 0 }));

  writeDenied.forEach((p, i) => {
    const f = `${p}/.detent-probe-${nonce}`;
    add(`write_denied_${i}`, `( : > ${sq(f)} ) >/dev/null 2>&1; rc=$?; rm -f ${sq(f)} >/dev/null 2>&1; r write_denied_${i} $rc`, E.rcNot0());
  });
  writeAllowed.forEach((p, i) => {
    const f = `${p}/.detent-probe-${nonce}`;
    add(`write_allowed_${i}`, `( : > ${sq(f)} ) >/dev/null 2>&1; rc=$?; rm -f ${sq(f)} >/dev/null 2>&1; r write_allowed_${i} $rc`, E.rc0());
  });

  const G = `cd ${sq(clone)}`;
  add("git_commit", `T=$(${G} && git write-tree 2>/dev/null); H=$(${G} && git rev-parse -q --verify HEAD 2>/dev/null); if [ -n "$T" ] && [ -n "$H" ]; then ( ${G} && git commit-tree "$T" -p "$H" -m probe ) >/dev/null 2>&1; r git_commit $?; else r git_commit 99; fi`, E.rc0());
  add("git_config_write", `( ${G} && git config detent.selfprobe 1 ) >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] && ( ${G} && git config --unset detent.selfprobe ) >/dev/null 2>&1; r git_config_write $rc`, E.rcNot0());
  for (const [key, rel] of [["git_commondir_write", ".git/commondir"], ["git_alternates_write", ".git/objects/info/alternates"], ["git_config_worktree_write", ".git/config.worktree"]]) {
    add(key, `( ${G} && mkdir -p .git/objects/info && : > ${sq(rel)} ) >/dev/null 2>&1; rc=$?; rm -f ${sq(`${clone}/${rel}`)} >/dev/null 2>&1; r ${key} $rc`, E.rcNot0());
  }

  rc("net_ext", "curl -m 5 -s -f -o /dev/null https://example.com", E.rcNot0());
  rc("net_ext_direct", "curl -m 5 -s --noproxy '*' -f -o /dev/null https://example.com", E.rcNot0());
  rc("net_loop_proxy", 'curl -m 3 -s -o /dev/null "http://127.0.0.1:$PORT/"', E.rcNot0());
  rc("net_loop_direct", 'curl -m 3 -s --noproxy "*" -o /dev/null "http://127.0.0.1:$PORT/"', E.rcNot0());
  rc("net_loop_v6", 'curl -m 3 -s -g --noproxy "*" -o /dev/null "http://[::1]:$PORT/"', E.rcNot0());
  rc("net_loop_devtcp", `bash -c 'exec 3<>/dev/tcp/127.0.0.1/$0' "$PORT"`, E.rcNot0());
  rc("unix_sock", 'nc -U -w 1 "$SOCK" </dev/null', E.rcNot0());

  const lc = `detent.selfprobe.${nonce}`;
  add("esc_launchctl_submit", `launchctl submit -l ${lc} -- /usr/bin/true >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] && launchctl remove ${lc} >/dev/null 2>&1; r esc_launchctl_submit $rc`, E.rcNot0());
  add("esc_defaults_write", `defaults write ${lc} k -string v >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] && defaults delete ${lc} >/dev/null 2>&1; r esc_defaults_write $rc`, E.rcNot0());
  rc("esc_open", "open -g -b com.apple.finder", E.rcNot0());
  if (canaries[0]) count("esc_mdfind", `mdfind -onlyin ${sq(dirname(canaries[0].path))} ${sq(canaries[0].nonce)} 2>/dev/null | grep -c .`, E.zero());

  rc("tty_dev_tty", "( : > /dev/tty )", E.rcNot0());
  rc("kill_parent", `kill -0 ${drivePid}`, E.rcNot0());
  const V = [];
  const vcount = (key, expr, exp) => { V.push(`N=$(${expr}); r ${key} "$N"`); expect[key] = exp; };
  const NAMES = "/usr/bin/env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | cut -d= -f1";
  const exempt = `grep -E ${sq(RUNTIME_ENV_RE)}`;
  const notExempt = `grep -vE ${sq(RUNTIME_ENV_RE)}`;
  const secretGrep = `grep -iE '${SECRET_NAMES}'`;
  vcount("env_secret_names", `${NAMES} | ${notExempt} | ${secretGrep} | wc -l | tr -d ' '`, E.zero());
  V.push(`[ "$N" != 0 ] && echo "@names env_secret_names $(${NAMES} | ${notExempt} | ${secretGrep} | paste -sd, -)"`);
  if (envAllow) {
    const extraGrep = `grep -vxE ${sq(`(${[...envAllow, RUNTIME_ENV].join("|")})`)}`;
    vcount("env_extra_names", `${NAMES} | ${notExempt} | ${extraGrep} | wc -l | tr -d ' '`, E.zero());
    V.push(`[ "$N" != 0 ] && echo "@names env_extra_names $(${NAMES} | ${notExempt} | ${extraGrep} | paste -sd, -)"`);
  }
  V.push(`E=$(${NAMES} | ${exempt} | paste -sd, -); [ -n "$E" ] && echo "@names claude_runtime_env $E"`);
  V.push('P="${HTTP_PROXY#*://}"; P="${P%%@*}"; P="${P#*:}"; [ -z "${CLOUDSDK_PROXY_PASSWORD+x}" ] || [ "$P" = "$CLOUDSDK_PROXY_PASSWORD" ]; r cloudsdk_pw_matches_proxy $?');
  expect.cloudsdk_pw_matches_proxy = E.rc0();
  vcount("git_config_keys_other", "/usr/bin/env | grep -E '^GIT_CONFIG_KEY_[0-9]+=' | grep -vc '=safe.directory$'", E.zero());
  L.push(...V);
  envScript = `${['r() { echo "$1=$2"; }', ...V].join("\n")}\n`;
  L.push(`D=/private/tmp/claude-$(id -u); if [ -d "$D" ]; then ( : > "$D/.detent-probe-${nonce}" ) >/dev/null 2>&1; rc=$?; rm -f "$D/.detent-probe-${nonce}" >/dev/null 2>&1; r claude_uid_tmp_writable $rc; else r claude_uid_tmp_writable 2; fi`);
  if (denyClaudeUidTmp) expect.claude_uid_tmp_writable = E.rcNot0();
  if (claudeTmp) {
    if (!isAbsolute(claudeTmp)) throw new Error("selfprobe: claudeTmp must be an absolute path");
    // A realpath mismatch means claude fell back to the shared /tmp/claude-<uid>.
    add("claude_tmpdir_matches", `A=$(cd "$TMPDIR" 2>/dev/null && pwd -P); B=$(cd ${sq(`${claudeTmp}/claude-`)}$(id -u) 2>/dev/null && pwd -P); [ -n "$A" ] && [ "$A" = "$B" ]; rc=$?; [ $rc -eq 0 ] || echo "@detail claude_tmpdir_matches TMPDIR=\${TMPDIR:-unset} resolved=\${A:-none} expected=\${B:-none}"; r claude_tmpdir_matches $rc`, E.rc0());
  }
  count("ps_parent_secret", `ps -E -ww -p ${drivePid} -o command= 2>/dev/null | tr ' ' '\\n' | grep -cE '^[A-Za-z0-9_]*(${SECRET_NAMES})[A-Za-z0-9_]*='`, E.zero());
  for (const t of toolchain) {
    add(`tool_${t}`, `command -v ${sq(t)} >/dev/null 2>&1 && ${sq(t)} ${VERSION_FLAG[t] ?? "--version"} >/dev/null 2>&1; r tool_${t} $?`, { k: "sameAsControl", control: `tool_${t}_rc` });
  }

  const C = ['r() { echo "$1=$2"; }', `security find-generic-password -s ${sq(KEYCHAIN_SERVICE)} >/dev/null 2>&1; r keychain_rc $?`];
  for (const t of toolchain) C.push(`command -v ${sq(t)} >/dev/null 2>&1 && ${sq(t)} ${VERSION_FLAG[t] ?? "--version"} >/dev/null 2>&1; r tool_${t}_rc $?`);
  return { script: `${L.join("\n")}\n`, expect, envScript, controlScript: `${C.join("\n")}\n` };
}

// Runs the control script outside any sandbox, so the baseline for keychain and toolchain checks is real.
export function collectControls(controlScript, { env = process.env, cwd } = {}) {
  const r = spawnSync("/bin/sh", ["-c", controlScript], { encoding: "utf8", env, cwd, timeout: 60000 });
  if (r.error) throw r.error;
  return parseTokens(r.stdout);
}

export const SHELL_STRING_SHAPE = Object.freeze({
  darwin: "env [-u NAME]... [NAME=VALUE]... /usr/bin/sandbox-exec -p <profile> <shell> -c <command>",
  linux: "bwrap <flags> -- <shell> -c <command>, with bwrap resolved from PATH unless sandbox.bwrapPath is set",
});

export function installShim(dir, exps) {
  if (!isAbsolute(dir)) throw new Error("installShim: dir must be an absolute path");
  const { validate, probe } = exps || {};
  if (!validate || !probe?.script || !probe?.expect) throw new Error("installShim: expectations need validate and probe {script, expect}");
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`installShim: ${dir} already exists and is not empty`);
  const nodeBin = exps.nodeBin ?? realpathSync(process.execPath);
  if (/\s/.test(nodeBin)) throw new Error("installShim: the node path must not contain whitespace (shebang)");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = realpathSync(dir);
  const binDir = join(root, "bin");
  const logDir = join(root, "log");
  mkdirSync(binDir, { mode: 0o700 });
  mkdirSync(logDir, { mode: 0o700 });
  const config = {
    sandboxExec: exps.sandboxExec ?? "/usr/bin/sandbox-exec",
    envBin: exps.envBin ?? "/usr/bin/env",
    timeoutMs: exps.timeoutMs ?? 90000,
    validate,
    probe: { script: probe.script, expect: probe.expect, controls: probe.controls ?? {} },
  };
  const callLogPath = join(logDir, "shell-calls.jsonl");
  const sentinelPath = join(logDir, "sentinel");
  writeFileSync(callLogPath, "", { mode: 0o600 });
  writeFileSync(sentinelPath, "", { mode: 0o600 });
  config.shell = { realShell: exps.shell?.realShell ?? "/bin/bash", canaryPort: exps.shell?.canaryPort ?? 0, canarySocket: exps.shell?.canarySocket ?? "", callLog: callLogPath, sentinel: sentinelPath };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o444 });
  const lib = readFileSync(SHIM_SRC, "utf8");
  writeFileSync(join(binDir, "env"), `#!${nodeBin}\n${lib}`, { mode: 0o555 });
  writeFileSync(join(binDir, "lib.cjs"), lib, { mode: 0o444 });
  writeFileSync(join(binDir, "bash"), `#!${nodeBin}\n${readFileSync(SHELL_SRC, "utf8")}`, { mode: 0o555 });
  chmodSync(binDir, 0o555);
  chmodSync(root, 0o555);
  return { dir: root, binDir, logDir, configPath, shellPath: join(binDir, "bash"), callLogPath, sentinelPath };
}

export function uninstallShim(dir) {
  if (!existsSync(dir)) return;
  for (const p of [dir, join(dir, "bin"), join(dir, "log")]) if (existsSync(p)) chmodSync(p, 0o700);
  rmSync(dir, { recursive: true, force: true });
}

export const pathWithShim = (binDir, pathVar) => `${binDir}:${pathVar}`;

// mode "env" reads the env shim's log, "shell" the shim shell's.
export function readShimReport(dir, { mode = "env" } = {}) {
  const log = join(dir, "log");
  const rep = { captured: false, ok: false, violations: [], tokens: {}, failures: [], inconclusive: [], canaryHits: 0, calls: 0, refused: 0, hashMismatches: 0, callFailures: [], findings: [], names: {} };
  const stateFile = join(log, "state.json");
  if (mode === "env" && existsSync(stateFile)) Object.assign(rep, JSON.parse(readFileSync(stateFile, "utf8")), { captured: true });
  const calls = join(log, mode === "shell" ? "shell-calls.jsonl" : "calls.jsonl");
  if (existsSync(calls)) {
    for (const line of readFileSync(calls, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.ev !== "call") continue;
      for (const f of ev.findings || []) if (!rep.findings.includes(f)) rep.findings.push(f);
      if (mode === "shell" && rep.calls === 0) Object.assign(rep, { captured: true, tokens: ev.tokens, names: ev.names || {} });
      rep.calls++;
      if (!ev.ok) rep.refused++;
      if (ev.reason === "profile_changed") rep.hashMismatches++;
      for (const f of [...(ev.failures || []), ...(ev.inconclusive || [])]) if (!rep.callFailures.includes(f)) rep.callFailures.push(f);
    }
  }
  if (mode === "shell") {
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    Object.assign(rep, { expect: cfg.probe.expect, controls: cfg.probe.controls, ok: rep.captured && rep.refused === 0 });
  }
  return rep;
}

// report: readShimReport(dir) plus { toolUses, platform }, where toolUses is the Bash tool_use count in the transcript.
export function evaluateSelfProbe(report) {
  const failures = [];
  const inconclusive = [];
  const knownLimits = [];
  const calls = report.calls ?? 0;
  const toolUses = report.toolUses ?? 0;
  if (/falls back to|too long for AF_UNIX/i.test(report.stderr ?? "")) failures.push(`claude_tmp_fallback: claude reported it fell back to the shared per-uid tmp dir: ${String(report.stderr).slice(0, 200)}`);
  let discard = false;
  if (report.platform === "darwin") knownLimits.push("procargs: a sandboxed command on macOS can read the exec-time env and argv of same-user processes (KERN_PROCARGS2); the check passes when drive's own env holds no secret-shaped name");
  if (!report.captured) {
    if (calls === 0 && toolUses === 0) return { ok: true, noBash: true, discard: false, failures, inconclusive, knownLimits };
    failures.push(`no_capture: the shim captured no sandbox profile but the transcript has ${toolUses} Bash tool use(s) and the shim saw ${calls} call(s)`);
    return { ok: false, noBash: false, discard: true, failures, inconclusive, knownLimits };
  }
  for (const v of report.violations || []) failures.push(`profile: ${v}`);
  if ((report.hashMismatches ?? 0) > 0) failures.push(`profile_changed: ${report.hashMismatches} command(s) ran with a different sandbox profile from the probed one`);
  for (const f of report.callFailures || []) failures.push(`call: ${f}`);
  const ev = evaluateTokens(report.tokens || {}, report.expect || {}, report.controls || {}, { canaryHits: report.canaryHits ?? 0, names: report.names || {} });
  failures.push(...ev.failures);
  inconclusive.push(...ev.inconclusive);
  if (calls !== toolUses) {
    failures.push(`call_count_mismatch: the shim wrapped ${calls} call(s) but the transcript has ${toolUses} Bash tool use(s); a command may have bypassed the shim`);
    discard = true;
  }
  return { ok: failures.length === 0 && inconclusive.length === 0, noBash: false, discard, failures, inconclusive, knownLimits, findings: report.findings || [] };
}
