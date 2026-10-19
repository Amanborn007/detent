import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'feedback.mjs');

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'self-feedback-t-'));
}
function run(root, args, envExtra = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DETENT_ROOT: root, ...envExtra },
  });
}
function journalPath(root) {
  return path.join(root, '.local', 'self-feedback', 'journal.jsonl');
}

test('append: two adds -> 2 lines, first line byte-identical after second append, fields round-trip, recorded:true', () => {
  const root = freshRoot();
  const r1 = run(root, ['add', '--area', 'scout', '--note', 'no hit for query X', '--kind', 'coverage-gap', '--stage', 'research', '--run', 'run-1', '--source', 'stage']);
  const j1 = JSON.parse(r1.stdout);
  assert.equal(j1.ok, true);
  assert.equal(j1.recorded, true);
  assert.ok(j1.id);

  const before = fs.readFileSync(journalPath(root), 'utf8').split('\n')[0];

  const r2 = run(root, ['add', '--area', 'respond', '--note', 'bot comment ambiguous']);
  const j2 = JSON.parse(r2.stdout);
  assert.equal(j2.recorded, true);
  assert.notEqual(j2.id, j1.id);

  const lines = fs.readFileSync(journalPath(root), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'two appended lines');
  assert.equal(lines[0], before, 'first line is byte-identical after the second append (append-only)');

  const first = JSON.parse(lines[0]);
  assert.equal(first.schema, 'self-feedback-v0');
  assert.equal(first.area, 'scout');
  assert.equal(first.kind, 'coverage-gap');
  assert.equal(first.note, 'no hit for query X');
  assert.equal(first.stage, 'research');
  assert.equal(first.run_id, 'run-1');
  assert.equal(first.source, 'stage');
  assert.ok(first.ts);
  assert.equal(first.id, j1.id);
});

test('parse: list filters --since/--area; a corrupted middle line is skipped, entries still returned, skipped_lines:1, no throw', () => {
  const root = freshRoot();
  run(root, ['add', '--area', 'scout', '--note', 'first', '--now-marker', 'ignored']);
  // Directly seed a well-formed old + new entry plus a corrupted middle line.
  const jp = journalPath(root);
  const early = JSON.stringify({ schema: 'self-feedback-v0', id: 'sf-1', ts: '2020-01-01T00:00:00Z', area: 'scout', kind: 'other', note: 'old' });
  const late = JSON.stringify({ schema: 'self-feedback-v0', id: 'sf-2', ts: '2030-01-01T00:00:00Z', area: 'respond', kind: 'other', note: 'new' });
  fs.writeFileSync(jp, [early, 'THIS IS NOT JSON {{{', late].join('\n') + '\n');

  const r = run(root, ['list']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.skipped_lines, 1, 'the corrupted middle line is counted, not thrown on');
  assert.equal(j.entries.length, 2, 'both well-formed entries still returned');
  assert.equal(j.entries[0].id, 'sf-2', 'newest-first');

  const rSince = run(root, ['list', '--since', '2025-01-01T00:00:00Z']);
  const jSince = JSON.parse(rSince.stdout);
  assert.equal(jSince.entries.length, 1);
  assert.equal(jSince.entries[0].id, 'sf-2');

  const rArea = run(root, ['list', '--area', 'scout']);
  const jArea = JSON.parse(rArea.stdout);
  assert.equal(jArea.entries.length, 1);
  assert.equal(jArea.entries[0].id, 'sf-1');
});

test('honesty (a): DETENT_SELF_FEEDBACK=off -> recorded:false, journal absent', () => {
  const root = freshRoot();
  const r = run(root, ['add', '--area', 'scout', '--note', 'should not land'], { DETENT_SELF_FEEDBACK: 'off' });
  const j = JSON.parse(r.stdout);
  assert.equal(r.status, 0);
  assert.equal(j.ok, true);
  assert.equal(j.recorded, false);
  assert.match(j.reason, /disabled via DETENT_SELF_FEEDBACK=off/);
  assert.equal(fs.existsSync(journalPath(root)), false, 'file untouched');
});

test('honesty (b): journal path unwritable (pre-created as a FILE) -> exit 1, recorded:false, never recorded:true', () => {
  const root = freshRoot();
  const storeDir = path.join(root, '.local', 'self-feedback');
  fs.mkdirSync(path.join(root, '.local'), { recursive: true });
  fs.writeFileSync(storeDir, 'not a directory'); // pre-create as a FILE so mkdir/append fails
  const r = run(root, ['add', '--area', 'scout', '--note', 'will fail to write']);
  const j = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.equal(j.recorded, false);
  assert.notEqual(j.recorded, true);
  assert.doesNotMatch(r.stdout, /"recorded":true/);
});
