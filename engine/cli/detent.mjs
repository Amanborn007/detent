#!/usr/bin/env node
// detent — the ONE umbrella command for detent's CLIs. One vocabulary: every
// subcommand is the crew name of the capability it drives.
//   detent curator  <args>  -> curator  (engine/curator/cli.mjs)   e.g. detent curator open x.html
//   detent sentinel <args>  -> sentinel (engine/sentinel/sentinel.mjs)
//   detent owl      <args>  -> owl      (engine/owl/owl.sh)
//   detent herald   <args>  -> herald   (engine/herald/herald.mjs)  e.g. detent herald assemble
//   detent courier  <args>  -> courier  (engine/courier/courier.mjs)
//   detent <anything else>  -> engine   (engine/cli/engine.mjs)     e.g. detent start owner/repo#1 | detent status | detent approve | detent next | detent dashboard
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
  index:    { bin: 'node', script: path.join(ENGINE_ROOT, 'index', 'index.mjs') },
};

if (group === '--help' || group === 'help' && rest.length === 0) {
  process.stdout.write(
    'detent — detent umbrella CLI (one vocabulary: crew names)\n' +
    '  detent start <owner/repo#N> [--repo .]  begin work on a ticket: setup if needed, index the repo, then a new run\n' +
    '  detent status           where the run stands: stages, waiting gates, what to do next\n' +
    '  detent continue [--yes] run one step of the run (inside Claude Code it names the stage skill instead)\n' +
    '  detent decide           answer the waiting gate in curator\n' +
    '  detent approve [D-xxx]  approve the intent gate, from your own terminal\n' +
    '  detent revise [D-xxx] [--note ".."]  send the plan back with a note, from your own terminal\n' +
    '  detent doctor           check node, git, gh, curator, stack.yaml and DETENT_ROOT\n' +
    '  detent curator  <...>   curator review surface (open|poll|reply|end|status)\n' +
    '  detent sentinel <...>   sentinel PR-bot watcher\n' +
    '  detent owl      <...>   owl overnight loop\n' +
    '  detent herald   <...>   herald morning brief (window|assemble|render)\n' +
    '  detent courier  <...>   courier connector reads (request|await|list|get|fulfill|fail)\n' +
    '  detent drive --run <id> contained intake, research and plan with headless claude children (experimental, spends credit)\n' +
    '  detent feedback <...>   agent self-feedback journal (add|list) — coverage gaps the AGENT logs; not curator human feedback\n' +
    '  detent index    <...>   repo index (build|refresh|status|query <words>|cochange <files>)\n' +
    '  detent drive --run <id> run a run end to end with headless claude children (experimental, spends credit, see engine/cli/README.md)\n' +
    '  detent <cmd>    <...>   machine layer: engine runner (run new|next|stage|gate|socket|dashboard|bench|help)\n');
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
const r = spawnSync(bin, args, { stdio: 'inherit', env: { ...process.env, DETENT_CLI: '1' } });
process.exit(r.status ?? 1);
