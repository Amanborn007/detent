// The review shell (the page with the artifact iframe and the sidebar) must not
// lose a reader's answers. Structure checks run against the page the server
// renders; the decision logic is exported from server.mjs and tested directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chromePage, answerProgress, deliveryLabel, itemDelivery } from '../server.mjs';

const page = chromePage({ id: 'abc123', file: '/tmp/plan.html' });

test('keys are stored per session before the fragment is stripped, and read back on reload', () => {
  const store = page.indexOf('sessionStorage.setItem(');
  const strip = page.indexOf('history.replaceState(');
  assert.ok(store !== -1 && strip !== -1 && store < strip, 'keys are saved before replaceState removes them');
  assert.match(page, /sessionStorage\.getItem\('curator:keys:' \+ SID\)|sessionStorage\.getItem\(KEYS_KEY\)/);
  assert.match(page, /sandbox="allow-scripts allow-forms"/);
  assert.doesNotMatch(page, /allow-same-origin/);
});

test('the shell never opens a native dialog', () => {
  assert.doesNotMatch(page, /window\.(prompt|confirm|alert)\(/);
});

test('annotation, selection and edit comments use an inline multi-line composer', () => {
  assert.match(page, /id="modalText"/);
  assert.match(page, /<textarea[^>]*id="modalText"/);
  assert.match(page, /function openModal\(/);
});

test('End session and artifact-queued prompts ask through an inline confirm row', () => {
  assert.match(page, /End the session\?/);
  assert.match(page, /enqueue\(\{ type: 'prompt', text: d\.text \}\)/);
  assert.match(page, /id="errText"/, 'errors show inline');
});

test('an unreachable server shows a banner, keeps ticking and clears on recovery', () => {
  assert.match(page, /Curator server not reachable — your unsent items are kept/);
  assert.match(page, /id="offline"/);
  assert.doesNotMatch(page, /server restarting; retry on next tick/);
});

test('the stale banner says what to do and unsent drafts are offered as copyable text', () => {
  assert.match(page, /earlier curator server/i);
  assert.match(page, /curator open/);
  assert.match(page, /id="drafts"/);
  assert.match(page, /function draftText\(/);
});

test('drafts persist per session and come back on reload', () => {
  assert.match(page, /sessionStorage\.setItem\(DRAFT_KEY/);
  assert.match(page, /sessionStorage\.getItem\(DRAFT_KEY\)/);
  assert.match(page, /commentEl\.addEventListener\('input'/);
});

test('after Send the artifact is told decision-sent; retractions still send decision-cleared', () => {
  assert.match(page, /action: 'decision-sent', question: item\.question/);
  assert.match(page, /action: 'decision-cleared', question: item\.question/);
  const sendBlock = page.slice(page.indexOf("api('POST', '/api/send?s='"));
  assert.doesNotMatch(sendBlock.slice(0, sendBlock.indexOf('endBtn.addEventListener')), /decision-cleared/);
});

test('the sidebar shows answered progress and warns before sending with required questions open', () => {
  assert.match(page, /id="progress"/);
  assert.match(page, /decisions answered/);
  assert.match(page, /Send anyway/);
  assert.match(page, /d\.action === 'questions'/);
});

test('sent items show delivery state from the updates feed', () => {
  assert.match(page, /resp\.delivered/);
  assert.match(page, /resp\.polling/);
  assert.match(page, /id="sentList"/);
});

test('a changed artifact mtime saves drafts, reloads the iframe and re-posts marks', () => {
  assert.match(page, /resp\.mtime/);
  assert.match(page, /function repostMarks\(/);
  assert.match(page, /frame\.addEventListener\('load', repostMarks\)/);
});

test('answerProgress counts answered questions against the ones the artifact reported', () => {
  const qs = [{ question: 'a', required: true }, { question: 'b', required: false }, { question: 'c', required: true }];
  const p = answerProgress(qs, ['a', 'b']);
  assert.equal(p.known, true);
  assert.equal(p.total, 3);
  assert.equal(p.answered, 2);
  assert.deepEqual(p.unanswered, ['c']);
  assert.deepEqual(p.requiredMissing, ['c']);
});

test('answerProgress without a reported total only counts answers and says so', () => {
  const p = answerProgress(null, ['a', 'a', 'b']);
  assert.equal(p.known, false);
  assert.equal(p.total, null);
  assert.equal(p.answered, 2, 'a re-answered question counts once');
  assert.deepEqual(p.requiredMissing, []);
});

test('an answer to a question the artifact did not list is not counted against its total', () => {
  const p = answerProgress([{ question: 'a' }], ['a', 'zzz']);
  assert.equal(p.answered, 1);
});

test('itemDelivery is sent until the ledger lists the id, then delivered', () => {
  assert.equal(itemDelivery('i1', [{ id: 'i2', at: 'x' }]), 'sent');
  assert.equal(itemDelivery('i1', [{ id: 'i1', at: 'x' }]), 'delivered');
});

test('deliveryLabel separates delivered from queued with no agent listening', () => {
  assert.equal(deliveryLabel('delivered', false), 'delivered to agent');
  assert.equal(deliveryLabel('sent', false), 'queued — agent not listening right now');
  assert.match(deliveryLabel('sent', true), /agent/);
});
