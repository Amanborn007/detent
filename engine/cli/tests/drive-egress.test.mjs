import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

const egress = await import("../drive/egress.mjs").catch((e) => ({ loadError: e }));
const need = () => { if (egress.loadError) throw egress.loadError; return egress; };

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
  const resolved = [];
  const table = over.table ?? { "registry.example.test": ["93.184.216.34"] };
  const proxy = await startEgressProxy({
    allowHosts: over.allowHosts ?? ["registry.example.test"],
    listen: { port: 0 },
    resolve: async (h) => { resolved.push(h); const a = table[h]; if (!a) throw new Error("ENOTFOUND"); return typeof a === "function" ? a() : a; },
    dial: (ip, port) => { dialed.push([ip, port]); return net.connect(up.port, "127.0.0.1"); },
    ...over.opts,
  });
  const close = async () => { await proxy.close(); up.srv.close(); };
  return { proxy, up, dialed, resolved, close };
}

function connectVia(port, line) {
  return new Promise((res) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(line));
    let buf = "";
    s.on("data", (d) => { buf += d; if (buf.includes("\r\n\r\n")) res({ s, head: buf }); });
    s.on("close", () => res({ s, head: buf }));
    s.on("error", () => {});
  });
}
const status = (h) => Number(h.split(" ")[1]);
const CONNECT = (t) => `CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`;

test("allowed host tunnels bytes to the checked IP, resolving once", async () => {
  const t = await boot();
  const { s, head } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  assert.equal(status(head), 200);
  const echoed = new Promise((r) => s.once("data", r));
  s.write("hello");
  assert.equal((await echoed).toString(), "hello");
  s.destroy();
  assert.deepEqual(t.dialed, [["93.184.216.34", 443]]);
  assert.equal(t.resolved.length, 1);
  await t.close();
});

test("refusals are counted by reason and never dial", async () => {
  const cases = [
    ["other.example.test:443", "host_not_allowed"],
    ["registry.example.test:80", "port_not_allowed"],
    ["127.0.0.1:443", "ip_literal"],
    ["[::1]:443", "ip_literal"],
    ["169.254.169.254:443", "ip_literal"],
    ["2130706433:443", "ip_literal"],
    ["registry.example.test.:443", "host_not_allowed"],
    ["registry.example.test:8443", "port_not_allowed"],
  ];
  const t = await boot();
  for (const [target, reason] of cases) {
    const { s, head } = await connectVia(t.proxy.port, CONNECT(target));
    assert.equal(status(head), 403, target);
    assert.match(head, new RegExp(`X-Detent-Refused: ${reason}`), target);
    s.destroy();
  }
  assert.deepEqual(t.dialed, []);
  const st = t.proxy.stats();
  assert.equal(st.refused.ip_literal, 4);
  assert.equal(st.refused.host_not_allowed, 2);
  assert.equal(st.refused.port_not_allowed, 2);
  await t.close();
});

test("non-CONNECT and absolute-form requests are refused", async () => {
  const t = await boot();
  for (const line of ["GET http://registry.example.test/ HTTP/1.1\r\nHost: registry.example.test\r\n\r\n", "POST / HTTP/1.1\r\nHost: x\r\n\r\n"]) {
    const { s, head } = await connectVia(t.proxy.port, line);
    assert.equal(status(head), 405);
    s.destroy();
  }
  assert.equal(t.proxy.stats().refused.method_not_allowed, 2);
  await t.close();
});

test("empty allowHosts refuses everything", async () => {
  const t = await boot({ allowHosts: [] });
  const { s, head } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  assert.equal(status(head), 403);
  s.destroy();
  await t.close();
});

test("wildcard and IP-literal entries in allowHosts are rejected at startup", async () => {
  const { startEgressProxy } = need();
  await assert.rejects(startEgressProxy({ allowHosts: ["*.example.test"], listen: { port: 0 } }), /wildcard/i);
  await assert.rejects(startEgressProxy({ allowHosts: ["1.2.3.4"], listen: { port: 0 } }), /literal/i);
});

for (const [name, addr] of [
  ["loopback", "127.0.0.1"], ["rfc1918 10/8", "10.1.2.3"], ["rfc1918 172.16/12", "172.20.0.1"],
  ["rfc1918 192.168/16", "192.168.1.1"], ["cgnat", "100.64.0.5"], ["link-local", "169.254.1.1"],
  ["metadata", "169.254.169.254"], ["multicast", "224.0.0.1"], ["unspecified", "0.0.0.0"],
  ["v6 loopback", "::1"], ["v6 ula", "fd12:3456::1"], ["v6 link-local", "fe80::1"],
  ["v6 multicast", "ff02::1"], ["v4-mapped", "::ffff:8.8.8.8"], ["v4-mapped hex", "::ffff:0808:0808"],
]) {
  test(`DNS answer in ${name} (${addr}) is refused`, async () => {
    const t = await boot({ table: { "registry.example.test": [addr] } });
    const { s, head } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
    assert.equal(status(head), 403);
    assert.match(head, /X-Detent-Refused: blocked_address/);
    s.destroy();
    assert.deepEqual(t.dialed, []);
    await t.close();
  });
}

test("one bad address among several refuses the whole answer", async () => {
  const t = await boot({ table: { "registry.example.test": ["93.184.216.34", "127.0.0.1"] } });
  const { s, head } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  assert.equal(status(head), 403);
  s.destroy();
  assert.deepEqual(t.dialed, []);
  await t.close();
});

test("rebinding answer on a second lookup cannot reach the dial", async () => {
  let n = 0;
  const t = await boot({ table: { "registry.example.test": () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]) } });
  const { s } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  s.destroy();
  assert.deepEqual(t.dialed, [["93.184.216.34", 443]]);
  assert.equal(n, 1);
  await t.close();
});

test("unresolvable host gets 502 and a counted reason", async () => {
  const t = await boot({ allowHosts: ["registry.example.test", "nx.example.test"] });
  const { s, head } = await connectVia(t.proxy.port, CONNECT("nx.example.test:443"));
  assert.equal(status(head), 502);
  s.destroy();
  assert.equal(t.proxy.stats().refused.resolve_failed, 1);
  await t.close();
});

test("concurrent connection cap refuses the extra tunnel", async () => {
  const t = await boot({ opts: { maxConnections: 1 } });
  const a = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  assert.equal(status(a.head), 200);
  const b = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  assert.equal(status(b.head), 503);
  assert.equal(t.proxy.stats().refused.too_many_connections, 1);
  a.s.destroy(); b.s.destroy();
  await t.close();
});

test("byte cap tears the tunnel down", async () => {
  const t = await boot({ opts: { maxBytesPerConnection: 10 } });
  const { s } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  const closed = new Promise((r) => s.on("close", r));
  s.write("x".repeat(64));
  await closed;
  assert.equal(t.proxy.stats().refused.byte_cap, 1);
  await t.close();
});

test("stats and log carry host and byte counts only", async () => {
  const lines = [];
  const t = await boot({ opts: { log: (l) => lines.push(l) } });
  const { s } = await connectVia(t.proxy.port, CONNECT("registry.example.test:443"));
  const closed = new Promise((r) => s.on("close", r));
  s.write("abcd");
  await new Promise((r) => s.once("data", r));
  s.end();
  await closed;
  await new Promise((r) => setTimeout(r, 30));
  const st = t.proxy.stats();
  assert.equal(st.hosts["registry.example.test"].bytes, 8);
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.doesNotMatch(l, /abcd|93\.184/);
  await t.close();
});

test("isTrustedManifestChange flags manifest and lockfile edits", () => {
  const { isTrustedManifestChange } = need();
  const base = { "package.json": "a", "package-lock.json": "b", "src/x.js": "1", ".npmrc": "n" };
  assert.deepEqual(isTrustedManifestChange(base, { ...base, "src/x.js": "2", "src/y.js": "3" }), { trusted: true, changed: [] });
  const r = isTrustedManifestChange(base, { ...base, "package.json": "z", "sub/go.sum": "q" });
  assert.equal(r.trusted, false);
  assert.deepEqual(r.changed.sort(), ["package.json", "sub/go.sum"]);
  assert.equal(isTrustedManifestChange(base, { ...base, ".npmrc": "evil" }).trusted, false);
  const del = { ...base }; delete del["package-lock.json"];
  assert.equal(isTrustedManifestChange(base, del).trusted, false);
});
