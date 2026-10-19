// Tests for the `log` verb: it writes an audit line straight into the artifact
// on disk (no server), creating a "Decision & Change Log" section on first use,
// newest-first, HTML-escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURATOR_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // engine/curator
const CLI = join(CURATOR_DIR, 'cli.mjs');

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function tmpArtifact(html) {
  const dir = mkdtempSync(join(tmpdir(), 'curator-log-'));
  const file = join(dir, 'plan.html');
  writeFileSync(file, html);
  return file;
}

test('log creates the changelog section and appends the entry before </body>', async () => {
  const file = tmpArtifact('<!doctype html><html><body><h1>Plan</h1></body></html>');
  const r = await runCli(['log', file, '-m', 'footprint decided -> cs+public']);
  assert.equal(r.code, 0, r.stderr);
  const json = JSON.parse(r.stdout.trim());
  assert.equal(json.status, 'logged');
  const html = readFileSync(file, 'utf8');
  assert.match(html, /data-curator-changelog/);
  assert.match(html, /footprint decided -&gt; cs\+public/); // '>' escaped
  assert.match(html, /data-curator-changelog[\s\S]*<\/section>[\s\S]*<\/body>/); // section sits before </body>
});

test('a second entry is prepended newest-first and untrusted HTML is escaped', async () => {
  const file = tmpArtifact('<!doctype html><html><body></body></html>');
  await runCli(['log', file, '-m', 'ALPHA']);
  await runCli(['log', file, '-m', 'BRAVO <b>x</b>']);
  const html = readFileSync(file, 'utf8');
  assert.match(html, /BRAVO &lt;b&gt;x&lt;\/b&gt;/); // escaped, not raw markup
  assert.ok(html.indexOf('BRAVO') < html.indexOf('ALPHA'), 'newest entry appears before the older one');
});

test('$-substitution patterns in the message are kept literal, not re-injected', async () => {
  // A string replacement arg would expand $&/$$/$1; the message must land verbatim.
  const file = tmpArtifact('<!doctype html><html><body></body></html>');
  const msg = 'cost $$ up then $& oops $1';
  const r = await runCli(['log', file, '-m', msg]);
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(file, 'utf8');
  // `$$`/`$1` land literally; the `&` in `$&` is HTML-escaped (not re-injected as
  // the matched `</body>`). A string replacement arg would have expanded them.
  assert.ok(html.includes('cost $$ up then $&amp; oops $1'), 'message stored with only HTML-escaping applied');
  assert.doesNotMatch(html, /<\/body>[\s\S]*<\/body>/, 'no stray injected </body>');
});

test('appends without a </body> tag (fallback branch)', async () => {
  const file = tmpArtifact('<h1>bare fragment</h1>');
  const r = await runCli(['log', file, '-m', 'no body tag here']);
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(file, 'utf8');
  assert.match(html, /data-curator-changelog/);
  assert.match(html, /no body tag here/);
});

test('log without -m fails with exit 1', async () => {
  const file = tmpArtifact('<!doctype html><html><body></body></html>');
  const r = await runCli(['log', file]);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout.trim()).error, /requires -m/);
});

test('log on a missing file fails with exit 1', async () => {
  const r = await runCli(['log', join(tmpdir(), 'curator-does-not-exist-xyz.html'), '-m', 'x']);
  assert.equal(r.code, 1);
});
