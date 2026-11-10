// checkDecisionRecord reads the stored form (string options plus option_details); parse decodes attribute entities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPage, checkDecisionRecord } from '../contract.mjs';

const ERR = { level: 'error' };
const stored = (over = {}) => ({
  question: 'Keep the retry cap or remove it?',
  options: ['capped', 'infinite'],
  option_details: {
    capped: { label: 'Keep the cap', consequence: 'Retries stay bounded at five per request.', then: 'The plan stage writes the capped steps.' },
    infinite: { label: 'Remove the cap', consequence: 'Retries run until the partner answers.', then: 'The plan stage writes the open-ended steps.' },
  },
  recommended: { key: 'capped', reason: 'Bounded retries protect the partner from load.' },
  ...over,
});

test('a stored record with string options and option_details is clean', () => {
  assert.deepEqual(checkDecisionRecord(stored(), ERR), { errors: [], warnings: [] });
});

test('a stored record whose options have no details warns C5 and C6 for each', () => {
  const r = checkDecisionRecord(stored({ option_details: undefined }), ERR);
  assert.deepEqual(r.errors.map((e) => e.id).sort(), ['C5', 'C5', 'C6', 'C6']);
});

test('a stored label that only repeats the key warns C6', () => {
  const d = stored();
  d.option_details.capped.label = 'Capped';
  const r = checkDecisionRecord(d, ERR);
  assert.deepEqual(r.errors.map((e) => e.id), ['C6']);
});

test('a details key that matches no option is not silently ignored', () => {
  const d = stored();
  d.option_details.ghost = { label: 'Ghost', consequence: 'Nothing here is real at all.' };
  assert.throws(() => checkDecisionRecord(d, ERR), /ghost/);
});

test('outbox-style object options are still read', () => {
  const o = stored();
  const r = checkDecisionRecord({ ...o, options: [{ key: 'capped', ...o.option_details.capped }, { key: 'infinite', ...o.option_details.infinite }], option_details: undefined }, ERR);
  assert.deepEqual(r, { errors: [], warnings: [] });
});

const BRIEF = `<section data-plan-brief>
<p data-brief="goal"><b>Goal:</b> move search onto the new index safely.</p>
<p data-brief="done"><b>Done:</b> dual writes have run for two weeks now.</p>
<p data-brief="ask"><b>Ask:</b> pick how real traffic should move across.</p>
<p data-brief="next"><b>Then:</b> i start the ramp this week.</p>
</section>`;

test('an attribute key written with an entity still matches the label that repeats it', () => {
  const html = `<!doctype html><html><body><h1>Search can move</h1>${BRIEF}
<div data-plan-question="q" data-plan-no-recommendation="Both are safe and you know the traffic."><h3>Which way now?</h3>
<div data-plan-option="don&#39;t"><strong>Don't</strong><p data-plan-consequence>Traffic stays on the old index for now.</p></div>
<div data-plan-option="go"><strong>Go ahead</strong><p data-plan-consequence>Traffic moves across in four steps.</p></div></div></body></html>`;
  assert.deepEqual(checkPage(html, ERR).errors.map((e) => e.id), ['C6']);
});

test('a recommended key written with an entity matches the option it names', () => {
  const html = `<!doctype html><html><body><h1>Search can move</h1>${BRIEF}
<div data-plan-question="q" data-plan-recommended="stay&amp;wait"><h3>Which way now?</h3><p data-plan-reason>Waiting costs nothing and keeps rollback easy.</p>
<div data-plan-option="stay&wait"><strong>Hold for now</strong><p data-plan-consequence>Traffic stays on the old index.</p></div>
<div data-plan-option="go"><strong>Go ahead</strong><p data-plan-consequence>Traffic moves across in four steps.</p></div></div></body></html>`;
  assert.deepEqual(checkPage(html, ERR).errors, []);
});
