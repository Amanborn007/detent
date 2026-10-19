// Unit tests for the core queue/poll semantics of curator's SessionStore.
// Written FIRST (TDD): these define the contract server.mjs must satisfy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore, FEEDBACK_NEXT_STEP, ENDED_NEXT_STEP } from '../server.mjs';

const KEY = '/tmp/fake/plan.html';

function freshStore(opts = {}) {
  const store = new SessionStore(opts);
  store.open(KEY);
  return store;
}

test('feedback sent while no poller is waiting is delivered to the next poll', async () => {
  const store = freshStore();
  const item = { type: 'annotation', selector: '#risk-1', elementText: 'Risk: data loss', comment: 'expand on this' };

  const delivered = store.send(KEY, [item]);
  assert.equal(delivered, false, 'no poller was waiting, so send() reports queued, not delivered');

  const result = await store.poll(KEY);
  assert.equal(result.status, 'feedback');
  assert.deepEqual(result.prompts, [item]);
  assert.equal(typeof result.next_step, 'string');
  assert.match(result.next_step, /curator reply/);
});

test('a waiting poll resolves as soon as feedback is sent', async () => {
  const store = freshStore();
  const pending = store.poll(KEY);
  const item = { type: 'prompt', text: 'prefer option B overall' };

  const delivered = store.send(KEY, [item]);
  assert.equal(delivered, true, 'a poller was waiting, so send() reports delivered');

  const result = await pending;
  assert.equal(result.status, 'feedback');
  assert.deepEqual(result.prompts, [item]);
  assert.equal(result.next_step, FEEDBACK_NEXT_STEP.replaceAll('<file>', KEY));
});

test('re-answering a decision question replaces the queued answer (exactly one per question)', async () => {
  const store = freshStore();
  const note = { type: 'annotation', selector: 'h2', elementText: 'Rollout', comment: 'too fast' };

  store.send(KEY, [{ type: 'decision', question: 'q1', answer: 'Option A' }, note]);
  store.send(KEY, [{ type: 'decision', question: 'q1', answer: 'Option B' }]);
  store.send(KEY, [{ type: 'decision', question: 'q2', answer: 'Yes' }]);

  const result = await store.poll(KEY);
  assert.equal(result.status, 'feedback');
  const decisions = result.prompts.filter((p) => p.type === 'decision');
  assert.deepEqual(decisions, [
    { type: 'decision', question: 'q1', answer: 'Option B' },
    { type: 'decision', question: 'q2', answer: 'Yes' },
  ]);
  assert.ok(result.prompts.some((p) => p.type === 'annotation'), 'non-decision items are kept');
  assert.equal(result.prompts.length, 3);
});

test('a decision note rides along with the answer and is replaced by question like any decision', async () => {
  const store = freshStore();

  // First answer carries a note; re-answering the same question replaces the
  // whole item (answer + note), keeping exactly one decision per question.
  store.send(KEY, [{ type: 'decision', question: 'q1', answer: 'Option A', note: 'cheaper to operate' }]);
  store.send(KEY, [{ type: 'decision', question: 'q1', answer: 'Option B', note: 'safer rollback' }]);
  store.send(KEY, [{ type: 'decision', question: 'q2', answer: 'Yes' }]); // note omitted → legacy shape

  const result = await store.poll(KEY);
  const decisions = result.prompts.filter((p) => p.type === 'decision');
  assert.deepEqual(decisions, [
    { type: 'decision', question: 'q1', answer: 'Option B', note: 'safer rollback' },
    { type: 'decision', question: 'q2', answer: 'Yes' },
  ]);
  // Backward-compat: a note-less decision has no `note` key at all.
  assert.equal('note' in decisions[1], false, 'note-less decision stays byte-identical to the legacy shape');
});

test('a note with no chosen option is a real answer and survives the round trip', async () => {
  const store = freshStore();

  // None of the offered options is the answer, so the reader writes their own.
  store.send(KEY, [{ type: 'decision', question: 'q1', answer: null, note: 'none of these — ship the flag first' }]);
  store.send(KEY, [{ type: 'decision', question: 'q2', answer: 'Yes' }]);

  const result = await store.poll(KEY);
  assert.deepEqual(result.prompts.filter((p) => p.type === 'decision'), [
    { type: 'decision', question: 'q1', answer: null, note: 'none of these — ship the flag first' },
    { type: 'decision', question: 'q2', answer: 'Yes' },
  ]);
});

test('a note-only answer is replaced by question like any other decision', async () => {
  const store = freshStore();

  store.send(KEY, [{ type: 'decision', question: 'q1', answer: null, note: 'first thoughts' }]);
  store.send(KEY, [{ type: 'decision', question: 'q1', answer: 'Option B', note: 'changed my mind' }]);

  const result = await store.poll(KEY);
  assert.deepEqual(result.prompts.filter((p) => p.type === 'decision'), [
    { type: 'decision', question: 'q1', answer: 'Option B', note: 'changed my mind' },
  ]);
});

test('end resolves a waiting poll with ended, and later polls return ended immediately', async () => {
  const store = freshStore();
  const pending = store.poll(KEY);

  store.end(KEY, { by: 'user' });

  const result = await pending;
  assert.equal(result.status, 'ended');
  assert.equal(result.next_step, ENDED_NEXT_STEP);

  const again = await store.poll(KEY);
  assert.equal(again.status, 'ended');
  assert.equal(again.next_step, ENDED_NEXT_STEP);
});

test('ending with undelivered feedback still hands the prompts over (never lost)', async () => {
  const store = freshStore();
  const item = { type: 'selection', selector: 'p', selectedText: 'phase 2', comment: 'cut this' };
  store.send(KEY, [item]);
  store.end(KEY, { by: 'user' });

  const result = await store.poll(KEY);
  assert.equal(result.status, 'ended');
  assert.deepEqual(result.prompts, [item]);
});

test('an ended payload dropped mid-delivery is requeued and served by the next poll', async () => {
  const store = freshStore();
  const item = { type: 'comment', text: 'last words before end' };
  store.send(KEY, [item]); // queued, no waiter
  store.end(KEY, { by: 'user' }); // no waiter -> pending kept for the next poll

  const payload = await store.poll(KEY);
  assert.equal(payload.status, 'ended');
  assert.deepEqual(payload.prompts, [item]);

  // The HTTP layer found the poller's socket dead and requeues the payload —
  // this must work for ended payloads too, not only feedback ones.
  store.requeue(KEY, payload);
  const again = await store.poll(KEY);
  assert.equal(again.status, 'ended');
  assert.deepEqual(again.prompts, [item], 'prompts from a dropped ended delivery are never lost');
});

test('pending feedback survives a store restart via the state file (durable queue)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curator-test-'));
  const stateFile = join(dir, 'state.json');

  const first = new SessionStore({ stateFile });
  first.open(KEY);
  const item = { type: 'decision', question: 'q1', answer: 'Ship it' };
  first.send(KEY, [item]);

  // The queue must already be flushed to disk (durable, not just in-memory).
  const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(onDisk.sessions[KEY], 'session persisted');
  assert.equal(onDisk.sessions[KEY].pending.length, 1);

  const second = new SessionStore({ stateFile });
  second.loadState();
  const result = await second.poll(KEY);
  assert.equal(result.status, 'feedback');
  assert.deepEqual(result.prompts, [item]);
});
