// Opt-in live test: DETENT_LIVE_HOSTBOX=1 runs the host box for real (no spend). It needs an
// unsandboxed terminal on macOS (sandbox-exec cannot nest) or Linux with bwrap and user namespaces:
//   DETENT_LIVE_HOSTBOX=1 node --test engine/cli/tests/drive-hostbox-live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { runInHostbox, detectNested } from "../drive/hostbox.mjs";
import { bundleExportArgv } from "../drive/bundle.mjs";
import { resolveGit } from "../drive/gitsafe.mjs";

const SELF_DIR = new URL(".", import.meta.url).pathname;

function skipReason() {
  if (process.env.DETENT_LIVE_HOSTBOX !== "1") return "set DETENT_LIVE_HOSTBOX=1 to run";
  if (process.platform !== "darwin" && process.platform !== "linux") return `unsupported platform ${process.platform}`;
  const n = detectNested({ platform: process.platform });
  if (n.nested) return `this shell is already inside a sandbox (${n.detail}); run from an unsandboxed terminal`;
  return false;
}

const reason = skipReason();
if (reason) process.stderr.write(`[drive-hostbox-live] skipped: ${reason}\n`);
const live = (name, fn) => test(name, { skip: reason || false }, fn);

const platform = process.platform;
const mkBox = () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "hostbox-live-")));
  for (const d of ["work", "tmp", "home", "cache", "out"]) mkdirSync(join(box, d));
  return box;
};
const run = (box, cmd, args, o = {}) => runInHostbox({ platform, box, cmd, args, cwd: join(box, "work"), net: "none", timeoutMs: 30_000, ...o });
const sh = (box, script, o) => run(box, "/bin/sh", ["-c", script], o);

live("exit code and output propagate", async () => {
  const box = mkBox();
  const r = await sh(box, "echo hi; echo err >&2; exit 7");
  assert.equal(r.code, 7);
  assert.match(r.stdout, /hi/);
  assert.match(r.stderr, /err/);
});

live("the box is writable and a path outside it is not", async () => {
  const box = mkBox();
  const outside = join(realpathSync(tmpdir()), `hostbox-outside-${process.pid}`);
  const r = await sh(box, `echo ok > "${box}/work/f" && echo x > "${outside}"`);
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(join(box, "work/f"), "utf8"), "ok\n");
  assert.equal(existsSync(outside), false);
});

live("HOME and credential files are unreadable", async () => {
  const box = mkBox();
  const r = await sh(box, `cat "${join(homedir(), ".npmrc")}"; ls "${homedir()}"`);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.stdout, /registry|_authToken/);
  assert.equal(r.stdout.trim(), "");
});

live("a grandchild is dead after the timeout", async () => {
  const box = mkBox();
  const pidFile = join(box, "out", "gc.pid");
  const t0 = Date.now();
  const r = await sh(box, `(sleep 300 & echo $! > "${pidFile}"; wait)`, { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 15_000);
  await new Promise((res) => setTimeout(res, 500));
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (platform === "linux") {
    // The pid is in the box's pid namespace, so the whole namespace dying is the proof.
    assert.ok(pid > 0);
    assert.equal(spawnSync("pgrep", ["-f", "sleep 300"]).status === 0, false);
  } else {
    // A setsid() survivor is a known gap on macOS; a plain grandchild must be gone.
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

live("10 MB of stdout is truncated without a hang", async () => {
  const box = mkBox();
  const r = await run(box, "/usr/bin/head", ["-c", "10485760", "/dev/zero"]);
  assert.equal(r.code, 0);
  assert.equal(r.truncated.stdout, true);
  assert.equal(r.bytes.stdout, 10 * 1024 * 1024);
  assert.ok(Buffer.byteLength(r.stdout) < 1024 * 1024 + 512);
  assert.match(r.sha256.stdout, /^[0-9a-f]{64}$/);
});

live("a canary on a second loopback port is unreachable, and null closes all network", async () => {
  const box = mkBox();
  const hits = { allowed: 0, canary: 0 };
  const srv = (k) => new Promise((res) => { const s = net.createServer((c) => { hits[k]++; c.destroy(); }); s.listen(0, "127.0.0.1", () => res(s)); });
  const allowed = await srv("allowed");
  const canary = await srv("canary");
  const node = process.execPath;
  const probe = (port) => ["-e", `require("net").connect(${port},"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(3))`];
  try {
    if (platform === "darwin") {
      const open = await run(box, node, probe(allowed.address().port), { net: { port: allowed.address().port } });
      assert.equal(open.code, 0);
      const other = await run(box, node, probe(canary.address().port), { net: { port: allowed.address().port } });
      assert.notEqual(other.code, 0);
    }
    const closed = await run(box, node, probe(allowed.address().port));
    assert.notEqual(closed.code, 0);
    assert.equal(hits.canary, 0);
  } finally { allowed.close(); canary.close(); }
});

live("git bundle creates from a read-only clone into the box out dir", async () => {
  const box = mkBox();
  const git = resolveGit();
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "hostbox-clone-")));
  const g = (...a) => spawnSync(git, ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "base");
  const base = g("rev-parse", "HEAD").stdout.trim();
  g("checkout", "-q", "-b", "feat");
  writeFileSync(join(clone, "a.txt"), "a\n");
  g("add", "a.txt");
  g("commit", "-q", "-m", "feat");
  const out = join(box, "out", "x.bundle");
  const argv = bundleExportArgv({ work: clone, branch: "refs/heads/feat", base, out });
  const r = await run(box, git, argv, { readOnly: [clone], writable: [join(box, "out")] });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(out));
  const w = await sh(box, `echo x > "${clone}/should-not-exist"`, { readOnly: [clone] });
  assert.notEqual(w.code, 0);
  rmSync(clone, { recursive: true, force: true });
});

live("the toolchain and git commit work inside the box", async () => {
  const box = mkBox();
  const git = resolveGit();
  const r = await sh(box, `"${git}" init -q . && "${git}" -c user.name=t -c user.email=t@example.invalid commit --allow-empty -q -m probe && "${git}" rev-parse --verify HEAD && "${process.execPath}" -e 'console.log(1+1)'`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\b2\b/);
  assert.ok(existsSync(join(box, "work", ".git")));
});

live("the PR #20 non-live probe set still reproduces 38 of 40, procargs the only fails", { skip: reason || platform !== "darwin" }, () => {
  const r = spawnSync(process.execPath, [join(SELF_DIR, "../drive/probes/run-probes.mjs")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const report = JSON.parse(r.stdout);
  const fails = report.results.filter((x) => x.status === "fail").map((x) => x.probe);
  assert.equal(report.summary.pass, 38, JSON.stringify(report.summary));
  assert.ok(fails.length === 2 && fails.every((p) => /procargs/i.test(p)), fails.join(", "));
});
