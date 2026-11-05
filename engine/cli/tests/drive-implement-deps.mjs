// Test-only deps for `drive --implement`, loaded through DETENT_IMPLEMENT_TEST_DEPS under node --test.
// It swaps the host box for an unboxed runner that records what drive asked for, and the probe for a trivial one.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

const sha = (b) => createHash("sha256").update(b).digest("hex");

export default function deps(cfg) {
  const log = (e) => appendFileSync(cfg.eventsFile, `${JSON.stringify(e)}\n`);
  function createBox({ parent }) {
    const dir = realpathSync(mkdtempSync(join(parent, "hostbox-")));
    for (const d of ["home", "tmp", "cache", "out", "work"]) mkdirSync(join(dir, d), { mode: 0o700 });
    log({ ev: "box_created", dir });
    let used = false;
    const run = async (opts) => {
      if (used) throw Object.assign(new Error(`box ${dir} was already used`), { code: "hostbox_box_reused" });
      used = true;
      const kind = opts.args[0] === "-c" ? "verify" : "export";
      const cwd = opts.cwd ?? join(dir, "work");
      const refExists = spawnSync("git", ["-C", cfg.repo, "rev-parse", "--verify", "-q", `refs/heads/detent/${cfg.runId}`]).status === 0;
      log({ ev: "box_run", kind, dir, cmd: opts.cmd, args: opts.args, net: opts.net, readOnly: opts.readOnly ?? [], writable: opts.writable ?? [dir], cwd, refExists });
      if (kind === "verify" && cfg.advanceRefOnVerify) {
        const head = spawnSync("git", ["-C", cfg.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
        spawnSync("git", ["-C", cfg.repo, "update-ref", `refs/heads/detent/${cfg.runId}`, head]);
      }
      const r = spawnSync(opts.cmd, opts.args, {
        cwd, encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: join(dir, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (kind === "export" && cfg.tamperBundle) {
        const out = opts.args[opts.args.indexOf("create") + 1];
        const b = readFileSync(out);
        b[b.length - 30] ^= 0xff;
        writeFileSync(out, b);
      }
      return {
        code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, timedOut: false,
        truncated: { stdout: false, stderr: false }, bytes: { stdout: r.stdout.length, stderr: r.stderr.length },
        sha256: { stdout: sha(r.stdout), stderr: sha(r.stderr) },
      };
    };
    return { dir, run };
  }

  return {
    platform: cfg.platform ?? "darwin",
    preflight: () => ({ ok: !cfg.preflightRefusals, refusals: cfg.preflightRefusals ?? [] }),
    createBox,
    makeProbe: () => ({
      exps: {
        validate: { readDeny: [], writeAllow: [], writeDenyRequired: [] },
        probe: { script: "echo bash_ran=1", expect: { bash_ran: { k: "eq", v: cfg.probeWant ?? 1 } }, controls: {} },
        shell: { realShell: "/bin/sh", canaryPort: 1, canarySocket: "/tmp/none.sock" },
      },
      finish: async () => ({ canaryHits: 0 }),
    }),
  };
}
