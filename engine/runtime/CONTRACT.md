# Runtime contract

A runtime runs one prompt through a model CLI. Callers send one request and get one response, whatever the CLI is. `engine/runtime/runtime.mjs` is the port. `adapters/<name>.mjs` is one runtime. The registry is closed: only adapters imported in `runtime.mjs` exist.

One rule governs the schema: **every request field maps to a capability.** A runtime that does not declare what a field asks for refuses the request with `CapabilityError`. It never drops the field, never substitutes another behaviour, and the request has no `extra` bag.

## Choosing a runtime

`--runtime <name>`, then `DETENT_RUNTIME`, then `claude-code`. An empty or unregistered name is `UnknownRuntimeError`.

## Request

```
{ prompt, cwd, output, tools, mcp, settings: { sources, file? }, auth?, model?, persist_session?, timeout_ms? }
```

| field | values | needs capability |
|---|---|---|
| `prompt` (required) | non-empty string, sent on stdin, never argv | none |
| `cwd` (required) | absolute path the child runs in | none |
| `output` (required) | `text` or `json` | `output` lists it |
| `tools` (required) | `none` or `inherit` | `tools` lists it |
| `mcp` (required) | `none` or `inherit` | `mcp` lists it |
| `settings.sources` (required) | `none`, `project` or `inherit` | `settings_sources` lists it |
| `settings.file` | absolute path | `settings_file: true` |
| `auth` | `session` or `api_key` | `auth` lists it |
| `model` | non-empty string | `model: true` |
| `persist_session` | `false` only | `persist_session: true` |
| `timeout_ms` | positive integer | `timeout: true` |

Reserved. They are known keys, so they are not a request error, and the claude-code runtime refuses all of them: `tools: { allow: [...] }` (`tools_allow`), `deny_tools`, `add_dirs`, `budget: { usd, turns }`, `env`, `containment`. Any other key is `RuntimeRequestError`. Nothing is defaulted: an absent optional field means the adapter adds no flag for it.

## Capabilities

`capabilities()` returns a frozen object: `output`, `tools`, `mcp`, `settings_sources`, `auth` (arrays of the values the runtime accepts), `settings_file`, `model`, `persist_session`, `timeout`, `tools_allow`, `deny_tools`, `add_dirs`, `budget`, `containment`, `env` (booleans), and `reports: { cost_usd, turns }` naming the output mode that carries each figure. Declare only what a golden test covers.

## Response

```
{ runtime, stop, text, cost_usd, turns, denials, error, raw: { stdout, stderr, exit_code, signal } }
```

- `stop`: `ok`, `budget`, `turns`, `timeout` or `error`.
- `text`: string, or `null` when there is no answer.
- `cost_usd`, `turns`: number or `null`. Never `0` for "unknown". `output: "text"` reports both as `null`.
- `error`: `null`, or `{ kind, message, exit_code? }` with `kind` one of `spawn`, `exit`, `bad_output`, `runtime_error`, `timeout`.

`run()` is synchronous. A spawn failure, nonzero exit, timeout or unparseable output comes back as a response with `stop: "error"` or `"timeout"`. Only contract violations throw.

## Errors

| class | `code` | extra fields |
|---|---|---|
| `UnknownRuntimeError` | `unknown_runtime` | `requested`, `known` |
| `RuntimeRequestError` | `bad_request` | `field` |
| `CapabilityError` | `capability_missing` | `runtime`, `capability`, `requested` |

## Verb

`engine runtime run [--runtime <name>] [--bin <path>]` reads the request on stdin and prints one JSON line.

| exit | when | stdout |
|---|---|---|
| 0 | `stop` is `ok`, `budget` or `turns` | `{ ok: true, ...response, next_step }` |
| 1 | `stop` is `error` or `timeout` | `{ ok: false, reason, next_step, response }` |
| 2 | bad stdin JSON, `RuntimeRequestError`, `UnknownRuntimeError`, `CapabilityError` | `{ ok: false, reason, next_step }` |

`engine runtime capabilities [--runtime <name>]` prints `{ ok: true, runtime, capabilities, next_step }`.

## Adding a runtime

Write `adapters/<name>.mjs` exporting `{ name, capabilities(), plan(req), parse(native, req) }`, all pure, register it in `runtime.mjs`, and call `conformanceSuite({ name, makeFake })` from a test. `plan` returns `{ bin, args, cwd }`. `parse` receives the raw `spawnSync` result and returns the response. The fake binary your `makeFake` returns must create `<dir>/spawned` when it starts, so the suite can prove a refused request spawned nothing.
