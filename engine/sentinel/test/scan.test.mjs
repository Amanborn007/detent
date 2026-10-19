import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, scanPure } from '../sentinel.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const config = loadConfig(here('../config.example.json'));
const dirty = {
  issue: JSON.parse(readFileSync(here('./fixtures/issue_comments.json'), 'utf8')),
  review: JSON.parse(readFileSync(here('./fixtures/review_comments.json'), 'utf8')),
};
const clean = {
  issue: JSON.parse(readFileSync(here('./fixtures/issue_comments_clean.json'), 'utf8')),
  review: JSON.parse(readFileSync(here('./fixtures/review_comments_clean.json'), 'utf8')),
};

const PR_KEY = 'acme/widget#7';

test('full scan over dirty fixtures: routing, escalation, iteration, state', () => {
  const { result, state } = scanPure({
    comments: dirty,
    config,
    state: {},
    prKey: PR_KEY,
  });

  // auto_address findings that do NOT hit escalation globs
  const files = result.new_findings.map((f) => f.file).sort();
  assert.deepEqual(files, ['src/api/handler.js', 'src/util/format.js']);
  for (const f of result.new_findings) assert.equal(f.policy, 'auto_address');

  // escalations: glob hit (deliveries/**), escalate-policy bot, unknown bot
  assert.equal(result.human_escalations.length, 3);
  const reasons = result.human_escalations.map((e) => e.reason).sort();
  assert.deepEqual(reasons, ['glob:deliveries/**', 'policy:escalate', 'unknown-bot']);
  const globEsc = result.human_escalations.find((e) => e.reason === 'glob:deliveries/**');
  assert.equal(globEsc.file, 'deliveries/retry.js');
  const secEsc = result.human_escalations.find((e) => e.reason === 'policy:escalate');
  assert.equal(secEsc.bot, 'seccomb-scan');
  assert.equal(secEsc.severity, 'High');

  // FYI bots recorded but not actionable
  assert.equal(result.ignored.length, 2);

  assert.equal(result.converged, false);
  assert.equal(result.iteration, 1);
  // review-bot is drip_feed and produced findings
  assert.ok(result.drip_warning);
  assert.match(result.next_step, /fix/i);

  // state advanced to the max seen ids
  const s = state[PR_KEY];
  assert.equal(s.last_issue_comment_id, 1005);
  assert.equal(s.last_review_comment_id, 2002);
  assert.equal(s.iteration, 1);
});

test('re-scan with advanced state sees nothing new and does not bump iteration', () => {
  const first = scanPure({ comments: dirty, config, state: {}, prKey: PR_KEY });
  const second = scanPure({
    comments: dirty,
    config,
    state: first.state,
    prKey: PR_KEY,
  });
  assert.equal(second.result.new_findings.length, 0);
  assert.equal(second.result.human_escalations.length, 0);
  assert.equal(second.result.iteration, 1);
  // latest sentinel comment still reports findings -> not converged
  assert.equal(second.result.converged, false);
});

test('an edited-in-place sticky (same id, newer updated_at) is re-detected', () => {
  // Some bots (e.g. an edit-in-place review bot) update ONE sticky comment in
  // place — same id, new body, bumped updated_at. Freshness-by-id alone misses
  // the new findings. State says we already advanced past this id, but the
  // comment was edited after our last scan.
  const edited = {
    issue: [{
      id: 1001,
      created_at: '2026-07-01T09:00:00Z',
      updated_at: '2026-07-01T12:00:00Z',
      html_url: 'https://github.com/acme/widget/pull/7#issuecomment-1001',
      user: { login: 'github-actions[bot]', type: 'Bot' },
      body: [
        '<!-- review-bot:sticky -->',
        '## Automated review',
        '[P1] Possible null dereference in `src/api/handler.js:42`',
        'The response object may be null.',
      ].join('\n'),
    }],
    review: [],
  };
  const state = { [PR_KEY]: { last_issue_comment_id: 5000, last_scan: '2026-07-01T09:00:00Z' } };
  const { result } = scanPure({ comments: edited, config, state, prKey: PR_KEY });
  const surfaced = [...result.new_findings, ...result.human_escalations];
  assert.ok(surfaced.some((f) => f.file === 'src/api/handler.js'),
    'an edited sticky must re-surface its findings');
});

test('re-processing an edited sticky does NOT re-report already-seen findings', () => {
  // Guard against the failure mode where re-extracting an edited sticky body
  // (which may retain resolved findings) fabricates duplicate findings.
  const edited = {
    issue: [{
      id: 1001,
      created_at: '2026-07-01T09:00:00Z',
      updated_at: '2026-07-01T12:00:00Z',
      html_url: 'https://github.com/acme/widget/pull/7#issuecomment-1001',
      user: { login: 'github-actions[bot]', type: 'Bot' },
      body: [
        '<!-- review-bot:sticky -->',
        '[P1] Possible null dereference in `src/api/handler.js:42`',
      ].join('\n'),
    }],
    review: [],
  };
  // First pass surfaces the finding and records its fingerprint.
  const base = { [PR_KEY]: { last_issue_comment_id: 5000, last_scan: '2026-07-01T09:00:00Z' } };
  const first = scanPure({ comments: edited, config, state: base, prKey: PR_KEY });
  assert.ok([...first.result.new_findings, ...first.result.human_escalations].length > 0);
  // Second pass: sticky edited again (still newer than the ORIGINAL last_scan),
  // same finding retained in the body -> must not re-report.
  const carried = { [PR_KEY]: { ...first.state[PR_KEY], last_scan: '2026-07-01T09:00:00Z' } };
  const second = scanPure({ comments: edited, config, state: carried, prKey: PR_KEY });
  assert.equal(second.result.new_findings.length + second.result.human_escalations.length, 0,
    'already-seen findings must not be re-reported when a sticky is edited again');
});

test('last_watched_comment_at reflects only watched (non-ignore) bot comments', () => {
  const comments = {
    issue: [
      { id: 1, created_at: '2026-07-01T10:00:00Z', user: { login: 'github-actions[bot]', type: 'Bot' },
        body: '<!-- review-bot:sticky -->\n[P1] bug in `src/a.js:1`' }, // auto_address -> watched
      { id: 2, created_at: '2026-07-01T11:00:00Z', user: { login: 'github-actions[bot]', type: 'Bot' },
        body: '<!-- bundlewatch:comment -->\nBundle size ok.' },            // ignore -> NOT watched
      { id: 3, created_at: '2026-07-01T12:00:00Z', user: { login: 'somedev', type: 'User' },
        body: 'lgtm' },                                                     // human -> NOT watched
    ],
    review: [],
  };
  const { result } = scanPure({ comments, config, state: {}, prKey: PR_KEY });
  // The later ignore/human comments must not win — only the 10:00 watched one.
  assert.equal(result.last_watched_comment_at, '2026-07-01T10:00:00Z');
});

test('last_watched_comment_at is null when only humans/ignored bots commented', () => {
  const comments = {
    issue: [
      { id: 1, created_at: '2026-07-01T11:00:00Z', user: { login: 'github-actions[bot]', type: 'Bot' },
        body: '<!-- bundlewatch:comment -->\nBundle size ok.' }, // ignore
      { id: 2, created_at: '2026-07-01T12:00:00Z', user: { login: 'somedev', type: 'User' }, body: 'lgtm' }, // human
    ],
    review: [],
  };
  const { result } = scanPure({ comments, config, state: {}, prKey: PR_KEY });
  assert.equal(result.last_watched_comment_at, null);
});

test('two distinct unknown-bot comments both escalate (fingerprint includes body, not just location)', () => {
  // Both have no file/line and severity 'unknown'; a location-only key would
  // collapse them and silently drop the second escalation.
  const comments = {
    issue: [
      { id: 1, created_at: '2026-07-01T10:00:00Z', user: { login: 'mystery-bot[bot]', type: 'Bot' },
        body: 'Concern A: something looks off.' },
      { id: 2, created_at: '2026-07-01T10:01:00Z', user: { login: 'mystery-bot[bot]', type: 'Bot' },
        body: 'Concern B: a different thing entirely.' },
    ],
    review: [],
  };
  const { result } = scanPure({ comments, config, state: {}, prKey: PR_KEY });
  assert.equal(result.human_escalations.length, 2);
});

test('last_watched_comment_at uses updated_at for edit-in-place re-reviews', () => {
  const comments = {
    issue: [
      { id: 1, created_at: '2026-07-01T09:00:00Z', updated_at: '2026-07-01T15:00:00Z',
        user: { login: 'github-actions[bot]', type: 'Bot' },
        body: '<!-- review-bot:sticky -->\nNo issues found' }, // watched, edited later
    ],
    review: [],
  };
  const { result } = scanPure({ comments, config, state: {}, prKey: PR_KEY });
  assert.equal(result.last_watched_comment_at, '2026-07-01T15:00:00Z');
});

test('--since filter drops comments at or before the cutoff', () => {
  const { result } = scanPure({
    comments: dirty,
    config,
    state: {},
    prKey: PR_KEY,
    since: '2026-07-01T10:04:30Z',
  });
  // only the two review comments (10:05, 10:06) are newer:
  // lintbot -> new_findings, seccomb -> human_escalations
  assert.equal(
    result.new_findings.length + result.human_escalations.length,
    2,
  );
  assert.ok(result.new_findings.every((f) => f.source === 'inline'));
});

test('clean fixtures converge', () => {
  const { result } = scanPure({ comments: clean, config, state: {}, prKey: PR_KEY });
  assert.equal(result.new_findings.length, 0);
  assert.equal(result.human_escalations.length, 0);
  assert.equal(result.converged, true);
  assert.match(result.next_step, /converged/i);
});

test('max_iterations reached tells the agent to stop and escalate', () => {
  // Seeded off the configured cap, so raising it does not silently stop
  // exercising the cap path.
  const { result } = scanPure({
    comments: dirty,
    config,
    state: { [PR_KEY]: { iteration: config.max_iterations - 1 } },
    prKey: PR_KEY,
  });
  assert.ok(result.iteration >= config.max_iterations);
  assert.match(result.next_step, /max iterations|escalate/i);
});

test('CLI config-check: exits 0 on the example config, 1 on a broken one', () => {
  const cli = here('../sentinel.mjs');
  const out = execFileSync(process.execPath, [cli, 'config-check', '--config', here('../config.example.json')], {
    encoding: 'utf8',
  });
  assert.match(out, /ok/i);

  const dir = mkdtempSync(join(tmpdir(), 'sentinel-test-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ bots: [{ name: 'x', policy: 'yolo' }] }));
  assert.throws(() =>
    execFileSync(process.execPath, [cli, 'config-check', '--config', bad], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
});
