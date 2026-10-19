import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = process.env.TMPDIR || '/tmp';

/** Make an isolated workspace dir under the sandbox-writable TMPDIR. */
export function mkWorkspace(prefix = 'brieftest-') {
  return mkdtempSync(join(TMP, prefix));
}

export function rmWorkspace(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function writeJson(p, obj) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

export function writeJsonl(p, rows) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** Seed a fake owl run under <repo>/.owl/<runId>/. */
export function seedOvernight(repo, runId, { startedAt, iterations = [], decisions = [], objective = 'do a thing', branch = 'owl/x' }) {
  const dir = join(repo, '.owl', runId);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'run-meta.json'), { objective, branch, repo, run_id: runId, started_at: startedAt });
  if (iterations.length) writeJsonl(join(dir, 'iterations.jsonl'), iterations);
  if (decisions.length) writeJsonl(join(dir, 'decisions.jsonl'), decisions);
  return dir;
}

/** Seed a fake engine (.sdlc) run under <sdlcHome>/<runId>/. */
export function seedSdlc(sdlcHome, runId, { ticket, repo, stages, decisions = [], createdAt = '2026-07-06T02:00:00Z' }) {
  const dir = join(sdlcHome, runId);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'run.json'), { run_id: runId, ticket_ref: ticket, repo, created_at: createdAt });
  writeJson(join(dir, 'stage-status.json'), { run_id: runId, stages });
  writeJson(join(dir, 'decisions.json'), decisions);
  return dir;
}
