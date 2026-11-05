// The shell's inline script is built from a template string plus injected
// function source, so a typo only shows up in the browser. Compile it here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { chromePage } from '../server.mjs';

test('the shell inline script compiles', () => {
  const page = chromePage({ id: 'abc123', file: '/tmp/plan.html' });
  const m = /<script>\n([\s\S]*)<\/script>/.exec(page);
  assert.ok(m, 'page has an inline script');
  assert.doesNotThrow(() => new vm.Script(m[1], { filename: 'shell.js' }));
});
