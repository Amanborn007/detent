// Integration tests for the engine CLI — the commands, not the modules.
//
// WHY THIS FILE EXISTS
//   engine/cli/ had no test directory. The module suites were green throughout,
//   yet five defects shipped in this layer and every one was caught either by
//   driving a command by hand or by a reviewer:
//
//     - `engine env` accepted `--run` as a COMMAND name, silently recording the
//       run id as a shell command and defeating its own no-flags guard.
//     - `engine env` wrote a shape-invalid env.json back unchanged and reported
//       success, discarding the caller's input.
//     - `engine attempt` died with an internal-error stack when
//       stage-status.json was absent, even with --stage given.
//     - `engine handoff --stage ../../x` escaped the handoff directory.
//     - `--record` wrote a zero-valued ledger line from a scan that priced
//       nothing.
//
//   Every test below pins one of those, or the contract a command promises in
//   its refusal path. They run the real binary in a child process, because what
//   broke was the wiring — argument parsing, guard ordering, exit codes — none
//   of which a module test can see.
//
// Contract under test (engine/cli/README.md): every command prints exactly ONE
// JSON line to stdout, and exits 0 ok / 1 environment failure / 2 refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "engine.mjs");

/** A detent root with its own .sdlc, so tests never touch the real one. */
function mkroot() {
  return mkdtempSync(join(tmpdir(), "engine-cli-"));
}

function mkrun(root, id, files = {}) {
  const dir = join(root, ".sdlc", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), "");
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/**
 * Run the CLI. Returns {code, json}. Asserts the one-JSON-line contract, since
 * a command that prints two lines or none is broken regardless of exit code.
 */
function engine(root, ...args) {
  let stdout = "", code = 0;
  try {
    stdout = execFileSync("node", [CLI, ...args],
      { env: { ...process.env, DETENT_ROOT: root }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout || "";
  }
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one JSON line, got ${lines.length}:\n${stdout}`);
  let json;
  assert.doesNotThrow(() => { json = JSON.parse(lines[0]); }, `stdout was not JSON: ${lines[0]}`);
  return { code, json };
}

const RUN_ID = "2026-08-14-adhoc-cli-test";
const RUN_JSON = { run_id: RUN_ID, ticket_ref: "PROJ-2516", repo: "/tmp/x" };
const STATUS_IMPL = {
  run_id: RUN_ID,
  stages: { intake: { status: "done" }, research: { status: "done" }, implement: { status: "in_progress" } },
};

// ---------------------------------------------------------------------------
// engine env
// ---------------------------------------------------------------------------

test("env: --run is the run id, never a command name", () => {
  // The bug: `run` was in the command-key list, so --run's value was stored as
  // a shell command AND the no-flags guard never fired.
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON });
  const r = engine(root, "env", "--run", RUN_ID);
  assert.equal(r.code, 2, "no command flags given — must refuse");
  assert.match(r.json.reason, /at least one of/);
  assert.equal(existsSync(join(root, ".sdlc", RUN_ID, "env.json")), false,
    "a refused call must not write the file");
});

test("env: --verify is recorded and reported as set", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON });
  const r = engine(root, "env", "--run", RUN_ID, "--verify", "node --test engine/");
  assert.equal(r.code, 0);
  assert.equal(r.json.verify_set, true);
  const env = JSON.parse(readFileSync(join(root, ".sdlc", RUN_ID, "env.json"), "utf8"));
  assert.equal(env.commands.verify, "node --test engine/");
  assert.equal(env.commands.run, undefined, "the run id must never land in commands");
});

test("env: merging preserves earlier commands and accumulates gotchas", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON });
  engine(root, "env", "--run", RUN_ID, "--verify", "make test");
  engine(root, "env", "--run", RUN_ID, "--gotcha", "ports are flaky under the sandbox");
  const r = engine(root, "env", "--run", RUN_ID, "--gotcha", "second trap");
  assert.equal(r.json.env.commands.verify, "make test", "adding a gotcha must not drop the verify command");
  assert.deepEqual(r.json.env.gotchas, ["ports are flaky under the sandbox", "second trap"]);
});

test("env: a shape-invalid env.json fails loudly instead of discarding input", () => {
  // The bug: `["a"]` parses as JSON, then `commands ||= {}` landed on an array
  // and JSON.stringify dropped it — reporting success while losing the input.
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON, "env.json": '["a"]' });
  const r = engine(root, "env", "--run", RUN_ID, "--verify", "x");
  assert.equal(r.code, 1);
  assert.match(r.json.reason, /not an object/);
});

test("env: an unparseable env.json names the file rather than crashing", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON, "env.json": "{oops" });
  const r = engine(root, "env", "--run", RUN_ID, "--verify", "x");
  assert.equal(r.code, 1);
  assert.match(r.json.reason, /not valid JSON/);
});

// ---------------------------------------------------------------------------
// engine attempt
// ---------------------------------------------------------------------------

test("attempt: works with --stage when stage-status.json is absent", () => {
  // The bug: loadStatus() ran unconditionally before the --stage fallback, so a
  // valid call ENOENT'd into "this is a bug in engine.mjs — read the stack".
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON });
  const r = engine(root, "attempt", "tried X", "--run", RUN_ID, "--outcome", "failed", "--stage", "implement");
  assert.equal(r.code, 0);
  assert.equal(r.json.attempt.stage, "implement");
  assert.equal(r.json.total_attempts, 1);
});

test("attempt: an unknown --outcome is refused with the legal values", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON, "stage-status.json": STATUS_IMPL });
  const r = engine(root, "attempt", "x", "--run", RUN_ID, "--outcome", "nope");
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /failed\|abandoned\|superseded/);
});

test("attempt: the log is append-only across calls", () => {
  const root = mkroot();
  const dir = mkrun(root, RUN_ID, { "run.json": RUN_JSON, "stage-status.json": STATUS_IMPL });
  engine(root, "attempt", "first", "--run", RUN_ID, "--outcome", "failed");
  const r = engine(root, "attempt", "second", "--run", RUN_ID, "--outcome", "abandoned", "--evidence", "why");
  assert.equal(r.json.total_attempts, 2);
  const rows = readFileSync(join(dir, "attempts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((x) => x.approach), ["first", "second"]);
  assert.equal(rows[1].evidence, "why");
});

test("attempt --none asserts nothing failed, and refuses to erase a real one", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON, "stage-status.json": STATUS_IMPL });
  const none = engine(root, "attempt", "--none", "--run", RUN_ID);
  assert.equal(none.code, 0);
  assert.equal(none.json.total_attempts, 0);

  engine(root, "attempt", "a real dead end", "--run", RUN_ID, "--outcome", "failed");
  const again = engine(root, "attempt", "--none", "--run", RUN_ID);
  assert.equal(again.code, 2, "an append-only record may not be erased by declaring there were none");
  assert.match(again.json.reason, /already records/);
});

test("attempt --none takes no approach argument", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON, "stage-status.json": STATUS_IMPL });
  const r = engine(root, "attempt", "some approach", "--none", "--run", RUN_ID);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /takes no approach argument/);
});

// ---------------------------------------------------------------------------
// engine decide-why
// ---------------------------------------------------------------------------

const GATED = [{ id: "D-001", status: "answered", answer: "reuse lib/retry.ts",
                 options: ["reuse lib/retry.ts", "new implementation"] }];

test("decide-why records a reason and unblocks the handoff", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, {
    "run.json": RUN_JSON, "brief.md": "x", "stage-status.json": STATUS_IMPL,
    "attempts.jsonl": "", "env.json": { commands: { verify: "x" } },
    "decisions.json": GATED,
  });
  // Unexplained discard: hard gap, and the gap names its own producer.
  const before = engine(root, "handoff", RUN_ID);
  assert.equal(before.code, 2);
  assert.match(before.json.missing.join(" "), /engine decide-why/);

  const w = engine(root, "decide-why", "--run", RUN_ID, "--decision", "D-001",
    "--option", "new implementation", "--why", "duplicates three existing callers");
  assert.equal(w.code, 0);

  const after = engine(root, "handoff", RUN_ID);
  assert.equal(after.code, 0);
  assert.equal(after.json.sufficient, true);
  assert.match(readFileSync(join(root, ".sdlc", RUN_ID, "handoff", "implement.md"), "utf8"),
    /rejected: new implementation — duplicates three existing callers/);
});

test("decide-why never writes to decisions.json", () => {
  // CONTRACT.md forbids rewriting an answered decision; the reason goes beside
  // it, not into it.
  const root = mkroot();
  const dir = mkrun(root, RUN_ID, { "run.json": RUN_JSON, "decisions.json": GATED });
  const beforeBytes = readFileSync(join(dir, "decisions.json"), "utf8");
  engine(root, "decide-why", "--run", RUN_ID, "--decision", "D-001",
    "--option", "new implementation", "--why", "because");
  assert.equal(readFileSync(join(dir, "decisions.json"), "utf8"), beforeBytes,
    "decisions.json must be byte-identical");
  assert.ok(existsSync(join(dir, "decision-rationale.jsonl")));
});

test("decide-why refuses an unknown decision, the answer itself, or a stray option", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON, "decisions.json": GATED });
  const bad = [
    ["--decision", "D-999", "--option", "new implementation", "--why", "x"],
    ["--decision", "D-001", "--option", "reuse lib/retry.ts", "--why", "x"],
    ["--decision", "D-001", "--option", "never offered", "--why", "x"],
  ];
  const expect = [/no decision/, /is the ANSWER/, /not among/];
  bad.forEach((args, i) => {
    const r = engine(root, "decide-why", "--run", RUN_ID, ...args);
    assert.equal(r.code, 2, `${args.join(" ")} should refuse`);
    assert.match(r.json.reason, expect[i]);
  });
});

test("decide-why requires all three of --decision/--option/--why", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON, "decisions.json": GATED });
  for (const args of [
    ["--decision", "D-001", "--option", "new implementation"],
    ["--decision", "D-001", "--why", "x"],
    ["--option", "new implementation", "--why", "x"],
  ]) {
    const r = engine(root, "decide-why", "--run", RUN_ID, ...args);
    assert.equal(r.code, 2, `${args.join(" ")} should refuse`);
    assert.match(r.json.reason, /requires --/);
  }
});

// ---------------------------------------------------------------------------
// engine handoff
// ---------------------------------------------------------------------------

test("handoff: --stage cannot escape the handoff directory", () => {
  // The bug: --stage was interpolated straight into a path.
  const root = mkroot();
  mkrun(root, RUN_ID, {
    "run.json": RUN_JSON, "brief.md": "x", "decisions.json": [],
    "stage-status.json": STATUS_IMPL, "attempts.jsonl": "",
    "env.json": { commands: { verify: "x" } },
  });
  for (const bad of ["../../escaped", "../x", "implement/../../y", "not-a-stage", "/etc/passwd"]) {
    const r = engine(root, "handoff", RUN_ID, "--stage", bad, "--force");
    assert.equal(r.code, 2, `--stage ${bad} must be refused`);
    assert.match(r.json.reason, /--stage must be one of/);
  }
  assert.equal(existsSync(join(root, ".sdlc", RUN_ID, "handoff")), false,
    "no refused call may create the directory, let alone a file outside it");
});

test("handoff: a valid stage writes exactly one note, named for that stage", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, {
    "run.json": RUN_JSON, "brief.md": "x", "decisions.json": [],
    "stage-status.json": STATUS_IMPL, "attempts.jsonl": "",
    "env.json": { commands: { verify: "x" } },
  });
  const r = engine(root, "handoff", RUN_ID, "--stage", "implement");
  assert.equal(r.code, 0);
  assert.equal(r.json.sufficient, true);
  assert.deepEqual(readdirSync(join(root, ".sdlc", RUN_ID, "handoff")), ["implement.md"]);
});

test("handoff: refuses an incomplete run and names every gap", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON, "brief.md": "x", "decisions.json": [], "stage-status.json": STATUS_IMPL });
  const r = engine(root, "handoff", RUN_ID);
  assert.equal(r.code, 2);
  assert.match(r.json.missing.join(" "), /attempts\.jsonl/);
  assert.match(r.json.missing.join(" "), /env\.json/);
});

test("handoff --force writes the note anyway, marked INCOMPLETE", () => {
  const root = mkroot();
  const dir = mkrun(root, RUN_ID, { "run.json": RUN_JSON, "brief.md": "x", "decisions.json": [], "stage-status.json": STATUS_IMPL });
  const r = engine(root, "handoff", RUN_ID, "--force");
  assert.equal(r.code, 0);
  assert.equal(r.json.sufficient, false);
  assert.match(readFileSync(join(dir, "handoff", "implement.md"), "utf8"), /INCOMPLETE/);
});

test("handoff: an unknown run is refused, not crashed", () => {
  const r = engine(mkroot(), "handoff", "no-such-run");
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /no run/);
});

// ---------------------------------------------------------------------------
// engine spend --record
// ---------------------------------------------------------------------------

/**
 * A transcripts dir whose files scan cleanly but price nothing. The placeholder
 * carries ZERO tokens, so it drops no spend — this exercises the
 * records_priced === 0 path, not the unpriced-with-traffic one.
 */
function unpricedTranscripts() {
  const root = mkdtempSync(join(tmpdir(), "unpriced-"));
  mkdirSync(join(root, "proj"), { recursive: true });
  writeFileSync(join(root, "proj", "a.jsonl"), '{"usage": broken\n');
  writeFileSync(join(root, "proj", "b.jsonl"), JSON.stringify({
    type: "assistant", timestamp: new Date(Date.now() - 86400000).toISOString(),
    message: { id: "z", model: "<synthetic>", usage: { output_tokens: 0 } },
  }) + "\n");
  return root;
}

/** Real traffic under a model name that has no rate row. */
function unratedModelTranscripts() {
  const root = mkdtempSync(join(tmpdir(), "unrated-"));
  mkdirSync(join(root, "proj"), { recursive: true });
  writeFileSync(join(root, "proj", "a.jsonl"), [
    JSON.stringify({
      type: "assistant", timestamp: new Date(Date.now() - 86400000).toISOString(),
      message: { id: "priced", model: "claude-opus-5", stop_reason: "end_turn",
                 usage: { output_tokens: 10, cache_read_input_tokens: 1000 } },
    }),
    JSON.stringify({
      type: "assistant", timestamp: new Date(Date.now() - 86400000).toISOString(),
      message: { id: "unrated", model: "claude-brandnew-7", stop_reason: "end_turn",
                 usage: { output_tokens: 5000, cache_read_input_tokens: 2_000_000 } },
    }),
  ].join("\n") + "\n");
  return root;
}

test("spend --record refuses a PARTIALLY priced scan, not just a wholly unpriced one", () => {
  // The dangerous case: an unrecognised model's traffic is dropped, the total
  // comes out lower, and the next delta reads the omission as a saving.
  const root = mkroot();
  const r = engine(root, "spend", "--days", "30", "--root", unratedModelTranscripts(), "--record");
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /unpriced model\(s\) carrying real traffic/);
  assert.match(r.json.reason, /claude-brandnew-7/);
  assert.equal(existsSync(join(root, "benchmarks", "spend-ledger.jsonl")), false);
});

test("a zero-token unpriced placeholder does NOT block recording", () => {
  // <synthetic> appears on real transcripts with no tokens; refusing on
  // it would block --record forever.
  const root = mkroot();
  const src = mkdtempSync(join(tmpdir(), "placeholder-"));
  mkdirSync(join(src, "proj"), { recursive: true });
  writeFileSync(join(src, "proj", "a.jsonl"), [
    JSON.stringify({
      type: "assistant", timestamp: new Date(Date.now() - 86400000).toISOString(),
      message: { id: "priced", model: "claude-opus-5", stop_reason: "end_turn",
                 usage: { output_tokens: 10, cache_read_input_tokens: 1000 } },
    }),
    JSON.stringify({
      type: "assistant", timestamp: new Date(Date.now() - 86400000).toISOString(),
      message: { id: "ph", model: "<synthetic>", usage: { output_tokens: 0 } },
    }),
  ].join("\n") + "\n");
  const r = engine(root, "spend", "--days", "30", "--root", src, "--record");
  assert.equal(r.code, 0, r.json.reason || "");
  assert.deepEqual(r.json.coverage.unpriced_models_with_traffic, {});
});

test("spend --record refuses a scan that PRICED nothing, not merely an empty dir", () => {
  // The bug: the guard checked files_scanned, so a directory of unreadable or
  // unpriced transcripts wrote a plausible zero into the trend series.
  const root = mkroot();
  const src = unpricedTranscripts();
  const r = engine(root, "spend", "--days", "30", "--root", src, "--record");
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /priced 0 records/);
  assert.equal(existsSync(join(root, "benchmarks", "spend-ledger.jsonl")), false);
});

test("spend without --record still reports the zero, so the path is debuggable", () => {
  const r = engine(mkroot(), "spend", "--days", "30", "--root", unpricedTranscripts());
  assert.equal(r.code, 0);
  assert.equal(r.json.coverage.records_priced, 0);
  assert.ok(r.json.coverage.files_scanned > 0);
  assert.equal(r.json.coverage.lines_unparseable, 1);
  assert.deepEqual(r.json.coverage.unpriced_models, { "<synthetic>": { records: 1, billable_tokens: 0 } });
});

test("spend --record refuses a missing transcript root", () => {
  const r = engine(mkroot(), "spend", "--days", "30", "--root", join(tmpdir(), "definitely-absent-4b1"), "--record");
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /no transcript files found/);
});

test("spend rejects a non-positive --days rather than scanning the future", () => {
  for (const bad of ["0", "-5", "abc"]) {
    const r = engine(mkroot(), "spend", "--days", bad);
    assert.equal(r.code, 2, `--days ${bad} must be refused`);
    assert.match(r.json.reason, /--days must be a positive number/);
  }
});

test("spend --record writes one parseable line and reports no delta the first time", () => {
  const root = mkroot();
  const src = mkdtempSync(join(tmpdir(), "priced-"));
  mkdirSync(join(src, "proj"), { recursive: true });
  writeFileSync(join(src, "proj", "a.jsonl"), JSON.stringify({
    type: "assistant", timestamp: new Date(Date.now() - 86400000).toISOString(),
    message: { id: "m1", model: "claude-opus-5", stop_reason: "end_turn",
               usage: { output_tokens: 10, cache_read_input_tokens: 1000 } },
  }) + "\n");
  const r = engine(root, "spend", "--days", "30", "--root", src, "--record");
  assert.equal(r.code, 0);
  assert.equal(r.json.delta, null, "a first line has nothing to compare, and must not fake a 0% delta");
  const lines = readFileSync(join(root, "benchmarks", "spend-ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test("spend --record repairs a torn tail instead of fusing onto it", () => {
  // The bug: the reader tolerated a truncated final line; the writer appended
  // straight onto it, so one bad write corrupted the next line too.
  const root = mkroot();
  const src = mkdtempSync(join(tmpdir(), "priced2-"));
  mkdirSync(join(src, "proj"), { recursive: true });
  writeFileSync(join(src, "proj", "a.jsonl"), JSON.stringify({
    type: "assistant", timestamp: new Date(Date.now() - 86400000).toISOString(),
    message: { id: "m1", model: "claude-opus-5", stop_reason: "end_turn",
               usage: { output_tokens: 10, cache_read_input_tokens: 1000 } },
  }) + "\n");
  mkdirSync(join(root, "benchmarks"), { recursive: true });
  const ledger = join(root, "benchmarks", "spend-ledger.jsonl");
  // One good line, then a torn tail — the realistic shape. A ledger whose ONLY
  // line is torn has no readable history at all and is refused instead; that is
  // covered by the next test.
  writeFileSync(ledger,
    '{"ts":"2026-01-01T00:00:00Z","schema":"detent-spend-v2","window_days":30,' +
    '"rate_table_version":"x","total_cost_usd":1,"main_cost_per_turn":1,' +
    '"subagent_share":0,"strong_tier_share":1}\n' +
    '{"ts":"2026-02-01T00:00:00Z","truncated');  // no trailing newline

  const r = engine(root, "spend", "--days", "30", "--root", src, "--record");
  assert.equal(r.code, 0);
  const lines = readFileSync(ledger, "utf8").trim().split("\n");
  assert.equal(lines.length, 3, "the torn line stays its own line");
  assert.match(lines[1], /^\{"ts":"2026-02-01/, "the torn line is left exactly as it was");
  assert.doesNotThrow(() => JSON.parse(lines[2]), "the appended line must be valid on its own");
});

test("spend --record fails loudly on a wholly unreadable ledger", () => {
  const root = mkroot();
  const src = mkdtempSync(join(tmpdir(), "priced3-"));
  mkdirSync(join(src, "proj"), { recursive: true });
  writeFileSync(join(src, "proj", "a.jsonl"), JSON.stringify({
    type: "assistant", timestamp: new Date(Date.now() - 86400000).toISOString(),
    message: { id: "m1", model: "claude-opus-5", stop_reason: "end_turn",
               usage: { output_tokens: 10, cache_read_input_tokens: 1000 } },
  }) + "\n");
  mkdirSync(join(root, "benchmarks"), { recursive: true });
  writeFileSync(join(root, "benchmarks", "spend-ledger.jsonl"), "not json\nalso not json\n");
  const r = engine(root, "spend", "--days", "30", "--root", src, "--record");
  assert.equal(r.code, 1, "declaring a fresh baseline over unreadable history would be a fabrication");
  assert.match(r.json.reason, /none parse as JSON/);
});

// ---------------------------------------------------------------------------
// the shared CLI contract
// ---------------------------------------------------------------------------

test("an unknown command is refused with the usage line", () => {
  const r = engine(mkroot(), "nonsense-command");
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /unknown command/);
  assert.match(r.json.next_step, /engine </);
});

test("help lists every command the dispatcher actually accepts", () => {
  const r = engine(mkroot(), "help");
  assert.equal(r.code, 0);
  for (const cmd of ["handoff", "attempt", "env", "decide-why", "spend", "bench", "run new", "stage begin"]) {
    assert.ok(r.json.usage[cmd], `help is missing '${cmd}' — USAGE and the dispatcher have drifted`);
  }
});

test("every refusal carries a next_step, so no dead end is silent", () => {
  const root = mkroot();
  const refusals = [
    ["handoff"],
    ["attempt", "--run", "nope", "--outcome", "failed"],
    ["env", "--run", "nope", "--verify", "x"],
    ["spend", "--days", "0"],
  ];
  for (const args of refusals) {
    const r = engine(root, ...args);
    assert.ok(r.code !== 0, `${args[0]} should have refused`);
    assert.ok(r.json.next_step, `${args.join(" ")} refused with no next_step`);
    assert.equal(r.json.ok, false);
  }
});

// ---------------------------------------------------------------------------
// argument parsing — repeats must never silently drop a value
// ---------------------------------------------------------------------------

test("a repeated --gotcha accumulates within ONE invocation", () => {
  // The bug: repeats overwrote, so `--gotcha a --gotcha b` kept only b and
  // cmdEnv's array handling was unreachable.
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON });
  const r = engine(root, "env", "--run", RUN_ID, "--verify", "x",
    "--gotcha", "first trap", "--gotcha", "second trap", "--gotcha", "third trap");
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.env.gotchas, ["first trap", "second trap", "third trap"]);
});

test("a single --gotcha still yields a one-element list, not a bare string", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON });
  const r = engine(root, "env", "--run", RUN_ID, "--verify", "x", "--gotcha", "only one");
  assert.deepEqual(r.json.env.gotchas, ["only one"]);
});

test("a repeated single-valued flag is refused, not silently overwritten", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON });
  const r = engine(root, "env", "--run", RUN_ID, "--verify", "first", "--verify", "second");
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /given more than once: --verify/);
  assert.match(r.json.next_step, /may repeat/);
  assert.equal(existsSync(join(root, ".sdlc", RUN_ID, "env.json")), false,
    "a refused call must write nothing");
});

test("a repeated --run is refused rather than picking one of them", () => {
  const root = mkroot();
  mkrun(root, RUN_ID, { "run.json": RUN_JSON });
  const r = engine(root, "handoff", "--run", RUN_ID, "--run", "some-other-run");
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /given more than once: --run/);
});

// ---------------------------------------------------------------------------
// the gate boundary is graded against the LIVE stage
// ---------------------------------------------------------------------------

test("a plan-stage gate blocking implement is graded as PLAN, not implement", () => {
  // The bug: `blocks[0]` is downstream impact, so a plan gate blocking
  // `implement` demanded attempts.jsonl and env.json — artifacts a plan-stage run
  // has no business having — and then advised keeping the costly session open.
  const root = mkroot();
  mkrun(root, RUN_ID, {
    "run.json": RUN_JSON,
    "brief.md": "x",
    "research.md": "y",
    // plan is the stage actually parked; implement has not started.
    "stage-status.json": {
      run_id: RUN_ID,
      stages: { intake: { status: "done" }, research: { status: "done" },
                plan: { status: "blocked", blocked_on: ["D-001"] } },
    },
    "decisions.json": [{ id: "D-001", raised_by: "plan", blocks: ["implement"],
                         question: "which approach?", options: ["a", "b"], status: "pending" }],
  });
  const r = engine(root, "gate", "open", "D-001", "--run", RUN_ID, "--repo", root);
  assert.equal(r.json.ok, true, r.json.reason || "");
  // The note must be named for plan, and plan-stage rules must not demand
  // implement-stage artifacts.
  const dir = join(root, ".sdlc", RUN_ID, "handoff");
  assert.ok(existsSync(dir), "the park should have written a handoff");
  assert.deepEqual(readdirSync(dir), ["plan.md"],
    "graded and named for the stage that parked, not the one it blocks");
  assert.equal(r.json.sufficient, true,
    `a plan-stage run should not need implement artifacts: ${JSON.stringify(r.json.missing)}`);
});
