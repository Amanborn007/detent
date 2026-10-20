#!/usr/bin/env node
// detent — the ONE umbrella command for detent's CLIs. One vocabulary: every
// subcommand is the crew name of the capability it drives.
//   detent curator  <args>  -> curator  (engine/curator/cli.mjs)   e.g. detent curator open x.html
//   detent sentinel <args>  -> sentinel (engine/sentinel/sentinel.mjs)
//   detent owl      <args>  -> owl      (engine/owl/owl.sh)
//   detent herald   <args>  -> herald   (engine/herald/herald.mjs)  e.g. detent herald assemble
//   detent courier  <args>  -> courier  (engine/courier/courier.mjs)
//   detent <anything else>  -> engine   (engine/cli/engine.mjs)     e.g. detent next | detent run new --ticket X | detent dashboard | detent bench <run>
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));         // engine/cli
const ENGINE_ROOT = path.resolve(DIR, '..');                     // engine/
const [group, ...rest] = process.argv.slice(2);

const ROUTES = {
  curator:  { bin: 'node', script: path.join(ENGINE_ROOT, 'curator', 'cli.mjs') },
  sentinel: { bin: 'node', script: path.join(ENGINE_ROOT, 'sentinel', 'sentinel.mjs') },
  owl:      { bin: 'bash', script: path.join(ENGINE_ROOT, 'owl', 'owl.sh') },
  herald:   { bin: 'node', script: path.join(ENGINE_ROOT, 'herald', 'herald.mjs') },
  courier:  { bin: 'node', script: path.join(ENGINE_ROOT, 'courier', 'courier.mjs') },
  feedback: { bin: 'node', script: path.join(ENGINE_ROOT, 'self-feedback', 'feedback.mjs') },
};

if (group === '--help' || group === 'help' && rest.length === 0) {
  process.stdout.write(
    'detent — detent umbrella CLI (one vocabulary: crew names)\n' +
    '  detent curator  <...>   curator review surface (open|poll|reply|end|status)\n' +
    '  detent sentinel <...>   sentinel PR-bot watcher\n' +
    '  detent owl      <...>   owl overnight loop\n' +
    '  detent herald   <...>   herald morning brief (window|assemble|render)\n' +
    '  detent courier  <...>   courier connector reads (request|await|list|get|fulfill|fail)\n' +
    '  detent feedback <...>   agent self-feedback journal (add|list) — coverage gaps the AGENT logs; not curator human feedback\n' +
    '  detent drive --run <id> run a run end to end with headless claude children (experimental, spends credit, see engine/cli/README.md)\n' +
    '  detent <cmd>    <...>   engine runner (run new|next|stage|gate|socket|dashboard|bench|help)\n');
  process.exit(0);
}

let bin, args;
if (ROUTES[group]) {
  ({ bin } = ROUTES[group]);
  args = [ROUTES[group].script, ...rest];
} else {
  // default: the engine runner gets the full arg list unchanged
  bin = process.execPath;
  args = [path.join(ENGINE_ROOT, 'cli', 'engine.mjs'), ...process.argv.slice(2)];
}
const r = spawnSync(bin, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
