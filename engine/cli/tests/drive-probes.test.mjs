import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProbeProfile, defaultDenyRead, OMITTED_MACH } from "../drive/probes/seatbelt-deny-default.mjs";
import { buildReport, result, summarize, validateResult, REPORT_SCHEMA } from "../drive/probes/report.mjs";
import { classifyPreflight, preflight } from "../drive/probes/exec.mjs";
import { evalLive, liveCheckScript, parseKv } from "../drive/probes/live-checks.mjs";

const PROBES = join(dirname(fileURLToPath(import.meta.url)), "..", "drive", "probes");
const base = { scratch: "/private/var/folders/xx/S", loopbackPort: 49152 };

test("profile is deny-default and omits the keychain and Launch Services mach names", () => {
  const p = buildProbeProfile(base);
  assert.match(p, /^\(version 1\)\n\(deny default/);
  for (const name of OMITTED_MACH) assert.ok(!p.includes(name), name);
  assert.ok(p.includes("(allow process-info* (target same-sandbox))"));
  assert.ok(p.includes("(allow signal (target same-sandbox))"));
  assert.ok(p.includes('(sysctl-name "kern.argmax")'));
  assert.ok(!p.includes("procargs"));
});

test("profile writes only to the scratch dir and a few devices, never a tty", () => {
  const p = buildProbeProfile(base);
  const writes = p.split("\n").filter((l) => l.startsWith("(allow file-write"));
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes('(subpath "/private/var/folders/xx/S")'));
  assert.ok(!p.includes("ttys"));
  assert.ok(!p.includes("ptmx"));
});

test("network allows exactly one loopback port", () => {
  const p = buildProbeProfile(base);
  const net = p.split("\n").filter((l) => /network/.test(l));
  assert.deepEqual(net, ['(allow network-outbound (remote ip "localhost:49152"))']);
});

test("rule order: denies come before re-allows, and write denies come after the write allow", () => {
  const p = buildProbeProfile({ ...base, denyRead: ["/a/denied"], reallowRead: ["/a/denied/open"], denyWrite: [`${base.scratch}/ro`] });
  const at = (s) => p.indexOf(s);
  assert.ok(at('(deny file-read* (subpath "/a/denied"))') < at('(allow file-read* (subpath "/a/denied/open"))'));
  assert.ok(at("(allow file-read*)\n") < at('(deny file-read* (subpath "/a/denied"))'));
  assert.ok(at("(allow file-write*") < at(`(deny file-write* (subpath "${base.scratch}/ro"))`));
  assert.ok(p.includes('(allow file-read-metadata (literal "/a"))'));
});

test("default read denies cover credentials and system config dirs", () => {
  const p = buildProbeProfile({ ...base, denyRead: defaultDenyRead("/Users/u") });
  for (const d of ["/Users/u/.ssh", "/Users/u/.aws", "/Users/u/.config", "/Users/u/.claude", "/Users/u/.curator",
    "/Library/Application Support", "/Library/Preferences", "/opt/homebrew/etc", "/usr/local/etc", "/private/var/db", "/private/var/log"]) {
    assert.ok(p.includes(`(deny file-read* (subpath "${d}"))`), d);
  }
});

test("profile refuses unsafe input", () => {
  assert.throws(() => buildProbeProfile({ ...base, scratch: '/tmp/a"b' }), /not allowed/);
  assert.throws(() => buildProbeProfile({ ...base, scratch: "relative" }), /absolute/);
  assert.throws(() => buildProbeProfile({ ...base, scratch: "/tmp/a/../b" }), /normalized/);
  assert.throws(() => buildProbeProfile({ ...base, denyRead: ["/"] }), /subpath of \//);
  assert.throws(() => buildProbeProfile({ ...base, loopbackPort: 0 }), /loopbackPort/);
  assert.throws(() => buildProbeProfile({ ...base, loopbackPort: "80" }), /loopbackPort/);
  assert.throws(() => buildProbeProfile({ ...base, denyRead: ["/x\n(allow default)"] }), /not allowed/);
});

test("result has the documented shape and pass mirrors status", () => {
  const r = result({ probe: "x.y", expected: "blocked", actual: "blocked(rc=1)", status: "pass" });
  assert.deepEqual(Object.keys(r), ["probe", "expected", "actual", "pass", "status"]);
  assert.equal(r.pass, true);
  assert.equal(result({ probe: "x.y", expected: "blocked", actual: "read", status: "fail" }).pass, false);
  assert.equal(result({ probe: "x.y", expected: "a", actual: "b", status: "inconclusive", note: "n" }).note, "n");
});

test("result rejects non-primitive or oversized values and inconsistent pass", () => {
  assert.throws(() => result({ probe: "p", expected: "a", actual: { text: "file contents" }, status: "fail" }), /actual/);
  assert.throws(() => result({ probe: "p", expected: "a", actual: "x".repeat(201), status: "fail" }), /actual/);
  assert.throws(() => result({ probe: "p", expected: "a", actual: "b", status: "maybe" }), /status/);
  assert.throws(() => validateResult({ probe: "p", expected: "a", actual: "b", pass: true, status: "fail" }), /pass must equal/);
  assert.throws(() => result({ probe: "", expected: "a", actual: "b", status: "pass" }), /probe id/);
});

test("report summarizes by status and is ok only without failures", () => {
  const rs = [
    result({ probe: "a", expected: "e", actual: "a", status: "pass" }),
    result({ probe: "b", expected: "e", actual: "a", status: "skipped" }),
    result({ probe: "c", expected: "e", actual: "a", status: "inconclusive" }),
  ];
  assert.deepEqual(summarize(rs), { total: 3, pass: 1, fail: 0, inconclusive: 1, skipped: 1, ok: true });
  const rep = buildReport({ results: rs, meta: { live: false }, now: new Date("2026-01-02T03:04:05Z") });
  assert.equal(rep.schema, REPORT_SCHEMA);
  assert.equal(rep.generated_at, "2026-01-02T03:04:05.000Z");
  assert.equal(JSON.parse(JSON.stringify(rep)).results.length, 3);
  const bad = rs.concat(result({ probe: "d", expected: "e", actual: "a", status: "fail" }));
  assert.equal(summarize(bad).ok, false);
});

test("preflight maps every refusal to a code and names the nested case clearly", () => {
  assert.equal(classifyPreflight({ platform: "linux" }).code, "unsupported_platform");
  assert.equal(classifyPreflight({ platform: "darwin", error: "ENOENT" }).code, "missing_binary");
  const nested = classifyPreflight({ platform: "darwin", status: 71 });
  assert.equal(nested.code, "nested");
  assert.match(nested.message, /already inside a Seatbelt sandbox.*unsandboxed terminal/);
  assert.equal(classifyPreflight({ platform: "darwin", status: 1 }).code, "preflight_failed");
  assert.deepEqual(classifyPreflight({ platform: "darwin", status: 0 }), { ok: true });
});

test("run-probes refuses to run when nested, with exit 71 and a clear message", async (t) => {
  const pf = await preflight();
  if (pf.code !== "nested") return t.skip(`not nested here (${pf.ok ? "sandbox-exec works" : pf.code}); the probes are not run by the test suite`);
  const r = spawnSync(process.execPath, [join(PROBES, "run-probes.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 71);
  assert.match(r.stderr, /sandbox_unavailable:nested/);
  assert.equal(JSON.parse(r.stdout).code, "nested");
});

test("live script records only exit codes and counts", () => {
  const s = liveCheckScript();
  for (const line of s.split("\n")) {
    if (line.startsWith("OUT=") || !/\b(cat|ls|security|kill|curl)\b/.test(line)) continue;
    assert.ok(line.includes(">/dev/null") || line.includes("-o /dev/null") || line.includes("grep -cF"), line);
  }
  assert.ok(!/-w\b|\s-g\b/.test(s.split("\n").filter((l) => l.includes("security")).join()), "security must not read the secret");
  assert.ok(!s.includes("printenv") && !/^env\s*$/m.test(s));
});

test("parseKv keeps only integer key=value lines", () => {
  assert.deepEqual(parseKv("a_rc=1\nb=0\nnoise\nc=x\nd=-2\n"), { a_rc: 1, b: 0, d: -2 });
});

const controls = { sshConfigExists: true, claudeCredsExist: true, keychainItemFound: true, netExternalOk: true };
const find = (rs, id) => rs.find((r) => r.probe.endsWith(id));

test("evalLive: a blocked kit passes, and any success is a fail", () => {
  const kv = { bash_ran: 1, ssh_config_rc: 1, claude_dir_ls_rc: 1, claude_creds_ls_rc: 1, keychain_rc: 1, ps_self_seen: 1, ps_parent_seen: 0,
    kill0_parent_rc: 1, tty_open_rc: 1, net_ext_rc: 6, net_loopback_rc: 0, write_home_rc: 1 };
  const ok = evalLive("live.alt_builtin", kv, controls, { keychainService: "Claude Code-credentials", expectLoopback: true });
  assert.ok(ok.every((r) => r.status === "pass"), JSON.stringify(ok.filter((r) => r.status !== "pass")));
  const leaky = evalLive("live.alt_builtin", { ...kv, ssh_config_rc: 0, keychain_rc: 0, ps_parent_seen: 1 }, controls, { keychainService: "Claude Code-credentials", expectLoopback: true });
  for (const id of ["ssh_config_read", "keychain_query", "ps_env_parent"]) assert.equal(find(leaky, id).status, "fail", id);
});

test("evalLive: a failed control makes the result inconclusive instead of a pass", () => {
  const kv = { ssh_config_rc: 1, keychain_rc: 1, ps_self_seen: 0, ps_parent_seen: 0, net_ext_rc: 6 };
  const rs = evalLive("l", kv, { ...controls, sshConfigExists: false, keychainItemFound: false, netExternalOk: false }, { keychainService: "Claude Code-credentials", expectLoopback: false });
  for (const id of ["ssh_config_read", "keychain_query", "ps_env_parent", "net_external"]) assert.equal(find(rs, id).status, "inconclusive", id);
});

test("evalLive: reaching securityd with the nonexistent service is a fail", () => {
  const rs = evalLive("l", { keychain_rc: 44 }, controls, { keychainService: "nonexistent-probe", expectLoopback: false });
  assert.equal(find(rs, "keychain_query").status, "fail");
  assert.equal(find(evalLive("l", { keychain_rc: 1 }, controls, { keychainService: "nonexistent-probe", expectLoopback: false }), "keychain_query").status, "pass");
});

test("the harness never prints captured probe output", () => {
  const src = readFileSync(join(PROBES, "run-probes.mjs"), "utf8");
  assert.ok(!/console\./.test(src));
  assert.ok(!/write\([^)]*\.(stdout|stderr)\b/.test(src));
});
