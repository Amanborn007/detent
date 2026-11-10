// A drive runs curator with a PATH that has no node, so the check is told which node to use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '..', 'scripts', 'artifact-check.py');
const cli = fs.readFileSync(path.join(HERE, '..', 'cli.mjs'), 'utf8');
const PYTHON = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();

const STYLE = '<style>:root{color-scheme:light dark;--p:#fff}@media (prefers-color-scheme:dark){:root{--p:#000}}body{background:var(--p)}</style>';
const PAGE = `<!doctype html><html><head><title>t</title>${STYLE}</head><body><h1>A finding</h1>
<div data-plan-question="q"><h3>Which one?</h3><div data-plan-option="a">A</div></div></body></html>`;

function run(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-env-'));
  const f = path.join(dir, 'page.html');
  fs.writeFileSync(f, PAGE);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nopath-'));
  const r = spawnSync(PYTHON, [CHECK, f], { encoding: 'utf8', env: { ...process.env, PATH: empty, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('CURATOR_NODE lets the check run when node is not on PATH', () => {
  const { code, out } = run({ CURATOR_NODE: process.execPath });
  assert.equal(code, 0, out);
  assert.match(out, /contract C\d/);
});

test('a CURATOR_NODE that is not executable fails loudly, with no fallback', () => {
  const { code, out } = run({ CURATOR_NODE: '/nonexistent/node' });
  assert.equal(code, 1, out);
  assert.match(out, /CURATOR_NODE/);
});

test('the CLI hands its own node to every artifact-check run', () => {
  const calls = cli.match(/spawnSync\('python3', \[CHECK_PATH[^\n]*\n?[^\n]*/g) || [];
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.match(c, /CURATOR_NODE: process\.execPath/);
});
