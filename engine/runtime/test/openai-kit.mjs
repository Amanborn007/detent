// Fixtures for the openai-compatible tests: a fake bin that stands in for node, and a server in its own process.
import { writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER_PATH = join(HERE, "fake-openai-server.mjs");
const CALL_PATH = join(HERE, "..", "adapters", "openai-compatible-call.mjs");

// `--bin` replaces node, so the runtime runs this as `<bin> <call.mjs> --base-url ...`. It serves the mode
// in-process, points --base-url at itself and runs the real helper. Modes: the fake server's, plus exit1 | nobin.
export function makeOpenAIFake(dir, mode) {
  const bin = join(dir, "fake-node");
  if (mode === "nobin") return { bin: join(dir, "no-such-node") };
  writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(dir, "spawned"))}, "");
const mode = ${JSON.stringify(mode)};
if (mode === "exit1") { process.stderr.write("boom\\n"); process.exit(1); }
(async () => {
  const { serve } = await import(${JSON.stringify(pathToFileURL(SERVER_PATH).href)});
  const { main } = await import(${JSON.stringify(pathToFileURL(CALL_PATH).href)});
  const { url, close } = await serve(mode, { logdir: ${JSON.stringify(dir)} });
  const argv = process.argv.slice(3);
  argv[argv.indexOf("--base-url") + 1] = url;
  process.exitCode = await main(argv);
  await close();
})();
`);
  chmodSync(bin, 0o755);
  return { bin };
}

/** Starts the fake server as a separate process, for tests whose own event loop is blocked in spawnSync. */
export function startServerProcess(mode, logdir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH, mode, ...(logdir ? [logdir] : [])], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("fake server did not print its url")); }, 5000);
    child.once("error", reject);
    child.stdout.on("data", (d) => {
      out += d;
      if (!out.includes("\n")) return;
      clearTimeout(timer);
      child.stdout.removeAllListeners("data");
      child.stdout.resume();
      resolve({ url: out.trim(), close: () => { child.kill(); } });
    });
  });
}
