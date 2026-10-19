// Headless real-flow verification against examples/demo-plan.html:
// curator open -> curl chrome page + sdk.js + artifact -> assert 200s and
// exactly one injected script tag -> curator end -> shut the server down.
// Run: node test/verify-demo.mjs   (uses a throwaway state dir)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURATOR_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(CURATOR_DIR, 'cli.mjs');
const DEMO = path.join(CURATOR_DIR, 'examples', 'demo-plan.html');
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'curator-demo-verify-'));
const env = { ...process.env, CURATOR_STATE_DIR: stateDir, CURATOR_NO_BROWSER: '1' };

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: reqPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

const open = await runCli(['open', DEMO]);
assert.equal(open.code, 0, open.stdout);
const opened = JSON.parse(open.stdout);
console.log('open ->', JSON.stringify({ url: opened.url, next_step: opened.next_step.slice(0, 60) + '...' }));
const port = Number(new URL(opened.url).port);
const sid = opened.session;

const chrome = await get(port, `/s/${sid}`);
assert.equal(chrome.code, 200);
assert.match(chrome.body, /sandbox="allow-scripts allow-forms"/);
console.log(`chrome page GET /s/${sid} -> ${chrome.code}`);

const sdk = await get(port, `/sdk.js?s=${sid}`);
assert.equal(sdk.code, 200);
assert.match(sdk.body, /queuePrompt/);
console.log(`sdk GET /sdk.js -> ${sdk.code} (${sdk.body.length} bytes)`);

const served = await get(port, `/artifact/${sid}`);
assert.equal(served.code, 200);
const tag = `<script src="/sdk.js?s=${sid}"></script>`;
assert.ok(served.body.startsWith(`<!DOCTYPE html>\n${tag}\n`), 'doctype first, tag injected right after');
assert.equal(served.body.split('/sdk.js?s=').length - 1, 1, 'exactly one injected tag');
assert.equal(served.body.replace(`\n${tag}`, ''), readFileSync(DEMO, 'utf8'), 'artifact bytes otherwise identical');
console.log(`artifact GET /artifact/${sid} -> ${served.code}, doctype first, one injected tag, bytes identical`);

const end = await runCli(['end', DEMO]);
assert.equal(end.code, 0, end.stdout);
console.log('end ->', end.stdout.trim());

const pid = JSON.parse(readFileSync(path.join(stateDir, 'state.json'), 'utf8')).pid;
process.kill(pid);
console.log('demo verification passed; server (pid ' + pid + ') shut down');
