import { test } from 'node:test';
import assert from 'node:assert';
import { tagUrgency, makeItem } from '../herald.mjs';

test('urgent signals', () => {
  assert.equal(tagUrgency({ blocked: true }), 'urgent');
  assert.equal(tagUrgency({ failing: true }), 'urgent');
  assert.equal(tagUrgency({ changes_requested: true }), 'urgent');
  assert.equal(tagUrgency({ unresolved_bot_comments: true }), 'urgent');
  assert.equal(tagUrgency({ due_today: true, overdue: true }), 'urgent');
});

test('needs-action signals', () => {
  assert.equal(tagUrgency({ review_requested_from_you: true }), 'needs-action');
  assert.equal(tagUrgency({ approved_mergeable: true }), 'needs-action');
  assert.equal(tagUrgency({ provisional_decisions: true }), 'needs-action');
  assert.equal(tagUrgency({ awaiting_your_stage: true }), 'needs-action');
  assert.equal(tagUrgency({ due_today: true }), 'needs-action');
  assert.equal(tagUrgency({ mention: true }), 'needs-action');
  assert.equal(tagUrgency({ needs_reply: true }), 'needs-action');
});

test('no actionable signal is FYI', () => {
  assert.equal(tagUrgency({}), 'fyi');
  assert.equal(tagUrgency(), 'fyi');
  assert.equal(tagUrgency({ merged: true }), 'fyi');
});

test('urgent beats needs-action when both present (precedence)', () => {
  assert.equal(tagUrgency({ failing: true, review_requested_from_you: true }), 'urgent');
});

test('makeItem computes urgency and preserves the action', () => {
  const it = makeItem({
    id: 'pr:7', title: 'PR #7', source: 'github',
    urgencySignals: { changes_requested: true },
    action: { type: 'pr', command: 'detent sentinel url' },
  });
  assert.equal(it.urgency, 'urgent');
  assert.equal(it.action.type, 'pr');
  assert.equal(it.id, 'pr:7');
});
