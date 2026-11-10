// Shared by the curator and engine test suites: stop the daemon a test started, and never anything else.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CURATOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(CURATOR_DIR, "cli.mjs");
const SERVER = join(CURATOR_DIR, "server.mjs");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function recordedPid(stateDir) {
  const f = join(stateDir, "state.json");
  if (!existsSync(f)) return null;
  const pid = JSON.parse(readFileSync(f, "utf8")).pid;
  return Number.isInteger(pid) ? pid : null;
}

/** Stop the daemon recorded in stateDir. A dead pid, or one the OS has since given to another process, counts as stopped. */
export function stopCuratorDaemon(stateDir) {
  const pid = recordedPid(stateDir);
  if (pid === null || !alive(pid)) return;
  const stop = spawnSync(process.execPath, [CLI, "stop"], { encoding: "utf8", env: { ...process.env, CURATOR_STATE_DIR: stateDir, CURATOR_NO_BROWSER: "1" } });
  if (stop.status === 0 || !alive(pid)) return;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.error) throw new Error(`curator stop failed for ${stateDir} and ps cannot confirm pid ${pid} is the daemon, so it was not killed: ${stop.stdout}${stop.stderr}${ps.error.message}`);
  if (ps.status !== 0) return;
  if (!ps.stdout.trim().endsWith(` ${SERVER} --daemon`)) return;
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 100 && alive(pid); i++) sleepSync(50);
  if (alive(pid)) throw new Error(`curator daemon ${pid} in ${stateDir} survived SIGKILL`);
}
