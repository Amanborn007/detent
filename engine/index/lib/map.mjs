import { rankOrder } from "./graph.mjs";

export const MAP_CHAR_BUDGET = 6000; // about 1.5k tokens at chars/4
const KIND_ORDER = ["class", "struct", "interface", "trait", "enum", "type", "union", "record", "function", "method", "const"];
const rank = (k) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };

export function renderMap(scores, symbolsByFile) {
  const head = "# Repo map\n\nFiles ranked by how much of the codebase refers to them, with their main definitions.\n";
  let out = head;
  for (const [path] of rankOrder(scores)) {
    const defs = [...(symbolsByFile.get(path) || [])].sort((a, b) => rank(a.kind) - rank(b.kind) || a.line - b.line).slice(0, 8);
    if (!defs.length) continue;
    const block = `\n${path}\n  ${defs.map((d) => `${d.kind} ${d.name}`).join(", ")}\n`;
    if (out.length + block.length > MAP_CHAR_BUDGET) break;
    out += block;
  }
  return out;
}
