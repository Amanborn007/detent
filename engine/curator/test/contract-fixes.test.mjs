// Referee fixes on the decision contract: hatch options, ID warnings, node-less pages, SDK robustness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPage } from '../contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ERR = { level: 'error' };
const sdk = fs.readFileSync(path.join(HERE, '..', 'sdk.js'), 'utf8');
const CHECK = path.join(HERE, '..', 'scripts', 'artifact-check.py');

const BRIEF = `<section data-plan-brief>
<p data-brief="goal"><b>What we are trying to do:</b> move search onto the new index safely.</p>
<p data-brief="done"><b>What is already done:</b> dual writes have run for two weeks now.</p>
<p data-brief="ask"><b>What i need from you:</b> pick how real traffic should move across.</p>
<p data-brief="next"><b>What happens after you answer:</b> i start the ramp this week.</p>
</section>`;
const REAL = `<div data-plan-option="phased"><strong>Phased rollout</strong>
<p data-plan-consequence>Traffic moves in four steps, so a bad ranking reaches few users.</p></div>`;

const page = (extra = '', after = '') => `<!doctype html><html><body><h1>Search can move</h1>${BRIEF}
<div data-plan-question="q" data-plan-recommended="phased"><h3>Should we move in phases?</h3>
<p data-plan-reason>Recommended: phased, because a bad ranking is invisible.</p>${REAL}${extra}</div>${after}</body></html>`;

test('hatch options need no distinct label and no real consequence', () => {
  const hatches = [
    '<div data-plan-option="Skip"><strong>Skip</strong><p data-plan-consequence>nothing happens</p></div>',
    '<div data-plan-option="later"><strong>Later</strong><p data-plan-consequence>nothing happens</p></div>',
    '<div data-plan-option="other"><strong>Skip this one</strong><p data-plan-consequence>nothing happens</p></div>',
    '<div data-plan-option="x"><strong>Not now</strong><p data-plan-consequence>nothing happens</p></div>',
  ];
  for (const h of hatches) {
    const r = checkPage(page(h), ERR);
    assert.deepEqual(r.errors, [], h);
  }
});

test('a real option with a label equal to its key still fails C6', () => {
  const bad = '<div data-plan-option="cutover"><strong>Cutover</strong><p data-plan-consequence>One switch for every user at once.</p></div>';
  assert.ok(checkPage(page(bad), ERR).errors.some((e) => e.id === 'C6'));
});

test('C8 ignores encodings and standards names but still flags ticket-style IDs', () => {
  const quiet = '<p>UTF-8 and H2 and ES2020 and SHA256 and SHA-256 are fine.</p>';
  assert.ok(!checkPage(page('', quiet), ERR).warnings.some((w) => w.id === 'C8'));
  for (const id of ['D-001', 'ACME-35']) {
    const w = checkPage(page('', `<p>See ${id} for details.</p>`), ERR).warnings;
    assert.ok(w.some((x) => x.id === 'C8' && x.msg.includes(id)), id);
  }
});

test('a page with no decision passes without node on PATH', () => {
  const py = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonode-'));
  const f = path.join(dir, 'p.html');
  fs.writeFileSync(f, '<!doctype html><html><head><title>t</title><style>:root{color-scheme:light dark;--p:#fff}@media (prefers-color-scheme:dark){:root{--p:#000}}body{background:var(--p)}</style></head><body><h1>x</h1><p>prose</p></body></html>');
  const r = spawnSync(py, [CHECK, f], { encoding: 'utf8', env: { ...process.env, PATH: dir } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /node/i);
});

test('the Sent badge rule comes after the dark-mode block so it wins there too', () => {
  const dark = sdk.indexOf("[data-plan-option]:hover{outline-color:var(--accent,#7aa9ff);}}");
  const sent = sdk.indexOf('content:"Sent — awaiting agent"');
  assert.ok(dark > 0 && sent > dark);
});

test('the no-recommendation line is inserted relative to the option parent', () => {
  assert.match(sdk, /firstOpt\.parentNode\.insertBefore\(p, firstOpt\)/);
  assert.doesNotMatch(sdk, /qEl\.insertBefore\(p, qEl\.querySelector\('\[data-plan-option\]'\)\)/);
});

test('document listeners attach before any per-question work can throw', () => {
  const init = sdk.slice(sdk.indexOf('function initDecisions()'));
  const click = init.indexOf("document.addEventListener('click'");
  const loop = init.indexOf('enhanceQuestion(qEl, n)');
  assert.ok(click > 0 && loop > 0 && click < loop);
});
