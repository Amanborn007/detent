// Unit tests for artifact SDK-tag injection: the injected tag must never
// displace the doctype, or every artifact renders in quirks mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { injectedArtifact } from '../server.mjs';

const SID = 'abc123';
const TAG = `<script src="/sdk.js?s=${SID}"></script>`;

test('artifact with a doctype: doctype stays first, tag injected right after it', () => {
  const html = '<!DOCTYPE html>\n<html><body>plan</body></html>\n';
  const out = injectedArtifact(Buffer.from(html), SID).toString();
  assert.ok(out.startsWith(`<!DOCTYPE html>\n${TAG}\n`), `doctype must stay first, got: ${out.slice(0, 80)}`);
  assert.equal(out.replace(`\n${TAG}`, ''), html, 'artifact bytes otherwise identical');
  assert.equal(out.split('/sdk.js?s=').length - 1, 1, 'tag appears exactly once');
});

test('doctype match is case-insensitive and tolerates leading whitespace', () => {
  const html = '\n  <!doctype html>\n<html></html>\n';
  const out = injectedArtifact(Buffer.from(html), SID).toString();
  assert.ok(out.startsWith(`\n  <!doctype html>\n${TAG}\n`));
  assert.equal(out.replace(`\n${TAG}`, ''), html);
});

test('artifact without a doctype: tag is prepended', () => {
  const html = '<html><body>plan</body></html>\n';
  const out = injectedArtifact(Buffer.from(html), SID).toString();
  assert.ok(out.startsWith(`${TAG}\n`));
  assert.equal(out.slice(TAG.length + 1), html);
});

test('doctype preceded by an HTML comment: the injected tag never lands before the doctype (standards mode preserved)', () => {
  // A legal license/generator comment before <!DOCTYPE> keeps the browser in
  // standards mode. Prepending the script before the doctype would silently
  // downgrade the artifact to quirks mode — exactly what injection must avoid.
  const html = '<!-- generated plan -->\n<!DOCTYPE html>\n<html><body>plan</body></html>\n';
  const out = injectedArtifact(Buffer.from(html), SID).toString();
  const tagIdx = out.indexOf(TAG);
  const docIdx = out.toLowerCase().indexOf('<!doctype');
  assert.ok(docIdx !== -1, 'doctype must still be present');
  assert.ok(tagIdx > docIdx, `tag must be injected AFTER the doctype, got: ${out.slice(0, 100)}`);
  assert.equal(out.replace(`\n${TAG}`, ''), html, 'artifact bytes otherwise identical');
  assert.equal(out.split('/sdk.js?s=').length - 1, 1, 'tag appears exactly once');
});
