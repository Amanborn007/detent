#!/usr/bin/env node
// Runs each probe under sandbox-exec with the deny-default profile and prints
// one JSON report. Only exit codes, booleans and counts are recorded: probe
// output is classified, never printed.
import net from "node:net";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, result } from "./report.mjs";
import { buildProbeProfile, defaultDenyRead, CLAUDE_BASE_VERSION } from "./seatbelt-deny-default.mjs";
import { preflight, run } from "./exec.mjs";

const SELF = fileURLToPath(import.meta.url);
const CONNECT_JS = `const net=require("net");const a=process.argv.slice(1);const s=a.length>1?net.connect(+a[1],a[0]):net.connect(a[0]);
const t=setTimeout(()=>{process.stdout.write("timeout");process.exit(0)},2500);
s.on("connect",()=>{process.stdout.write("connected");process.exit(0)});s.on("error",e=>{process.stdout.write("error:"+e.code);process.exit(0)})`;
const PROCARGS_PY = `import ctypes,sys
l=ctypes.CDLL("libc.dylib");m=(ctypes.c_int*3)(1,49,int(sys.argv[1]));n=ctypes.c_size_t(0)
if l.sysctl(m,3,None,ctypes.byref(n),None,0)!=0: print("rc=fail");sys.exit(0)
b=ctypes.create_string_buffer(n.value)
if l.sysctl(m,3,b,ctypes.byref(n),None,0)!=0: print("rc=fail");sys.exit(0)
print("seen=%d"%(sys.argv[2].encode() in b.raw[:n.value]))`;

const TOOLS = [
  ["node", ["-v"]], ["npm", ["-v"]], ["git", ["--version"]], ["go", ["version"]],
  ["cargo", ["--version"]], ["python3", ["-V"]], ["make", ["-v"]], ["clang", ["--version"]],
];

function listen(server, where) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(where, () => resolve(server)); });
}

function hostConnect(...target) {
  return new Promise((resolve) => {
    const s = target.length > 1 ? net.connect(target[1], target[0]) : net.connect(target[0]);
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 3000);
    s.on("connect", () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

export async function runSandboxProbes({ T, S, realHome, canary, nonce }) {
  const out = [];
  const add = (probe, expected, actual, status, note) => out.push(result({ probe, expected, actual, status, note }));
  const fakeHome = join(T, "fakehome");
  const pb1 = join(T, "pb1");
  const markers = {};
  const mk = (rel, name) => {
    const dir = join(T, rel); mkdirSync(dir, { recursive: true });
    const m = `detent-marker-${randomBytes(8).toString("hex")}`;
    writeFileSync(join(dir, name), m + "\n");
    return { path: join(dir, name), dir, nonce: m };
  };
  for (const d of [".ssh", ".aws", ".config", ".claude", ".curator"]) markers[d] = mk(`fakehome/${d}`, "marker");
  const p1 = {
    denied: mk("pb1/denied", "blocked.txt"), open: mk("pb1/denied/open", "allowed.txt"),
    secret: mk("pb1/inside/secret", "x.txt"), plain: mk("pb1/inside", "ok.txt"),
  };
  mkdirSync(join(S, "tmp"), { recursive: true });
  mkdirSync(join(S, "ro"), { recursive: true });

  const extSock = join(T, "ext.sock");
  const accept = (s) => s.destroy();
  const loopAllowed = await listen(net.createServer(accept), { port: 0, host: "127.0.0.1" });
  const loopOther = await listen(net.createServer(accept), { port: 0, host: "127.0.0.1" });
  const extServer = await listen(net.createServer(accept), extSock);
  const allowedPort = loopAllowed.address().port, otherPort = loopOther.address().port;

  const profile = buildProbeProfile({
    scratch: S, loopbackPort: allowedPort,
    denyRead: [...defaultDenyRead(realHome), ...Object.values(markers).map((m) => m.dir), p1.denied.dir, dirname(p1.secret.path)],
    reallowRead: [p1.open.dir],
    denyWrite: [join(S, "ro")],
  });
  const profileSha = createHash("sha256").update(profile).digest("hex").slice(0, 16);
  const hostEnv = { ...process.env };
  const sbEnv = { PATH: process.env.PATH, HOME: fakeHome, TMPDIR: join(S, "tmp"), LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const host = (argv, o = {}) => run(argv[0], argv.slice(1), { env: hostEnv, ...o });
  const sb = (argv, o = {}) => run("sandbox-exec", ["-p", profile, ...argv], { env: sbEnv, cwd: S, ...o });
  const sh = (script, ...a) => ["/bin/sh", "-c", script, "_", ...a];
  const sees = (r, n) => r.stdout.includes(n);

  // Secret-bearing target: leak means the marker text came back through stdout.
  const readLeak = async (probe, target, n, note) => {
    const h = await host(["/bin/cat", target]);
    if (!sees(h, n)) return add(probe, "blocked", "control_failed", "inconclusive", note ?? "unsandboxed read of the marker failed, so the result proves nothing");
    const r = await sb(["/bin/cat", target]);
    sees(r, n) ? add(probe, "blocked", "read", "fail") : add(probe, "blocked", `blocked(rc=${r.code})`, "pass");
  };

  // PB1: SBPL last-matching-rule-wins, in both directions and for writes.
  {
    const r = await sb(["/bin/cat", p1.plain.path]);
    sees(r, p1.plain.nonce) ? add("PB1.read_baseline_allowed", "readable", "readable", "pass") : add("PB1.read_baseline_allowed", "readable", `rc=${r.code}`, "fail");
  }
  {
    const r = await sb(["/bin/cat", p1.secret.path]);
    sees(r, p1.secret.nonce) ? add("PB1.deny_inside_allowed", "blocked", "read", "fail") : add("PB1.deny_inside_allowed", "blocked", `blocked(rc=${r.code})`, "pass");
  }
  {
    const r = await sb(["/bin/cat", p1.open.path]);
    sees(r, p1.open.nonce) ? add("PB1.allow_inside_denied", "readable", "readable", "pass") : add("PB1.allow_inside_denied", "readable", `blocked(rc=${r.code})`, "fail", "a later allow did not override the earlier deny");
  }
  {
    const r = await sb(["/bin/cat", p1.denied.path]);
    sees(r, p1.denied.nonce) ? add("PB1.denied_sibling_still_blocked", "blocked", "read", "fail") : add("PB1.denied_sibling_still_blocked", "blocked", `blocked(rc=${r.code})`, "pass");
  }
  {
    const ok = join(S, "ok.txt"), ro = join(S, "ro", "z.txt");
    await sb(sh(': > "$1"', ok)); await sb(sh(': > "$1"', ro));
    add("PB1.write_allowed_then_denied_subpath", "scratch writable, scratch/ro not", `scratch=${existsSync(ok)} ro=${existsSync(ro)}`, existsSync(ok) && !existsSync(ro) ? "pass" : "fail");
  }

  // Reads.
  {
    const outside = join(T, "outside-write.txt");
    await sb(sh(': > "$1"', outside));
    add("write.outside_scratch", "blocked", existsSync(outside) ? "written" : "blocked", existsSync(outside) ? "fail" : "pass");
  }
  {
    const cands = [".ssh", ".aws", ".config", ".claude", ".curator"].map((d) => join(realHome, d))
      .concat(["/Library/Application Support", "/Library/Preferences", "/opt/homebrew/etc", "/usr/local/etc", "/private/var/db", "/private/var/log"]);
    let hostOk = 0, leaked = 0;
    for (const p of cands) {
      if ((await host(["/bin/ls", p])).code !== 0) continue;
      hostOk++;
      if ((await sb(["/bin/ls", p])).code === 0) leaked++;
    }
    add("read.denied_directories", "0 listable", `${leaked} of ${hostOk} listable`, hostOk === 0 ? "inconclusive" : leaked === 0 ? "pass" : "fail", hostOk === 0 ? "none of the denied directories exist or are listable on this host" : undefined);
    for (const [name, m] of Object.entries(markers)) await readLeak(`read.marker${name.replace(".", "_")}`, m.path, m.nonce);
  }

  // Escape set.
  await readLeak("esc.firmlink_marker", `/System/Volumes/Data${markers[".ssh"].path}`, markers[".ssh"].nonce);
  {
    const real = join(realHome, ".ssh");
    if ((await host(["/bin/ls", `/System/Volumes/Data${real}`])).code !== 0) add("esc.firmlink_real_ssh_listing", "blocked", "no_listing_on_host", "skipped", "~/.ssh is missing or not listable on this host");
    else {
      const r = await sb(["/bin/ls", `/System/Volumes/Data${real}`]);
      add("esc.firmlink_real_ssh_listing", "blocked", r.code === 0 ? "listable" : `blocked(rc=${r.code})`, r.code === 0 ? "fail" : "pass");
    }
  }
  {
    const st = statSync(markers[".aws"].path);
    await readLeak("esc.vol_inode_read", `/.vol/${st.dev}/${st.ino}`, markers[".aws"].nonce, "/.vol access by device and inode is not available on the host");
  }
  {
    const hl = join(S, "hardlink");
    const r = await sb(sh('ln "$1" "$2" && cat "$2"', markers[".config"].path, hl));
    add("esc.hardlink_into_scratch", "marker not readable", `linked=${existsSync(hl)} readable=${sees(r, markers[".config"].nonce)}`, sees(r, markers[".config"].nonce) ? "fail" : "pass");
  }
  {
    const label = `detent.probe.${nonce}`;
    const lc = join(S, "lc");
    copyFileSync("/bin/launchctl", lc); chmodSync(lc, 0o755);
    const ctl = await host([lc, "list", label]);
    await sb([lc, "submit", "-l", label, "--", "/usr/bin/true"]);
    const submitted = (await host(["/bin/launchctl", "list", label])).code === 0;
    await host(["/bin/launchctl", "remove", label]);
    if (ctl.signal) add("esc.launchctl_submit_copy", "not submitted", "control_failed", "inconclusive", "the copied launchctl cannot run even unsandboxed");
    else add("esc.launchctl_submit_copy", "not submitted", submitted ? "submitted" : "not_submitted", submitted ? "fail" : "pass");
  }
  {
    const domain = `detent.probe.${nonce}`;
    await sb(["/usr/bin/defaults", "write", domain, "k", "-string", "v"]);
    const wrote = (await host(["/usr/bin/defaults", "read", domain])).code === 0;
    await host(["/usr/bin/defaults", "delete", domain]);
    rmSync(join(realHome, "Library", "Preferences", `${domain}.plist`), { force: true });
    add("esc.defaults_write", "domain not created", wrote ? "created" : "not_created", wrote ? "fail" : "pass");
  }
  {
    const op = join(S, "open");
    copyFileSync("/usr/bin/open", op); chmodSync(op, 0o755);
    const probeArgs = ["-g", "-a", "NoSuchApp.detentprobe"];
    const reach = (r) => /Unable to find application/i.test(r.stderr);
    if (!reach(await host([op, ...probeArgs]))) add("esc.open_copy", "launchservices unreachable", "control_failed", "inconclusive", "open could not reach Launch Services even unsandboxed");
    else {
      const reached = reach(await sb([op, ...probeArgs]));
      add("esc.open_copy", "launchservices unreachable", reached ? "reachable" : "blocked", reached ? "fail" : "pass");
    }
  }
  {
    const hits = (r) => r.stdout.split("\n").filter(Boolean).length;
    const q = [markers[".ssh"].dir];
    const hostHits = hits(await host(["/usr/bin/mdfind", "-onlyin", q[0], markers[".ssh"].nonce]));
    const sbHits = hits(await sb(["/usr/bin/mdfind", "-onlyin", q[0], markers[".ssh"].nonce]));
    const works = Number((await sb(["/usr/bin/mdfind", "-count", "-name", "launchctl"])).stdout.trim()) > 0;
    if (sbHits > 0) add("esc.mdfind_marker", "0 hits", `${sbHits} hits`, "fail");
    else if (!works) add("esc.mdfind_marker", "0 hits", "mdfind_unavailable_in_sandbox", "pass");
    else if (hostHits > 0) add("esc.mdfind_marker", "0 hits", "0 hits (host finds it)", "pass");
    else add("esc.mdfind_marker", "0 hits", "0 hits (marker not indexed)", "inconclusive", "mdfind works in the sandbox but Spotlight never indexed the temp marker, so no leak could be shown");
  }
  {
    const argv = ["/usr/bin/security", "find-generic-password", "-s", "nonexistent-probe"];
    const h = await host(argv);
    if (h.code !== 44) add("esc.securityd_reachable", "unreachable", `host_rc=${h.code}`, "inconclusive", "the unsandboxed query did not report item-not-found (44)");
    else {
      const r = await sb(argv);
      add("esc.securityd_reachable", "unreachable", r.code === 44 ? "reachable(rc=44)" : `rc=${r.code}`, r.code === 44 ? "fail" : "pass");
    }
  }
  {
    const target = async (cands) => {
      let hit = 0;
      for (const c of cands) if ((await sb([process.execPath, "-e", CONNECT_JS, c])).stdout.startsWith("connected")) hit++;
      return [hit, cands.length];
    };
    const ctl = await hostConnect(extSock);
    if (!ctl) add("esc.unix_socket_harness", "blocked", "control_failed", "inconclusive", "the harness could not connect to its own socket");
    else {
      const [hit] = await target([extSock]);
      add("esc.unix_socket_harness", "blocked", hit ? "connected" : "blocked", hit ? "fail" : "pass");
    }
    const dirs = ["/var/run", join(realHome, ".docker", "run")];
    const socks = dirs.flatMap((d) => { try { return readdirSync(d).filter((f) => f.endsWith(".sock")).map((f) => join(d, f)); } catch { return []; } });
    if (!socks.length) add("esc.unix_socket_system", "0 connected", "none_present", "skipped", "no /var/run/*.sock or ~/.docker/run/*.sock on this host");
    else {
      const [hit, n] = await target(socks);
      add("esc.unix_socket_system", "0 connected", `${hit} of ${n} connected`, hit ? "fail" : "pass");
    }
  }
  {
    const psCmd = (pid) => ["/bin/ps", "-E", "-ww", "-p", String(pid), "-o", "command="];
    const hostSees = sees(await host(psCmd(process.pid)), canary);
    const self = await sb(sh("env PROBE_CTL=\"$1\" ps -E -ww -p $$ -o command=", nonce));
    const selfOk = self.stdout.includes(`PROBE_CTL=${nonce}`);
    const leak = sees(await sb(psCmd(process.pid)), canary);
    if (!hostSees) add("esc.ps_env_parent", "canary not visible", "control_failed", "inconclusive", "unsandboxed ps -E could not see the harness canary");
    else if (!leak && !selfOk) add("esc.ps_env_parent", "canary not visible", "ps_unusable_in_sandbox", "pass", "ps -E reads nothing, not even its own env");
    else add("esc.ps_env_parent", "canary not visible", leak ? "visible" : "not_visible", leak ? "fail" : "pass");
  }
  {
    const py = ["/usr/bin/python3", "-c", PROCARGS_PY, String(process.pid), canary];
    const h = await host(py);
    if (!h.stdout.includes("seen=1")) add("esc.procargs2_parent", "canary not visible", "control_failed", "inconclusive", "python3 sysctl KERN_PROCARGS2 could not read the harness env unsandboxed");
    else if ((await sb(["/usr/bin/python3", "-c", "print(1)"])).code !== 0) add("esc.procargs2_parent", "canary not visible", "python3_unusable_in_sandbox", "inconclusive", "python3 cannot start under the profile, so the sysctl was never tried");
    else {
      const r = await sb(py);
      add("esc.procargs2_parent", "canary not visible", r.stdout.includes("seen=1") ? "visible" : r.stdout.includes("seen=0") ? "not_visible" : "sysctl_denied", r.stdout.includes("seen=1") ? "fail" : "pass");
    }
  }
  {
    const h = await host(sh('kill -0 "$1"', String(process.pid)));
    if (h.code !== 0) add("esc.kill0_parent", "blocked", "control_failed", "inconclusive", "kill -0 on the harness failed unsandboxed");
    else {
      const r = await sb(sh('kill -0 "$1"', String(process.pid)));
      add("esc.kill0_parent", "blocked", r.code === 0 ? "signal_allowed" : `blocked(rc=${r.code})`, r.code === 0 ? "fail" : "pass");
    }
  }
  {
    const tty = readdirSync("/dev").filter((f) => /^ttys\d+$/.test(f)).map((f) => `/dev/${f}`)
      .find((p) => { try { return statSync(p).uid === process.getuid(); } catch { return false; } });
    if (!tty) add("esc.write_tty", "blocked", "no_owned_tty", "skipped", "no /dev/ttys* owned by this user");
    else if ((await host(sh(': > "$1"', tty))).code !== 0) add("esc.write_tty", "blocked", "control_failed", "inconclusive", "the unsandboxed open of the tty failed");
    else {
      const r = await sb(sh(': > "$1"', tty));
      add("esc.write_tty", "blocked", r.code === 0 ? "opened" : `blocked(rc=${r.code})`, r.code === 0 ? "fail" : "pass");
    }
  }

  // Network.
  {
    const hostOk = await hostConnect("1.1.1.1", 443);
    const ips = (await sb([process.execPath, "-e", CONNECT_JS, "1.1.1.1", "443"])).stdout.startsWith("connected");
    const dns = (await sb([process.execPath, "-e", CONNECT_JS, "example.com", "443"])).stdout.startsWith("connected");
    if (!hostOk) add("net.external_blocked", "blocked", "control_failed", "inconclusive", "the host could not reach 1.1.1.1:443 either");
    else add("net.external_blocked", "blocked", `ip=${ips ? "connected" : "blocked"} dns=${dns ? "connected" : "blocked"}`, ips || dns ? "fail" : "pass");
    const a = (await sb([process.execPath, "-e", CONNECT_JS, "127.0.0.1", String(allowedPort)])).stdout.startsWith("connected");
    add("net.loopback_allowed_port", "connected", a ? "connected" : "blocked", a ? "pass" : "fail");
    const o = (await sb([process.execPath, "-e", CONNECT_JS, "127.0.0.1", String(otherPort)])).stdout.startsWith("connected");
    add("net.loopback_other_port_blocked", "blocked", o ? "connected" : "blocked", o ? "fail" : "pass");
  }

  // Toolchain smoke.
  for (const [tool, args] of TOOLS) {
    const h = await host([tool, ...args]);
    const expected = h.code === 0 ? "present" : "absent";
    const r = await sb([tool, ...args]);
    const actual = r.code === 0 ? "present" : expected === "absent" ? "absent" : "blocked";
    add(`toolchain.${tool}`, expected, actual, actual === expected ? "pass" : "fail");
  }
  {
    const repo = join(S, "repo");
    mkdirSync(repo, { recursive: true });
    const hostGit = (await host(["git", "--version"])).code === 0;
    const r = await sb(sh('cd "$1" && git init -q && git -c user.name=probe -c user.email=probe@example.invalid commit --allow-empty -q -m probe && git rev-parse --verify HEAD', repo));
    add("toolchain.git_init_commit_in_scratch", hostGit ? "present" : "absent", r.code === 0 ? "present" : hostGit ? "blocked" : "absent", (r.code === 0) === hostGit ? "pass" : "fail");
  }

  await Promise.all([loopAllowed, loopOther, extServer].map((s) => new Promise((r) => s.close(r))));
  return { results: out, profileSha };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv) {
  const live = argv.includes("--live");
  const pf = await preflight();
  if (!pf.ok) {
    process.stderr.write(`sandbox_unavailable:${pf.code}: ${pf.message}\n`);
    process.stdout.write(JSON.stringify({ error: "sandbox_unavailable", code: pf.code, message: pf.message }) + "\n");
    return pf.code === "nested" ? 71 : 2;
  }
  const canary = process.env.PROBE_CANARY;
  const nonce = randomBytes(6).toString("hex");
  const realHome = realpathSync(os.homedir());
  const T = realpathSync(mkdtempSync(join(os.tmpdir(), "detent-probes-")));
  const S = join(T, "scratch");
  mkdirSync(S, { recursive: true });
  const log = (m) => process.stderr.write(`[probes] ${m}\n`);
  try {
    log("running sandbox probes");
    const { results, profileSha } = await runSandboxProbes({ T, S, realHome, canary, nonce });
    let all = results;
    if (live) {
      log("running live probes (spends up to 0.10 USD)");
      const { runLive } = await import("./live.mjs");
      all = results.concat(await runLive({ T, realHome, canary, nonce, log }));
    }
    const report = buildReport({ results: all, meta: { platform: process.platform, os_release: os.release(), node: process.version, claude_profile_base: CLAUDE_BASE_VERSION, profile_sha256_16: profileSha, live } });
    const text = JSON.stringify(report, null, 2) + "\n";
    const out = argValue(argv, "--out");
    if (out) writeFileSync(out, text);
    process.stdout.write(text);
    return report.summary.ok ? 0 : 1;
  } finally {
    if (!argv.includes("--keep")) rmSync(T, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF)) {
  if (!process.env.PROBE_CANARY) {
    const r = spawnSync(process.execPath, [SELF, ...process.argv.slice(2)], {
      stdio: "inherit", env: { ...process.env, PROBE_CANARY: randomBytes(16).toString("hex") },
    });
    process.exit(r.status ?? 1);
  }
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`probe harness error: ${e.message}\n`); process.exit(2); });
}
