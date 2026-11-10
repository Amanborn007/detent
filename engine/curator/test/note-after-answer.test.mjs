// A note typed on an already-answered question must not erase the answer marks on disk,
// and a note-only stamp must be visible after a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(DIR, 'cli.mjs');
const PAGE = `<!doctype html><html><body>
<div data-plan-question="rollout">
  <div data-plan-option="approve">approve</div>
  <div data-plan-option="revise">revise</div>
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
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'curator-noteafter-')));
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

test('a note-only reply after an answer keeps the answer marks and adds the note', async () => {
  const { file, stateDir } = setup([]);
  const a = await runCli(['answer', file, '--question', 'rollout', '--answer', 'approve'], stateDir);
  assert.equal(a.code, 0, a.stderr);
  const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
  state.sessions[file].pending = [{ type: 'decision', question: 'rollout', answer: null, note: 'but watch the rollout' }];
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state));
  const r = await runCli(['poll', file], stateDir);
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(file, 'utf8');
  assert.match(html, /data-curator-answered="approve"/);
  assert.match(html, /data-plan-option="approve"[^>]*data-curator-answered-option|data-curator-answered-option[^>]*data-plan-option="approve"/);
  assert.match(html, /data-curator-answered-note="but watch the rollout"/);
});

test('a note-only stamp renders its note text at load, without an answer', () => {
  const src = readFileSync(join(DIR, 'sdk.js'), 'utf8');
  const m = /function renderAnswered\(qEl\) \{[\s\S]*?\n  \}\n/.exec(src);
  assert.ok(m, 'renderAnswered not found');
  const made = [];
  const document = { createElement: () => { const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }; made.push(el); return el; } };
  const attrs = { 'data-curator-answered-note': 'need the rollback plan', 'data-curator-answered-at': 'x' };
  const qEl = {
    hasAttribute: (k) => k in attrs,
    getAttribute: (k) => attrs[k] ?? null,
    querySelector: () => null,
    insertBefore: () => {},
  };
  new Function('document', 'ANSWERED', 'ANSWERED_NOTE', 'ANSWERED_NOTE_TEXT', 'qEl',
    `${m[0]}\nrenderAnswered(qEl);`)(document, 'data-curator-answered', 'data-curator-answered-note', 'data-curator-answered-note-text', qEl);
  assert.equal(made.length, 1);
  assert.equal(made[0].textContent, 'need the rollback plan');
});
