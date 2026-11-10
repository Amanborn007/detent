// `curator open` must launch a tab whenever it had to (re)start the server, and must survive malformed /api/status and /api/open bodies.
import "./daemon-env.mjs";
import { stopCuratorDaemon } from "./daemon-kit.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { healthProof } from "../auth.mjs";

const CLI = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "cli.mjs");
const HTML = '<!DOCTYPE html>\n<html><body><h1>plan</h1></body></html>\n';
const cleanups = [];
after(() => { for (const fn of cleanups) fn(); });

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "curator-restore-")));
  const stateDir = path.join(root, "state");
  const bin = path.join(root, "bin");
  const log = path.join(root, "opener.log");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(bin);
  fs.writeFileSync(log, "");
  for (const name of ["open", "xdg-open"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
  }
  const artifact = path.join(root, "plan.html");
  fs.writeFileSync(artifact, HTML);
  const env = { ...process.env, CURATOR_STATE_DIR: stateDir, CURATOR_NO_CHECK: "1", CURATOR_ALLOW_BROWSER: "1", PATH: `${bin}:${process.env.PATH}` };
  delete env.CURATOR_NO_BROWSER;
  delete env.BROWSER;
  const count = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  const launches = async (expected) => {
    for (let i = 0; i < 300 && count() < expected; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 3000));
    return count();
  };
  return { root, stateDir, artifact, env, launches };
}

function run(ws) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "open", ws.artifact], { env: ws.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const lastJson = (r) => JSON.parse(r.stdout.trim().split("\n").pop());

test("a last_seen_at restored from state.json never suppresses the launch after a restart from down", async () => {
  const ws = workspace();
  cleanups.push(() => stopCuratorDaemon(ws.stateDir));
  fs.writeFileSync(path.join(ws.stateDir, "state.json"), JSON.stringify({
    pid: 2147483646, port: 1,
    sessions: { [ws.artifact]: { id: "restored1", file: ws.artifact, createdAt: new Date().toISOString(), pending: [], lastSeenAt: Date.now() - 1000 } },
  }), { mode: 0o600 });
  const r = await run(ws);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(lastJson(r).tab_live, false);
  assert.equal(await ws.launches(1), 1);
});

test("a last_seen_at restored across an untrusted-server restart never suppresses the launch", async () => {
  const ws = workspace();
  cleanups.push(() => stopCuratorDaemon(ws.stateDir));
  const first = await run(ws);
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  assert.equal(await ws.launches(1), 1);
  const u = new URL(lastJson(first).url);
  const cap = new URLSearchParams(u.hash.slice(1)).get("c");
  const res = await fetch(`${u.origin}/api/updates?s=${u.pathname.split("/").pop()}`, { headers: { "X-Curator-Cap": cap } });
  assert.equal(res.status, 200);
  // A different secret makes the running daemon fail its health proof, so open stops and restarts it.
  fs.writeFileSync(path.join(ws.stateDir, "secret"), crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const second = await run(ws);
  assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
  assert.equal(lastJson(second).tab_live, false);
  assert.equal(await ws.launches(2), 2);
});

async function stubRun(ws, { status, open }) {
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(ws.stateDir, "secret"), secret, { mode: 0o600 });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
    if (u.pathname === "/healthz") return send(200, JSON.stringify({ ok: true, pid: process.pid, boot: "b".repeat(8), proof: healthProof(secret, u.searchParams.get("nonce")) }));
    if (u.pathname === "/api/open") return open ? send(...open) : send(200, JSON.stringify({ sessionId: "abc123" }));
    if (u.pathname === "/api/status") return send(...status);
    send(404, "{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  fs.writeFileSync(path.join(ws.stateDir, "state.json"), JSON.stringify({ pid: process.pid, port: server.address().port }));
  return run(ws);
}

for (const [name, body] of [["a JSON null body", "null"], ["a non-JSON body", "<html>oops</html>"]]) {
  test(`/api/status with ${name} warns on stderr and launches without a TypeError`, async () => {
    const ws = workspace();
    const r = await stubRun(ws, { status: [200, body] });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /WARNING cannot tell whether a tab is already open/);
    assert.doesNotMatch(r.stderr, /TypeError/);
    assert.equal(await ws.launches(1), 1);
  });
}

test("/api/open failing with a JSON null body exits with a clear error, not a TypeError", async () => {
  const ws = workspace();
  const r = await stubRun(ws, { status: [200, "{}"], open: [500, "null"] });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr + r.stdout, /TypeError/);
  assert.match(r.stderr + r.stdout, /server error 500/);
});
