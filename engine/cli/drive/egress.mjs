// Egress proxy for the setup step of `detent drive --implement`: HTTP CONNECT only, exact-host
// allowlist, port 443, DNS resolved once here and a checked IP dialed. The allowlist is SSRF
// protection, not exfil protection: an allowed registry host can still receive encoded data.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ALLOWED_PORT = 443;
const CONNECT_ATTEMPT_MS = 5_000;
const IDLE_TIMEOUT_MS = 60_000;
const REFUSED_LINGER_MS = 1_500;
const MAX_ADDRS = 4;
const MAX_HELLO = 16 * 1024 + 5;

const inV4 = (a, b, c, [x, y, z]) => a === x && (y === undefined || b === y) && (z === undefined || c === z);
function v4Blocked(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    inV4(a, b, c, [192, 0, 0]) || inV4(a, b, c, [192, 0, 2]) || inV4(a, b, c, [192, 88, 99]) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    inV4(a, b, c, [198, 51, 100]) || inV4(a, b, c, [203, 0, 113]) ||
    a >= 224
  );
}

function parseV6(ip) {
  if (ip.includes("%")) return null;
  let s = ip.toLowerCase();
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    s = dotted[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

// Allow-only: global unicast 2000::/3 minus the special-purpose blocks inside it.
function v6Blocked(ip) {
  const g = parseV6(ip);
  if (!g) return true;
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] < 0x200) return true; // IETF protocol assignments, Teredo, ORCHID
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // documentation
  return false;
}

export function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v === 6) return v6Blocked(ip);
  return true;
}

const NUMERIC_HOST = /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i;
const isIpLiteral = (h) => net.isIP(h) !== 0 || h.startsWith("[") || h.includes(":") || NUMERIC_HOST.test(h);

function parseTarget(url) {
  const m = /^\[([^\]]*)\](?::(\d+))?$/.exec(url) ?? /^([^:]*)(?::(\d+))?$/.exec(url);
  if (!m || !m[2]) return null;
  return { host: m[1].toLowerCase(), port: Number(m[2]) };
}

function validateAllowHosts(list) {
  const out = new Set();
  for (const raw of list) {
    const h = String(raw).trim().toLowerCase();
    if (!h) throw new Error("egress: empty host in allowHosts");
    if (h.includes("*")) throw new Error(`egress: wildcard host not allowed: ${h}`);
    if (isIpLiteral(h)) throw new Error(`egress: IP literal not allowed in allowHosts: ${h}`);
    if (/[/\s]/.test(h)) throw new Error(`egress: invalid host in allowHosts: ${h}`);
    out.add(h);
  }
  return out;
}

const safe = (s) => JSON.stringify(String(s).slice(0, 80));

// Returns {sni, ech} for a complete first TLS record, null when more bytes are needed, or {error}.
export function parseClientHello(buf) {
  if (buf.length < 5) return buf.length && buf[0] !== 0x16 ? { error: "not_tls" } : null;
  if (buf[0] !== 0x16 || buf[1] !== 3) return { error: "not_tls" };
  const recLen = buf.readUInt16BE(3);
  if (recLen > MAX_HELLO) return { error: "not_tls" };
  if (buf.length < 5 + recLen) return null;
  const bad = { error: "not_tls" };
  let p = 5;
  const end = 5 + recLen;
  if (recLen < 4 || buf[p] !== 1) return bad;
  const hsLen = buf.readUIntBE(p + 1, 3);
  p += 4;
  if (p + hsLen > end) return bad;
  p += 2 + 32;
  const need = (n) => p + n <= end;
  if (!need(1)) return bad;
  p += 1 + buf[p];
  if (!need(2)) return bad;
  p += 2 + buf.readUInt16BE(p);
  if (!need(1)) return bad;
  p += 1 + buf[p];
  if (!need(2)) return bad;
  const extEnd = p + 2 + buf.readUInt16BE(p);
  p += 2;
  if (extEnd > end) return bad;
  let sni = null;
  let ech = false;
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    const body = p + 4;
    if (body + len > extEnd) return bad;
    if (type === 0xfe0d || type === 0xffce) ech = true;
    if (type === 0) {
      if (len < 5 || buf.readUInt16BE(body) !== len - 2 || buf[body + 2] !== 0) return bad;
      const nameLen = buf.readUInt16BE(body + 3);
      if (5 + nameLen !== len) return bad;
      sni = buf.toString("latin1", body + 5, body + 5 + nameLen).toLowerCase();
    }
    p = body + len;
  }
  return { sni, ech };
}

function dialOne(dial, ip, timeoutMs, live) {
  return new Promise((ok) => {
    let sock;
    try {
      sock = dial(ip, ALLOWED_PORT);
    } catch {
      return ok(null);
    }
    live.add(sock);
    const done = (good) => {
      clearTimeout(timer);
      sock.removeListener("connect", onOk);
      sock.removeListener("error", onBad);
      if (!good) { sock.destroy(); live.delete(sock); }
      ok(good ? sock : null);
    };
    const onOk = () => done(true);
    const onBad = () => done(false);
    const timer = setTimeout(onBad, timeoutMs);
    sock.once("connect", onOk);
    sock.once("error", onBad);
    sock.once("close", () => live.delete(sock));
  });
}

export async function startEgressProxy({
  allowHosts = [],
  listen,
  resolve = async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address),
  dial,
  requireSni = dial === undefined,
  maxConnections = 16,
  maxBytesPerConnection = 512 * 1024 * 1024,
  maxTotalBytes = 2 * 1024 * 1024 * 1024,
  maxTunnelMs = 30 * 60 * 1000,
  handshakeTimeoutMs = 10_000,
  log = () => {},
} = {}) {
  const dialFn = dial ?? ((ip, port) => net.connect({ host: ip, port }));
  const allowed = validateAllowHosts(allowHosts);
  const refused = {};
  const hosts = {};
  const live = new Set();
  let active = 0;
  let tunnels = 0;
  let totalBytes = 0;

  const refuse = (reason, host) => {
    refused[reason] = (refused[reason] ?? 0) + 1;
    log(`refused reason=${reason} host=${safe(host ?? "")}`);
  };
  const reply = (sock, code, text, reason) => {
    if (sock.writable) sock.end(`HTTP/1.1 ${code} ${text}\r\nX-Detent-Refused: ${reason}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => sock.destroy(), REFUSED_LINGER_MS).unref();
  };

  const server = http.createServer({ connectionsCheckingInterval: 500 }, (req, res) => {
    refuse("method_not_allowed");
    res.writeHead(405, { "X-Detent-Refused": "method_not_allowed", Connection: "close" });
    res.end();
    setTimeout(() => req.socket.destroy(), REFUSED_LINGER_MS).unref();
  });
  server.maxConnections = maxConnections * 2 + 8;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.on("clientError", (_e, sock) => sock.destroy());

  server.on("connect", async (req, client, head) => {
    live.add(client);
    client.on("close", () => live.delete(client));
    client.on("error", () => {});
    const target = parseTarget(req.url ?? "");
    if (!target) return (refuse("bad_target", req.url), reply(client, 400, "Bad Request", "bad_target"));
    const { host, port } = target;
    if (isIpLiteral(host)) return (refuse("ip_literal", host), reply(client, 403, "Forbidden", "ip_literal"));
    if (!allowed.has(host)) return (refuse("host_not_allowed", host), reply(client, 403, "Forbidden", "host_not_allowed"));
    if (port !== ALLOWED_PORT) return (refuse("port_not_allowed", host), reply(client, 403, "Forbidden", "port_not_allowed"));
    if (active >= maxConnections) return (refuse("too_many_connections", host), reply(client, 503, "Service Unavailable", "too_many_connections"));

    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    client.on("close", release);

    let addrs;
    try {
      addrs = await resolve(host);
    } catch {
      release();
      return (refuse("resolve_failed", host), reply(client, 502, "Bad Gateway", "resolve_failed"));
    }
    if (!addrs?.length || addrs.some(isBlockedAddress)) {
      release();
      return (refuse("blocked_address", host), reply(client, 403, "Forbidden", "blocked_address"));
    }
    if (client.destroyed) return release();

    let up = null;
    for (const ip of addrs.slice(0, MAX_ADDRS)) {
      up = await dialOne(dialFn, ip, CONNECT_ATTEMPT_MS, live);
      if (up || client.destroyed) break;
    }
    if (!up || client.destroyed) {
      up?.destroy();
      release();
      return (refuse("upstream_failed", host), reply(client, 502, "Bad Gateway", "upstream_failed"));
    }

    const entry = (hosts[host] ??= { connections: 0, bytes: 0 });
    const timers = [];
    let bytes = 0;
    let capped = false;
    const finish = () => { client.destroy(); up.destroy(); };
    const fail = (reason) => { refuse(reason, host); finish(); };
    const count = (n) => {
      bytes += n; entry.bytes += n; totalBytes += n;
      if (!capped && (bytes > maxBytesPerConnection || totalBytes > maxTotalBytes)) {
        capped = true;
        fail("byte_cap");
      }
    };
    up.on("error", finish);
    up.on("close", () => client.destroy());
    client.on("close", () => {
      timers.forEach(clearTimeout);
      up.destroy();
      log(`closed host=${safe(host)} bytes=${bytes}`);
    });

    tunnels++;
    entry.connections++;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    timers.push(setTimeout(() => fail("lifetime"), maxTunnelMs));
    client.setTimeout(IDLE_TIMEOUT_MS, finish);
    up.setTimeout(IDLE_TIMEOUT_MS, finish);

    const open = (first) => {
      client.on("data", (d) => count(d.length));
      up.on("data", (d) => count(d.length));
      if (first?.length) { count(first.length); up.write(first); }
      client.pipe(up);
      up.pipe(client);
    };

    if (!requireSni) return open(head);

    let buf = Buffer.from(head ?? []);
    const gather = (d) => {
      buf = Buffer.concat([buf, d]);
      check();
    };
    const check = () => {
      const r = parseClientHello(buf);
      if (r === null) return;
      client.removeListener("data", gather);
      clearTimeout(hsTimer);
      if (r.error) return fail(r.error);
      if (r.ech) return fail("ech_present");
      if (!r.sni) return fail("sni_missing");
      if (r.sni !== host) return fail("sni_mismatch");
      open(buf);
    };
    const hsTimer = setTimeout(() => { client.removeListener("data", gather); fail("handshake_timeout"); }, handshakeTimeoutMs);
    timers.push(hsTimer);
    client.on("data", gather);
    check();
  });

  let sockDir = null;
  let socketPath = listen?.socket;
  if (!listen) {
    sockDir = mkdtempSync(join(tmpdir(), "detent-egress-"));
    socketPath = join(sockDir, "proxy.sock");
  }
  await new Promise((ok, fail) => {
    server.once("error", fail);
    if (socketPath) server.listen(socketPath, ok);
    else server.listen(listen.port ?? 0, listen.host ?? "127.0.0.1", ok);
  });
  if (socketPath) chmodSync(socketPath, 0o600);

  return {
    port: socketPath ? undefined : server.address().port,
    socket: socketPath,
    stats: () => ({
      connections: tunnels,
      active,
      bytes: totalBytes,
      refused: { ...refused },
      hosts: Object.fromEntries(Object.entries(hosts).map(([k, v]) => [k, { ...v }])),
    }),
    close: () => new Promise((ok) => {
      for (const s of live) s.destroy();
      server.close(() => {
        if (sockDir) rmSync(sockDir, { recursive: true, force: true });
        ok();
      });
    }),
  };
}

// Advisory only: a child edit to any of these means the child changed what setup would run.
// Setup itself always runs in prepareSetupWorkdir's base-tree export, never in the child's clone.
const MANIFEST_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", ".pnp.cjs", ".pnp.loader.mjs", "bun.lockb", "bun.lock", "bunfig.toml",
  "deno.json", "deno.jsonc", "deno.lock", "pipfile", "pipfile.lock", "pyproject.toml", "poetry.lock", "uv.lock", "uv.toml",
  "pip.conf", "pip.ini", "setup.py", "setup.cfg", "go.mod", "go.sum", "go.work", "go.work.sum", "cargo.toml", "cargo.lock",
  "rust-toolchain", "rust-toolchain.toml", "gemfile", "gemfile.lock", "gems.rb", "gems.locked",
  ".tool-versions", ".nvmrc", ".node-version", ".python-version", ".mise.toml", "mise.toml",
]);
function isManifest(path) {
  const p = path.toLowerCase();
  const b = basename(p);
  const segs = p.split("/");
  return (
    MANIFEST_NAMES.has(b) ||
    /^(requirements|constraints).*\.txt$/.test(b) ||
    b.endsWith(".gemspec") ||
    segs.includes(".yarn") || segs.includes(".cargo") ||
    p === ".bundle/config" || p.endsWith("/.bundle/config") ||
    (segs.at(-2) === "requirements" && b.endsWith(".txt"))
  );
}

export function manifestChangesSinceBase(baseTree, headTree) {
  const changed = [];
  for (const p of new Set([...Object.keys(baseTree), ...Object.keys(headTree)])) {
    if (isManifest(p) && baseTree[p] !== headTree[p]) changed.push(p);
  }
  return changed.sort();
}

export function isTrustedManifestChange(baseTree, headTree) {
  const changed = manifestChangesSinceBase(baseTree, headTree);
  return { trusted: changed.length === 0, changed };
}

const GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false"];
const GIT_ENV = () => ({
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
});
function git(repo, args, input) {
  const r = spawnSync("git", [...GIT_FLAGS, "-C", repo, ...args], { env: GIT_ENV(), input, maxBuffer: 1 << 30, shell: false });
  if (r.error) throw r.error;
  return r;
}

// Exports the trusted base commit's tree into a fresh 0700 dir with plumbing only: no checkout,
// no attributes or filters, no symlinks or submodules. Setup must run here, never in the child's clone.
export function prepareSetupWorkdir({ repo, baseCommit, dest }) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(baseCommit))) throw new Error("egress: baseCommit must be a full commit id");
  const kind = git(repo, ["cat-file", "-t", baseCommit]);
  if (kind.status !== 0 || kind.stdout.toString().trim() !== "commit") throw new Error("egress: baseCommit is not a commit in repo");
  const ls = git(repo, ["ls-tree", "-r", "-z", "--full-tree", baseCommit]);
  if (ls.status !== 0) throw new Error(`egress: git ls-tree failed: ${ls.stderr.toString().trim()}`);

  const wanted = [];
  const skipped = [];
  for (const rec of ls.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(rec);
    if (!m) throw new Error("egress: unparseable ls-tree entry");
    const [, mode, type, sha, path] = m;
    const segs = path.split("/");
    if (mode === "120000") skipped.push({ path, reason: "symlink" });
    else if (type !== "blob") skipped.push({ path, reason: "submodule" });
    else if (path.startsWith("/") || segs.some((s) => s === "" || s === "." || s === "..")) skipped.push({ path, reason: "unsafe_path" });
    else if (segs.some((s) => s.toLowerCase() === ".git")) skipped.push({ path, reason: "git_dir" });
    else wanted.push({ mode, sha, path });
  }

  try {
    mkdirSync(dest, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`egress: dest already exists: ${dest}`);
    throw e;
  }
  chmodSync(dest, 0o700);

  const blobs = new Map();
  if (wanted.length) {
    const cat = git(repo, ["cat-file", "--batch"], wanted.map((w) => w.sha).join("\n") + "\n");
    if (cat.status !== 0) throw new Error(`egress: git cat-file failed: ${cat.stderr.toString().trim()}`);
    let p = 0;
    const out = cat.stdout;
    for (const w of wanted) {
      const nl = out.indexOf(10, p);
      const [sha, type, size] = out.toString("latin1", p, nl).split(" ");
      if (type !== "blob" || sha !== w.sha) throw new Error("egress: unexpected cat-file output");
      blobs.set(w.path, out.subarray(nl + 1, nl + 1 + Number(size)));
      p = nl + 1 + Number(size) + 1;
    }
  }
  const files = [];
  for (const w of wanted) {
    const target = join(dest, w.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, blobs.get(w.path), { flag: "wx", mode: w.mode === "100755" ? 0o755 : 0o644 });
    if (w.mode === "100755") chmodSync(target, 0o755);
    files.push(w.path);
  }
  return { dest, files, skipped };
}
