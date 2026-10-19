import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDispatchFeedback, buildDispatchLedger, applyDispatchUpdate,
  dispatchSummary, ledgerToRenderData, renderBriefHtml, DISPATCH_STATUSES,
} from '../herald.mjs';
import { mkWorkspace, rmWorkspace } from './helpers.mjs';

const BRIEF = join(dirname(fileURLToPath(import.meta.url)), '..', 'herald.mjs');
const NOW = new Date('2026-07-07T07:00:00Z');

function sampleData() {
  return {
    window: { start: '2026-07-06T07:00:00Z', end: '2026-07-07T07:00:00Z', hours: 24 },
    sections: [
      { title: 'Open PRs', items: [
        { id: 'pr-1', title: 'PR 1 red', urgency: 'urgent', action: { type: 'pr', url: 'https://x/1' } },
        { id: 'pr-2', title: 'PR 2 nit', urgency: 'needs-action', action: { type: 'pr' } },
        { id: 'pr-3', title: 'PR 3 fyi', urgency: 'fyi', action: {} },
      ] },
      { title: 'Slack', items: [
        { id: 'sl-1', title: 'reply', urgency: 'needs-action', action: { type: 'thread' } },
      ] },
    ],
  };
}

const FEEDBACK = { status: 'feedback', prompts: [
  { type: 'decision', question: 'item:pr-1', answer: 'act' },
  { type: 'decision', question: 'item:pr-2', answer: 'act' },
  { type: 'decision', question: 'item:pr-3', answer: 'snooze' },
  { type: 'decision', question: 'item:sl-1', answer: 'dismiss' },
  { type: 'prompt', text: 'item:pr-2 — note: also add a test' },
  { type: 'prompt', text: 'item:pr-4 — note: fix this one too (no button)' },
  { type: 'prompt', text: 'general standup reminder' },
] };

test('parseDispatchFeedback splits decisions, per-item notes, and general notes', () => {
  const { decisions, notes, general } = parseDispatchFeedback(FEEDBACK);
  assert.equal(decisions.get('pr-1'), 'act');
  assert.equal(decisions.get('sl-1'), 'dismiss');
  assert.equal(notes.get('pr-2'), 'also add a test');
  assert.equal(notes.get('pr-4'), 'fix this one too (no button)');
  assert.deepEqual(general, ['general standup reminder']);
});

test('buildDispatchLedger promotes act + note-only to pending, records snooze/dismiss, orders by urgency', () => {
  const l = buildDispatchLedger(sampleData(), FEEDBACK, { now: NOW });
  assert.deepEqual(l.items.map((i) => i.id), ['pr-1', 'pr-2', 'pr-4']); // urgent, needs-action, fyi(note-only)
  assert.ok(l.items.every((i) => i.status === 'pending'));
  assert.equal(l.items.find((i) => i.id === 'pr-2').note, 'also add a test');
  assert.equal(l.items.find((i) => i.id === 'pr-4').note, 'fix this one too (no button)'); // note-only => Act
  assert.deepEqual(l.snoozed.map((s) => s.id), ['pr-3']);
  assert.deepEqual(l.dismissed.map((s) => s.id), ['sl-1']);
  assert.equal(l.eta.count, 3);
  assert.ok(l.eta.minutes_low > 0 && l.eta.minutes_high >= l.eta.minutes_low);
});

test('a note attached to the decision itself (curator per-decision note field) is captured, not dropped', () => {
  // curator's SDK injects a note textarea under every decision block, so a note
  // can ride back on the decision prompt as {type:"decision", ..., note}. It
  // must survive parsing and reach the ledger row.
  const fb = { status: 'feedback', prompts: [
    { type: 'decision', question: 'item:pr-1', answer: 'act', note: 'only after the migration ships' },
    { type: 'decision', question: 'item:pr-2', answer: 'act' },
    { type: 'prompt', text: 'item:pr-2 — note: comment prompt wins over a decision note' },
    { type: 'decision', question: 'item:pr-3', answer: 'snooze' },
    { type: 'decision', question: 'item:sl-1', answer: 'dismiss' },
  ] };
  const { notes } = parseDispatchFeedback(fb);
  assert.equal(notes.get('pr-1'), 'only after the migration ships');
  // an explicit comment prompt for the same id still takes precedence
  assert.equal(notes.get('pr-2'), 'comment prompt wins over a decision note');
  const l = buildDispatchLedger(sampleData(), fb, { now: NOW });
  assert.equal(l.items.find((i) => i.id === 'pr-1').note, 'only after the migration ships');
});

test('applyDispatchUpdate marks a row and rejects bad id / bad status loudly', () => {
  const l = buildDispatchLedger(sampleData(), FEEDBACK, { now: NOW });
  applyDispatchUpdate(l, { id: 'pr-1', status: 'done', outcome: 'pushed abc', run: 'https://x/1' }, NOW);
  const it = l.items.find((i) => i.id === 'pr-1');
  assert.equal(it.status, 'done');
  assert.equal(it.outcome, 'pushed abc');
  assert.equal(it.run, 'https://x/1');
  assert.throws(() => applyDispatchUpdate(l, { id: 'nope', status: 'done' }), /no ledger item/);
  assert.throws(() => applyDispatchUpdate(l, { id: 'pr-2', status: 'bogus' }), /unknown dispatch status/);
  assert.ok(DISPATCH_STATUSES.includes('blocked'));
});

test('dispatchSummary is complete only when nothing is pending/in-progress', () => {
  const l = buildDispatchLedger(sampleData(), FEEDBACK, { now: NOW });
  assert.equal(dispatchSummary(l).complete, false);
  applyDispatchUpdate(l, { id: 'pr-1', status: 'done' }, NOW);
  applyDispatchUpdate(l, { id: 'pr-2', status: 'in-progress' }, NOW);
  assert.equal(dispatchSummary(l).complete, false); // in-progress still counts as remaining
  applyDispatchUpdate(l, { id: 'pr-2', status: 'blocked' }, NOW);
  applyDispatchUpdate(l, { id: 'pr-4', status: 'skipped' }, NOW);
  const s = dispatchSummary(l);
  assert.equal(s.complete, true);
  assert.deepEqual(s.by, { pending: 0, 'in-progress': 0, done: 1, blocked: 1, skipped: 1 });
});

test('ledgerToRenderData + renderBriefHtml produce a read-only outcome view with status badges', () => {
  const l = buildDispatchLedger(sampleData(), FEEDBACK, { now: NOW });
  applyDispatchUpdate(l, { id: 'pr-1', status: 'done', outcome: 'pushed abc123' }, NOW);
  applyDispatchUpdate(l, { id: 'pr-2', status: 'blocked', outcome: 'needs infra' }, NOW);
  applyDispatchUpdate(l, { id: 'pr-4', status: 'done' }, NOW);
  const html = renderBriefHtml(ledgerToRenderData(l));
  assert.match(html, /dispatch status/);       // header flips to outcome view
  assert.match(html, /d-done/);                  // done badge
  assert.match(html, /d-blocked/);               // blocked badge
  assert.match(html, /pushed abc123/);           // outcome text surfaces
  assert.match(html, /Snoozed/);                 // snoozed item shown
  assert.doesNotMatch(html, /data-plan-question="item:/); // no decision buttons on cards in dispatch mode
  // M1: general notes (not tied to any item) must never be silently dropped.
  assert.deepEqual(ledgerToRenderData(l).general_notes, ['general standup reminder']);
  assert.match(html, /General notes/);
  assert.match(html, /general standup reminder/);
  // sanity: the actionable (non-dispatch) render DOES emit those controls
  const actionable = renderBriefHtml({ ...sampleData(), counts: { urgent: 1, 'needs-action': 2, fyi: 1 } });
  assert.match(actionable, /data-plan-question="item:/);
});

test('dismiss note is preserved and surfaced in the outcome view (m3)', () => {
  const feedback = { prompts: [
    { type: 'decision', question: 'item:pr-3', answer: 'dismiss' },
    { type: 'prompt', text: 'item:pr-3 — note: false positive, already fixed upstream' },
  ] };
  const l = buildDispatchLedger(sampleData(), feedback, { now: NOW });
  assert.deepEqual(l.dismissed, [{ id: 'pr-3', title: 'PR 3 fyi', note: 'false positive, already fixed upstream' }]);
  const html = renderBriefHtml(ledgerToRenderData(l));
  assert.match(html, /Dismissed — false positive, already fixed upstream/);
});

test('a non-standard urgency is normalized to fyi and never crashes the renderer (m2)', () => {
  const data = {
    window: { start: '2026-07-06T07:00:00Z', end: '2026-07-07T07:00:00Z', hours: 24 },
    sections: [
      { title: 'Weird', items: [{ id: 'w-1', title: 'mystery urgency', urgency: 'critical', action: {} }] },
    ],
  };
  const feedback = { prompts: [{ type: 'decision', question: 'item:w-1', answer: 'act' }] };
  const l = buildDispatchLedger(data, feedback, { now: NOW });
  assert.equal(l.items[0].urgency, 'fyi'); // normalized in mkLedgerItem, not left as "critical"
  assert.doesNotThrow(() => renderBriefHtml(ledgerToRenderData(l)));
  // Guard the non-ledger (actionable) render path too — itemsByUrgency buckets an
  // unknown urgency into the fyi array but does not rewrite it.urgency itself, so
  // card() must fall back on its own.
  const actionableData = { ...data, counts: { urgent: 0, 'needs-action': 0, fyi: 1 } };
  assert.doesNotThrow(() => renderBriefHtml(actionableData));
});

test('CLI resume: dispatch-plan -> dispatch-update -> reloading the ledger from disk shows nothing pending was lost (m1)', () => {
  const root = mkWorkspace();
  try {
    const env = { ...process.env, DETENT_ROOT: root };
    const dataPath = join(root, 'brief-data-2026-07-07.json');
    writeFileSync(dataPath, JSON.stringify(sampleData()));

    const plan = spawnSync('node', [
      BRIEF, 'dispatch-plan', dataPath, '--feedback-json', JSON.stringify(FEEDBACK), '--now', '2026-07-07T07:00:00Z',
    ], { encoding: 'utf8', env });
    assert.equal(plan.status, 0, plan.stderr);
    const planOut = JSON.parse(plan.stdout);
    assert.ok(existsSync(planOut.ledger));
    assert.equal(planOut.worklist.length, 3);
    assert.deepEqual(planOut.general_notes, ['general standup reminder']);

    const upd = spawnSync('node', [
      BRIEF, 'dispatch-update', planOut.ledger, '--id', 'pr-1', '--status', 'done',
      '--outcome', 'pushed abc123', '--now', '2026-07-07T08:00:00Z',
    ], { encoding: 'utf8', env });
    assert.equal(upd.status, 0, upd.stderr);

    // Simulate a session restart: reload straight from disk, as a fresh process
    // (or a context-summarized session) would. Nothing pending should be lost.
    const reloaded = JSON.parse(readFileSync(planOut.ledger, 'utf8'));
    assert.equal(reloaded.items.find((i) => i.id === 'pr-1').status, 'done');
    assert.equal(reloaded.items.find((i) => i.id === 'pr-1').outcome, 'pushed abc123');
    assert.deepEqual(reloaded.items.filter((i) => i.id !== 'pr-1').map((i) => i.status), ['pending', 'pending']);

    const status = spawnSync('node', [BRIEF, 'dispatch-status', planOut.ledger], { encoding: 'utf8', env });
    assert.equal(status.status, 0, status.stderr);
    const statusOut = JSON.parse(status.stdout);
    assert.equal(statusOut.summary.complete, false);
    assert.equal(statusOut.summary.by.done, 1);
  } finally { rmWorkspace(root); }
});

test('dispatch-update CLI refuses loudly on a missing ledger, missing --id/--status, and an unknown id', () => {
  const root = mkWorkspace();
  try {
    const env = { ...process.env, DETENT_ROOT: root };

    const missing = spawnSync('node', [
      BRIEF, 'dispatch-update', join(root, 'nope.json'), '--id', 'x', '--status', 'done',
    ], { encoding: 'utf8', env });
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).ok, false);

    const dataPath = join(root, 'brief-data-2026-07-07.json');
    writeFileSync(dataPath, JSON.stringify(sampleData()));
    const plan = JSON.parse(spawnSync('node', [
      BRIEF, 'dispatch-plan', dataPath, '--feedback-json', JSON.stringify(FEEDBACK), '--now', '2026-07-07T07:00:00Z',
    ], { encoding: 'utf8', env }).stdout);

    const noId = spawnSync('node', [BRIEF, 'dispatch-update', plan.ledger, '--status', 'done'], { encoding: 'utf8', env });
    assert.equal(noId.status, 2);

    const noStatus = spawnSync('node', [BRIEF, 'dispatch-update', plan.ledger, '--id', 'pr-1'], { encoding: 'utf8', env });
    assert.equal(noStatus.status, 2);

    const badId = spawnSync('node', [
      BRIEF, 'dispatch-update', plan.ledger, '--id', 'nope-id', '--status', 'done',
    ], { encoding: 'utf8', env });
    assert.equal(badId.status, 2);
    assert.match(JSON.parse(badId.stdout).reason, /no ledger item/);

    const corruptPath = join(root, 'corrupt-ledger.json');
    writeFileSync(corruptPath, '{not json');
    const corrupt = spawnSync('node', [
      BRIEF, 'dispatch-update', corruptPath, '--id', 'x', '--status', 'done',
    ], { encoding: 'utf8', env });
    assert.equal(corrupt.status, 1); // JSON parse failure is a `fail()`, not a `refuse()`
  } finally { rmWorkspace(root); }
});

test('dispatch-plan refuses to clobber a ledger with progress unless --force (m4)', () => {
  const root = mkWorkspace();
  try {
    const env = { ...process.env, DETENT_ROOT: root };
    const dataPath = join(root, 'brief-data-2026-07-07.json');
    writeFileSync(dataPath, JSON.stringify(sampleData()));
    const plan1 = JSON.parse(spawnSync('node', [
      BRIEF, 'dispatch-plan', dataPath, '--feedback-json', JSON.stringify(FEEDBACK), '--now', '2026-07-07T07:00:00Z',
    ], { encoding: 'utf8', env }).stdout);

    spawnSync('node', [BRIEF, 'dispatch-update', plan1.ledger, '--id', 'pr-1', '--status', 'in-progress'], { encoding: 'utf8', env });

    // Re-plan without --force must refuse — pr-1 is no longer pending.
    const replan = spawnSync('node', [
      BRIEF, 'dispatch-plan', dataPath, '--feedback-json', JSON.stringify(FEEDBACK),
      '--out', plan1.ledger, '--now', '2026-07-07T09:00:00Z',
    ], { encoding: 'utf8', env });
    assert.equal(replan.status, 2, replan.stdout);
    assert.match(JSON.parse(replan.stdout).reason, /already exists/);
    const untouched = JSON.parse(readFileSync(plan1.ledger, 'utf8'));
    assert.equal(untouched.items.find((i) => i.id === 'pr-1').status, 'in-progress'); // progress survived the refused re-plan

    // --force explicitly overwrites.
    const forced = spawnSync('node', [
      BRIEF, 'dispatch-plan', dataPath, '--feedback-json', JSON.stringify(FEEDBACK),
      '--out', plan1.ledger, '--force', '--now', '2026-07-07T09:00:00Z',
    ], { encoding: 'utf8', env });
    assert.equal(forced.status, 0, forced.stderr);
    const overwritten = JSON.parse(readFileSync(plan1.ledger, 'utf8'));
    assert.equal(overwritten.items.find((i) => i.id === 'pr-1').status, 'pending');
  } finally { rmWorkspace(root); }
});
