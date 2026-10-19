import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildFeedbackSection, computeWindow } from '../herald.mjs';
import { mkWorkspace, rmWorkspace } from './helpers.mjs';

const WINDOW = computeWindow({ last_window_end: '2026-07-05T09:00:00Z' }, new Date('2026-07-06T09:00:00Z'));

function writeJournal(dir, lines) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'journal.jsonl');
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}

test('in-window entries roll up into ONE fyi item naming the areas and count', () => {
  const root = mkWorkspace();
  try {
    const jp = writeJournal(join(root, '.local', 'self-feedback'), [
      { schema: 'self-feedback-v0', id: 'sf-1', ts: '2026-07-05T10:00:00Z', area: 'scout', kind: 'coverage-gap', note: 'no hit' },
      { schema: 'self-feedback-v0', id: 'sf-2', ts: '2026-07-05T12:00:00Z', area: 'respond', kind: 'other', note: 'stuck' },
    ]);
    const sec = buildFeedbackSection(WINDOW, jp);
    assert.equal(sec.key, 'self-feedback');
    assert.equal(sec.status, 'ok');
    assert.equal(sec.items.length, 1, 'a rollup, never one item per entry');
    const item = sec.items[0];
    assert.equal(item.id, 'self-feedback:window');
    assert.equal(item.urgency, 'fyi');
    assert.match(item.title, /2 new self-feedback entries/);
    assert.match(item.title, /scout/);
    assert.match(item.title, /respond/);
    assert.equal(item.meta.count, 2);
    assert.match(item.action.command, /detent feedback list --since/);
  } finally { rmWorkspace(root); }
});

test('out-of-window entries are excluded from the count', () => {
  const root = mkWorkspace();
  try {
    const jp = writeJournal(join(root, '.local', 'self-feedback'), [
      { schema: 'self-feedback-v0', id: 'sf-old', ts: '2026-07-01T00:00:00Z', area: 'scout', kind: 'coverage-gap', note: 'old, out of window' },
    ]);
    const sec = buildFeedbackSection(WINDOW, jp);
    assert.equal(sec.items.length, 0, 'nothing in-window -> no rollup item');
  } finally { rmWorkspace(root); }
});

test('missing journal file -> 0 items, status ok, no throw', () => {
  const root = mkWorkspace();
  try {
    const jp = join(root, '.local', 'self-feedback', 'journal.jsonl'); // never written
    const sec = buildFeedbackSection(WINDOW, jp);
    assert.equal(sec.status, 'ok');
    assert.equal(sec.items.length, 0);
  } finally { rmWorkspace(root); }
});

test('a malformed line is skipped, never throws, and is reported in the rollup detail', () => {
  const root = mkWorkspace();
  try {
    const jp = writeJournal(join(root, '.local', 'self-feedback'), [
      { schema: 'self-feedback-v0', id: 'sf-1', ts: '2026-07-05T10:00:00Z', area: 'scout', kind: 'coverage-gap', note: 'ok' },
      'NOT VALID JSON {{{',
    ]);
    const sec = buildFeedbackSection(WINDOW, jp);
    assert.equal(sec.items.length, 1);
    assert.match(sec.items[0].detail, /1 malformed line/);
  } finally { rmWorkspace(root); }
});
