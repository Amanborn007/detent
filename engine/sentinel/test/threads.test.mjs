// threads.test.mjs — roadmap #5: GraphQL human review-thread classification.
// D-04 (locked): isOutdated is POSITIONAL, not semantic — an outdated but
// unresolved thread always escalates, never drops. D-01 (locked): human
// threads always escalate; `converged` stays bot-only (see classifyThreads'
// header comment in sentinel.mjs) — a human answers via the pending decision
// that blocks `respond`, sentinel itself never gates on an open thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadConfig, classifyThreads, scanPure, fetchReviewThreads } from '../sentinel.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const config = loadConfig(here('../config.example.json'));
const threadsFixture = JSON.parse(readFileSync(here('./fixtures/review_threads.json'), 'utf8'));
const PR_KEY = 'acme/widget#7';

function findThread(id) {
  const t = threadsFixture.find((x) => x.id === id);
  if (!t) throw new Error(`no fixture thread ${id}`);
  return t;
}

test('a new human thread escalates as human-thread:new', () => {
  const { escalations, summary } = classifyThreads({
    threads: [findThread('THREAD_new')], config, state: {}, prKey: PR_KEY,
  });
  assert.equal(escalations.length, 1);
  const e = escalations[0];
  assert.equal(e.reason, 'human-thread:new');
  assert.equal(e.thread_status, 'new');
  assert.equal(e.bot, 'human:msmith');
  assert.equal(e.source, 'thread');
  assert.equal(e.policy, 'escalate');
  assert.equal(e.severity, 'n/a');
  assert.equal(e.file, 'src/sender.ts');
  assert.equal(e.line, 95);
  assert.equal(e.comment_id, 9001);
  assert.equal(summary.new, 1);
  assert.equal(summary.total, 1);
  assert.equal(summary.escalated, 1);
});

test('an outdated + unresolved thread is escalated, never dropped (D-04, locked)', () => {
  const { escalations, summary } = classifyThreads({
    threads: [findThread('THREAD_outdated_unresolved')], config, state: {}, prKey: PR_KEY,
  });
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, 'human-thread:outdated-unresolved');
  assert.equal(escalations[0].thread_status, 'outdated_unresolved');
  assert.equal(summary.outdated_unresolved, 1);
  assert.equal(summary.new, 0);
});

test('a resolved thread is counted but never escalated', () => {
  const { escalations, summary } = classifyThreads({
    threads: [findThread('THREAD_resolved')], config, state: {}, prKey: PR_KEY,
  });
  assert.equal(escalations.length, 0);
  assert.equal(summary.resolved, 1);
  assert.equal(summary.escalated, 0);
  assert.equal(summary.total, 1);
});

test('a thread escalated then resolved then reopened without a new comment re-escalates (no silent forever-drop)', () => {
  const base = findThread('THREAD_new');
  const first = classifyThreads({ threads: [base], config, state: {}, prKey: PR_KEY });
  assert.equal(first.escalations.length, 1);

  // Same thread, same comments, but now resolved.
  const resolved = { ...base, isResolved: true };
  const state = { [PR_KEY]: { seen_thread_keys: first.seen_thread_keys } };
  const secondScan = classifyThreads({ threads: [resolved], config, state, prKey: PR_KEY });
  assert.equal(secondScan.escalations.length, 0);
  assert.equal(secondScan.summary.resolved, 1);

  // Reopened (GitHub "Unresolve conversation") with no new comment — same
  // last-comment id as the original escalation. Must re-escalate, not be
  // silently swallowed as already-seen forever.
  const state2 = { [PR_KEY]: { seen_thread_keys: secondScan.seen_thread_keys } };
  const thirdScan = classifyThreads({ threads: [base], config, state: state2, prKey: PR_KEY });
  assert.equal(thirdScan.escalations.length, 1, 'reopened thread with no new comment must re-escalate');
  assert.equal(thirdScan.summary.new, 1);
});

test('a bot-rooted thread is skipped entirely (no double-report vs. the REST inline path)', () => {
  const { escalations, summary } = classifyThreads({
    threads: [findThread('THREAD_bot_rooted')], config, state: {}, prKey: PR_KEY,
  });
  assert.equal(escalations.length, 0);
  assert.equal(summary.total, 0, 'bot-rooted threads are not counted as human threads at all');
});

test('dedup across scans: an unchanged unresolved thread does not re-escalate', () => {
  const first = classifyThreads({ threads: [findThread('THREAD_new')], config, state: {}, prKey: PR_KEY });
  assert.equal(first.escalations.length, 1);
  const state = { [PR_KEY]: { seen_thread_keys: first.seen_thread_keys } };
  const second = classifyThreads({ threads: [findThread('THREAD_new')], config, state, prKey: PR_KEY });
  assert.equal(second.escalations.length, 0, 'already-escalated + unchanged thread must not re-escalate');
  assert.equal(second.summary.new, 1, 'still counted as an open new thread even though not re-escalated');
});

test('a new comment on a seen thread re-escalates (key includes the last comment id)', () => {
  const first = classifyThreads({ threads: [findThread('THREAD_new')], config, state: {}, prKey: PR_KEY });
  const state = { [PR_KEY]: { seen_thread_keys: first.seen_thread_keys } };
  const base = findThread('THREAD_new');
  const withReply = {
    ...base,
    comments: [
      ...base.comments,
      {
        id: 9101,
        html_url: 'https://github.com/acme/widget/pull/7#discussion_r9101',
        body: 'Following up — still waiting on an answer.',
        created_at: '2026-07-01T10:00:00Z',
        updated_at: '2026-07-01T10:00:00Z',
        user: { login: 'msmith', type: 'User' },
      },
    ],
  };
  const second = classifyThreads({ threads: [withReply], config, state, prKey: PR_KEY });
  assert.equal(second.escalations.length, 1, 'a fresh human comment on an already-seen thread must re-escalate');
  assert.equal(second.escalations[0].comment_id, 9101);
});

test('ordering: new entries before outdated (ralph new/non-outdated-first)', () => {
  const { escalations } = classifyThreads({
    threads: [findThread('THREAD_outdated_unresolved'), findThread('THREAD_new')],
    config, state: {}, prKey: PR_KEY,
  });
  assert.deepEqual(escalations.map((e) => e.thread_status), ['new', 'outdated_unresolved']);
});

test('scanPure without threads: human_threads.scanned is false, existing result shape unchanged (back-compat)', () => {
  const { result } = scanPure({ comments: { issue: [], review: [] }, config, state: {}, prKey: PR_KEY });
  assert.deepEqual(result.human_threads, { scanned: false });
  assert.equal(result.converged, true);
  assert.deepEqual(result.human_escalations, []);
});

test('scanPure with threads: appends thread escalations after bot escalations; converged stays bot-only', () => {
  const { result, state } = scanPure({
    comments: { issue: [], review: [] },
    config, state: {}, prKey: PR_KEY,
    threads: [findThread('THREAD_new'), findThread('THREAD_outdated_unresolved')],
  });
  assert.equal(result.human_threads.scanned, true);
  assert.equal(result.human_threads.new, 1);
  assert.equal(result.human_threads.outdated_unresolved, 1);
  assert.equal(result.human_escalations.length, 2);
  assert.deepEqual(result.human_escalations.map((e) => e.source), ['thread', 'thread']);
  assert.equal(result.converged, true,
    'human threads never hold converged — a human answers via the pending decision blocking respond, not sentinel');
  assert.match(result.next_step, /unresolved human thread/i);

  // Re-scan with the advanced state: dedup means no re-escalation, and
  // converged remains unaffected either way (still bot-only).
  const rescan = scanPure({
    comments: { issue: [], review: [] },
    config, state, prKey: PR_KEY,
    threads: [findThread('THREAD_new'), findThread('THREAD_outdated_unresolved')],
  });
  assert.equal(rescan.result.human_escalations.length, 0, 'already-escalated threads dedup on rescan');
  assert.equal(rescan.result.converged, true);
});

test('fetchReviewThreads paginates and marks a comment-capped thread truncated', () => {
  const pages = [
    {
      data: { repository: { pullRequest: { reviewThreads: {
        nodes: [
          {
            id: 'T1', isResolved: false, isOutdated: false, path: 'a.js', line: 1,
            comments: { totalCount: 1, nodes: [
              { databaseId: 1, author: { login: 'human1', __typename: 'User' }, body: 'hi', url: 'u1', createdAt: 'c1', updatedAt: 'u1' },
            ] },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' },
      } } } },
    },
    {
      data: { repository: { pullRequest: { reviewThreads: {
        nodes: [
          {
            id: 'T2', isResolved: false, isOutdated: false, path: 'b.js', line: 2,
            comments: {
              totalCount: 60,
              nodes: Array.from({ length: 50 }, (_, i) => ({
                databaseId: 100 + i, author: { login: 'human2', __typename: 'User' },
                body: `c${i}`, url: `u${i}`, createdAt: 'c', updatedAt: 'u',
              })),
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } },
    },
  ];
  let call = 0;
  const fakeGql = () => pages[call++];
  const threads = fetchReviewThreads({ owner: 'acme', repo: 'widget', number: 7 }, fakeGql);
  assert.equal(threads.length, 2);
  assert.equal(threads[0].truncated, false);
  assert.equal(threads[1].truncated, true, 'a thread hitting the 50-comment cap is marked truncated');
  assert.equal(threads[1].comments.length, 50);
  assert.equal(threads[0].comments[0].user.login, 'human1');
  assert.equal(threads[0].comments[0].user.type, 'User');
});

test('fetchReviewThreads surfaces GraphQL errors loudly', () => {
  const fakeGql = () => ({ errors: [{ message: 'boom' }] });
  assert.throws(
    () => fetchReviewThreads({ owner: 'acme', repo: 'widget', number: 7 }, fakeGql),
    /errors/i,
  );
});
