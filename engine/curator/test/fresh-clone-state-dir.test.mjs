// A fresh clone has no <clone>/.local yet; checkStateDir must treat missing ancestors as "nothing to check".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStateDir, AuthSetupError } from '../auth.mjs';

const CLONE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('state dir whose parents do not exist yet reports "not created" instead of crashing', () => {
  const missing = join(CLONE, `.fresh-clone-probe-${process.pid}`, 'curator');
  assert.equal(checkStateDir(missing), false);
});

test('an existing group-writable ancestor is still refused', () => {
  const parent = mkdtempSync(join(CLONE, '.fresh-clone-probe-'));
  try {
    chmodSync(parent, 0o777);
    assert.throws(() => checkStateDir(join(parent, 'sub', 'curator')), AuthSetupError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
