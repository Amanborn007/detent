import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, statSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const egress = await import("../drive/egress.mjs").catch((e) => ({ loadError: e }));
const need = () => { if (egress.loadError) throw egress.loadError; return egress; };

// ---- helpers -------------------------------------------------------------
function upstream() {
  return new Promise((res) => {
    const seen = [];
    const srv = net.createServer((s) => { s.on("data", (d) => { seen.push(d.length); s.write(d); }); s.on("error", () => {}); });
    srv.listen(0, "127.0.0.1", () => res({ srv, port: srv.address().port, seen }));
  });
}
async function boot(over = {}) {
  const { startEgressProxy } = need();
  const up = await upstream();
  const dialed = [];
  const addrs = over.addrs ?? ["93.184.216.34"];
  const proxy = await startEgressProxy({
    allowHosts: ["registry.example.test"],
    listen: over.listen ?? { port: 0 },
    resolve: async () => addrs,
    dial: over.dial ?? ((ip, port) => { dialed.push([ip, port]); return net.connect(up.port, "127.0.0.1"); }),
    requireSni: true,
    ...over.opts,
  });
  return { proxy, up, dialed, close: async () => { await proxy.close(); up.srv.close(); } };
}
function connectVia(target, line) {
  return new Promise((res) => {
    const s = typeof target === "string" ? net.connect(target) : net.connect(target, "127.0.0.1");
    s.on("connect", () => s.write(line));
    let buf = "";
    s.on("data", (d) => { buf += d; if (buf.includes("\r\n\r\n")) res({ s, head: buf }); });
    s.on("close", () => res({ s, head: buf }));
    s.on("error", () => {});
  });
}
const CONNECT = (t) => `CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`;
const status = (h) => Number(h.split(" ")[1]);
const u16 = (n) => Buffer.from([n >> 8, n & 255]);
function clientHello(sni, { ech = false } = {}) {
  const exts = [];
  if (sni) {
    const name = Buffer.from(sni);
    const list = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    exts.push(Buffer.concat([u16(0), u16(list.length + 2), u16(list.length), list]));
  }
  if (ech) exts.push(Buffer.concat([u16(0xfe0d), u16(0)]));
  const extBuf = Buffer.concat(exts);
  const body = Buffer.concat([u16(0x0303), Buffer.alloc(32, 7), Buffer.from([0]), u16(2), u16(0x1301), Buffer.from([1, 0]), u16(extBuf.length), extBuf]);
  const hs = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);
}
const closes = (s, ms = 3000) => new Promise((r) => { const t = setTimeout(() => r(false), ms); s.on("close", () => { clearTimeout(t); r(true); }); });

// ---- M4: SNI -------------------------------------------------------------
test("ClientHello whose SNI matches the CONNECT host is forwarded", async () => {
  const t = await boot();
  const { s, head } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  assert.equal(status(head), 200);
  const hello = clientHello("registry.example.test");
  const echoed = new Promise((r) => s.once("data", r));
  s.write(hello.subarray(0, 10));
  await new Promise((r) => setTimeout(r, 20));
  s.write(hello.subarray(10));
  assert.deepEqual(await echoed, hello);
  s.destroy();
  await t.close();
});

for (const [name, hello, reason] of [
  ["a different SNI", clientHello("other.example.test"), "sni_mismatch"],
  ["no SNI", clientHello(null), "sni_missing"],
  ["an ECH extension", clientHello("registry.example.test", { ech: true }), "ech_present"],
  ["non-TLS bytes", Buffer.from("GET / HTTP/1.1\r\n\r\n"), "not_tls"],
]) {
  test(`${name} after CONNECT is destroyed with zero upstream bytes`, async () => {
    const t = await boot();
    const { s } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
    const closed = closes(s);
    s.write(hello);
    assert.equal(await closed, true);
    assert.deepEqual(t.up.seen, []);
    assert.equal(t.proxy.stats().refused[reason], 1);
    await t.close();
  });
}

test("a silent client after CONNECT is dropped by the handshake timeout", async () => {
  const t = await boot({ opts: { handshakeTimeoutMs: 200 } });
  const { s } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  assert.equal(await closes(s, 2000), true);
  assert.equal(t.proxy.stats().refused.handshake_timeout, 1);
  await t.close();
});

// ---- L1: lifetimes ---------------------------------------------------------
test("a refused socket that never closes is destroyed within 2s", async () => {
  const t = await boot();
  const { s } = await connectVia(t.proxy.port, CONNECT("other.example.test:443"));
  assert.equal(await closes(s, 2500), true);
  await t.close();
});

test("absolute tunnel lifetime tears the tunnel down", async () => {
  const t = await boot({ opts: { maxTunnelMs: 150 } });
  const { s } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  s.write(clientHello("registry.example.test"));
  assert.equal(await closes(s, 2000), true);
  assert.equal(t.proxy.stats().refused.lifetime, 1);
  await t.close();
});

// ---- L2: allow-only addresses ------------------------------------------------
test("isBlockedAddress is allow-only global unicast", () => {
  const { isBlockedAddress } = need();
  for (const ip of [
    "::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "100::1", "2001:2::1", "2001:10::1", "2001:20::1", "3fff::1",
    "4000::1", "64:ff9b:1::a00:1", "fe80::1%lo0", "::", "0.0.0.0",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "192.88.99.1", "255.255.255.255", "not-an-ip",
  ]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4001::1"]) assert.equal(isBlockedAddress(ip), false, ip);
});

// ---- L3: address fallback --------------------------------------------------
test("a failing first address falls through to the next checked address", async () => {
  const dead = net.createServer(); await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
  const up = await upstream();
  const dialed = [];
  const t = await boot({
    addrs: ["93.184.216.35", "93.184.216.34"],
    dial: (ip) => { dialed.push(ip); return net.connect(ip === "93.184.216.35" ? deadPort : up.port, "127.0.0.1"); },
  });
  const { s, head } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  assert.equal(status(head), 200);
  assert.deepEqual(dialed, ["93.184.216.35", "93.184.216.34"]);
  s.destroy(); up.srv.close();
  await t.close();
});

// ---- L5: unix socket ---------------------------------------------------------
test("listen.socket is created 0600 and tunnels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "egsock-"));
  const sock = join(dir, "p.sock");
  const t = await boot({ listen: { socket: sock } });
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  assert.equal(t.proxy.socket, sock);
  const { s, head } = await connectVia(sock, CONNECT("registry.example.test:443"));
  assert.equal(status(head), 200);
  s.destroy();
  await t.close();
});

test("with no listen option the proxy prefers a private unix socket", async () => {
  const { startEgressProxy } = need();
  const p = await startEgressProxy({ allowHosts: [] });
  assert.ok(p.socket && p.port === undefined);
  assert.equal(statSync(p.socket).mode & 0o777, 0o600);
  const sockPath = p.socket;
  await p.close();
  assert.equal(existsSync(sockPath), false);
});

// ---- H1/H2: advisory names ---------------------------------------------------
test("manifestChangesSinceBase flags every manifest-like name", () => {
  const { manifestChangesSinceBase } = need();
  const names = [
    ".bundle/config", "sub/.bundle/config", ".cargo/config.toml", ".cargo/config", "a/.cargo/config.toml",
    ".yarn/releases/yarn.cjs", ".yarn/plugins/p.cjs", ".pnpmfile.cjs", ".pnp.cjs", "setup.py", "setup.cfg", "x.gemspec",
    "gems.rb", "go.work", "rust-toolchain.toml", "rust-toolchain", "bunfig.toml", "constraints.txt", "constraints-dev.txt",
    "deps/requirements/base.txt", "requirements/dev.txt", "requirements-dev.txt", "pip.ini", "uv.toml", ".tool-versions",
    ".nvmrc", ".node-version", ".python-version", ".mise.toml", "deno.json", "package.json", "pnpm-lock.yaml", ".npmrc",
  ];
  for (const p of names) assert.deepEqual(manifestChangesSinceBase({}, { [p]: "evil" }), [p], p);
  assert.deepEqual(manifestChangesSinceBase({ "src/a.js": "1" }, { "src/a.js": "2", "README.md": "x", "patches/x.patch": "y" }), []);
  assert.deepEqual(manifestChangesSinceBase({ "package.json": "a" }, { "package.json": "a" }), []);
});

// ---- H1/H2: trusted workdir ----------------------------------------------------
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "egrepo-"));
  git(repo, "init", "-q");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "package.json"), '{"name":"x"}');
  writeFileSync(join(repo, "src/a.js"), "console.log(1)\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n*.js export-ignore\n");
  symlinkSync("/etc/passwd", join(repo, "link"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}
const walk = (d, p = "") => readdirSync(join(d, p), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d, join(p, e.name)) : [join(p, e.name)]));

test("prepareSetupWorkdir exports only the base tree into a fresh 0700 dir", () => {
  const { prepareSetupWorkdir } = need();
  const { repo, base } = makeRepo();
  writeFileSync(join(repo, ".npmrc"), "registry=https://evil.example/\n");
  writeFileSync(join(repo, "package.json"), '{"name":"CHILD-EDIT"}');
  mkdirSync(join(repo, ".git/hooks"), { recursive: true });
  const dest = join(mkdtempSync(join(tmpdir(), "egdest-")), "work");
  const out = prepareSetupWorkdir({ repo, baseCommit: base, dest });
  assert.equal(statSync(dest).mode & 0o777, 0o700);
  assert.deepEqual(walk(dest).sort(), [".gitattributes", "package.json", "run.sh", "src/a.js"]);
  assert.equal(readFileSync(join(dest, "package.json"), "utf8"), '{"name":"x"}');
  assert.equal(readFileSync(join(dest, "src/a.js"), "utf8"), "console.log(1)\n");
  assert.equal(statSync(join(dest, "run.sh")).mode & 0o111, 0o111);
  assert.equal(existsSync(join(dest, ".npmrc")), false);
  assert.equal(existsSync(join(dest, ".git")), false);
  assert.deepEqual(out.skipped, [{ path: "link", reason: "symlink" }]);
});

test("prepareSetupWorkdir refuses an existing dest and a malformed commit", () => {
  const { prepareSetupWorkdir } = need();
  const { repo, base } = makeRepo();
  const parent = mkdtempSync(join(tmpdir(), "egdest-"));
  assert.throws(() => prepareSetupWorkdir({ repo, baseCommit: base, dest: parent }), /exist/i);
  assert.throws(() => prepareSetupWorkdir({ repo, baseCommit: "--output=/tmp/x", dest: join(parent, "w") }), /commit/i);
  assert.throws(() => prepareSetupWorkdir({ repo, baseCommit: "0".repeat(40), dest: join(parent, "w2") }), /commit/i);
});
