// HTTP-layer serving tests for the artifact route: exercises createServer with
// a real SessionStore over real HTTP, focusing on rendering/serving edge cases
// surfaced by adversarial artifacts (deleted files, etc.). No CLI, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

import { SessionStore, createServer } from '../server.mjs';

function fetchRaw(port, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SECRET = crypto.randomBytes(32).toString('hex');
const artifactKey = (id) => crypto.createHmac('sha256', SECRET).update(`curator-artifact:${id}`).digest('hex');

async function withServer(fn) {
  // realpath so safeReadArtifact's canonical comparison matches (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pv-serve-')));
  const store = new SessionStore();
  const server = createServer(store, { secret: SECRET });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn({ dir, store, port });
  } finally {
    server.close();
  }
}

test('artifact deleted after open: reload returns 404 (not 500), leaks no raw fs path, server stays up', async () => {
  await withServer(async ({ dir, store, port }) => {
    const file = join(dir, 'plan.html');
    writeFileSync(file, '<!DOCTYPE html><html><body>ephemeral</body></html>');
    const session = store.open(file);

    const ok = await fetchRaw(port, `/artifact/${session.id}?k=${artifactKey(session.id)}`);
    assert.equal(ok.code, 200, 'served while the file exists');

    rmSync(file);

    const gone = await fetchRaw(port, `/artifact/${session.id}?k=${artifactKey(session.id)}`);
    assert.equal(gone.code, 404, 'a deleted artifact is Not Found, not an Internal Server Error');
    assert.doesNotMatch(gone.body, /ENOENT|lstat|realpath/i, 'must not leak the raw filesystem error');
    const parsed = JSON.parse(gone.body);
    assert.ok(parsed.error && parsed.next_step, 'clean agent-facing error + next_step');

    // A missing artifact must never take the whole server down.
    const hz = await fetchRaw(port, '/healthz?nonce=0123456789abcdef0123456789abcdef');
    assert.equal(hz.code, 200, 'server survives a missing-artifact request');
  });
});
