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

Reserved. They are known keys, so they are not a request error, and both runtimes refuse all of them: `tools: { allow: [...] }` (`tools_allow`), `deny_tools`, `add_dirs`, `budget: { usd, turns }`, `env`, `containment`. Any other key is `RuntimeRequestError`. Nothing is defaulted: an absent optional field means the adapter adds no flag for it.

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

`engine runtime capabilities [--runtime <name>]` prints `{ ok: true, runtime, capabilities, next_step }`.

## Adding a runtime

Write `adapters/<name>.mjs` exporting `{ name, capabilities(), plan(req, env), parse(native, req) }`, all pure, register it in `runtime.mjs`, and call `conformanceSuite({ name, makeFake })` from a test. `plan` returns `{ bin, args, cwd }`, plus optionally `env` (the child's whole environment, used instead of the parent's) and `echo_stderr: true` (the port copies the child's stderr to its own after the child exits; `raw.stderr` is unchanged). `env` defaults to `process.env`, and `getRuntime({ env })` and `createRuntime(adapter, { env })` pass another one. `plan` throws `RuntimeConfigError` when the environment is missing or unsafe, before anything spawns. `parse` receives the raw `spawnSync` result and returns the response. The fake binary your `makeFake` returns must create `<dir>/spawned` when it starts, so the suite can prove a refused request spawned nothing.

## openai-compatible

Sends the prompt to any server that speaks `POST {base}/chat/completions` (OpenAI, Ollama, vLLM, LM Studio). There is no default endpoint and no default model. Select it with `--runtime openai-compatible` or `DETENT_RUNTIME=openai-compatible`. Scores from the judge are not comparable across runtimes, so do not mix them in one benchmark.

| env var | meaning |
|---|---|
| `DETENT_OPENAI_BASE_URL` (required) | `http:` or `https:` endpoint root, such as `http://127.0.0.1:11434/v1`. A trailing `/` is trimmed. `OPENAI_BASE_URL` is not read. |
| `DETENT_OPENAI_MODEL` | model name, used when the request has no `model`. With neither, the call is refused. |
| `DETENT_OPENAI_API_KEY_ENV` | the NAME of the variable that holds the key, not the key. If set, that variable must be non-empty, and a refusal says only that the variable named by `DETENT_OPENAI_API_KEY_ENV` is empty or unset, never its name. The key goes out as `Authorization: Bearer` and never appears in argv, the request JSON or the response. With none set, no header is sent, which is what Ollama wants. |

`request.auth: "api_key"` also requires `DETENT_OPENAI_API_KEY_ENV`. Plain `http:` to a host other than `localhost`, `127.x.x.x` or `[::1]` is refused when a key is configured. A base URL with a username or password is always refused, and the message does not repeat it. Every refusal is a `RuntimeConfigError` whose `setting` names what to set, and the verb prints `set <setting>; see engine/runtime/CONTRACT.md (openai-compatible)` and exits 2.

Capabilities: `output` text and json (both return the message content as `text`; `response_format` is not sent), `tools` none, `mcp` none, `settings_sources` none, `auth` api_key, `model`, `persist_session` (only `false` is accepted, and nothing is persisted either way) and `timeout`. `reports` is empty, so `cost_usd` and `turns` are always `null`. Token usage stays in `raw.stdout`.

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
