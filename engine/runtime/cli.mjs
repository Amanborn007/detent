// `engine runtime run|plan|parse|capabilities` — the port's verbs. engine.mjs lazy-imports this and injects its output helpers.
import { readFileSync } from "node:fs";
import { getRuntime, resolveRuntimeName, RuntimeError, UnknownRuntimeError, CapabilityError, RuntimeConfigError } from "./runtime.mjs";

const USAGE = "engine runtime run [--runtime <name>] [--bin <path>] (request JSON on stdin) | engine runtime plan [--runtime <name>] [--bin <path>] (request JSON on stdin) | " +
  "engine runtime parse [--runtime <name>] --stdout <file> --stderr <file> (--exit-code <int> | --signal <NAME>) (request JSON on stdin) | engine runtime capabilities [--runtime <name>]";
const STDIN_HINT = "send the request JSON on stdin; the schema is in engine/runtime/CONTRACT.md";

function flagValue(flags, name, E) {
  const v = flags[name];
  if (v === true) E.refuse(`--${name} needs a value`, USAGE);
  return v;
}

function refusalNext(e) {
  if (e instanceof UnknownRuntimeError) return `set --runtime or DETENT_RUNTIME to one of: ${e.known.join(", ")}`;
  if (e instanceof CapabilityError) return `drop that field, or pick a runtime that declares it: engine runtime capabilities --runtime ${e.runtime}`;
  if (e instanceof RuntimeConfigError) return `set ${e.setting}; see engine/runtime/CONTRACT.md (openai-compatible)`;
  return "fix the request JSON; the schema is in engine/runtime/CONTRACT.md";
}

function parseNative(flags, E) {
  const stdoutFile = flagValue(flags, "stdout", E);
  const stderrFile = flagValue(flags, "stderr", E);
  const code = flagValue(flags, "exit-code", E);
  const signal = flagValue(flags, "signal", E);
  if (stdoutFile === undefined || stderrFile === undefined) E.refuse("runtime parse needs --stdout <file> and --stderr <file>", USAGE);
  if ((code === undefined) === (signal === undefined)) E.refuse("runtime parse needs exactly one of --exit-code <int> or --signal <NAME>", USAGE);
  if (code !== undefined && !/^\d+$/.test(code)) E.refuse(`--exit-code must be a non-negative integer, got ${JSON.stringify(code)}`, USAGE);
  if (signal !== undefined && !/^SIG[A-Z0-9]+$/.test(signal)) E.refuse(`--signal must be a signal name such as SIGTERM, got ${JSON.stringify(signal)}`, USAGE);
  const read = (file, flag) => {
    try { return readFileSync(file, "utf8"); } catch (e) { return E.refuse(`cannot read --${flag} ${file}: ${e.message}`, USAGE); }
  };
  return {
    status: code === undefined ? null : Number(code), signal: signal === undefined ? null : signal,
    stdout: read(stdoutFile, "stdout"), stderr: read(stderrFile, "stderr"),
  };
}

function readRequest(E) {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch (e) {
    return E.refuse(`stdin is not valid JSON: ${e.message}`, STDIN_HINT);
  }
}

function respond(res, E) {
  if (res.stop === "error" || res.stop === "timeout") {
    return E.fail(`${res.runtime} ${res.error.kind}: ${res.error.message}`, "read response.raw.stderr, fix the cause, then re-run", { response: res });
  }
  const next = res.stop === "ok" ? "the answer is in text" : `the run stopped at its ${res.stop} limit; text holds what was produced`;
  return E.out({ ok: true, ...res, next_step: next });
}

export function cmdRuntime(sub, flags, E) {
  if (!["run", "plan", "parse", "capabilities"].includes(sub)) return E.refuse(`unknown runtime command: ${sub || "(none)"}`, USAGE);
  const runtimeFlag = flagValue(flags, "runtime", E);
  const bin = flagValue(flags, "bin", E);
  if (sub === "parse" && bin !== undefined) E.refuse("runtime parse takes no --bin; it reads files and spawns nothing", USAGE);
  const native = sub === "parse" ? parseNative(flags, E) : undefined;
  let rt;
  try {
    const name = resolveRuntimeName({ flag: runtimeFlag });
    rt = getRuntime({ name, bins: bin === undefined ? {} : { [name]: bin } });
  } catch (e) {
    if (e instanceof RuntimeError) return E.refuse(e.message, refusalNext(e), { code: e.code });
    throw e;
  }
  if (sub === "capabilities") {
    return E.out({ ok: true, runtime: rt.name, capabilities: rt.capabilities(), next_step: "send a request JSON on stdin to: engine runtime run" });
  }
  const req = readRequest(E);
  let res;
  try {
    if (sub === "plan") {
      const p = rt.plan(req);
      const { env, ...rest } = p;
      return E.out({
        ok: true, runtime: rt.name, plan: req.env === undefined ? rest : { ...rest, env },
        next_step: "run plan.bin with plan.args in plan.cwd, the request prompt on stdin, and plan.env as the whole environment when present",
      });
    }
    if (sub === "parse") {
      rt.check(req);
      res = rt.parse(native, req);
    } else res = rt.run(req);
  } catch (e) {
    if (e instanceof RuntimeError) return E.refuse(e.message, refusalNext(e), { code: e.code });
    throw e;
  }
  return respond(res, E);
}
