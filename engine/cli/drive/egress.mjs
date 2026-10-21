// Egress proxy for the setup step of `detent drive --implement`: HTTP CONNECT only,
// exact-host allowlist, port 443, DNS resolved once here and the checked IP is the one dialed.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { basename } from "node:path";

const ALLOWED_PORT = 443;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 60_000;

function v4Blocked(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseV6(ip) {
  let s = ip.split("%")[0].toLowerCase();
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

function v6Blocked(ip) {
  const g = parseV6(ip);
  if (!g) return true;
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, v4-compatible
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return true; // v4-mapped
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
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

export async function startEgressProxy({
  allowHosts = [],
  listen = { port: 0 },
  resolve = async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address),
  dial = (ip, port) => net.connect({ host: ip, port }),
  maxConnections = 16,
  maxBytesPerConnection = 512 * 1024 * 1024,
  maxTotalBytes = 2 * 1024 * 1024 * 1024,
  log = () => {},
} = {}) {
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
  };

  const server = http.createServer((req, res) => {
    refuse("method_not_allowed");
    res.writeHead(405, { "X-Detent-Refused": "method_not_allowed", Connection: "close" });
    res.end();
  });
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

    const up = dial(addrs[0], ALLOWED_PORT);
    live.add(up);
    up.on("close", () => live.delete(up));
    const entry = (hosts[host] ??= { connections: 0, bytes: 0 });
    let bytes = 0;
    let capped = false;
    const count = (n) => {
      bytes += n; entry.bytes += n; totalBytes += n;
      if (!capped && (bytes > maxBytesPerConnection || totalBytes > maxTotalBytes)) {
        capped = true;
        refuse("byte_cap", host);
        client.destroy(); up.destroy();
      }
    };
    const finish = () => { client.destroy(); up.destroy(); };
    const connectTimer = setTimeout(() => { refuse("connect_timeout", host); finish(); }, CONNECT_TIMEOUT_MS);
    up.on("error", () => { clearTimeout(connectTimer); if (client.writable && !client.destroyed && !tunnelUp) reply(client, 502, "Bad Gateway", "upstream_failed"); finish(); });
    up.on("close", () => { clearTimeout(connectTimer); client.destroy(); });
    client.on("close", () => { clearTimeout(connectTimer); up.destroy(); log(`closed host=${safe(host)} bytes=${bytes}`); });

    let tunnelUp = false;
    up.once("connect", () => {
      clearTimeout(connectTimer);
      tunnelUp = true;
      tunnels++;
      entry.connections++;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.setTimeout(IDLE_TIMEOUT_MS, finish);
      up.setTimeout(IDLE_TIMEOUT_MS, finish);
      client.on("data", (d) => count(d.length));
      up.on("data", (d) => count(d.length));
      if (head?.length) { count(head.length); up.write(head); }
      client.pipe(up);
      up.pipe(client);
    });
  });

  await new Promise((ok, fail) => {
    server.once("error", fail);
    if (listen.socket) server.listen(listen.socket, ok);
    else server.listen(listen.port ?? 0, listen.host ?? "127.0.0.1", ok);
  });

  return {
    port: listen.socket ? undefined : server.address().port,
    socket: listen.socket,
    stats: () => ({
      connections: tunnels,
      active,
      bytes: totalBytes,
      refused: { ...refused },
      hosts: Object.fromEntries(Object.entries(hosts).map(([k, v]) => [k, { ...v }])),
    }),
    close: () => new Promise((ok) => {
      for (const s of live) s.destroy();
      server.close(() => ok());
    }),
  };
}

// R9: setup runs only when the child did not touch manifests, lockfiles or registry config.
const MANIFEST_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", ".npmrc", ".yarnrc", ".yarnrc.yml", "bun.lockb", "bun.lock",
  "pipfile", "pipfile.lock", "pyproject.toml", "poetry.lock", "pip.conf", "uv.lock",
  "go.mod", "go.sum", "cargo.toml", "cargo.lock", "gemfile", "gemfile.lock", ".bundle/config",
]);
const isManifest = (p) => {
  const b = basename(p).toLowerCase();
  return MANIFEST_NAMES.has(b) || /^requirements.*\.txt$/.test(b);
};

export function isTrustedManifestChange(baseTree, headTree) {
  const changed = [];
  for (const p of new Set([...Object.keys(baseTree), ...Object.keys(headTree)])) {
    if (isManifest(p) && baseTree[p] !== headTree[p]) changed.push(p);
  }
  return { trusted: changed.length === 0, changed };
}
