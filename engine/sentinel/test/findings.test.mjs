import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  loadConfig,
  classifyComment,
  extractFindingsFromSticky,
  extractFindingsFromInline,
} from '../sentinel.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const config = loadConfig(here('../config.example.json'));
const issueComments = JSON.parse(readFileSync(here('./fixtures/issue_comments.json'), 'utf8'));
const reviewComments = JSON.parse(readFileSync(here('./fixtures/review_comments.json'), 'utf8'));

const botCfg = (name) => config.bots.find((b) => b.name === name);

test('sticky body extraction: severity tags, file:line refs, checkbox flag', () => {
  const sticky = issueComments.find((c) => c.id === 1001);
  const cls = classifyComment(sticky, config);
  assert.equal(cls.bot, 'review-bot');
  const findings = extractFindingsFromSticky(sticky, botCfg('review-bot'));
  assert.equal(findings.length, 2);

  const [p1, p2] = findings;
  assert.equal(p1.severity, 'P1');
  assert.equal(p1.file, 'src/api/handler.js');
  assert.equal(p1.line, 42);
  assert.equal(p1.source, 'sticky');
  assert.match(p1.body_excerpt, /null dereference/);
  assert.equal(p1.url, sticky.html_url);
  assert.equal(p1.feedback_checkbox, true);

  assert.equal(p2.severity, 'P2');
  assert.equal(p2.file, 'deliveries/retry.js');
  assert.equal(p2.line, 10);
});

test('sticky with no finding blocks yields no findings', () => {
  const clean = {
    ...issueComments[0],
    body: '<!-- review-bot:sticky -->\nNo issues found in this PR.',
  };
  const findings = extractFindingsFromSticky(clean, botCfg('review-bot'));
  assert.equal(findings.length, 0);
});

test('inline extraction: severity label, path and line from the API fields', () => {
  const inline = reviewComments.find((c) => c.id === 2001);
  const f = extractFindingsFromInline(inline, botCfg('lintbot'));
  assert.equal(f.severity, 'Medium');
  assert.equal(f.file, 'src/util/format.js');
  assert.equal(f.line, 12);
  assert.equal(f.source, 'inline');
  assert.equal(f.reply_channel, '@lintbot');
  assert.match(f.body_excerpt, /const/);
});

test('inline with no severity text falls back to "unknown"', () => {
  const inline = { ...reviewComments[0], body: 'just a nit, no label' };
  const f = extractFindingsFromInline(inline, botCfg('lintbot'));
  assert.equal(f.severity, 'unknown');
});

test('body excerpts are truncated (untrusted input stays bounded)', () => {
  const inline = { ...reviewComments[0], body: 'Severity: Low\n' + 'x'.repeat(5000) };
  const f = extractFindingsFromInline(inline, botCfg('lintbot'));
  assert.ok(f.body_excerpt.length <= 300);
});
