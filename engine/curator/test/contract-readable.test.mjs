// Readable decision pages: C2 counts only what a reader sees, and three warn-level checks
// keep paragraphs, consequences and folded sections short and labelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPage } from '../contract.mjs';

const BRIEF = `<section data-plan-brief>
<p data-brief="goal"><b>What we are trying to do:</b> move search onto the new index safely.</p>
<p data-brief="done"><b>What is already done:</b> dual writes have run for two weeks now.</p>
<p data-brief="ask"><b>What i need from you:</b> pick how real traffic should move across.</p>
<p data-brief="next"><b>What happens after you answer:</b> i start the ramp this week.</p>
</section>`;

const cons = (text) => `<p data-plan-consequence>${text}</p>`;
const options = (c1 = 'Traffic moves in four steps, so a bad ranking reaches few users.') => `
<div data-plan-option="phased"><strong>Phased rollout</strong>${cons(c1)}</div>
<div data-plan-option="cutover"><strong>Single cutover</strong>${cons('One switch and one code path, but every user sees any regression.')}</div>`;

const question = (opts = options()) => `<div data-plan-question="rollout" data-plan-recommended="phased" data-plan-required>
<h3>Should we move traffic in phases?</h3>
<p data-plan-why-now>Why now: the legacy cluster is retired next month.</p>
<p data-plan-reason>Recommended: phased, because a bad ranking is invisible to health checks.</p>${opts}</div>`;

const page = ({ before = '', q = question(), after = '' } = {}) =>
  `<!doctype html><html><head><title>t</title></head><body><h1>Search can move without downtime</h1>\n${BRIEF}\n${before}${q}\n${after}</body></html>`;

const run = (html) => checkPage(html, { level: 'error' });
const ids = (list) => list.map((x) => x.id);
const words = (n) => Array.from({ length: n }, () => 'word').join(' ');
const paras = (count, n) => Array.from({ length: count }, () => `<p>${words(n)}</p>`).join('');

test('C2 ignores a closed <details> before the decision', () => {
  const folded = `<details><summary>Background and evidence</summary>${paras(7, 40)}</details>`;
  assert.ok(!ids(run(page({ before: folded })).errors).includes('C2'));
});

test('C2 counts an open <details> before the decision', () => {
  const open = `<details open><summary>Background</summary>${paras(7, 40)}</details>`;
  assert.ok(ids(run(page({ before: open })).errors).includes('C2'));
});

test('C2 still fires for 300 visible words and ignores script and style text', () => {
  assert.ok(ids(run(page({ before: `<p>${words(300)}</p>` })).errors).includes('C2'));
  const hidden = `<style>${words(300)}</style><script>${words(300)}</script>`;
  assert.ok(!ids(run(page({ before: hidden })).errors).includes('C2'));
});

test('C11 warns on a paragraph over 60 words, but not inside <details>', () => {
  const long = `<p>${words(61)}</p>`;
  assert.equal(run(page({ after: long })).warnings.filter((x) => x.id === 'C11').length, 1);
  assert.ok(!ids(run(page({ after: `<details><summary>Evidence log</summary>${long}</details>` })).warnings).includes('C11'));
  assert.ok(!ids(run(page({ after: `<p>${words(60)}</p>` })).warnings).includes('C11'));
});

test('C11 skips [data-plan-raw] evidence', () => {
  const raw = `<div data-plan-raw><p>${words(90)}</p></div>`;
  assert.ok(!ids(run(page({ after: raw })).warnings).includes('C11'));
});

test('C12 warns on an option consequence over 20 words', () => {
  assert.ok(!ids(run(page()).warnings).includes('C12'));
  assert.equal(run(page({ q: question(options(words(21))) })).warnings.filter((x) => x.id === 'C12').length, 1);
});

test('C13 warns on a <details> with no summary text', () => {
  const ok = '<details><summary>Raw numbers</summary><p>x</p></details>';
  assert.ok(!ids(run(page({ after: ok })).warnings).includes('C13'));
  for (const bad of ['<details><p>x</p></details>', '<details><summary>  </summary><p>x</p></details>']) {
    assert.ok(ids(run(page({ after: bad })).warnings).includes('C13'), bad);
  }
});

test('the new checks are warnings even at error level', () => {
  const r = run(page({ after: `<p>${words(70)}</p><details><p>x</p></details>` }));
  assert.ok(!ids(r.errors).some((i) => ['C11', 'C12', 'C13'].includes(i)));
});
