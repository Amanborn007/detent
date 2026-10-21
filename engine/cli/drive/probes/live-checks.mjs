// The script a live probe has `claude` run through its Bash tool, and the
// pure evaluation of what it wrote back. Every command in the script sends its
// output to /dev/null and records only an exit code or a count.
import { result } from "./report.mjs";

export const LIVE_MODEL = "claude-haiku-5-5";
export const LIVE_BUDGET_TOTAL_USD = 0.10;
export const ALLOWED_PROXY_PATHS = ["/v1/messages", "/v1/messages/count_tokens"];

// Args: 1 out file, 2 parent pid file, 3 canary file, 4 real HOME,
// 5 loopback port (0 = none), 6 keychain service, 7 write-test path.
export function liveCheckScript() {
  return `#!/bin/sh
OUT="$1"; PARENT="$(cat "$2")"; CANARY="$(cat "$3")"; RHOME="$4"; LPORT="$5"; KSVC="$6"; WTEST="$7"
r() { echo "$1=$2" >> "$OUT"; }
r bash_ran 1
cat "$RHOME/.ssh/config" >/dev/null 2>&1; r ssh_config_rc $?
ls "$RHOME/.claude" >/dev/null 2>&1; r claude_dir_ls_rc $?
ls "$RHOME"/.claude/.credentials* >/dev/null 2>&1; r claude_creds_ls_rc $?
security find-generic-password -s "$KSVC" >/dev/null 2>&1; r keychain_rc $?
N="$(env PROBE_CTL="$CANARY" sh -c 'ps -E -ww -p $$ -o command=' 2>/dev/null | grep -cF "$CANARY")"; r ps_self_seen "$N"
N="$(ps -E -ww -p "$PARENT" -o command= 2>/dev/null | grep -cF "$CANARY")"; r ps_parent_seen "$N"
kill -0 "$PARENT" >/dev/null 2>&1; r kill0_parent_rc $?
TTY="$(ls -l /dev/ttys* 2>/dev/null | awk -v u="$(id -un)" '$3==u{print $NF; exit}')"
if [ -n "$TTY" ]; then ( : > "$TTY" ) >/dev/null 2>&1; r tty_open_rc $?; fi
curl -m 5 -sS -f -o /dev/null https://example.com >/dev/null 2>&1; r net_ext_rc $?
if [ "$LPORT" != "0" ]; then curl -m 5 -s -o /dev/null "http://127.0.0.1:$LPORT/" >/dev/null 2>&1; r net_loopback_rc $?; fi
( : > "$WTEST" ) >/dev/null 2>&1; r write_home_rc $?
`;
}

export function parseKv(text) {
  const kv = {};
  for (const line of String(text).split("\n")) {
    const m = /^([a-z0-9_]+)=(-?\d+)$/.exec(line.trim());
    if (m) kv[m[1]] = Number(m[2]);
  }
  return kv;
}

const blocked = (rc) => rc !== 0;

// controls: booleans measured on the host without a sandbox.
//   sshConfigExists, claudeCredsExist, keychainItemFound, netExternalOk
export function evalLive(prefix, kv, controls, { expectLoopback }) {
  const out = [];
  const add = (probe, expected, actual, status, note) => out.push(result({ probe: `${prefix}.${probe}`, expected, actual, status, note }));
  const rcProbe = (probe, key, control, controlNote) => {
    if (kv[key] === undefined) return add(probe, "blocked", "not_recorded", "skipped", "script did not record this check");
    if (control === false) return add(probe, "blocked", `rc=${kv[key]}`, "inconclusive", controlNote);
    add(probe, "blocked", `rc=${kv[key]}`, blocked(kv[key]) ? "pass" : "fail");
  };
  rcProbe("ssh_config_read", "ssh_config_rc", controls.sshConfigExists, "no ~/.ssh/config on this host to read");
  if (kv.claude_dir_ls_rc !== undefined) rcProbe("claude_dir_list", "claude_dir_ls_rc", true);
  if (kv.claude_creds_ls_rc !== undefined) rcProbe("claude_credentials_file", "claude_creds_ls_rc", controls.claudeCredsExist, "no ~/.claude/.credentials* file on this host");
  rcProbe("keychain_query", "keychain_rc", controls.keychainItemFound,
    "the keychain item was not found on the host either, so a failure proves nothing");
  if (kv.ps_parent_seen === undefined) add("ps_env_parent", "canary not visible", "not_recorded", "skipped");
  else if (!(kv.ps_self_seen >= 1)) add("ps_env_parent", "canary not visible", "control_failed", "inconclusive", "ps -E could not read its own env, so the parent result proves nothing");
  else add("ps_env_parent", "canary not visible", kv.ps_parent_seen === 0 ? "not_visible" : "visible", kv.ps_parent_seen === 0 ? "pass" : "fail");
  rcProbe("kill_parent", "kill0_parent_rc", true);
  if (kv.tty_open_rc === undefined) add("tty_write", "blocked", "no_owned_tty", "skipped", "no /dev/ttys* owned by this user");
  else rcProbe("tty_write", "tty_open_rc", true);
  rcProbe("net_external", "net_ext_rc", controls.netExternalOk, "host could not reach the external site either");
  if (expectLoopback) {
    if (kv.net_loopback_rc === undefined) add("net_loopback", "reachable", "not_recorded", "skipped");
    else add("net_loopback", "reachable", `rc=${kv.net_loopback_rc}`, kv.net_loopback_rc === 0 ? "pass" : "fail");
  }
  rcProbe("write_real_home", "write_home_rc", true);
  return out;
}
