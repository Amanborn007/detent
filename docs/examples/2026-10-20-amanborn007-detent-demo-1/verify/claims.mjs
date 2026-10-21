import { slugify } from "../worktree/src/index.js";
const show = (label, fn) => {
  let r;
  try { r = JSON.stringify(fn()); } catch (e) { r = `${e.constructor.name}: ${e.message}`; }
  console.log(`${label}\n  => ${r}`);
};
const t = "Hello brave new world";
console.log("C1 result is at most maxLength characters");
for (const n of [5, 11, 12, 13]) show(`  maxLength ${n}`, () => { const s = slugify(t, { maxLength: n }); return `${s} (length ${s.length})`; });
console.log("C2 cut lands on a separator");
show("  maxLength 13", () => slugify(t, { maxLength: 13 }));
show('  separator "--", maxLength 7, "ab cd ef"', () => slugify("ab cd ef", { separator: "--", maxLength: 7 }));
console.log("C3 first word longer than maxLength is cut");
show('  maxLength 5, "Supercalifragilistic expialidocious"', () => slugify("Supercalifragilistic expialidocious", { maxLength: 5 }));
console.log("C4 never ends in the separator");
show("  maxLength 12", () => slugify(t, { maxLength: 12 }));
show('  separator "--", maxLength 3, "ab cd"', () => slugify("ab cd", { separator: "--", maxLength: 3 }));
console.log("C5 RangeError below 1 or not an integer");
for (const v of [0, -1, 2.5, "10", Number.NaN]) show(`  maxLength ${typeof v === "string" ? JSON.stringify(v) : String(v)}`, () => slugify("Hello World", { maxLength: v }));
console.log("C6 unchanged without maxLength, and with null per D-001");
show("  no options", () => slugify(t));
show("  maxLength null", () => slugify(t, { maxLength: null }));
