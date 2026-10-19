import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'courier.mjs');
function run(dir, ...args){ return spawnSync('node',[CLI,...args],{encoding:'utf8',env:{...process.env,DETENT_COURIER_DIR:dir}}); }
function freshDir(){ return fs.mkdtempSync(path.join(os.tmpdir(),'reads-t-')); }

test('request -> list -> fulfill -> await round-trip', () => {
  const d=freshDir();
  const req=JSON.parse(run(d,'request','--source','drive','--query','x','--for','sub').stdout);
  assert.equal(req.status,'pending'); assert.ok(req.id);
  assert.match(run(d,'list').stdout, new RegExp(req.id));
  const rf=path.join(d,'r.json'); fs.writeFileSync(rf,'{"title":"T"}');
  assert.equal(JSON.parse(run(d,'fulfill',req.id,'--result-file',rf).stdout).status,'fulfilled');
  const aw=JSON.parse(run(d,'await',req.id).stdout);
  assert.equal(aw.status,'fulfilled'); assert.equal(JSON.parse(aw.result).title,'T');
});
test('await after fulfill is durable (re-await returns same result)', () => {
  const d=freshDir();
  const id=JSON.parse(run(d,'request','--source','jira','--query','q').stdout).id;
  const rf=path.join(d,'r.json'); fs.writeFileSync(rf,'DATA');
  run(d,'fulfill',id,'--result-file',rf);
  assert.equal(JSON.parse(run(d,'await',id).stdout).result,'DATA');
  assert.equal(JSON.parse(run(d,'await',id).stdout).result,'DATA'); // re-await, never lost
});
test('list is empty on a fresh queue', () => {
  assert.equal(JSON.parse(run(freshDir(),'list').stdout).pending,0);
});
test('await/fulfill on unknown id fails cleanly (exit 1)', () => {
  const r=run(freshDir(),'await','nope'); assert.equal(r.status,1); assert.match(r.stdout,/no read request/);
});

test('fail -> await returns failed with error; list shows it', () => {
  const d=freshDir();
  const id=JSON.parse(run(d,'request','--source','drive','--query','q').stdout).id;
  assert.equal(JSON.parse(run(d,'fail',id,'--error','boom').stdout).status,'failed');
  const aw=JSON.parse(run(d,'await',id).stdout);
  assert.equal(aw.status,'failed'); assert.equal(aw.error,'boom');
  assert.match(run(d,'list').stdout, /failed/); // list surfaces failed for retry
});
