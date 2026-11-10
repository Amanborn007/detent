// A note-only decision (answer:null) must stamp the note, not throw on a "null" option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cli.mjs');
const PAGE = `<!doctype html><html><body>
<div data-plan-question="rollout">
  <div data-plan-option="Phased">Phased</div>
  <div data-plan-option="Big-bang">Big-bang</div>
</div></body></html>`;

function runCli(args, stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, CURATOR_STATE_DIR: stateDir, CURATOR_NO_BROWSER: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function setup(prompts) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'curator-noteonly-')));
  const stateDir = join(work, 'state');
  mkdirSync(stateDir, { recursive: true });
  const file = join(work, 'plan.html');
  writeFileSync(file, PAGE);
  const session = {
    id: 'aaaa1111bbbb2222cccc3333', file, createdAt: new Date().toISOString(),
    pending: prompts, ended: false, endedBy: null, chat: [],
  };
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ sessions: { [file]: session } }));
  return { file, stateDir };
}

test('poll with the server down stamps a note-only decision without a stamp_error', async () => {
  const { file, stateDir } = setup([{ type: 'decision', question: 'rollout', answer: null, note: 'need the rollback plan first' }]);
  const r = await runCli(['poll', file], stateDir);
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(payload.stamp_error, undefined, `stamp_error: ${payload.stamp_error}`);
  const html = readFileSync(file, 'utf8');
  assert.match(html, /data-curator-answered-note="need the rollback plan first"/);
  assert.doesNotMatch(html, /data-curator-answered="null"/);
  assert.doesNotMatch(html, /data-curator-answered-option/);
});

test('curator answer on a missing option still throws', async () => {
  const { file, stateDir } = setup([]);
  const r = await runCli(['answer', file, '--question', 'rollout', '--answer', 'Nope'], stateDir);
  assert.notEqual(r.code, 0);
});
