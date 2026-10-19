// pack.test.mjs — `engine pack validate` and its YAML-subset parser. Hermetic:
// every pack under test is a temp file; the CLI is driven as a child process
// because the wiring (flag -> user config -> default, exit codes) is the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseYaml, YamlError } from "../yaml.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CLI = join(REPO, "engine", "cli", "engine.mjs");
const EXAMPLE = join(REPO, "packs", "example", "stack.yaml");

function tmp() {
  return mkdtempSync(join(tmpdir(), "pack-test-"));
}

// A root holding only a copy of the shipped example pack, so the default path
// is exercised without depending on the checkout's own detent.user.yaml.
function exampleRoot() {
  const root = tmp();
  mkdirSync(join(root, "packs", "example"), { recursive: true });
  copyFileSync(EXAMPLE, join(root, "packs", "example", "stack.yaml"));
  return root;
}

function validate(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, "pack", "validate", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const lines = (r.stdout || "").trim().split("\n");
  let json = null;
  try { json = JSON.parse(lines[lines.length - 1]); } catch { /* assert on raw */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

// A minimal valid pack, mutated per test by string replacement.
const VALID = `pack: {name: t, version: "1"}
knowledge:
  providers:
    - {id: kb, kind: mcp, server: s, tool: t, requires_network: private, required_corpus: null}
    - {id: docs, kind: local, paths: [README.md]}
  blast_radius: {enabled: false, service_manifest: service.yaml, neighbor_source: kb}
review:
  lenses:
    - {id: cross, kind: skill, skill: x, probe: {provider: kb, required_corpus: c}}
    - {id: slop, kind: builtin}
network: {check_cmd: null}
`;

function packFile(text) {
  const p = join(tmp(), "stack.yaml");
  writeFileSync(p, text);
  return p;
}

function expectInvalid(text, pattern) {
  const p = packFile(text);
  const r = validate(["--pack", p], { DETENT_ROOT: tmp() });
  assert.notEqual(r.code, 0, `expected non-zero exit; stdout=${r.stdout}`);
  assert.equal(r.json.ok, false);
  const joined = r.json.errors.join("\n");
  assert.ok(joined.includes(p), `error must name the path ${p}: ${joined}`);
  assert.match(joined, pattern);
  return r;
}

// ---------------------------------------------------------------------------
// valid packs
// ---------------------------------------------------------------------------

test("the shipped example pack is valid and reports ON/OFF", () => {
  const root = exampleRoot();
  const r = validate([], { DETENT_ROOT: root });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.pack.name, "example");
  assert.equal(r.json.pack.path, join(root, "packs", "example", "stack.yaml"));
  const state = (list) => Object.fromEntries(list.map((x) => [x.id, x.state]));
  assert.deepEqual(state(r.json.providers), { "org-kb": "ON", "repo-docs": "ON" });
  assert.deepEqual(state(r.json.lenses), { "cross-system": "OFF", principal: "OFF", deslop: "ON" });
  assert.equal(r.json.blast_radius.enabled, false);
  assert.equal(r.json.incident.state, "OFF");
  assert.equal(r.json.analytics.state, "OFF");
});

test("a lens skill of null is OFF and says why", () => {
  const r = validate([], { DETENT_ROOT: exampleRoot() });
  const cross = r.json.lenses.find((l) => l.id === "cross-system");
  assert.match(cross.reason, /skill/);
});

test("a lens whose probe provider is itself OFF is OFF", () => {
  const p = packFile(VALID.replace("server: s, tool: t", "server: null, tool: t"));
  const r = validate(["--pack", p]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.providers.find((x) => x.id === "kb").state, "OFF");
  const cross = r.json.lenses.find((l) => l.id === "cross");
  assert.equal(cross.state, "OFF");
  assert.match(cross.reason, /kb/);
});

test("a minimal valid pack passes", () => {
  const r = validate(["--pack", packFile(VALID)]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
});

test("empty provider and lens lists are valid (features OFF, not an error)", () => {
  const text = `pack: {name: t}\nknowledge:\n  providers: []\nreview:\n  lenses: []\n`;
  const r = validate(["--pack", packFile(text)]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.providers, []);
});

// ---------------------------------------------------------------------------
// path resolution: flag -> detent.user.yaml pack.path -> packs/example/stack.yaml
// ---------------------------------------------------------------------------

test("--pack beats detent.user.yaml pack.path", () => {
  const root = tmp();
  writeFileSync(join(root, "detent.user.yaml"), "pack:\n  path: nope/missing.yaml\n");
  const p = packFile(VALID);
  const r = validate(["--pack", p], { DETENT_ROOT: root });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.pack.path, p);
});

test("detent.user.yaml pack.path resolves relative to the detent root", () => {
  const root = tmp();
  mkdirSync(join(root, "mypacks"));
  writeFileSync(join(root, "mypacks", "p.yaml"), VALID);
  writeFileSync(join(root, "detent.user.yaml"), "user:\n  name: \"\"\n  teams: []\npack:\n  path: mypacks/p.yaml\n");
  const r = validate([], { DETENT_ROOT: root });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.pack.path, join(root, "mypacks", "p.yaml"));
});

test("pack.path null in detent.user.yaml falls to packs/example/stack.yaml under the root", () => {
  const root = tmp();
  mkdirSync(join(root, "packs", "example"), { recursive: true });
  writeFileSync(join(root, "packs", "example", "stack.yaml"), VALID);
  writeFileSync(join(root, "detent.user.yaml"), "pack:\n  path: null\n");
  const r = validate([], { DETENT_ROOT: root });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.pack.path, join(root, "packs", "example", "stack.yaml"));
});

test("an unparseable detent.user.yaml is an error, not a skipped config", () => {
  const root = tmp();
  writeFileSync(join(root, "detent.user.yaml"), "pack:\n\tpath: x\n");
  const r = validate([], { DETENT_ROOT: root });
  assert.notEqual(r.code, 0);
  assert.match(r.json.errors.join("\n"), /detent\.user\.yaml/);
});

// ---------------------------------------------------------------------------
// invalid packs — each names the path and the field
// ---------------------------------------------------------------------------

test("missing file names the path", () => {
  const p = join(tmp(), "absent.yaml");
  const r = validate(["--pack", p]);
  assert.notEqual(r.code, 0);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.join("\n").includes(p));
  assert.match(r.json.errors.join("\n"), /cannot read/);
});

test("a directory is unreadable", () => {
  const r = validate(["--pack", tmp()]);
  assert.notEqual(r.code, 0);
  assert.match(r.json.errors.join("\n"), /cannot read/);
});

test("parse error names the path and the line", () => {
  expectInvalid("pack: {name: t\nknowledge:\n", /parse error.*line \d+/i);
});

test("missing pack.name", () => {
  expectInvalid(VALID.replace("pack: {name: t, version: \"1\"}", "pack: {version: \"1\"}"), /pack\.name/);
});

test("missing pack block entirely", () => {
  expectInvalid(VALID.replace("pack: {name: t, version: \"1\"}\n", ""), /pack\.name/);
});

test("unknown provider kind", () => {
  expectInvalid(VALID.replace("kind: local", "kind: ftp"), /knowledge\.providers\[1\]\.kind.*ftp.*mcp\|skill\|command\|local/);
});

test("unknown lens kind", () => {
  expectInvalid(VALID.replace("kind: builtin", "kind: mcp"), /review\.lenses\[1\]\.kind.*mcp.*skill\|builtin/);
});

test("duplicate provider ids", () => {
  expectInvalid(VALID.replace("id: docs", "id: kb"), /knowledge\.providers.*duplicate id.*kb/);
});

test("duplicate lens ids", () => {
  expectInvalid(VALID.replace("id: slop", "id: cross"), /review\.lenses.*duplicate id.*cross/);
});

test("lens probe referencing an unknown provider", () => {
  expectInvalid(VALID.replace("probe: {provider: kb", "probe: {provider: ghost"), /review\.lenses\[0\]\.probe\.provider.*ghost/);
});

test("blast_radius.neighbor_source referencing an unknown provider", () => {
  expectInvalid(VALID.replace("neighbor_source: kb", "neighbor_source: ghost"), /knowledge\.blast_radius\.neighbor_source.*ghost/);
});

test("blast_radius enabled without a neighbor_source", () => {
  expectInvalid(VALID.replace("enabled: false", "enabled: true").replace("neighbor_source: kb", "neighbor_source: null"), /knowledge\.blast_radius\.neighbor_source/);
});

test("requires_network outside public|private", () => {
  expectInvalid(VALID.replace("requires_network: private", "requires_network: vpn"), /knowledge\.providers\[0\]\.requires_network.*vpn.*public\|private/);
});

test("missing knowledge.providers list", () => {
  expectInvalid(VALID.replace(/knowledge:[\s\S]*?review:/, "review:"), /knowledge\.providers/);
});

test("missing review.lenses list", () => {
  expectInvalid(VALID.replace(/review:[\s\S]*?network:/, "network:"), /review\.lenses/);
});

test("provider without an id", () => {
  expectInvalid(VALID.replace("{id: docs, kind: local", "{kind: local"), /knowledge\.providers\[1\]\.id/);
});

test("all errors are reported together, not just the first", () => {
  const text = VALID.replace("kind: local", "kind: ftp").replace("requires_network: private", "requires_network: vpn");
  const r = expectInvalid(text, /kind/);
  assert.ok(r.json.errors.length >= 2, JSON.stringify(r.json.errors));
});

test("invalid pack leaves ok:false on a single JSON line with a next_step", () => {
  const r = validate(["--pack", packFile("pack: {version: 1}\n")]);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.ok(r.json.next_step);
});

test("--pack with no value is refused", () => {
  const r = validate(["--pack"]);
  assert.notEqual(r.code, 0);
  assert.equal(r.json.ok, false);
});

// ---------------------------------------------------------------------------
// YAML subset
// ---------------------------------------------------------------------------

test("yaml: the example pack parses to the expected shape", () => {
  const doc = parseYaml(readFileSync(EXAMPLE, "utf8"), EXAMPLE);
  assert.deepEqual(doc.pack, { name: "example", version: "1" });
  assert.equal(doc.knowledge.providers[1].paths.length, 3);
  assert.equal(doc.review.lenses[0].probe.required_corpus, "services");
  assert.equal(doc.network.check_cmd, null);
});

test("yaml: scalars, comments, quotes", () => {
  const doc = parseYaml(
    `a: 1 # trailing\nb: "x # not a comment"\nc: 'it''s'\nd: ~\ne: true\nf: 1.5\ng: plain text\nh: ""\n`, "t");
  assert.deepEqual(doc, { a: 1, b: "x # not a comment", c: "it's", d: null, e: true, f: 1.5, g: "plain text", h: "" });
});

test("yaml: block list of scalars and of maps, nested flow", () => {
  const doc = parseYaml(`xs:\n  - a\n  - b\nys:\n  - id: 1\n    n: {p: [1, "two, three"], q: null}\n  - {id: 2}\n`, "t");
  assert.deepEqual(doc.xs, ["a", "b"]);
  assert.deepEqual(doc.ys, [{ id: 1, n: { p: [1, "two, three"], q: null } }, { id: 2 }]);
});

test("yaml: empty value with no children is null; empty flow collections", () => {
  assert.deepEqual(parseYaml("a:\nb: []\nc: {}\n", "t"), { a: null, b: [], c: {} });
});

test("yaml: tab indentation, duplicate keys and unterminated flow throw YamlError with a line", () => {
  assert.throws(() => parseYaml("a:\n\tb: 1\n", "t"), (e) => e instanceof YamlError && e.line === 2);
  assert.throws(() => parseYaml("a: 1\na: 2\n", "t"), (e) => e instanceof YamlError && e.line === 2);
  assert.throws(() => parseYaml("a: {b: 1\n", "t"), (e) => e instanceof YamlError && e.line === 1);
});
