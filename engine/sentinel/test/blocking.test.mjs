import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  loadConfig,
  scanPure,
  validateConfig,
  isBlockingSeverity,
  DEFAULT_BLOCKING_SEVERITIES,
} from '../sentinel.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const config = loadConfig(here('../config.example.json'));
const dirty = {
  issue: JSON.parse(readFileSync(here('./fixtures/issue_comments.json'), 'utf8')),
  review: JSON.parse(readFileSync(here('./fixtures/review_comments.json'), 'utf8')),
};
const threadFixtures = JSON.parse(readFileSync(here('./fixtures/review_threads.json'), 'utf8'));
const findThread = (id) => structuredClone(threadFixtures.find((t) => t.id === id));

const PR_KEY = 'acme/widget#7';

// ---------------------------------------------------------------------------
// 1. severity vocabulary
// ---------------------------------------------------------------------------

test('isBlockingSeverity: the blocking tiers', () => {
  for (const raw of ['P0', 'P1', 'critical', 'Critical', 'high', 'High', 'HIGH', 'blocker', 'Blocker']) {
    assert.equal(isBlockingSeverity(raw), true, `${raw} must be blocking`);
  }
});

test('isBlockingSeverity: the non-blocking tiers', () => {
  for (const raw of ['P2', 'P3', 'P4', 'medium', 'Medium', 'low', 'Low', 'nit', 'info', 'WARNING']) {
    assert.equal(isBlockingSeverity(raw), false, `${raw} must not be blocking`);
  }
});

test('isBlockingSeverity: must_fix / must-fix / "must fix" are one token', () => {
  for (const raw of ['must_fix', 'must-fix', 'must fix', 'MUST_FIX', 'Must-Fix']) {
    assert.equal(isBlockingSeverity(raw), true, `${raw} must be blocking`);
  }
});

test('isBlockingSeverity: Medium-High is blocking (the claude-review reportable tier)', () => {
  // A clean-review phrase such as "No High or Medium-High issues found" shows
  // Medium-High is a tier the bot reports, not a nit.
  assert.equal(isBlockingSeverity('Medium-High'), true);
  assert.equal(isBlockingSeverity('medium-high'), true);
});

test('isBlockingSeverity: exact token, so "highly unlikely" is not "high"', () => {
  assert.equal(isBlockingSeverity('highly unlikely'), false);
  assert.equal(isBlockingSeverity('higher'), false);
});

test('isBlockingSeverity: unparsed severity is INDETERMINATE (null), never a silent false', () => {
  for (const raw of ['unknown', '', null, undefined]) {
    assert.equal(isBlockingSeverity(raw), null, `${JSON.stringify(raw)} must be indeterminate`);
  }
});

test('isBlockingSeverity: a caller-supplied vocabulary replaces the default', () => {
  assert.equal(isBlockingSeverity('ERROR', ['ERROR']), true);
  assert.equal(isBlockingSeverity('High', ['ERROR']), false, 'a custom vocabulary is not additive');
  assert.ok(DEFAULT_BLOCKING_SEVERITIES.length > 0);
});

test('isBlockingSeverity: semgrep ERROR is blocking under the engine default', () => {
  // A security scanner's top severity reading non-blocking would be backwards.
  assert.equal(isBlockingSeverity('ERROR'), true);
});

// ---------------------------------------------------------------------------
// 2. every finding carries `blocking`
// ---------------------------------------------------------------------------

test('every finding carries a blocking flag', () => {
  const { result } = scanPure({ comments: dirty, config, state: {}, prKey: PR_KEY });
  const all = [...result.new_findings, ...result.human_escalations];
  assert.ok(all.length > 0);
  for (const f of all) {
    assert.ok('blocking' in f, `${f.bot} finding is missing the blocking flag`);
    assert.ok([true, false, null].includes(f.blocking));
  }

  const p1 = result.new_findings.find((f) => f.file === 'src/api/handler.js');
  assert.equal(p1.severity, 'P1');
  assert.equal(p1.blocking, true);

  const medium = result.new_findings.find((f) => f.file === 'src/util/format.js');
  assert.equal(medium.blocking, false);

  // the unknown bot never declared a severity pattern -> indeterminate
  const unknown = result.human_escalations.find((e) => e.reason === 'unknown-bot');
  assert.equal(unknown.blocking, null);
});

test('severity_unparsed counts findings from bots that DECLARED patterns but produced no match', () => {
  const cfg = {
    bots: [
      {
        name: 'mumbler',
        match: { logins: ['mumbler[bot]'] },
        policy: 'auto_address',
        severity_patterns: ['Severity:\\s*([A-Za-z][A-Za-z-]*)'],
      },
    ],
  };
  const comments = {
    issue: [],
    review: [
      {
        id: 1,
        user: { login: 'mumbler[bot]', type: 'Bot' },
        body: 'This looks off to me but I will not say how badly.',
        path: 'src/a.js',
        line: 3,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  };
  const { result } = scanPure({ comments, config: cfg, state: {}, prKey: PR_KEY });
  assert.equal(result.new_findings.length, 1);
  assert.equal(result.new_findings[0].blocking, null);
  assert.equal(result.blocking_detail.severity_unparsed, 1);
});

// ---------------------------------------------------------------------------
// 3. blocking_open from unresolved bot-rooted review threads
// ---------------------------------------------------------------------------

const blockingBotThread = (overrides = {}) => ({
  id: 'THREAD_bot_p1',
  isResolved: false,
  isOutdated: false,
  path: 'src/qux.js',
  line: 8,
  truncated: false,
  comments: [
    {
      id: 7001,
      html_url: 'https://github.com/acme/widget/pull/7#discussion_r7001',
      body: '<!-- review-bot:sticky -->\n[P1] null deref in `src/qux.js:8`',
      created_at: '2026-07-01T09:00:00Z',
      updated_at: '2026-07-01T09:00:00Z',
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ],
  ...overrides,
});

const inlineBotComment = (id, body, path, line) => ({
  id,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  body,
  path,
  line,
  html_url: `https://github.com/acme/widget/pull/7#discussion_r${id}`,
  created_at: '2026-07-01T09:00:00Z',
  updated_at: '2026-07-01T09:00:00Z',
});

test('an UNRESOLVED bot-rooted thread with a blocking root counts as open', () => {
  const { result } = scanPure({
    comments: { issue: [], review: [] },
    config,
    state: {},
    prKey: PR_KEY,
    threads: [blockingBotThread()],
  });
  assert.equal(result.blocking_detail.inline_open, 1);
  assert.equal(result.blocking_open, 1);
  assert.equal(result.converged, false, 'an open blocking finding must hold convergence');
});

test('a RESOLVED bot-rooted thread does not count as open', () => {
  const { result } = scanPure({
    comments: { issue: [], review: [] },
    config,
    state: {},
    prKey: PR_KEY,
    threads: [blockingBotThread({ isResolved: true })],
  });
  assert.equal(result.blocking_detail.inline_open, 0);
  assert.equal(result.blocking_open, 0);
});

test('an OUTDATED-but-unresolved bot thread still counts as open (isOutdated is positional, D-04)', () => {
  const { result } = scanPure({
    comments: { issue: [], review: [] },
    config,
    state: {},
    prKey: PR_KEY,
    threads: [blockingBotThread({ isOutdated: true })],
  });
  assert.equal(result.blocking_detail.inline_open, 1);
});

test('a truncated bot thread claiming resolved is treated as still open (fail loud)', () => {
  const { result } = scanPure({
    comments: { issue: [], review: [] },
    config,
    state: {},
    prKey: PR_KEY,
    threads: [blockingBotThread({ isResolved: true, truncated: true })],
  });
  assert.equal(result.blocking_detail.inline_open, 1);
});

test('a NON-blocking bot-rooted thread does not count (the P2 fixture)', () => {
  const { result } = scanPure({
    comments: { issue: [], review: [] },
    config,
    state: {},
    prKey: PR_KEY,
    threads: [findThread('THREAD_bot_rooted')],
  });
  assert.equal(result.blocking_detail.inline_open, 0);
  assert.equal(result.human_threads.total, 0, 'bot-rooted threads are still not human threads');
});

// ---------------------------------------------------------------------------
// 4. THE key test: sticky blocking findings are recomputed, bypassing dedup
// ---------------------------------------------------------------------------

test('a sticky bot still printing [P1] holds the gate even after seen-dedup silences the finding', () => {
  // A sticky bot with NO clean_phrases: botsClean cannot catch it, so the
  // recomputed sticky count is the ONLY thing standing between a retained P1
  // and a false convergence.
  const cfg = {
    bots: [
      {
        name: 'stickybot',
        match: { logins: ['github-actions[bot]'], markers: ['<!-- stickybot -->'] },
        policy: 'auto_address',
        severity_patterns: ['\\[(P\\d)\\]'],
      },
    ],
  };
  const sticky = {
    id: 500,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '<!-- stickybot -->\n[P1] null deref in `src/a.js:10`\n',
    created_at: '2026-07-01T09:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
    html_url: 'https://github.com/acme/widget/pull/7#issuecomment-500',
  };
  const comments = { issue: [sticky], review: [] };

  const first = scanPure({ comments, config: cfg, state: {}, prKey: PR_KEY });
  assert.equal(first.result.new_findings.length, 1);
  assert.equal(first.result.blocking_open, 1);
  assert.equal(first.result.converged, false);

  // Second scan, same unchanged sticky. seen_finding_keys suppresses the
  // finding, so new_findings is empty and nothing is "actionable" — but the
  // bot is still printing [P1], so the PR is NOT clean.
  const second = scanPure({ comments, config: cfg, state: first.state, prKey: PR_KEY });
  assert.equal(second.result.new_findings.length, 0, 'dedup suppresses the re-report');
  assert.equal(
    second.result.blocking_detail.sticky_open,
    1,
    'the blocking count must be RECOMPUTED from the latest comment, not carried in state',
  );
  assert.equal(second.result.converged, false, 'a retained [P1] must block convergence');
});

test('once the sticky stops printing the blocking finding, the gate clears', () => {
  const cfg = {
    bots: [
      {
        name: 'stickybot',
        match: { logins: ['github-actions[bot]'], markers: ['<!-- stickybot -->'] },
        policy: 'auto_address',
        severity_patterns: ['\\[(P\\d)\\]'],
      },
    ],
  };
  const dirtySticky = {
    id: 500,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '<!-- stickybot -->\n[P1] null deref in `src/a.js:10`\n',
    created_at: '2026-07-01T09:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
  };
  const first = scanPure({ comments: { issue: [dirtySticky], review: [] }, config: cfg, state: {}, prKey: PR_KEY });

  const cleanSticky = { ...dirtySticky, body: '<!-- stickybot -->\nAll clear.\n', updated_at: '2026-07-01T10:00:00Z' };
  const second = scanPure({
    comments: { issue: [cleanSticky], review: [] },
    config: cfg,
    state: first.state,
    prKey: PR_KEY,
  });
  assert.equal(second.result.blocking_open, 0);
  assert.equal(second.result.converged, true);
});

test('resolved_marker lets a sticky that RETAINS fixed findings still converge', () => {
  const cfg = {
    bots: [
      {
        name: 'stickybot',
        match: { logins: ['github-actions[bot]'], markers: ['<!-- stickybot -->'] },
        policy: 'auto_address',
        severity_patterns: ['\\[(P\\d)\\]'],
        resolved_marker: '~~|\\bRESOLVED\\b',
      },
    ],
  };
  const sticky = {
    id: 500,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '<!-- stickybot -->\n[P1] RESOLVED — null deref in `src/a.js:10`\n',
    created_at: '2026-07-01T09:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
  };
  const { result } = scanPure({ comments: { issue: [sticky], review: [] }, config: cfg, state: {}, prKey: PR_KEY });
  assert.equal(result.blocking_detail.sticky_open, 0, 'a struck-through/RESOLVED block is not open');
});

// ---------------------------------------------------------------------------
// 5. convergence interaction
// ---------------------------------------------------------------------------

test('clean phrase + zero new findings + one open blocking finding => NOT converged', () => {
  const cfg = {
    bots: [
      {
        name: 'stickybot',
        match: { logins: ['github-actions[bot]'], markers: ['<!-- stickybot -->'] },
        policy: 'auto_address',
        severity_patterns: ['\\[(P\\d)\\]'],
        clean_phrases: ['No issues found'],
      },
    ],
  };
  // The sticky claims clean, but an inline review thread from the same bot is
  // still unresolved with a P1 root: the bot contradicts itself, and the open
  // thread wins.
  const sticky = {
    id: 500,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '<!-- stickybot -->\nNo issues found',
    created_at: '2026-07-01T09:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
  };
  const thread = {
    id: 'T1',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.js',
    line: 10,
    truncated: false,
    comments: [
      {
        id: 7100,
        html_url: 'u',
        body: '<!-- stickybot -->\n[P1] null deref',
        created_at: '2026-07-01T09:00:00Z',
        updated_at: '2026-07-01T09:00:00Z',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ],
  };
  const { result } = scanPure({
    comments: { issue: [sticky], review: [] },
    config: cfg,
    state: {},
    prKey: PR_KEY,
    threads: [thread],
  });
  assert.equal(result.blocking_open, 1);
  assert.equal(result.converged, false, 'a clean phrase must not override an open blocking thread');
});

test('ANTI-LIVELOCK: an escalate-policy blocking finding does NOT hold convergence', () => {
  // A blocking semgrep/seccomb finding is gated by its pending decision in
  // respond, not by blocking_open. If it held blocking_open too, a human
  // answering "won't fix" would leave converged permanently false.
  const cfg = {
    bots: [
      {
        name: 'seccomb-scan',
        match: { logins: ['seccomb[bot]'] },
        policy: 'escalate',
        severity_patterns: ['Severity:\\s*([A-Za-z][A-Za-z-]*)'],
      },
    ],
  };
  const thread = {
    id: 'T_sec',
    isResolved: false,
    isOutdated: false,
    path: 'src/db/query.js',
    line: 88,
    truncated: false,
    comments: [
      {
        id: 7200,
        html_url: 'u',
        body: 'Severity: High\nPossible SQL injection.',
        created_at: '2026-07-01T09:00:00Z',
        updated_at: '2026-07-01T09:00:00Z',
        user: { login: 'seccomb[bot]', type: 'Bot' },
      },
    ],
  };
  const { result } = scanPure({
    comments: { issue: [], review: [] },
    config: cfg,
    state: {},
    prKey: PR_KEY,
    threads: [thread],
  });
  assert.equal(result.blocking_detail.inline_open, 0, 'escalate-policy findings are not auto-fixable');
  assert.equal(result.blocking_open, 0);
});

test('ANTI-LIVELOCK: a glob-escalated blocking finding does NOT hold convergence', () => {
  const cfg = {
    escalate_globs: ['deliveries/**'],
    bots: [
      {
        name: 'stickybot',
        match: { logins: ['github-actions[bot]'], markers: ['<!-- stickybot -->'] },
        policy: 'auto_address',
        severity_patterns: ['\\[(P\\d)\\]'],
      },
    ],
  };
  const sticky = {
    id: 500,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '<!-- stickybot -->\n[P1] hardcoded retry limit in `deliveries/retry.js:10`\n',
    created_at: '2026-07-01T09:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
  };
  const { result } = scanPure({ comments: { issue: [sticky], review: [] }, config: cfg, state: {}, prKey: PR_KEY });
  assert.equal(result.blocking_detail.sticky_open, 0, 'a glob-escalated finding is the human\'s, not the gate\'s');
});

test('without threads, blocking_open is a LOWER BOUND and says so via threads_scanned', () => {
  // The inline half of the gate is unknowable without GraphQL threads, so
  // blocking_open counts only what is provable. threads_scanned:false is the
  // signal that a 0 here is "none found", not "none exist" — respond must not
  // treat an incomplete gate as a clean one.
  const { result } = scanPure({ comments: { issue: [], review: [] }, config, state: {}, prKey: PR_KEY });
  assert.equal(result.blocking_detail.threads_scanned, false);
  assert.equal(result.blocking_detail.inline_open, null, 'unknown, not zero');
  assert.equal(result.blocking_open, 0, 'a lower bound over what was actually scanned');
  // back-compat: an empty PR still converges on the pre-existing bot-only rule
  assert.equal(result.converged, true);
});

// ---------------------------------------------------------------------------
// 6. iteration accounting
// ---------------------------------------------------------------------------

test('ANTI-UNBOUNDED-LOOP: iteration bumps on an escalation-only round', () => {
  const cfg = {
    bots: [
      {
        name: 'seccomb-scan',
        match: { logins: ['seccomb[bot]'] },
        policy: 'escalate',
        severity_patterns: ['Severity:\\s*([A-Za-z][A-Za-z-]*)'],
      },
    ],
  };
  const comments = {
    issue: [],
    review: [
      {
        id: 1,
        user: { login: 'seccomb[bot]', type: 'Bot' },
        body: 'Severity: High\nSQL injection.',
        path: 'src/db/query.js',
        line: 88,
        created_at: '2026-07-01T09:00:00Z',
        updated_at: '2026-07-01T09:00:00Z',
      },
    ],
  };
  const { result } = scanPure({ comments, config: cfg, state: {}, prKey: PR_KEY });
  assert.equal(result.new_findings.length, 0);
  assert.equal(result.human_escalations.length, 1);
  assert.equal(result.iteration, 1, 'an escalation-only round must still burn a round');
});

test('a no-news round does NOT bump iteration (polling silence is free)', () => {
  const { result } = scanPure({ comments: { issue: [], review: [] }, config, state: { [PR_KEY]: { iteration: 3 } }, prKey: PR_KEY });
  assert.equal(result.iteration, 3);
});

// ---------------------------------------------------------------------------
// 7. the cap
// ---------------------------------------------------------------------------

test('the engine default cap is 10 rounds', () => {
  assert.equal(config.max_iterations, 10, 'config.example.json is the authoritative default');
});

test('at the cap WITH blocking findings open, next_step is distinct and names them', () => {
  const cfg = {
    max_iterations: 10,
    bots: [
      {
        name: 'stickybot',
        match: { logins: ['github-actions[bot]'], markers: ['<!-- stickybot -->'] },
        policy: 'auto_address',
        severity_patterns: ['\\[(P\\d)\\]'],
      },
    ],
  };
  const sticky = {
    id: 500,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '<!-- stickybot -->\n[P1] still broken in `src/a.js:10`\n',
    created_at: '2026-07-01T09:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
  };
  const { result } = scanPure({
    comments: { issue: [sticky], review: [] },
    config: cfg,
    state: { [PR_KEY]: { iteration: 9 } },
    prKey: PR_KEY,
  });
  assert.equal(result.iteration, 10);
  assert.equal(result.blocking_open, 1);
  assert.match(result.next_step, /blocking/i);
  assert.match(result.next_step, /human|escalate/i);
});

// ---------------------------------------------------------------------------
// 8. the thread-id join
// ---------------------------------------------------------------------------

test('an inline bot finding gets thread_id joined from the threads by comment_id', () => {
  const cfg = {
    bots: [
      {
        name: 'stickybot',
        match: { logins: ['github-actions[bot]'], markers: ['<!-- stickybot -->'] },
        policy: 'auto_address',
        severity_patterns: ['\\[(P\\d)\\]'],
      },
    ],
  };
  const comments = {
    issue: [],
    review: [inlineBotComment(7001, '<!-- stickybot -->\n[P1] null deref', 'src/qux.js', 8)],
  };
  const { result } = scanPure({
    comments,
    config: cfg,
    state: {},
    prKey: PR_KEY,
    threads: [blockingBotThread()],
  });
  const f = result.new_findings[0];
  assert.equal(f.comment_id, 7001);
  assert.equal(f.thread_id, 'THREAD_bot_p1', 'the loop cannot resolve a thread it cannot name');
  assert.equal(f.thread_resolved, false);
});

test('a bot comment REPLYING inside a HUMAN-rooted thread gets no thread_id (D-01 guard)', () => {
  // Indexing every comment instead of thread roots would stamp a human's
  // thread_id onto a bot finding, and the resolve step would then close a
  // human's conversation.
  const cfg = {
    bots: [
      {
        name: 'stickybot',
        match: { logins: ['github-actions[bot]'], markers: ['<!-- stickybot -->'] },
        policy: 'auto_address',
        severity_patterns: ['\\[(P\\d)\\]'],
      },
    ],
  };
  const humanRooted = {
    id: 'THREAD_human',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.js',
    line: 4,
    truncated: false,
    comments: [
      {
        id: 8000,
        html_url: 'u',
        body: 'Why this approach?',
        created_at: '2026-07-01T08:00:00Z',
        updated_at: '2026-07-01T08:00:00Z',
        user: { login: 'msmith', type: 'User' },
      },
      {
        id: 8001,
        html_url: 'u',
        body: '<!-- stickybot -->\n[P1] also a null deref here',
        created_at: '2026-07-01T09:00:00Z',
        updated_at: '2026-07-01T09:00:00Z',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ],
  };
  const comments = {
    issue: [],
    review: [inlineBotComment(8001, '<!-- stickybot -->\n[P1] also a null deref here', 'src/a.js', 4)],
  };
  const { result } = scanPure({
    comments,
    config: cfg,
    state: {},
    prKey: PR_KEY,
    threads: [humanRooted],
  });
  const f = result.new_findings[0];
  assert.equal(f.thread_id, null, 'a bot reply inside a human thread must never be resolvable by the loop');
  assert.equal(result.blocking_detail.inline_open, 0, 'a human-rooted thread is not the bot gate');
});

// ---------------------------------------------------------------------------
// 9. config validation
// ---------------------------------------------------------------------------

test('validateConfig accepts a per-bot blocking_severities array', () => {
  const cfg = {
    bots: [
      {
        name: 'b',
        match: { logins: ['b[bot]'] },
        policy: 'auto_address',
        blocking_severities: ['ERROR'],
      },
    ],
  };
  assert.equal(validateConfig(cfg).ok, true, validateConfig(cfg).errors.join('; '));
});

test('validateConfig rejects a non-array blocking_severities', () => {
  const cfg = {
    bots: [{ name: 'b', match: { logins: ['b[bot]'] }, policy: 'auto_address', blocking_severities: 'ERROR' }],
  };
  const { ok, errors } = validateConfig(cfg);
  assert.equal(ok, false);
  assert.match(errors.join('; '), /blocking_severities/);
});

test('validateConfig rejects an empty or non-string blocking_severities entry', () => {
  for (const bad of [[''], [null], [3]]) {
    const cfg = {
      bots: [{ name: 'b', match: { logins: ['b[bot]'] }, policy: 'auto_address', blocking_severities: bad }],
    };
    assert.equal(validateConfig(cfg).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('validateConfig rejects "unknown" as a blocking severity (it is the unparsed sentinel)', () => {
  const cfg = {
    bots: [{ name: 'b', match: { logins: ['b[bot]'] }, policy: 'auto_address', blocking_severities: ['unknown'] }],
  };
  const { ok, errors } = validateConfig(cfg);
  assert.equal(ok, false);
  assert.match(errors.join('; '), /unknown/);
});

test('validateConfig accepts a global blocking_severities and rejects a bad one', () => {
  const base = { bots: [{ name: 'b', match: { logins: ['b[bot]'] }, policy: 'auto_address' }] };
  assert.equal(validateConfig({ ...base, blocking_severities: ['P1'] }).ok, true);
  assert.equal(validateConfig({ ...base, blocking_severities: 'P1' }).ok, false);
});

test('validateConfig rejects an invalid resolved_marker regex', () => {
  const cfg = {
    bots: [{ name: 'b', match: { logins: ['b[bot]'] }, policy: 'auto_address', resolved_marker: '(' }],
  };
  const { ok, errors } = validateConfig(cfg);
  assert.equal(ok, false);
  assert.match(errors.join('; '), /resolved_marker/);
});

test('a per-bot blocking_severities overrides the engine default', () => {
  const cfg = {
    bots: [
      {
        name: 'oddbot',
        match: { logins: ['odd[bot]'] },
        policy: 'auto_address',
        severity_patterns: ['Severity:\\s*([A-Za-z][A-Za-z-]*)'],
        blocking_severities: ['spicy'],
      },
    ],
  };
  const mk = (sev) => ({
    id: 1,
    user: { login: 'odd[bot]', type: 'Bot' },
    body: `Severity: ${sev}\nsomething`,
    path: 'src/a.js',
    line: 1,
    created_at: '2026-07-01T09:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
  });
  const spicy = scanPure({ comments: { issue: [], review: [mk('spicy')] }, config: cfg, state: {}, prKey: PR_KEY });
  assert.equal(spicy.result.new_findings[0].blocking, true);
  const high = scanPure({ comments: { issue: [], review: [mk('High')] }, config: cfg, state: {}, prKey: PR_KEY });
  assert.equal(high.result.new_findings[0].blocking, false, 'the override is not additive');
});
