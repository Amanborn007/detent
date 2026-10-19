import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import {
  buildOvernightSection, buildPrsSection, buildSdlcSection,
  assembleBrief, computeWindow, renderBriefHtml,
} from '../herald.mjs';
import { mkWorkspace, rmWorkspace, seedOvernight, seedSdlc } from './helpers.mjs';

const WINDOW = computeWindow({ last_window_end: '2026-07-05T09:00:00Z' }, new Date('2026-07-06T09:00:00Z'));

test('owl: runs in the window are surfaced; failure and provisional-decision signals tag urgency', () => {
  const repo = mkWorkspace();
  try {
    // In-window run with a provisional decision -> needs-action.
    seedOvernight(repo, '2026-07-06-0300-tests', {
      startedAt: '2026-07-06T03:00:00Z',
      iterations: [{ n: 1, status: 'success', summary: 'added a test' }],
      decisions: [{ id: 'D-1', decision_needed: 'which mock lib' }],
    });
    // In-window run that only failed -> urgent.
    seedOvernight(repo, '2026-07-06-0400-lint', {
      startedAt: '2026-07-06T04:00:00Z',
      iterations: [{ n: 1, status: 'failure', reason: 'no-op' }],
    });
    // Out-of-window run (before the window) -> excluded.
    seedOvernight(repo, '2026-07-01-old', { startedAt: '2026-07-01T03:00:00Z', iterations: [{ n: 1, status: 'success' }] });

    const sec = buildOvernightSection(WINDOW, [repo]);
    assert.equal(sec.items.length, 2, 'only the two in-window runs');
    const byId = Object.fromEntries(sec.items.map((i) => [i.id, i]));
    assert.equal(byId['owl:2026-07-06-0300-tests'].urgency, 'needs-action');
    assert.equal(byId['owl:2026-07-06-0400-lint'].urgency, 'urgent');
    // Action carries the run dir so the agent can kick off a dedicated review.
    assert.ok(byId['owl:2026-07-06-0300-tests'].action.run_dir.includes('.owl'));
  } finally { rmWorkspace(repo); }
});

test('.sdlc: active runs surfaced, blocked -> urgent, in_progress -> needs-action, done excluded', () => {
  const home = join(mkWorkspace(), '.sdlc');
  try {
    seedSdlc(home, 'r-blocked', {
      ticket: 'ABC-1', repo: '/x',
      stages: { intake: { status: 'done' }, research: { status: 'done' }, plan: { status: 'blocked' } },
      decisions: [{ id: 'D-001', gate: 'intent', status: 'pending', blocks: ['implement'] }],
    });
    seedSdlc(home, 'r-progress', {
      ticket: 'ABC-2', repo: '/y',
      stages: { intake: { status: 'in_progress' } },
    });
    seedSdlc(home, 'r-done', {
      ticket: 'ABC-3', repo: '/z',
      stages: { intake: { status: 'done' }, research: { status: 'done' }, plan: { status: 'done' },
        implement: { status: 'done' }, recheck: { status: 'done' }, ship: { status: 'done' }, respond: { status: 'done' } },
    });
    const sec = buildSdlcSection(WINDOW, home);
    const byId = Object.fromEntries(sec.items.map((i) => [i.id, i]));
    assert.ok(!byId['sdlc:r-done'], 'completed run excluded');
    assert.equal(byId['sdlc:r-blocked'].urgency, 'urgent');
    assert.match(byId['sdlc:r-blocked'].action.command, /gate open intent/);
    assert.equal(byId['sdlc:r-progress'].urgency, 'needs-action');
    assert.match(byId['sdlc:r-progress'].action.command, /detent next --run/);
  } finally { rmWorkspace(join(home, '..')); }
});

test('PRs: injected fetch -> urgency from review/checks/bot signals', () => {
  const sec = buildPrsSection(WINDOW, {
    fetchPRs: () => [
      { number: 10, title: 'changes requested', url: 'u10', repository: 'o/r', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [] },
      { number: 11, title: 'failing checks', url: 'u11', repository: 'o/r', reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
      { number: 12, title: 'approved & green', url: 'u12', repository: 'o/r', reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
      { number: 13, title: 'quiet', url: 'u13', repository: 'o/r', reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [] },
    ],
  });
  const byId = Object.fromEntries(sec.items.map((i) => [i.id, i]));
  assert.equal(byId['pr:10'].urgency, 'urgent');
  assert.equal(byId['pr:11'].urgency, 'urgent');
  assert.equal(byId['pr:12'].urgency, 'needs-action');
  assert.equal(byId['pr:13'].urgency, 'fyi');
  assert.match(byId['pr:10'].action.command, /detent sentinel u10/);
});

test('PRs: gh failure surfaces as a section error (never a silent skip)', () => {
  const sec = buildPrsSection(WINDOW, { fetchPRs: () => { throw new Error('gh not runnable'); } });
  assert.equal(sec.status, 'error');
  assert.match(sec.error, /gh not runnable/);
  assert.ok(sec.enable_action);
});

test('assembleBrief: connector sections present and marked pending-interactive; counts computed', () => {
  const root = mkWorkspace();
  try {
    const data = assembleBrief({
      root,
      state: { last_window_end: '2026-07-05T09:00:00Z' },
      now: new Date('2026-07-06T09:00:00Z'),
      owlRoots: [root],
      deps: { fetchPRs: () => [{ number: 1, title: 'p', url: 'u', repository: 'o/r', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [] }] },
    });
    assert.equal(data.schema, 'morning-brief-data-v0');
    const connectors = data.sections.filter((s) => s.status === 'pending-interactive').map((s) => s.key).sort();
    assert.deepEqual(connectors, ['chat', 'mail', 'tickets']);
    assert.deepEqual(data.connectors_pending.sort(), ['chat', 'mail', 'tickets']);
    for (const s of data.sections.filter((s) => s.status === 'pending-interactive')) {
      assert.match(s.pending_reason, /interactive/i);
      assert.equal(s.items.length, 0);
    }
    assert.equal(data.counts.urgent, 1); // the one changes-requested PR
  } finally { rmWorkspace(root); }
});

test('renderBriefHtml: self-contained, actionable, no external URLs', () => {
  const root = mkWorkspace();
  try {
    const data = assembleBrief({
      root, state: { last_window_end: '2026-07-05T09:00:00Z' }, now: new Date('2026-07-06T09:00:00Z'),
      owlRoots: [root],
      deps: { fetchPRs: () => [{ number: 9, title: 'a pr', url: 'u9', repository: 'o/r', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [] }] },
    });
    const html = renderBriefHtml(data);
    assert.match(html, /<!DOCTYPE html>/);
    assert.doesNotMatch(html, /https?:\/\/[^"']*\.(css|js|woff|png|jpg|svg)/, 'no external asset URLs');
    assert.doesNotMatch(html, /<script src=/, 'no external scripts');
    assert.match(html, /data-plan-question=/, 'actionable decision blocks present');
    assert.match(html, /Access &amp; data completeness/, 'preflight panel present when connectors pending');
    assert.match(html, /Window 2026-07-05T09:00:00Z/);
  } finally { rmWorkspace(root); }
});
