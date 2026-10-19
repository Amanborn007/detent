// Source-level guards for the two review-surface affordances that are easy to
// regress and expensive to notice: a decision answerable in your own words, and
// queued feedback you can still edit before sending. Both live in browser code
// (the injected SDK and the chrome page's inline script), so they are asserted
// against the source that ships rather than through a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sdk = fs.readFileSync(path.join(DIR, '..', 'sdk.js'), 'utf8');
const server = fs.readFileSync(path.join(DIR, '..', 'server.mjs'), 'utf8');

test('a note is emitted whether or not an option is chosen', () => {
  // The old shape gated the emit on a chosen answer, which silently dropped the
  // note of anyone who disagreed with every option offered.
  assert.match(sdk, /emitDecision\(qEl, chosenAnswer\(qEl\)\)/);
  assert.doesNotMatch(sdk, /if \(answer !== null\) emitDecision/);
});

test('the note label never tells the reader to pick an option first', () => {
  assert.doesNotMatch(sdk, /pick an option above/i);
  assert.match(sdk, /answer in your own words/i);
});

test('the decision block gets its own panel treatment and a badge', () => {
  assert.match(sdk, /\[data-plan-question\]\{[^}]*border-left:4px solid/);
  assert.match(sdk, /\[data-plan-question\]::before\{content:"Decision needed"/);
  // The artifact is read in both themes, so the accent must be defined for dark too.
  assert.match(sdk, /prefers-color-scheme: dark[\s\S]*data-plan-question/);
});

test('the SDK applies a note pushed back from the queue', () => {
  assert.match(sdk, /d\.action === 'note-set'/);
  assert.match(sdk, /function setNote\(question, note\)/);
});

test('an answerless, noteless decision retracts instead of queueing a null answer', () => {
  assert.match(server, /d\.answer === null && dec\.note === undefined/);
  assert.match(server, /function dequeueDecision\(question\)/);
});

test('a note-only decision is labelled as an answer, not as "null"', () => {
  assert.match(server, /answered in your own words/);
});

test('queued items are click-to-edit and keyboard reachable', () => {
  assert.match(server, /function editItem\(i\)/);
  assert.match(server, /body\.addEventListener\('click', function \(\) \{ editItem\(i\); \}\)/);
  assert.match(server, /body\.setAttribute\('tabindex', '0'\)/);
  assert.match(server, /title = 'Click to edit'/);
});

test('editing a decision pushes the new note back into the artifact', () => {
  assert.match(server, /action: 'note-set', question: item\.question/);
});

test('removing a decision clears its note out of the artifact too', () => {
  // Otherwise the textarea still shows text that is no longer queued, and the
  // next keystroke or option click resurrects it.
  assert.match(sdk, /d\.action === 'decision-cleared'\) \{[\s\S]{0,240}setNote\(d\.question, ''\)/);
});

test('clearing an edited item removes it from the queue', () => {
  assert.match(server, /if \(next === ''\) queue\.splice\(i, 1\); else item\[field\] = next;/);
});
