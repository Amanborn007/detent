// Source-level guards for the decision cards, in the same style as review-surface.test.mjs:
// the SDK is browser code, so it is asserted against the source that ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sdk = fs.readFileSync(path.join(DIR, '..', 'sdk.js'), 'utf8');

test('the accent comes from the page theme, not a hardcoded blue', () => {
  assert.match(sdk, /border-left:4px solid var\(--accent,/);
  assert.doesNotMatch(sdk, /border-left:4px solid #2563c9/);
  assert.match(sdk, /outline:2px solid var\(--accent,/);
});

test('options render as side-by-side cards', () => {
  assert.match(sdk, /grid-template-columns:repeat\(auto-fit,minmax\(/);
});

test('the recommended card carries a text label, not colour alone', () => {
  assert.match(sdk, /'Recommended'/);
  assert.match(sdk, /data-plan-recommended/);
  assert.match(sdk, /data-plan-reason/);
});

test('required decisions say so in words', () => {
  assert.match(sdk, /data-plan-required/);
  assert.match(sdk, /Required/);
});

test('options are keyboard operable', () => {
  assert.match(sdk, /setAttribute\('role', 'radio'\)/);
  assert.match(sdk, /setAttribute\('tabindex', '0'\)/);
  assert.match(sdk, /e\.key === 'Enter'/);
  assert.match(sdk, /e\.key === ' '/);
  assert.match(sdk, /:focus-visible/);
});

test('the brief is styled as the first thing on the page', () => {
  assert.match(sdk, /\[data-plan-brief\]\{/);
});

test('decision-sent keeps the mark and the note, and badges the panel', () => {
  assert.match(sdk, /d\.action === 'decision-sent'/);
  assert.match(sdk, /Sent — awaiting agent/);
  const sent = sdk.match(/d\.action === 'decision-sent'\) \{([\s\S]*?)\n    \}/);
  assert.ok(sent, 'decision-sent handler not found');
  assert.doesNotMatch(sent[1], /setNote\(d\.question, ''\)/);
  assert.doesNotMatch(sent[1], /markChosen\(d\.question, null\)/);
});

test('decision-cleared still retracts', () => {
  assert.match(sdk, /d\.action === 'decision-cleared'/);
});
