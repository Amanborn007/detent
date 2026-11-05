// The decision-page contract: a page from any agent has to be readable and decidable.
// Each check gets one passing and one failing case. CONTRACT_LEVEL is 'warn' today, so the
// level-sensitive cases pass {level} explicitly to see what the check will do once it flips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contract from '../contract.mjs';

const { checkPage, checkDecisionRecord, CONTRACT_LEVEL } = contract;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ERR = { level: 'error' };

const BRIEF = `<section data-plan-brief>
<p data-brief="goal"><b>What we are trying to do:</b> move search onto the new index safely.</p>
<p data-brief="done"><b>What is already done:</b> dual writes have run for two weeks now.</p>
<p data-brief="ask"><b>What i need from you:</b> pick how real traffic should move across.</p>
<p data-brief="next"><b>What happens after you answer:</b> i start the ramp this week.</p>
</section>`;

const OPTIONS = `<div data-plan-option="phased"><strong>Phased rollout</strong>
<p data-plan-consequence>Traffic moves in four steps, so a bad ranking reaches few users.</p>
<p data-plan-then>If chosen: i add the ramp flag.</p></div>
<div data-plan-option="cutover"><strong>Single cutover</strong>
<p data-plan-consequence>One switch and one code path, but every user sees any regression.</p>
<p data-plan-then>If chosen: i schedule the switch.</p></div>`;

function question(over = {}) {
  const o = {
    attrs: 'data-plan-question="rollout" data-plan-recommended="phased" data-plan-required data-plan-shape="pick-one"',
    heading: '<h3>Should we move traffic in phases?</h3>',
    why: '<p data-plan-why-now>Why now: the legacy cluster is retired next month.</p>',
    reason: '<p data-plan-reason>Recommended: phased, because a bad ranking is invisible to health checks.</p>',
    options: OPTIONS,
    ...over,
  };
  return `<div ${o.attrs}>${o.heading}${o.why}${o.reason}${o.options}</div>`;
}

function page({ h1 = '<h1>Search can move without downtime</h1>', brief = BRIEF, q = question(), before = '', after = '<h2>Background</h2><p>Evidence goes here.</p>' } = {}) {
  return `<!doctype html><html><head><title>t</title></head><body>${h1}\n${before}${brief}\n${q}\n${after}</body></html>`;
}

const ids = (list) => list.map((x) => x.id);
const only = (html, id, opts = ERR) => checkPage(html, opts).errors.filter((e) => e.id === id);

test('CONTRACT_LEVEL is warn, and warn mode reports every E check as a warning', () => {
  assert.equal(CONTRACT_LEVEL, 'warn');
  const r = checkPage(page({ brief: '' }));
  assert.deepEqual(r.errors, []);
  assert.ok(ids(r.warnings).includes('C1'));
  assert.equal(typeof r.warnings[0].line, 'number');
  assert.ok(r.warnings[0].msg.length > 0);
});

test('a good page is clean', () => {
  assert.deepEqual(checkPage(page(), ERR), { errors: [], warnings: [] });
});

test('a page with no decision is not checked', () => {
  assert.deepEqual(checkPage('<h1>x</h1><p>just prose</p>', ERR), { errors: [], warnings: [] });
});

test('C1 brief: missing, misplaced, missing part, short part, pointer-only part', () => {
  assert.equal(only(page(), 'C1').length, 0);
  assert.equal(only(page({ brief: '' }), 'C1').length, 1);
  assert.equal(only(page({ before: '<p>intro</p>' }), 'C1').length, 1);
  const noNext = BRIEF.replace(/<p data-brief="next">.*<\/p>\n/, '');
  assert.equal(only(page({ brief: noNext }), 'C1').length, 1);
  const short = BRIEF.replace('i start the ramp this week.', 'soon.');
  assert.equal(only(page({ brief: short }), 'C1').length, 1);
  const ptr = BRIEF.replace('move search onto the new index safely.', 'engine/curator/contract.mjs');
  assert.ok(only(page({ brief: ptr }), 'C1').length >= 1);
  assert.equal(only(page({ h1: '' }), 'C1').length, 1);
});

test('C2 ask-first: more than 250 words before the first question', () => {
  assert.equal(only(page(), 'C2').length, 0);
  const wall = `<p>${'word '.repeat(300)}</p>`;
  assert.equal(only(page({ brief: BRIEF + wall }), 'C2').length, 1);
});

test('C3 question: heading missing, too long, no question mark', () => {
  assert.equal(only(page(), 'C3').length, 0);
  assert.equal(only(page({ q: question({ heading: '' }) }), 'C3').length, 1);
  assert.equal(only(page({ q: question({ heading: '<h3>Move traffic in phases</h3>' }) }), 'C3').length, 1);
  const long = `<h3>${'word '.repeat(45)}ok?</h3>`;
  assert.equal(only(page({ q: question({ heading: long }) }), 'C3').length, 1);
});

test('C4 recommend: needs a real key and a reason, or an explained no-recommendation', () => {
  assert.equal(only(page(), 'C4').length, 0);
  assert.equal(only(page({ q: question({ attrs: 'data-plan-question="r" data-plan-recommended="ghost"' }) }), 'C4').length, 1);
  assert.equal(only(page({ q: question({ reason: '<p data-plan-reason>Because.</p>' }) }), 'C4').length, 1);
  assert.equal(only(page({ q: question({ reason: '' }) }), 'C4').length, 1);
  const none = question({ attrs: 'data-plan-question="r" data-plan-no-recommendation="both fit and the call is about budget"', reason: '' });
  assert.equal(only(page({ q: none }), 'C4').length, 0);
  const thin = question({ attrs: 'data-plan-question="r" data-plan-no-recommendation="unsure"', reason: '' });
  assert.equal(only(page({ q: thin }), 'C4').length, 1);
  const neither = question({ attrs: 'data-plan-question="r"', reason: '' });
  assert.equal(only(page({ q: neither }), 'C4').length, 1);
});

test('C5 consequence: non-hatch options need one; hatch options do not', () => {
  assert.equal(only(page(), 'C5').length, 0);
  const missing = OPTIONS.replace(/<p data-plan-consequence>.*?<\/p>/, '');
  assert.equal(only(page({ q: question({ options: missing }) }), 'C5').length, 1);
  const hatch = OPTIONS + '<div data-plan-option="Other"><strong>Something else</strong></div>' +
    '<div data-plan-option="skip"><strong>Skip this</strong></div>';
  assert.equal(only(page({ q: question({ options: hatch }) }), 'C5').length, 0);
  const shortC = OPTIONS.replace('Traffic moves in four steps, so a bad ranking reaches few users.', 'Safer.');
  assert.equal(only(page({ q: question({ options: shortC }) }), 'C5').length, 1);
});

test('C6 label: strong label must exist and differ from the key', () => {
  assert.equal(only(page(), 'C6').length, 0);
  const noLabel = OPTIONS.replace('<strong>Phased rollout</strong>', '');
  assert.equal(only(page({ q: question({ options: noLabel }) }), 'C6').length, 1);
  const same = OPTIONS.replace('<strong>Phased rollout</strong>', '<strong>Phased</strong>');
  assert.equal(only(page({ q: question({ options: same }) }), 'C6').length, 1);
  const sameNorm = OPTIONS.replace('<strong>Phased rollout</strong>', '<strong>PHASED!</strong>');
  assert.equal(only(page({ q: question({ options: sameNorm }) }), 'C6').length, 1);
});

test('C7 context: bare pointers and tiny fragments are not context', () => {
  assert.equal(only(page(), 'C7').length, 0);
  assert.equal(only(page({ q: question({ why: '<p data-plan-why-now>c</p>' }) }), 'C7').length, 1);
  assert.equal(only(page({ q: question({ why: '<p data-plan-why-now>Why now: ~/code/x/plan.md</p>' }) }), 'C7').length, 1);
  assert.equal(only(page({ q: question({ why: '<p data-plan-why-now>Why now: https://example.com/a</p>' }) }), 'C7').length, 1);
  assert.equal(only(page({ q: question({ why: '<p data-plan-why-now>Why now: ACME-35</p>' }) }), 'C7').length, 1);
  const ptrConseq = OPTIONS.replace('Traffic moves in four steps, so a bad ranking reaches few users.', 'src/engine/a/b/c.mjs');
  assert.ok(only(page({ q: question({ options: ptrConseq }) }), 'C7').length >= 1);
  const ptrBrief = BRIEF.replace('dual writes have run for two weeks now.', 'docs/design/plan-v2.md');
  assert.ok(only(page({ brief: ptrBrief }), 'C7').length >= 1);
});

test('C8 glossary (warning): an ID token needs an abbr, a glossary entry or a link', () => {
  const withId = page({ after: '<h2>Background</h2><p>See ACME-35 for history.</p>' });
  const r = checkPage(withId, ERR);
  assert.ok(ids(r.warnings).includes('C8'));
  assert.equal(r.errors.filter((e) => e.id === 'C8').length, 0);
  const abbr = page({ after: '<h2>B</h2><p>See <abbr title="the banner ticket">ACME-35</abbr>.</p>' });
  assert.ok(!ids(checkPage(abbr, ERR).warnings).includes('C8'));
  const gl = page({ after: '<h2>B</h2><p>See ACME-35.</p><dl data-plan-glossary><dt>ACME-35</dt><dd>banner</dd></dl>' });
  assert.ok(!ids(checkPage(gl, ERR).warnings).includes('C8'));
  const link = page({ after: '<h2>B</h2><p>See <a href="https://j/ACME-35">ACME-35</a>.</p>' });
  assert.ok(!ids(checkPage(link, ERR).warnings).includes('C8'));
});

test('C9 count (warning): more than 7 questions', () => {
  const many = Array.from({ length: 8 }, (_, i) => question({ attrs: `data-plan-question="q${i}" data-plan-recommended="phased"` })).join('\n');
  assert.ok(ids(checkPage(page({ q: many }), ERR).warnings).includes('C9'));
  assert.ok(!ids(checkPage(page(), ERR).warnings).includes('C9'));
});

test('C10 instructions (warning): annotation how-to belongs to the shell', () => {
  const alt = page({ after: '<p>Alt-click anything to annotate.</p>' });
  assert.ok(ids(checkPage(alt, ERR).warnings).includes('C10'));
  const click = page({ after: '<p>Click an option to decide.</p>' });
  assert.ok(ids(checkPage(click, ERR).warnings).includes('C10'));
  assert.ok(!ids(checkPage(page(), ERR).warnings).includes('C10'));
});

test('hatch list is exported once and matched whole', () => {
  assert.equal(contract.isHatch('Other'), true);
  assert.equal(contract.isHatch('Not now.'), true);
  assert.equal(contract.isHatch('No change to API; migrate storage'), false);
  assert.equal(contract.isHatch('Other (specify)'), true);
});

const record = (over = {}) => ({
  question: 'Should we move traffic in phases?',
  why_now: 'The legacy cluster is retired next month.',
  context_excerpt: 'Dual writes have been running for two weeks.',
  options: [
    { key: 'phased', label: 'Phased rollout', consequence: 'Four steps, so a bad ranking reaches few users.', then: 'i add the ramp flag' },
    { key: 'cutover', label: 'Single cutover', consequence: 'One switch, but every user sees any regression.', then: 'i schedule it' },
  ],
  recommended: { key: 'phased', reason: 'a bad ranking is invisible to health checks' },
  ...over,
});

test('checkDecisionRecord: a good record is clean, and warn mode never errors', () => {
  assert.deepEqual(checkDecisionRecord(record(), ERR), { errors: [], warnings: [] });
  const r = checkDecisionRecord(record({ question: 'no question mark' }));
  assert.deepEqual(r.errors, []);
  assert.ok(ids(r.warnings).includes('C3'));
});

test('checkDecisionRecord applies C3 to C7', () => {
  const e = (o) => ids(checkDecisionRecord(record(o), ERR).errors);
  assert.ok(e({ question: 'Move traffic in phases' }).includes('C3'));
  assert.ok(e({ recommended: { key: 'ghost', reason: 'it is fine really' } }).includes('C4'));
  assert.ok(e({ recommended: undefined }).includes('C4'));
  assert.ok(!e({ recommended: undefined, no_recommendation: 'both fit, the call is about budget' }).includes('C4'));
  const opts = record().options;
  assert.ok(e({ options: [{ ...opts[0], consequence: '' }, opts[1]] }).includes('C5'));
  assert.ok(e({ options: [{ ...opts[0], label: 'phased' }, opts[1]] }).includes('C6'));
  assert.ok(e({ why_now: 'plan.md' }).includes('C7'));
  assert.ok(e({ context_excerpt: 'src/a/b.mjs' }).includes('C7'));
});

test('CLI: --page prints the JSON result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  const f = path.join(dir, 'p.html');
  fs.writeFileSync(f, page({ brief: '' }));
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'contract.mjs'), '--page', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.errors, []);
  assert.ok(out.warnings.some((w) => w.id === 'C1'));
});
