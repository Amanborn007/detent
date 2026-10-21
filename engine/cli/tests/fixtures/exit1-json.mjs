// Exits 1 with a JSON body on stdout; appends a line to $EXIT1_COUNT_FILE per invocation.
import { appendFileSync } from "node:fs";
if (process.env.EXIT1_COUNT_FILE) appendFileSync(process.env.EXIT1_COUNT_FILE, "x\n");
process.stdout.write(JSON.stringify({ error: "rate limited", code: 429 }));
process.exit(1);
