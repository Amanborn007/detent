import { test } from 'node:test';
import assert from 'node:assert';
import { renderBriefHtml, resourceLinkLabel } from '../herald.mjs';

const baseData = (items) => ({
  window: { start: '2026-07-05T05:56:50Z', end: '2026-07-06T05:56:50Z', hours: 24 },
  carry_context: [],
  counts: { urgent: 0, 'needs-action': 0, fyi: items.length },
  sections: [{ key: 'prs', title: 'Open PRs needing action', status: 'ok', items }],
});

test('resourceLinkLabel produces a readable host+path label', () => {
  assert.equal(
    resourceLinkLabel('https://github.com/example-org/webapp/pull/42'),
    'github.com/example-org/webapp/pull/42',
  );
  assert.equal(
    resourceLinkLabel('https://example.atlassian.net/browse/PROJ-42'),
    'example.atlassian.net/browse/PROJ-42',
  );
  // Non-URL input falls back to the raw string rather than throwing.
  assert.equal(resourceLinkLabel('not a url'), 'not a url');
});

test('every card with an action.url renders a clickable resource link', () => {
  const html = renderBriefHtml(baseData([
    { id: 'a', title: 'PR one', urgency: 'fyi',
      action: { type: 'pr', url: 'https://github.com/example-org/webapp/pull/42' } },
  ]));
  assert.match(html, /href="https:\/\/github\.com\/example-org\/webapp\/pull\/42"/);
  assert.match(html, /github\.com\/example-org\/webapp\/pull\/42/);
});

test('resource link falls back to meta.url then item.url', () => {
  const viaMeta = renderBriefHtml(baseData([
    { id: 'm', title: 'via meta', urgency: 'fyi', action: {}, meta: { url: 'https://example.com/x' } },
  ]));
  assert.match(viaMeta, /href="https:\/\/example\.com\/x"/);
});

test('a card with no url is flagged unverifiable, never silently linkless', () => {
  const html = renderBriefHtml(baseData([
    { id: 'n', title: 'no link', urgency: 'fyi', action: { type: 'thread' } },
  ]));
  assert.match(html, /no resource link — source unverifiable/);
});

test('every card carries a free-text note control wired to curator.queuePrompt', () => {
  const html = renderBriefHtml(baseData([
    { id: 'z', title: 'notable', urgency: 'fyi', action: { url: 'https://example.com/z' } },
  ]));
  assert.match(html, /class="note-in"/);
  assert.match(html, /data-plan-note="item:z"/);
  assert.match(html, /queuePrompt/);
});

test('a non-http(s) url never becomes a clickable href (XSS guard)', () => {
  const html = renderBriefHtml(baseData([
    { id: 'x', title: 'evil', urgency: 'fyi', action: { url: 'javascript:alert(1)' } },
  ]));
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /resource \(non-web link\)/);
});
