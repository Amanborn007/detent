// Driving a run to needs_human with the real sibling curator must not open a browser or leave a daemon behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engine, detentHome } from "./helpers.mjs";
import { setup, throughStage, scratch, BARE_PATH } from "./drive-kit.mjs";

const CURATOR_CLI = join(fileURLToPath(import.meta.url), "..", "..", "..", "curator", "cli.mjs");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };

test("needs_human with the real curator launches no browser and leaves no daemon", () => {
  const t = setup();
  throughStage(t, "research");
  const d = scratch();
  const bin = join(d, "bin");
  const log = join(d, "opened.log");
  mkdirSync(bin);
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $@" >> "${log}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(t.d, "mode.json"), JSON.stringify({
    manifestPatch: { env: { commands: { verify: "node --test" }, gotchas: ["g"] } },
  }));
  mkdirSync(t.tmp, { recursive: true });
  const state = join(detentHome(), ".local", "curator");
  try {
    const r = engine(["drive", "--run", t.runId, "--repo", t.repo, "--claude-bin", t.stub, "--stack", t.stack],
      { env: { PATH: `${bin}:${BARE_PATH}`, TMPDIR: t.tmp, CURATOR_ALLOW_DAEMON: "1" } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.stopped, "needs_human");
    assert.ok(r.json.url, `the real curator did not open the gate page: ${r.stderr}`);
    assert.ok(!/curator open failed/.test(r.stderr), r.stderr);
    assert.equal(existsSync(log) ? readFileSync(log, "utf8") : "", "", "a browser opener was run");
  } finally {
    const stop = spawnSync(process.execPath, [CURATOR_CLI, "stop"], { encoding: "utf8", env: { ...process.env, CURATOR_STATE_DIR: state, CURATOR_NO_BROWSER: "1" } });
    const f = join(state, "state.json");
    const pid = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).pid : null;
    if (stop.status !== 0 && pid && alive(pid)) process.kill(pid, "SIGKILL");
    assert.equal(stop.status, 0, stop.stdout + stop.stderr);
    assert.ok(!(pid && alive(pid)), `daemon ${pid} still alive in ${state}`);
  }
});
