// artifact-check.py runs the node contract and reports it in its usual line format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '..', 'scripts', 'artifact-check.py');

const which = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
const PYTHON = which('python3');

const STYLE = '<style>:root{color-scheme:light dark;--ink:#111;--paper:#fff}@media (prefers-color-scheme:dark){:root{--ink:#eee;--paper:#111}}body{background:var(--paper);color:var(--ink)}</style>';
const BAD = `<!doctype html><html><head><title>t</title>${STYLE}</head><body><h1>A finding</h1>
<p>Some intro prose before any brief.</p>
<div data-plan-question="q" data-plan-recommended="a"><p>no heading</p>
<div data-plan-option="a">A plain option with no label or consequence</div></div></body></html>`;

function tmpPage(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-check-'));
  const f = path.join(dir, 'page.html');
  fs.writeFileSync(f, html);
  return f;
}

function run(file, env = process.env) {
  const r = spawnSync(PYTHON, [CHECK, file], { encoding: 'utf8', env });
  assert.equal(r.error, undefined, String(r.error));
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a contract-violating page yields warning: lines that name the check ids', () => {
  const { code, out } = run(tmpPage(BAD));
  assert.equal(code, 0, out);
  const warned = out.split('\n').filter((l) => l.startsWith('warning:'));
  for (const id of ['C1', 'C3', 'C4', 'C5', 'C6']) {
    assert.ok(warned.some((l) => l.includes(id)), `no ${id} warning in:\n${out}`);
  }
  assert.match(warned[0], /^warning: .*page\.html:\d+ /);
});

test('a page without a decision gets no contract output', () => {
  const { out } = run(tmpPage(`<!doctype html><html><head><title>t</title>${STYLE}</head><body><h1>x</h1><p>prose</p></body></html>`));
  assert.doesNotMatch(out, /\bC\d+\b/);
});

test('node missing from PATH fails loudly with a next step', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nonode-'));
  const { code, out } = run(tmpPage(BAD), { ...process.env, PATH: empty });
  assert.equal(code, 1, out);
  assert.match(out, /node/i);
  assert.match(out, /install|PATH/i);
  assert.doesNotMatch(out, /^OK,/m);
});
