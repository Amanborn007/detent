// Tests for the `answer` verb: it marks a decision as answered in the artifact
// on disk, so a reload shows the settled state instead of an open question.
//
// The durable mark lives on the QUESTION (`data-curator-answered`) and on the
// chosen OPTION (`data-curator-answered-option`). It deliberately does NOT reuse
// `data-curator-chosen`, which the SDK uses for the transient "queued" state and
// strips from every option in a block on each new selection.
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

const QUESTION = `
<div data-plan-question="rollout">
  <div data-plan-option="Phased">Phased rollout</div>
  <div data-plan-option="Big-bang">Big-bang rollout</div>
</div>`;

function tmpArtifact(body = QUESTION) {
  const dir = mkdtempSync(join(tmpdir(), 'curator-answer-'));
  const file = join(dir, 'plan.html');
  writeFileSync(file, `<!doctype html><html><body>${body}</body></html>`);
  return file;
}

test('answer marks the question and the chosen option', async () => {
  const file = tmpArtifact();
  const r = await runCli(['answer', file, '--question', 'rollout', '--answer', 'Phased']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).status, 'answered');

  const html = readFileSync(file, 'utf8');
  assert.match(html, /data-curator-answered="Phased"/, 'question carries the answer');
  assert.match(html, /data-plan-option="Phased"[^>]*data-curator-answered-option/, 'chosen option is marked');
  assert.doesNotMatch(
    html,
    /data-plan-option="Big-bang"[^>]*data-curator-answered-option/,
    'the option that was not chosen stays unmarked',
  );
});

test('answer records when it was answered', async () => {
  const file = tmpArtifact();
  await runCli(['answer', file, '--question', 'rollout', '--answer', 'Phased']);
  const html = readFileSync(file, 'utf8');
  const m = html.match(/data-curator-answered-at="([^"]+)"/);
  assert.ok(m, 'an answered-at stamp is written');
  assert.ok(!Number.isNaN(Date.parse(m[1])), `answered-at parses as a date, got ${m[1]}`);
});

test('answer never reuses data-curator-chosen, which the SDK strips on reselect', async () => {
  const file = tmpArtifact();
  await runCli(['answer', file, '--question', 'rollout', '--answer', 'Phased']);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /data-curator-chosen/);
});

test('a note is stored on the question so the page can render it', async () => {
  const file = tmpArtifact();
  const r = await runCli([
    'answer', file, '--question', 'rollout', '--answer', 'Phased',
    '--note', 'start with the two smallest regions',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(file, 'utf8'), /data-curator-answered-note="start with the two smallest regions"/);
});

test('untrusted answer and note text is HTML-escaped', async () => {
  const file = tmpArtifact(`
<div data-plan-question="shape">
  <div data-plan-option="&lt;b&gt;bold&lt;/b&gt;">markup-ish option</div>
</div>`);
  const r = await runCli([
    'answer', file, '--question', 'shape', '--answer', '<b>bold</b>', '--note', 'a "quoted" & risky note',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(file, 'utf8');
  assert.match(html, /data-curator-answered="&lt;b&gt;bold&lt;\/b&gt;"/, 'answer escaped');
  assert.match(html, /a &quot;quoted&quot; &amp; risky note/, 'note escaped');
});

test('re-answering replaces the prior answer rather than stacking a second one', async () => {
  const file = tmpArtifact();
  await runCli(['answer', file, '--question', 'rollout', '--answer', 'Phased']);
  const r = await runCli(['answer', file, '--question', 'rollout', '--answer', 'Big-bang']);
  assert.equal(r.code, 0, r.stderr);

  const html = readFileSync(file, 'utf8');
  assert.equal(html.match(/data-curator-answered="/g).length, 1, 'exactly one answer attribute survives');
  assert.match(html, /data-curator-answered="Big-bang"/);
  assert.equal(html.match(/data-curator-answered-option/g).length, 1, 'exactly one option stays marked');
  assert.match(html, /data-plan-option="Big-bang"[^>]*data-curator-answered-option/);
});

test('a question id that does not exist is refused, and the file is untouched', async () => {
  const file = tmpArtifact();
  const before = readFileSync(file, 'utf8');
  const r = await runCli(['answer', file, '--question', 'no-such-question', '--answer', 'Phased']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout.trim()).error, /no-such-question/);
  assert.equal(readFileSync(file, 'utf8'), before, 'a refused answer writes nothing');
});

test('an answer value matching no option is refused rather than guessed', async () => {
  const file = tmpArtifact();
  const before = readFileSync(file, 'utf8');
  const r = await runCli(['answer', file, '--question', 'rollout', '--answer', 'Sideways']);
  assert.equal(r.code, 1);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('a duplicated question id is refused rather than marking an arbitrary one', async () => {
  const file = tmpArtifact(`${QUESTION}${QUESTION}`);
  const before = readFileSync(file, 'utf8');
  const r = await runCli(['answer', file, '--question', 'rollout', '--answer', 'Phased']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout.trim()).error, /twice|more than once|not unique/i);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('hand-added data-curator-chosen elsewhere in the artifact is left alone', async () => {
  // Two shipped artifacts already carry hand-added `data-curator-chosen`.
  // Marking one question must not disturb them.
  const file = tmpArtifact(`
<div data-plan-question="legacy">
  <div data-plan-option="Kept" data-curator-chosen>hand-marked earlier</div>
</div>${QUESTION}`);
  const r = await runCli(['answer', file, '--question', 'rollout', '--answer', 'Phased']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(file, 'utf8'), /data-plan-option="Kept" data-curator-chosen/);
});

test('answer requires both --question and --answer', async () => {
  const file = tmpArtifact();
  assert.equal((await runCli(['answer', file, '--answer', 'Phased'])).code, 1);
  assert.equal((await runCli(['answer', file, '--question', 'rollout'])).code, 1);
});

test('answer on a missing file fails with exit 1', async () => {
  const r = await runCli([
    'answer', join(tmpdir(), 'curator-does-not-exist-xyz.html'), '--question', 'q', '--answer', 'a',
  ]);
  assert.equal(r.code, 1);
});
