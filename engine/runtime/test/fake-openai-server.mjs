// A fake OpenAI-compatible server for the runtime tests. serve(mode) -> { url, close }.
// url ends in /v1. A blocked parent cannot serve requests, so tests that spawn from the test
// process run this as its own process: `node fake-openai-server.mjs <mode> [logdir]` prints its url.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const GOOD_FINDING = Object.freeze({
  summary: "Retry path skips reconcile()",
  location: "src/a.js:3",
  action: "ask-user",
  risk_level: "high",
  detail: "The early return bypasses reconcile().",
});

export const USAGE = Object.freeze({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

const completion = (content, finish_reason = "stop") => JSON.stringify({
  id: "chatcmpl-fake", object: "chat.completion", model: "fake-model",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason }],
  usage: USAGE,
});

const CONTENT = {
  ok: "hi",
  record: "hi",
  findings: JSON.stringify({ findings: [GOOD_FINDING] }),
  score: '{"score":0.7}',
};

export const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Modes: ok | garbage | sleep | flaky (503, 503, 200) | down (503 forever) | 401-echo-auth | length | findings | score | record. */
export function serve(mode, { logdir } = {}) {
  let hits = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits++;
      const body = Buffer.concat(chunks).toString("utf8");
      if (mode === "record" && logdir) {
        const auth = req.headers.authorization;
        appendFileSync(join(logdir, "requests.jsonl"), JSON.stringify({
          method: req.method, path: req.url, body,
          headers: { ...req.headers, ...(auth === undefined ? {} : { authorization: sha(auth) }) },
        }) + "\n");
      }
      const send = (status, text, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(text);
      };
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(404, '{"error":"not found"}');
      if (mode === "garbage") return send(200, "not json at all");
      if (mode === "sleep") return void setTimeout(() => send(200, completion("late")), 10000);
      if (mode === "down") return send(503, '{"error":{"message":"service unavailable"}}');
      if (mode === "flaky") return hits <= 2 ? send(503, '{"error":{"message":"warming up"}}') : send(200, completion("hi"));
      if (mode === "401-echo-auth") return send(401, JSON.stringify({ error: { message: "bad key", echo: req.headers.authorization ?? null } }));
      if (mode === "length") return send(200, completion("cut off", "length"));
      if (!Object.hasOwn(CONTENT, mode)) return send(500, `{"error":"unknown fake mode ${mode}"}`);
      return send(200, completion(CONTENT[mode]));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
    });
  });
}

// A mode is required so `node --test <dir>`, which runs every file in it, does not start a server.
if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  const [mode, logdir] = process.argv.slice(2);
  const { url } = await serve(mode, { logdir });
  process.stdout.write(url + "\n");
}
