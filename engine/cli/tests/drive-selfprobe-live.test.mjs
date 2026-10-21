// Opt-in live test: DETENT_LIVE_CLAUDE=1 runs two real `claude -p` children (haiku, about 0.05 USD in
// total, OAuth login) with the `env` shim on PATH. Seatbelt cannot nest, so run it from an unsandboxed
// terminal:  DETENT_LIVE_CLAUDE=1 node --test engine/cli/tests/drive-selfprobe-live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir, userInfo } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { buildSelfProbe, collectControls, evaluateSelfProbe, installShim, pathWithShim, readShimReport, uninstallShim } from "../drive/selfprobe.mjs";
import { parseTranscript } from "../drive/probes/transcript.mjs";

const CLAUDE = process.env.DETENT_CLAUDE_BIN || "claude";
const MODEL = "claude-haiku-5-5";
const BUDGET_USD = "0.025";

function skipReason() {
  if (process.env.DETENT_LIVE_CLAUDE !== "1") return "set DETENT_LIVE_CLAUDE=1 to run";
  if (process.platform !== "darwin") return `the capture-and-replay gate is macOS only (platform is ${process.platform})`;
  const nest = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
  if (nest.status === 71) return "this shell is already inside a Seatbelt sandbox (sandbox-exec exit 71), and Seatbelt cannot nest: run from an unsandboxed terminal";
  if (spawnSync(CLAUDE, ["--version"]).status !== 0) return `\`${CLAUDE} --version\` failed: install and log in to claude, or set DETENT_CLAUDE_BIN`;
  return false;
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "selfprobe-live-")));
  const home = homedir();
  const S = join(root, "step");
  const dirs = { clone: join(S, "clone"), outbox: join(S, "outbox"), tmp: join(S, "tmp"), denied: join(root, "denied"), runDir: join(root, "run") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const git = (...a) => { const r = spawnSync("git", ["-C", dirs.clone, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); };
  git("init", "-q");
  git("config", "user.name", "Detent Live");
  git("config", "user.email", "live@example.invalid");
  writeFileSync(join(dirs.clone, "README"), "live\n");
  git("add", "README");
  git("commit", "-q", "-m", "init");
  const nonce = `DENIED-${randomBytes(8).toString("hex")}`;
  const canary = join(dirs.denied, "canary");
  writeFileSync(canary, `${nonce}\n`);
  const st = statSync(canary);
  mkdirSync("/tmp/claude", { recursive: true });
  const exists = (p) => existsSync(p);
  const denyRead = [dirs.denied, dirs.runDir, join(home, ".ssh"), join(home, ".aws"), join(home, ".claude"), join(home, ".config"), join(home, "Library", "Keychains"), "/Library/Keychains", "/tmp/claude", "/private/tmp/claude"];
  const denyReadAll = [...new Set(denyRead.flatMap((p) => (p.startsWith("/Users/") ? [p, `/System/Volumes/Data${p}`] : [p])))];
  const denyWrite = ["commondir", "config.worktree", "objects/info/alternates", "objects/info/http-alternates"].map((f) => join(dirs.clone, ".git", f)).concat(["/tmp/claude", "/private/tmp/claude"]);
  return { root, home, S, dirs, canary, nonce, volPath: `/.vol/${st.dev}/${st.ino}`, denyRead: denyReadAll, denyWrite, existingDeny: denyRead.filter(exists) };
}

function settingsFor(fx, { weak = false } = {}) {
  const network = { allowedDomains: [], deniedDomains: [] };
  if (weak) network.allowLocalBinding = true;
  return {
    permissions: { defaultMode: "dontAsk", allow: ["Bash"], deny: ["WebFetch", "WebSearch", "Task", "Agent", "Skill", "NotebookEdit", "Read", "Glob", "Grep", "Write", "Edit"] },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, excludedCommands: [],
      network,
      filesystem: { denyRead: fx.denyRead, allowWrite: [fx.dirs.outbox, fx.dirs.tmp], denyWrite: fx.denyWrite },
    },
    disableAllHooks: true, enableAllProjectMcpServers: false, autoMemoryEnabled: false,
  };
}

function runStep(fx, { name, weak = false, prompt }) {
  const probe = buildSelfProbe({
    platform: "darwin", clone: fx.dirs.clone, drivePid: process.pid,
    denyTargets: fx.existingDeny,
    canaries: [{ path: fx.canary, nonce: fx.nonce, volPath: fx.volPath }],
    writeAllowed: [fx.dirs.outbox, fx.dirs.tmp],
    writeDenied: [fx.home, fx.dirs.runDir, "/tmp/claude", "/private/tmp/claude"],
    toolchain: ["node", "git"],
  });
  const controls = collectControls(probe.controlScript);
  const shimDir = join(fx.root, `shim-${name}`);
  const inst = installShim(shimDir, {
    validate: { home: fx.home, readDeny: fx.denyRead, writeAllow: [fx.dirs.clone, fx.dirs.outbox, fx.dirs.tmp], writeDenyRequired: [join(fx.dirs.clone, ".git", "config"), ...fx.denyWrite] },
    probe: { script: probe.script, expect: probe.expect, controls },
  });
  const settingsFile = join(fx.root, `settings-${name}.json`);
  writeFileSync(settingsFile, JSON.stringify(settingsFor(fx, { weak }), null, 2), { mode: 0o400 });
  const env = {
    PATH: pathWithShim(inst.binDir, process.env.PATH), HOME: fx.home, USER: userInfo().username, LANG: process.env.LANG || "en_US.UTF-8", TERM: "dumb", SHELL: "/bin/sh",
    TMPDIR: fx.dirs.tmp, CLAUDE_CODE_TMPDIR: fx.dirs.tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
  };
  const args = ["-p", "--restricted", "--tools", "Bash", "--permission-mode", "dontAsk", "--settings", settingsFile, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", MODEL, "--max-budget-usd", BUDGET_USD, "--max-turns", "4", prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd: fx.dirs.clone, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }, 150000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(t);
      const transcript = parseTranscript(out);
      const report = { ...readShimReport(shimDir), toolUses: transcript.bashUses, platform: "darwin" };
      resolve({ code, out, err, transcript, report, evaluation: evaluateSelfProbe(report), shimDir });
    });
  });
}

const dump = (r) => JSON.stringify({ code: r.code, bashUses: r.transcript.bashUses, report: { ...r.report, expect: undefined, controls: r.report.controls }, evaluation: r.evaluation, stderr: r.err.slice(0, 600) }, null, 1);

test("live: hardened settings are captured, validated, replayed and every command is counted", { skip: skipReason(), timeout: 200000 }, async () => {
  const fx = fixture();
  const r = await runStep(fx, { name: "ok", prompt: "Use the Bash tool exactly once to run: echo detent-live-ok\nThen reply with the single word DONE." });
  try {
    assert.equal(r.report.captured, true, `the shim captured no profile (is it first on the child's PATH?)\n${dump(r)}`);
    assert.deepEqual(r.report.violations, [], dump(r));
    assert.ok(Object.keys(r.report.tokens).length > 10, `the replayed probe printed too few tokens\n${dump(r)}`);
    assert.deepEqual(r.evaluation.failures, [], dump(r));
    assert.deepEqual(r.evaluation.inconclusive, [], dump(r));
    assert.equal(r.report.calls, r.transcript.bashUses, `shim calls vs Bash tool_use\n${dump(r)}`);
    assert.ok(r.transcript.bashUses >= 1, dump(r));
    assert.equal(r.evaluation.ok, true, dump(r));
    assert.ok(r.out.includes("detent-live-ok"), "the real command should have run after the probe");
  } finally { uninstallShim(r.shimDir); }
});

test("live: a weakened settings file (allowLocalBinding true) is refused and its command never runs", { skip: skipReason(), timeout: 200000 }, async () => {
  const fx = fixture();
  const ran = join(fx.dirs.outbox, "ran");
  const r = await runStep(fx, { name: "weak", weak: true, prompt: `Use the Bash tool exactly once to run: touch ${ran}\nThen reply with the single word DONE.` });
  try {
    assert.equal(r.report.captured, true, `the shim captured no profile\n${dump(r)}`);
    assert.equal(r.evaluation.ok, false, dump(r));
    assert.ok(r.report.violations.some((v) => /network/.test(v)), `expected a network violation\n${dump(r)}`);
    assert.equal(existsSync(ran), false, "the refused command must not have run");
    assert.match(r.out + r.err, /DETENT_SELFPROBE_REFUSED/, dump(r));
  } finally { uninstallShim(r.shimDir); }
});
