// `curator open` must not launch a second browser tab while a tab for the same artifact is still ticking /api/updates.
// A stub `open`/`xdg-open` first on PATH records launches, so no real browser is ever started.
import "./daemon-env.mjs";
import { stopCuratorDaemon } from "./daemon-kit.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "curator-live-")));
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
  // The CLI spawns the opener detached, so wait for the expected launches, then give a stray extra one time to land.
  const launches = async (expected) => {
    for (let i = 0; i < 60 && count() < expected; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    return count();
  };
  return { root, stateDir, artifact, env, launches };
}

function open(ws) {
  const r = spawnSync(process.execPath, [CLI, "open", ws.artifact], { encoding: "utf8", env: ws.env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return { json: JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
}

// What the page does: tick /api/updates with the session key from the URL fragment.
async function tick(url) {
  const u = new URL(url);
  const cap = new URLSearchParams(u.hash.slice(1)).get("c");
  const sid = u.pathname.split("/").pop();
  const res = await fetch(`${u.origin}/api/updates?s=${sid}`, { headers: { "X-Curator-Cap": cap } });
  assert.equal(res.status, 200);
}

test("a tab that ticked recently is reused, not reopened", async () => {
  const ws = workspace();
  cleanups.push(() => stopCuratorDaemon(ws.stateDir));
  const first = open(ws);
  assert.equal(await ws.launches(1), 1);
  await tick(first.json.url);
  const second = open(ws);
  assert.equal(second.json.tab_live, true);
  assert.equal(await ws.launches(1), 1, "no second launch while the tab is live");
});

test("a session no tab has ticked is launched again", async () => {
  const ws = workspace();
  cleanups.push(() => stopCuratorDaemon(ws.stateDir));
  open(ws);
  const second = open(ws);
  assert.equal(second.json.tab_live, false);
  assert.equal(await ws.launches(2), 2);
});

test("a status response without last_seen_at warns on stderr and launches", async () => {
  const ws = workspace();
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(ws.stateDir, "secret"), secret, { mode: 0o600 });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/healthz") return send({ ok: true, pid: process.pid, boot: "b".repeat(8), proof: healthProof(secret, u.searchParams.get("nonce")) });
    if (u.pathname === "/api/open") return send({ sessionId: "abc123" });
    if (u.pathname === "/api/status") return send({ pid: process.pid, sessions: [{ key: ws.artifact }] });
    res.writeHead(404); res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  fs.writeFileSync(path.join(ws.stateDir, "state.json"), JSON.stringify({ pid: process.pid, port: server.address().port }));
  // Async: the stub server lives in this process, so a blocking spawn would starve it.
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "open", ws.artifact], { env: ws.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /last_seen_at/);
  assert.equal(await ws.launches(1), 1);
});
