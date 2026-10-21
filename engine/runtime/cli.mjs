// `engine runtime run|capabilities` — the port's verb. engine.mjs lazy-imports this and injects its output helpers.
import { readFileSync } from "node:fs";
import { getRuntime, resolveRuntimeName, RuntimeError, UnknownRuntimeError, CapabilityError, RuntimeConfigError } from "./runtime.mjs";

const USAGE = "engine runtime run [--runtime <name>] [--bin <path>] (request JSON on stdin) | engine runtime capabilities [--runtime <name>]";

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

export function cmdRuntime(sub, flags, E) {
  if (sub !== "run" && sub !== "capabilities") return E.refuse(`unknown runtime command: ${sub || "(none)"}`, USAGE);
  const runtimeFlag = flagValue(flags, "runtime", E);
  const bin = flagValue(flags, "bin", E);
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
  let req;
  try { req = JSON.parse(readFileSync(0, "utf8")); } catch (e) {
    return E.refuse(`stdin is not valid JSON: ${e.message}`, "send the request JSON on stdin; the schema is in engine/runtime/CONTRACT.md");
  }
  let res;
  try { res = rt.run(req); } catch (e) {
    if (e instanceof RuntimeError) return E.refuse(e.message, refusalNext(e), { code: e.code });
    throw e;
  }
  if (res.stop === "error" || res.stop === "timeout") {
    return E.fail(`${res.runtime} ${res.error.kind}: ${res.error.message}`, "read response.raw.stderr, fix the cause, then re-run", { response: res });
  }
  const next = res.stop === "ok" ? "the answer is in text" : `the run stopped at its ${res.stop} limit; text holds what was produced`;
  return E.out({ ok: true, ...res, next_step: next });
}
