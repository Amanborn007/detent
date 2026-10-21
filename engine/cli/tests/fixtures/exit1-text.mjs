// Exits 1 with non-JSON stdout; appends a line to $EXIT1_COUNT_FILE per invocation.
import { appendFileSync } from "node:fs";
if (process.env.EXIT1_COUNT_FILE) appendFileSync(process.env.EXIT1_COUNT_FILE, "x\n");
process.stdout.write("boom");
process.exit(1);
