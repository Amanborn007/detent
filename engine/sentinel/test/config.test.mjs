import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  validateConfig,
  parsePrRef,
  globToRegExp,
  matchEscalationGlob,
} from '../sentinel.mjs';

const config = loadConfig(
  fileURLToPath(new URL('../config.example.json', import.meta.url)),
);

test('example config validates clean', () => {
  const res = validateConfig(config);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
});

test('config missing bots array is invalid', () => {
  const res = validateConfig({});
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /bots/.test(e)));
});

test('bot without name or policy is invalid', () => {
  const res = validateConfig({ bots: [{ match: { logins: ['x[bot]'] } }] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /name/.test(e)));
  assert.ok(res.errors.some((e) => /policy/.test(e)));
});

test('unknown policy value is invalid', () => {
  const res = validateConfig({
    bots: [{ name: 'x', policy: 'yolo', match: { logins: ['x[bot]'] } }],
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /policy/.test(e)));
});

test('bot without logins is invalid', () => {
  const res = validateConfig({ bots: [{ name: 'x', policy: 'ignore' }] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /logins/.test(e)));
});

test('broken severity_patterns regex is invalid', () => {
  const res = validateConfig({
    bots: [
      {
        name: 'x',
        policy: 'auto_address',
        match: { logins: ['x[bot]'] },
        severity_patterns: ['[unclosed'],
      },
    ],
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /severity_patterns/.test(e)));
});

test('duplicate bot names are invalid', () => {
  const res = validateConfig({
    bots: [
      { name: 'x', policy: 'ignore', match: { logins: ['a[bot]'] } },
      { name: 'x', policy: 'ignore', match: { logins: ['b[bot]'] } },
    ],
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /duplicate/i.test(e)));
});

test('non-array service_accounts / escalate_globs are invalid', () => {
  const res = validateConfig({
    bots: [{ name: 'x', policy: 'ignore', match: { logins: ['a[bot]'] } }],
    service_accounts: 'nope',
    escalate_globs: 42,
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /service_accounts/.test(e)));
  assert.ok(res.errors.some((e) => /escalate_globs/.test(e)));
});

test('parsePrRef handles full PR URLs', () => {
  const ref = parsePrRef('https://github.com/cli/cli/pull/1234', undefined);
  assert.deepEqual(ref, { owner: 'cli', repo: 'cli', number: 1234 });
});

test('parsePrRef handles bare number plus --repo', () => {
  const ref = parsePrRef('42', 'acme/widget');
  assert.deepEqual(ref, { owner: 'acme', repo: 'widget', number: 42 });
});

test('parsePrRef throws on a bare number without --repo', () => {
  assert.throws(() => parsePrRef('42', undefined), /--repo/);
});

test('parsePrRef throws on garbage', () => {
  assert.throws(() => parsePrRef('not-a-pr', 'acme/widget'));
});

test('glob matching: ** crosses directories, * does not', () => {
  assert.ok(globToRegExp('deliveries/**').test('deliveries/retry.js'));
  assert.ok(globToRegExp('deliveries/**').test('deliveries/deep/nested/backoff.kt'));
  assert.ok(!globToRegExp('deliveries/**').test('src/deliveries/retry.js'));
  assert.ok(globToRegExp('src/*.js').test('src/a.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/deep/a.js'));
});

test('matchEscalationGlob returns the matching glob or null', () => {
  assert.equal(
    matchEscalationGlob('deliveries/retry.js', ['auth/**', 'deliveries/**']),
    'deliveries/**',
  );
  assert.equal(matchEscalationGlob('src/util/format.js', ['deliveries/**']), null);
  assert.equal(matchEscalationGlob(null, ['deliveries/**']), null);
});
