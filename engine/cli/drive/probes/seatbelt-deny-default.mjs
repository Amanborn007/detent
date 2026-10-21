// Deny-default Seatbelt profile for the drive sandbox probes. The rule set is
// ported from Claude Code 2.1.306's own macOS template, minus the mach
// services that reach the keychain daemon and Launch Services.
import { posix } from "node:path";

export const CLAUDE_BASE_VERSION = "2.1.306";

// Dropped from Claude's allowlist on purpose; the probes check they stay unreachable.
export const OMITTED_MACH = ["com.apple.securityd.xpc", "com.apple.coreservices.launchservicesd", "com.apple.SecurityServer", "com.apple.lsd.mapdb"];

// Denied again after the allowlist, so a later edit to it cannot reopen these.
const DENY_MACH_REGEX = '^com\\.apple\\.([Cc]ore[Ss]ervices|lsd|securityd|SecurityServer|security\\.)';

const MACH_LOOKUP = [
  "com.apple.audio.systemsoundserver", "com.apple.distributed_notifications@Uv3",
  "com.apple.FontObjectsServer", "com.apple.fonts", "com.apple.logd",
  "com.apple.PowerManagement.control", "com.apple.system.logger",
  "com.apple.system.notification_center", "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership", "com.apple.bsd.dirhelper",
];

const SYSCTL_NAMES = [
  "hw.activecpu", "hw.busfrequency_compat", "hw.byteorder", "hw.cacheconfig", "hw.cachelinesize_compat",
  "hw.cpufamily", "hw.cpufrequency", "hw.cpufrequency_compat", "hw.cputype", "hw.l1dcachesize_compat",
  "hw.l1icachesize_compat", "hw.l2cachesize_compat", "hw.l3cachesize_compat", "hw.logicalcpu",
  "hw.logicalcpu_max", "hw.machine", "hw.memsize", "hw.ncpu", "hw.nperflevels", "hw.packages",
  "hw.pagesize_compat", "hw.pagesize", "hw.physicalcpu", "hw.physicalcpu_max", "hw.tbfrequency_compat",
  "hw.vectorunit", "kern.argmax", "kern.bootargs", "kern.hostname", "kern.iossupportversion", "kern.maxfiles",
  "kern.maxfilesperproc", "kern.maxproc", "kern.ngroups", "kern.osproductversion", "kern.osrelease",
  "kern.ostype", "kern.osvariant_status", "kern.osversion", "kern.secure_kernel", "kern.tcsm_available",
  "kern.tcsm_enable", "kern.usrstack64", "kern.version", "kern.willshutdown",
  "machdep.cpu.brand_string", "machdep.ptrauth_enabled", "security.mac.lockdown_mode_state",
  "sysctl.proc_cputype", "vm.loadavg",
];

const SYSCTL_PREFIXES = [
  "hw.optional.arm", "hw.optional.arm.", "hw.optional.armv8_", "hw.perflevel", "kern.proc.all",
  "kern.proc.pgrp.", "kern.proc.pid.", "machdep.cpu.", "net.routetable.",
];

// Read-denied in every profile; a caller adds its own marker dirs on top.
export function defaultDenyRead(home) {
  return [
    `${home}/.ssh`, `${home}/.aws`, `${home}/.config`, `${home}/.claude`, `${home}/.curator`,
    `${home}/Library/Keychains`, "/Library/Keychains",
    "/Library/Application Support", "/Library/Preferences", "/opt/homebrew/etc", "/usr/local/etc",
    "/private/var/db", "/private/var/log",
  ];
}

// The /usr/bin developer-tool shims read this to find the active toolchain.
export const XCODE_SELECT_LINK = "/private/var/db/xcode_select_link";
// xcrun exits 69 (EX_UNAVAILABLE) unless it can read the license acceptance here.
export const XCODE_LICENSE_PLIST = "/Library/Preferences/com.apple.dt.Xcode.plist";

const DEVICE_WRITES = ["/dev/null", "/dev/dtracehelper", "/dev/autofs_nowait"];
const DEVICE_IOCTL = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/dtracehelper", "/dev/tty"];

export function sbplString(p, what = "path") {
  if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`${what} must be an absolute path: ${String(p)}`);
  if (/["\\\n\r\0]/.test(p)) throw new Error(`${what} contains a character that is not allowed in a profile`);
  if (posix.normalize(p) !== p && p !== "/") throw new Error(`${what} is not normalized: ${p}`);
  return JSON.stringify(p);
}

function subpath(p, what) {
  if (p === "/") throw new Error(`${what}: refusing a subpath of /`);
  return `(subpath ${sbplString(p, what)})`;
}

function ancestors(p) {
  const out = [];
  for (let d = posix.dirname(p); d !== "/"; d = posix.dirname(d)) out.push(d);
  return out.reverse();
}

// scratch is the only writable tree and loopbackPort the only reachable endpoint.
// denyRead entries are emitted before reallowRead, and denyWrite after the write
// allow, so each probe can pin down SBPL's last-matching-rule-wins order.
export function buildProbeProfile({ scratch, loopbackPort, denyRead = [], reallowRead = [], denyWrite = [], logTag = "detent-probe" }) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(logTag)) throw new Error(`logTag must be 1-64 letters, digits or dashes: ${logTag}`);
  if (!Number.isInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > 65535) {
    throw new Error(`loopbackPort must be an integer in 1..65535: ${loopbackPort}`);
  }
  const out = [
    "(version 1)",
    `(deny default (with message "${logTag}"))`,
    "",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow mach-priv-task-port (target same-sandbox))",
    "(allow user-preference-read)",
    "",
    "(allow mach-lookup",
    ...MACH_LOOKUP.map((n) => `  (global-name ${JSON.stringify(n)})`),
    ")",
    `(deny mach-lookup (global-name-regex #"${DENY_MACH_REGEX}"))`,
    "(deny appleevent-send)",
    "(deny lsopen)",
    "",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    "(allow iokit-open",
    '  (iokit-registry-entry-class "IOSurfaceRootUserClient")',
    '  (iokit-registry-entry-class "RootDomainUserClient")',
    '  (iokit-user-client-class "IOSurfaceSendRight")',
    ")",
    "(allow iokit-get-properties)",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "",
    "(allow sysctl-read",
    ...SYSCTL_NAMES.map((n) => `  (sysctl-name ${JSON.stringify(n)})`),
    ...SYSCTL_PREFIXES.map((n) => `  (sysctl-name-prefix ${JSON.stringify(n)})`),
    ")",
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs") (sysctl-name-prefix "kern.proc.args"))',
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
    "(allow distributed-notification-post)",
    "",
    ...DEVICE_IOCTL.map((d) => `(allow file-ioctl (literal ${JSON.stringify(d)}))`),
    "",
    "(allow network-outbound (remote ip " + JSON.stringify(`localhost:${loopbackPort}`) + "))",
    "",
    "(allow file-read*)",
  ];
  for (const p of denyRead) out.push(`(deny file-read* ${subpath(p, "denyRead")})`);
  const metaDirs = [...new Set(reallowRead.flatMap(ancestors))];
  for (const d of metaDirs) out.push(`(allow file-read-metadata (literal ${sbplString(d, "reallowRead")}))`);
  for (const p of reallowRead) out.push(`(allow file-read* ${subpath(p, "reallowRead")})`);
  out.push("");
  out.push(`(allow file-write* ${subpath(scratch, "scratch")}${DEVICE_WRITES.map((d) => ` (literal ${JSON.stringify(d)})`).join("")})`);
  for (const p of denyWrite) out.push(`(deny file-write* ${subpath(p, "denyWrite")})`);
  return out.join("\n") + "\n";
}
