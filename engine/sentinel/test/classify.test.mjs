import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig, classifyComment } from '../sentinel.mjs';

const config = loadConfig(
  fileURLToPath(new URL('../config.example.json', import.meta.url)),
);

function comment(overrides) {
  return {
    id: 1,
    html_url: 'https://github.com/acme/widget/pull/7#issuecomment-1',
    created_at: '2026-07-01T10:00:00Z',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: 'hello',
    ...overrides,
  };
}

test('marker disambiguation: shared login resolves via sticky marker (sentinel)', () => {
  const c = classifyComment(
    comment({ body: '<!-- review-bot:sticky -->\n[P1] something' }),
    config,
  );
  assert.equal(c.bot, 'review-bot');
  assert.equal(c.policy, 'auto_address');
  assert.equal(c.matchedBy, 'marker');
});

test('marker disambiguation: same login, different marker resolves to bundlewatch', () => {
  const c = classifyComment(
    comment({ body: '<!-- bundlewatch:comment -->\nBundle size: 400 kB' }),
    config,
  );
  assert.equal(c.bot, 'bundlewatch');
  assert.equal(c.policy, 'ignore');
  assert.equal(c.matchedBy, 'marker');
});

test('shared login with no recognizable marker is unknown (ambiguous)', () => {
  const c = classifyComment(comment({ body: 'no marker here' }), config);
  assert.equal(c.unknown, true);
  assert.equal(c.policy, 'escalate');
});

test('dedicated bot login matches by login alone', () => {
  const c = classifyComment(
    comment({
      user: { login: 'lintbot[bot]', type: 'Bot' },
      body: 'Severity: Low\nnit',
    }),
    config,
  );
  assert.equal(c.bot, 'lintbot');
  assert.equal(c.policy, 'auto_address');
  assert.equal(c.matchedBy, 'login');
});

test('service account with user.type == User is treated as a bot via allowlist', () => {
  const c = classifyComment(
    comment({
      user: { login: 'acme-coverage-bot', type: 'User' },
      body: 'Coverage: 84%',
    }),
    config,
  );
  assert.equal(c.bot, 'coverage-svc');
  assert.equal(c.policy, 'ignore');
});

test('plain human user is not classified as a bot', () => {
  const c = classifyComment(
    comment({ user: { login: 'somedev', type: 'User' }, body: 'LGTM' }),
    config,
  );
  assert.equal(c, null);
});

test('unrecognized bot login is unknown and escalated', () => {
  const c = classifyComment(
    comment({ user: { login: 'mysterybot[bot]', type: 'Bot' }, body: 'beep' }),
    config,
  );
  assert.equal(c.unknown, true);
  assert.equal(c.policy, 'escalate');
  assert.match(c.bot, /mysterybot/);
});
