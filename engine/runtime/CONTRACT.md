# Runtime contract

A runtime runs one prompt through a model CLI. Callers send one request and get one response, whatever the CLI is. `engine/runtime/runtime.mjs` is the port. `adapters/<name>.mjs` is one runtime. The registry is closed: only adapters imported in `runtime.mjs` exist.

One rule governs the schema: **every request field maps to a capability.** A runtime that does not declare what a field asks for refuses the request with `CapabilityError`. It never drops the field, never substitutes another behaviour, and the request has no `extra` bag.

## Choosing a runtime

`--runtime <name>`, then `DETENT_RUNTIME`, then `claude-code`. An empty or unregistered name is `UnknownRuntimeError`.

## Request

```
{ prompt, cwd, output, tools, mcp, settings: { sources, file? }, approvals?, auth?, model?, persist_session?, timeout_ms?,
  deny_tools?, add_dirs?, budget?, env?, containment? }
```

| field | values | needs capability |
|---|---|---|
| `prompt` (required) | non-empty string, sent on stdin, never argv | none |
| `cwd` (required) | absolute path the child runs in | none |
| `output` (required) | `text` or `json` | `output` lists it |
| `tools` (required) | `none`, `inherit` or `{ allow: [...] }` | `tools` lists the string; the object needs `tools_allow: true` |
| `mcp` (required) | `none` or `inherit` | `mcp` lists it |
| `settings.sources` (required) | `none`, `project` or `inherit` | `settings_sources` lists it |
| `settings.file` | absolute path | `settings_file: true` |
| `approvals` | `deny` | `approvals` lists it |
| `auth` | `session` or `api_key` | `auth` lists it |
| `model` | non-empty string | `model: true` |
| `persist_session` | `false` only | `persist_session: true` |
| `timeout_ms` | positive integer | `timeout: true` |
| `tools: { allow }` | exactly `{ allow }`, a non-empty list of unique names from `read glob grep write edit todo`, order kept | `tools_allow: true` |
| `deny_tools` | non-empty array of `{ shell_prefix }`; the prefix is non-empty with no `(`, `)`, `*`, newline or NUL; order kept | `deny_tools: true` |
| `add_dirs` | non-empty list of unique absolute paths | `add_dirs: true` |
| `budget` | `{ usd?, turns? }`, at least one; `usd` a positive finite number, `turns` a positive integer | `budget: true` |
| `env` | object; names match `^[A-Za-z_][A-Za-z0-9_]*$`, values are strings without NUL | `env: true` |
| `containment` | `"strict"` | `containment: true` |

Any other key is `RuntimeRequestError`. Nothing is defaulted: an absent optional field means the adapter adds no flag for it. `approvals: "deny"` means a tool the settings do not allow is refused, never prompted for.

### Validation order

`rt.plan(req)` and `rt.check(req)` run `validateRequest`, then `requireCapabilities`, then `validateDeclared`; `plan` then calls the adapter. `check` stops before the adapter, so it needs no environment. A runtime that lacks a capability refuses with `CapabilityError` even when the field is malformed, because the capability check comes first. `validateRequest` knows the shapes of the base fields only. `validateDeclared` checks the shape of `tools.allow`, `deny_tools`, `add_dirs`, `budget`, `env` and `containment`, and every refusal is a `RuntimeRequestError` whose `field` names the field (`deny_tools[1].shell_prefix`, `budget.usd`).

## Capabilities

`capabilities()` returns a frozen object: `output`, `tools`, `mcp`, `settings_sources`, `auth`, `approvals` (arrays of the values the runtime accepts), `settings_file`, `model`, `persist_session`, `timeout`, `tools_allow`, `deny_tools`, `add_dirs`, `budget`, `containment`, `env` (booleans), and `reports: { cost_usd, turns }` naming the output mode that carries each figure. Declare only what a golden test covers.

## Response

```
{ runtime, stop, text, cost_usd, turns, denials, error, raw: { stdout, stderr, exit_code, signal } }
```

- `stop`: `ok`, `budget`, `turns`, `timeout` or `error`.
- `text`: string, or `null` when there is no answer.
- `cost_usd`, `turns`: number or `null`. Never `0` for "unknown". `output: "text"` reports both as `null`.
- `error`: `null`, or `{ kind, message, exit_code? }` with `kind` one of `spawn`, `exit`, `bad_output`, `runtime_error`, `timeout`.
- On a nonzero exit, `claude-code` still fills `cost_usd`, `turns` and `denials` when `output` is `json` and stdout holds a valid envelope. `stop` stays `error`, `error.kind` stays `exit` and `text` stays `null`. A child that spent money before it failed is therefore still counted.

`run()` is synchronous. A spawn failure, nonzero exit, timeout or unparseable output comes back as a response with `stop: "error"` or `"timeout"`. Only contract violations throw.

## Errors

| class | `code` | extra fields |
|---|---|---|
| `UnknownRuntimeError` | `unknown_runtime` | `requested`, `known` |
| `RuntimeConfigError` | `bad_config` | `setting` |
| `RuntimeRequestError` | `bad_request` | `field` |
| `CapabilityError` | `capability_missing` | `runtime`, `capability`, `requested` |

## Verb

`engine runtime run [--runtime <name>] [--bin <path>]` reads the request on stdin and prints one JSON line.

| exit | when | stdout |
|---|---|---|
| 0 | `stop` is `ok`, `budget` or `turns` | `{ ok: true, ...response, next_step }` |
| 1 | `stop` is `error` or `timeout` | `{ ok: false, reason, next_step, response }` |
| 2 | bad stdin JSON, `RuntimeRequestError`, `UnknownRuntimeError`, `CapabilityError`, `RuntimeConfigError` | `{ ok: false, reason, next_step }` |

`engine runtime plan [--runtime <name>] [--bin <path>]` reads the same request and prints the command without running it: `{ ok: true, runtime, plan: { bin, args, cwd, env?, echo_stderr? }, next_step }`, exit 0. Exit 2 has the refusal shapes of `run`; there is no exit 1. `plan.env` is printed only when the request carried `env`, because `openai-compatible` copies the parent environment into its plan and that can hold a key.

`engine runtime parse [--runtime <name>] --stdout <file> --stderr <file> (--exit-code <int> | --signal <NAME>)` reads the same request, runs `rt.check` (not `adapter.plan`, so `openai-compatible` needs no endpoint variables), then `adapter.parse({ status, signal, stdout, stderr }, request)`. Every flag is required and exactly one of `--exit-code` and `--signal` is given. Exit 0 prints `{ ok: true, ...response, next_step }` for `ok`, `budget` and `turns`. Exit 1 prints `{ ok: false, reason, next_step, response }` for `error` and `timeout`. Exit 2 is a missing or conflicting flag, an unreadable file, bad stdin JSON or a refused request. A shell caller plans, spawns the child with its own kill logic, then parses what it captured.

`engine runtime capabilities [--runtime <name>]` prints `{ ok: true, runtime, capabilities, next_step }`.

## claude-code

Argv, in this order. A field that is absent adds no flag.

`-p`, `--output-format json`, `--tools ""` (`tools: "none"`) or `--tools Read,Glob,...` (`tools.allow`, names mapped `read Read`, `glob Glob`, `grep Grep`, `write Write`, `edit Edit`, `todo TodoWrite`, joined by `,`), `--strict-mcp-config`, `--no-session-persistence`, `--permission-mode dontAsk` (`approvals: "deny"`), `--bare` or `--setting-sources X`, `--settings F`, `--model M`, `--add-dir D` per entry, `--max-budget-usd U`, `--max-turns T`, then `--disallowedTools` with one `Bash(<prefix>*)` per `deny_tools` entry. `--disallowedTools` takes a variable number of values, so it is last, and the prompt is on stdin. `env` becomes `plan.env`, the child's whole environment.

`containment: "strict"` selects a fixed template instead:

```
-p --restricted --tools <allow> --output-format json --model M --permission-mode dontAsk --settings F
--strict-mcp-config --mcp-config '{"mcpServers":{}}' --add-dir I --add-dir O --max-budget-usd U --max-turns T [--bare]
```

`engine/cli/drive/profile.mjs` `buildChildArgs` is the same argv. The request must carry `output: "json"`, `tools.allow`, `mcp: "none"`, `approvals: "deny"`, `settings.file`, `model`, `budget.usd`, `budget.turns`, `add_dirs` and `env`. It must not carry `deny_tools`, `persist_session` or `settings.sources: "project"`. The sources are `inherit` with no `auth` (OAuth, no `--setting-sources`), or `none` with `auth: "api_key"` (`--bare`, last). Anything else is `RuntimeRequestError` with `field: "containment"`.

The adapter exports `containment: { bin, probe_args: ["--version"], timeout_ms: 30000, check(native) }`. `check` returns `{ ok: true, version }`, `{ ok: false, kind: "spawn", message }` when `native.error` is set, or `{ ok: false, kind: "version", text, min }` when the output is not `2.1.306` or later. `MIN_CLAUDE_VERSION`, `parseVersion` and `versionAtLeast` are exported from the adapter, and `drive/profile.mjs` re-exports them.

`rt.probeContainment({ env })` is the port side. It throws `CapabilityError(runtime, "containment", "strict")` when the runtime does not declare `containment`. Otherwise it spawns the bin (the `--bin` override, else `containment.bin`) with `probe_args` and `env`, and returns what `containment.check` says. Adapters stay pure; the port spawns.

`DETENT_RUNTIME` set to a runtime without `containment` makes a caller that needs strict containment refuse instead of running uncontained. owl and drive adopt this in later changes.

## Adding a runtime

Write `adapters/<name>.mjs` exporting `{ name, capabilities(), plan(req, env), parse(native, req) }`, all pure, optionally with `containment` as above, register it in `runtime.mjs`, and call `conformanceSuite({ name, makeFake })` from a test. `plan` returns `{ bin, args, cwd }`, plus optionally `env` (the child's whole environment, used instead of the parent's) and `echo_stderr: true` (the port copies the child's stderr to its own after the child exits; `raw.stderr` is unchanged). `env` defaults to `process.env`, and `getRuntime({ env })` and `createRuntime(adapter, { env })` pass another one. `plan` throws `RuntimeConfigError` when the environment is missing or unsafe, before anything spawns. `parse` receives the raw `spawnSync` result and returns the response. The fake binary your `makeFake` returns must create `<dir>/spawned` when it starts, so the suite can prove a refused request spawned nothing.

## openai-compatible

Sends the prompt to any server that speaks `POST {base}/chat/completions` (OpenAI, Ollama, vLLM, LM Studio). There is no default endpoint and no default model. Select it with `--runtime openai-compatible` or `DETENT_RUNTIME=openai-compatible`. Scores from the judge are not comparable across runtimes, so do not mix them in one benchmark.

| env var | meaning |
|---|---|
| `DETENT_OPENAI_BASE_URL` (required) | `http:` or `https:` endpoint root, such as `http://127.0.0.1:11434/v1`. A trailing `/` is trimmed. `OPENAI_BASE_URL` is not read. |
| `DETENT_OPENAI_MODEL` | model name, used when the request has no `model`. With neither, the call is refused. |
| `DETENT_OPENAI_API_KEY_ENV` | the NAME of the variable that holds the key, not the key. If set, that variable must be non-empty, and a refusal says only that the variable named by `DETENT_OPENAI_API_KEY_ENV` is empty or unset, never its name. The key goes out as `Authorization: Bearer` and never appears in argv, the request JSON or the response. With none set, no header is sent, which is what Ollama wants. |

`request.auth: "api_key"` also requires `DETENT_OPENAI_API_KEY_ENV`. Plain `http:` to a host other than `localhost`, `127.x.x.x` or `[::1]` is refused when a key is configured. A base URL with a username or password is always refused, and the message does not repeat it. Every refusal is a `RuntimeConfigError` whose `setting` names what to set, and the verb prints `set <setting>; see engine/runtime/CONTRACT.md (openai-compatible)` and exits 2.

Capabilities: `output` text and json (both return the message content as `text`; `response_format` is not sent), `tools` none, `mcp` none, `settings_sources` none, `approvals` none, `auth` api_key, `model`, `persist_session` (only `false` is accepted, and nothing is persisted either way) and `timeout`. `reports` is empty, so `cost_usd` and `turns` are always `null`. Token usage stays in `raw.stdout`.

The plan runs `node adapters/openai-compatible-call.mjs --base-url <url> --model <m> [--api-key-env <NAME>]` with the prompt on stdin. `--bin` replaces `node`, which is how the tests substitute a fake. The helper sends `{ model, messages: [{ role: "user", content: prompt }], stream: false }` and prints one line, exit 0 whenever it classified the outcome:

```
{"protocol":"detent-openai-call-v1","ok":true,"http_status":200,"attempts":n,"body":{...}}
{"protocol":"detent-openai-call-v1","ok":false,"class":"http"|"network"|"bad_body","http_status"?,"attempts":n,"message":"..."}
```

A nonzero helper exit is a crash and maps to kind `exit`. The key value is replaced by `[redacted]` in the error `message` and in every string inside `body`, never in `protocol`, `ok`, `class`, `http_status` or `attempts`. A key shorter than 8 characters, such as `EMPTY`, is not redacted at all, because replacing it would also rewrite ordinary text.

| outcome | `stop` | `error.kind` |
|---|---|---|
| `finish_reason` `stop` with string content | `ok` | none, `text` is the content |
| `finish_reason` `length` | `error` | `runtime_error`, "output truncated (finish_reason length)" |
| `content_filter`, any other or a missing `finish_reason` | `error` | `runtime_error` naming it |
| no `choices`, non-string content, a 200 that is not JSON, stdout that is not the protocol | `error` | `bad_output` |
| HTTP error or network failure after the retries | `error` | `runtime_error` with the status or cause and the attempt count |
| `timeout_ms` reached | `timeout` | `timeout` |
| node missing | `error` | `spawn` |
| helper crash | `error` | `exit` |

Retries: network errors and HTTP 408, 429, 500, 502, 503 and 504 get three attempts in all, with 500 ms then 1000 ms between them. A `Retry-After` in seconds replaces the wait, capped at 10 s. Other 4xx statuses and unparseable 200 bodies are not retried. Each retry writes `openai-compatible: attempt i/3 failed (<HTTP 503 | ECONNREFUSED>); retrying in Nms` to stderr, which the port echoes. There are no knobs. `timeout_ms` bounds the whole call, retries included, and without it there is no timeout.
