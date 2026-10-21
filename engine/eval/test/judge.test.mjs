// Unit tests for graders/judge.mjs. Zero dependencies (node:test). Every test
// injects a FAKE executor — this file must NEVER spawn a real `claude`
// process; a stray real invocation is itself a test bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeOnPath, parseJudgeOutput, judgeCase, runJudgeCase,
  loadAnchors, formatAnchorsBlock, classifyBand,
} from "../graders/judge.mjs";

function fakeExecutorFor(scores) {
  let i = 0;
  return () => {
    const s = scores[Math.min(i, scores.length - 1)];
    i++;
    return { stdout: `preamble text\n{"score": ${s}, "reasoning": "vote-${i}"}\ntrailing` };
  };
}

// ---------------------------------------------------------------------------
// parseJudgeOutput
// ---------------------------------------------------------------------------

test("parseJudgeOutput: parses a trailing {\"score\":...} JSON object out of prose", () => {
  const out = parseJudgeOutput('The description covers triggers.\n{"score": 0.8, "reasoning": "ok"}', "c1");
  assert.equal(out.score, 0.8);
  assert.equal(out.reasoning, "ok");
});

test("parseJudgeOutput: takes the LAST score-shaped object when several appear", () => {
  const out = parseJudgeOutput(
    'draft: {"score": 0.1, "reasoning": "scratch"}\nfinal: {"score": 0.9, "reasoning": "final"}',
    "c1",
  );
  assert.equal(out.score, 0.9);
});

test("parseJudgeOutput: throws (never guesses) when no score-shaped JSON is present", () => {
  assert.throws(() => parseJudgeOutput("I don't know how to score this.", "c1"), /could not parse/);
});

// ---------------------------------------------------------------------------
// judgeCase — panel aggregation (k runs, median + spread)
// ---------------------------------------------------------------------------

test("judgeCase: k=1 records a single vote as the score, spread 0", () => {
  const r = judgeCase({ id: "J1", prompt: "rate this" }, { executor: fakeExecutorFor([0.7]), k: 1 });
  assert.equal(r.recorded, true);
  assert.equal(r.score, 0.7);
  assert.equal(r.k, 1);
  assert.equal(r.spread, 0);
  assert.equal(r.votes.length, 1);
});

test("judgeCase: k=3 panel aggregates by MEDIAN, not mean", () => {
  // mean would be (0.2+0.5+0.9)/3 = 0.5333..; median of [0.2,0.5,0.9] is 0.5
  const r = judgeCase({ id: "J2", prompt: "rate this" }, { executor: fakeExecutorFor([0.2, 0.9, 0.5]), k: 3 });
  assert.equal(r.recorded, true);
  assert.equal(r.score, 0.5);
  assert.equal(r.k, 3);
  assert.equal(r.votes.length, 3);
});

test("judgeCase: disagreement handling — spread reflects max-min across the panel", () => {
  const r = judgeCase({ id: "J3", prompt: "rate this" }, { executor: fakeExecutorFor([0.1, 0.9, 0.5]), k: 3 });
  assert.equal(r.spread, 0.8); // 0.9 - 0.1
});

test("judgeCase: an out-of-range score (e.g. 1.4) throws — never clamped/fabricated", () => {
  assert.throws(
    () => judgeCase({ id: "J4", prompt: "rate this" }, { executor: fakeExecutorFor([1.4]), k: 1 }),
    /outside \[0,1\]/,
  );
});

test("runJudgeCase: an out-of-range judge score (e.g. 85 on a percent scale) degrades to recorded:false, never clamped to a fabricated in-range score", () => {
  const r = runJudgeCase({ id: "J4b", prompt: "rate this" }, { executor: fakeExecutorFor([85]) });
  assert.equal(r.recorded, false);
  assert.match(r.note, /outside \[0,1\]/);
});

test("judgeCase: throws loudly on a missing prompt (never fabricates)", () => {
  assert.throws(() => judgeCase({ id: "J5" }, { executor: fakeExecutorFor([0.5]) }), /missing params\.prompt/);
});

test("judgeCase: propagates an executor throw straight through (no swallowing)", () => {
  const boom = () => { throw new Error("model timed out"); };
  assert.throws(() => judgeCase({ id: "J6", prompt: "rate this" }, { executor: boom }), /model timed out/);
});

// ---------------------------------------------------------------------------
// runJudgeCase — graceful degradation, never a fabricated score
// ---------------------------------------------------------------------------

test("runJudgeCase: --no-judge skips WITHOUT ever invoking the executor", () => {
  let calls = 0;
  const executor = () => { calls++; return { stdout: '{"score": 1}' }; };
  const r = runJudgeCase({ id: "J7", prompt: "rate this" }, { noJudge: true, executor });
  assert.equal(r.recorded, false);
  assert.match(r.note, /--no-judge/);
  assert.equal(calls, 0, "executor must never be invoked when --no-judge is set");
});

test("runJudgeCase: no injected executor + claudeOnPath()===null skips WITHOUT spawning claude", () => {
  const r = runJudgeCase({ id: "J8", prompt: "rate this" }, { hasClaude: () => false });
  assert.equal(r.recorded, false);
  assert.match(r.note, /claude not found on PATH/);
});

test("runJudgeCase: with an injected executor, claudeOnPath is never consulted", () => {
  let hasClaudeCalls = 0;
  const r = runJudgeCase(
    { id: "J9", prompt: "rate this" },
    { executor: fakeExecutorFor([0.6]), hasClaude: () => { hasClaudeCalls++; return false; } },
  );
  assert.equal(r.recorded, true);
  assert.equal(r.score, 0.6);
  assert.equal(hasClaudeCalls, 0, "hasClaude must only be consulted when no executor is injected");
});

test("runJudgeCase: an executor that throws degrades to recorded:false with the error message, never a fabricated score", () => {
  const boom = () => { throw new Error("connection refused"); };
  const r = runJudgeCase({ id: "J10", prompt: "rate this" }, { executor: boom });
  assert.equal(r.recorded, false);
  assert.match(r.note, /connection refused/);
});

test("runJudgeCase: unparsable output degrades to recorded:false, never a fabricated score", () => {
  const executor = () => ({ stdout: "no json here" });
  const r = runJudgeCase({ id: "J11", prompt: "rate this" }, { executor });
  assert.equal(r.recorded, false);
  assert.match(r.note, /could not parse/);
});

test("runJudgeCase: success path returns the full judgeCase shape (k, votes, spread)", () => {
  const r = runJudgeCase({ id: "J12", prompt: "rate this" }, { executor: fakeExecutorFor([0.4, 0.6]), k: 2 });
  assert.equal(r.recorded, true);
  assert.equal(r.k, 2);
  assert.equal(r.votes.length, 2);
  assert.equal(typeof r.spread, "number");
});

// ---------------------------------------------------------------------------
// claudeOnPath — injectable exec, never a real spawn in tests
// ---------------------------------------------------------------------------

test("claudeOnPath: returns the first stdout line on a successful probe", () => {
  const fakeExec = () => ({ status: 0, stdout: "/usr/local/bin/claude\n" });
  assert.equal(claudeOnPath(fakeExec), "/usr/local/bin/claude");
});

test("claudeOnPath: returns null when the probe exits non-zero", () => {
  const fakeExec = () => ({ status: 1, stdout: "" });
  assert.equal(claudeOnPath(fakeExec), null);
});

test("claudeOnPath: returns null when the probe throws/returns nothing usable", () => {
  const fakeExec = () => null;
  assert.equal(claudeOnPath(fakeExec), null);
});

// ---------------------------------------------------------------------------
// loadAnchors — reads + shape-validates evals/calibration/<dim>/anchors.json
// ---------------------------------------------------------------------------

function mkAnchorsRoot(dimension, doc) {
  const root = mkdtempSync(join(tmpdir(), "judge-anchors-"));
  const dir = join(root, "evals", "calibration", dimension);
  mkdirSync(dir, { recursive: true });
  if (doc !== undefined) {
    writeFileSync(join(dir, "anchors.json"), JSON.stringify(doc, null, 2));
  }
  return root;
}

const VALID_ANCHORS_DOC = {
  schema: "detent-eval-anchors-v1",
  dimension: "widget",
  scenario: "A fixed test scenario.",
  bands: { green: [0.75, 1], yellow: [0.4, 0.75], red: [0, 0.4] },
  anchors: [
    { label: "green", sample: "green sample text", expected_range: [0.8, 1.0], why: "it is good" },
    { label: "yellow", sample: "yellow sample text", expected_range: [0.5, 0.6] },
    { label: "red", sample: "red sample text", expected_range: [0.0, 0.2] },
  ],
};

test("loadAnchors: happy path parses a valid anchors.json from a scratch tree", () => {
  const root = mkAnchorsRoot("widget", VALID_ANCHORS_DOC);
  try {
    const doc = loadAnchors(root, "widget");
    assert.equal(doc.dimension, "widget");
    assert.equal(doc.anchors.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAnchors: missing dimension directory/file throws (never {recorded:false})", () => {
  const root = mkdtempSync(join(tmpdir(), "judge-anchors-"));
  try {
    assert.throws(() => loadAnchors(root, "nonexistent"), /cannot read calibration anchors/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAnchors: invalid shape (no red anchor) throws", () => {
  const doc = { ...VALID_ANCHORS_DOC, anchors: VALID_ANCHORS_DOC.anchors.filter((a) => a.label !== "red") };
  const root = mkAnchorsRoot("widget", doc);
  try {
    assert.throws(() => loadAnchors(root, "widget"), /missing at least one 'red' anchor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAnchors: invalid shape (missing bands) throws", () => {
  const { bands, ...doc } = VALID_ANCHORS_DOC;
  const root = mkAnchorsRoot("widget", doc);
  try {
    assert.throws(() => loadAnchors(root, "widget"), /missing bands/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAnchors: unparsable JSON throws", () => {
  const root = mkAnchorsRoot("widget", undefined);
  writeFileSync(join(root, "evals", "calibration", "widget", "anchors.json"), "{ not json");
  try {
    assert.throws(() => loadAnchors(root, "widget"), /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// formatAnchorsBlock — deterministic, pure
// ---------------------------------------------------------------------------

test("formatAnchorsBlock: output contains every sample verbatim plus the scenario", () => {
  const block = formatAnchorsBlock(VALID_ANCHORS_DOC);
  assert.match(block, /A fixed test scenario\./);
  assert.match(block, /green sample text/);
  assert.match(block, /yellow sample text/);
  assert.match(block, /red sample text/);
  assert.match(block, /NOT the output you are grading/);
  assert.match(block, /it is good/); // 'why' field, when present
});

test("formatAnchorsBlock: is a pure function of its input (same doc -> identical output)", () => {
  assert.equal(formatAnchorsBlock(VALID_ANCHORS_DOC), formatAnchorsBlock(VALID_ANCHORS_DOC));
});

// ---------------------------------------------------------------------------
// classifyBand
// ---------------------------------------------------------------------------

const BANDS = { green: [0.75, 1], yellow: [0.4, 0.75], red: [0, 0.4] };

test("classifyBand: classifies each band correctly", () => {
  assert.equal(classifyBand(0.9, BANDS), "green");
  assert.equal(classifyBand(0.5, BANDS), "yellow");
  assert.equal(classifyBand(0.1, BANDS), "red");
});

test("classifyBand: boundary 0.75 is green (lo-inclusive rule, green wins the shared boundary)", () => {
  assert.equal(classifyBand(0.75, BANDS), "green");
});

test("classifyBand: boundary 0.4 is yellow (lo-inclusive), not red", () => {
  assert.equal(classifyBand(0.4, BANDS), "yellow");
});

test("classifyBand: score 0 is red, score 1 is green", () => {
  assert.equal(classifyBand(0, BANDS), "red");
  assert.equal(classifyBand(1, BANDS), "green");
});

test("classifyBand: a score in a gap between non-contiguous bands returns null, never a nearest-guess", () => {
  const gappyBands = { green: [0.9, 1], yellow: [0.6, 0.8], red: [0, 0.3] };
  assert.equal(classifyBand(0.85, gappyBands), null); // between yellow.hi=0.8 and green.lo=0.9
  assert.equal(classifyBand(0.4, gappyBands), null); // between red.hi=0.3 and yellow.lo=0.6
});

test("classifyBand: non-numeric score or missing bands returns null", () => {
  assert.equal(classifyBand(null, BANDS), null);
  assert.equal(classifyBand(0.5, null), null);
});

// ---------------------------------------------------------------------------
// uncertain votes — excluded from median/spread, never silently folded in
// ---------------------------------------------------------------------------

function fakeExecutorWithUncertain(entries) {
  // entries: array of {score, uncertain?}
  let i = 0;
  return () => {
    const e = entries[Math.min(i, entries.length - 1)];
    i++;
    const obj = { score: e.score, reasoning: `vote-${i}` };
    if (e.uncertain) obj.uncertain = true;
    return { stdout: JSON.stringify(obj) };
  };
}

test("judgeCase: k=3 with one uncertain vote excludes it — median computed over the remaining 2, uncertain_votes:1", () => {
  const r = judgeCase(
    { id: "U1", prompt: "rate this" },
    {
      executor: fakeExecutorWithUncertain([{ score: 0.2 }, { score: 0.8, uncertain: true }, { score: 0.6 }]),
      k: 3,
    },
  );
  assert.equal(r.recorded, true);
  assert.equal(r.uncertain_votes, 1);
  // median of remaining [0.2, 0.6] -> 0.4
  assert.equal(r.score, 0.4);
  assert.equal(r.votes.length, 3);
  assert.equal(r.votes.filter((v) => v.uncertain).length, 1);
});

test("judgeCase: uncertain votes never enter spread (spread computed only over confident votes)", () => {
  const r = judgeCase(
    { id: "U2", prompt: "rate this" },
    {
      executor: fakeExecutorWithUncertain([{ score: 0.1 }, { score: 0.99, uncertain: true }, { score: 0.3 }]),
      k: 3,
    },
  );
  // spread should be 0.3-0.1=0.2, NOT 0.99-0.1=0.89 (the uncertain vote must be excluded)
  assert.equal(r.spread, 0.2);
});

test("judgeCase: ALL k votes uncertain throws (unusable), never a fabricated score", () => {
  assert.throws(
    () => judgeCase(
      { id: "U3", prompt: "rate this" },
      { executor: fakeExecutorWithUncertain([{ score: 0.5, uncertain: true }, { score: 0.6, uncertain: true }]), k: 2 },
    ),
    /all 2 vote\(s\) uncertain — unusable/,
  );
});

test("runJudgeCase: all-uncertain panel degrades to recorded:false with the 'all uncertain' note", () => {
  const r = runJudgeCase(
    { id: "U4", prompt: "rate this" },
    { executor: fakeExecutorWithUncertain([{ score: 0.5, uncertain: true }]), k: 1 },
  );
  assert.equal(r.recorded, false);
  assert.match(r.note, /all 1 vote\(s\) uncertain/);
});

test("judgeCase: band_unstable is set when confident vote scores straddle two bands, even though the median lands in one", () => {
  // votes 0.3 (red) and 0.9 (green) -> median 0.6 (yellow), but the panel
  // straddles red and green -> band_unstable:true.
  const r = judgeCase(
    { id: "U5", prompt: "rate this" },
    { executor: fakeExecutorWithUncertain([{ score: 0.3 }, { score: 0.9 }]), k: 2, bands: BANDS },
  );
  assert.equal(classifyBand(r.score, BANDS), "yellow");
  assert.equal(r.band_unstable, true);
});

test("judgeCase: band_unstable is absent (never fabricated) when no bands are supplied", () => {
  const r = judgeCase(
    { id: "U6", prompt: "rate this" },
    { executor: fakeExecutorWithUncertain([{ score: 0.3 }, { score: 0.9 }]), k: 2 },
  );
  assert.equal(r.band_unstable, undefined);
});

// ---------------------------------------------------------------------------
// default executor — a `claude` stub first on PATH (the only way to reach it)
// ---------------------------------------------------------------------------

function withClaudeStub(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "judge-stub-"));
  const log = join(dir, "log.json");
  writeFileSync(join(dir, "claude"), `#!${process.execPath}
const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
${body}
`);
  chmodSync(join(dir, "claude"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
  try { return fn(() => JSON.parse(readFileSync(log, "utf8"))); } finally { process.env.PATH = savedPath; }
}

test("default executor: argv is exactly ['-p'], prompt on stdin, stdout returned verbatim", () => {
  withClaudeStub(`process.stdout.write('pre\\n{"score": 0.6}\\n');`, (rec) => {
    const r = judgeCase({ id: "D1", prompt: "--dangerously-skip-permissions rate" }, { k: 1 });
    assert.equal(r.score, 0.6);
    assert.deepEqual(rec().argv, ["-p"]);
    assert.equal(rec().stdin, "--dangerously-skip-permissions rate");
  });
});

test("default executor: nonzero exit throws 'claude -p exited 1' with the first 300 chars", () => {
  withClaudeStub(`process.stderr.write("x".repeat(500)); process.exit(1);`, () => {
    assert.throws(() => judgeCase({ id: "D2", prompt: "p" }, { k: 1 }), (e) => {
      assert.match(e.message, /^claude -p exited 1: x{300}$/);
      return true;
    });
  });
});

test("default executor: a stub slower than timeoutMs throws", () => {
  withClaudeStub(`setTimeout(() => {}, 5000);`, () => {
    assert.throws(() => judgeCase({ id: "D3", prompt: "p" }, { k: 1, timeoutMs: 300 }), /ETIMEDOUT/);
  });
});
