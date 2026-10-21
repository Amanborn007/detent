import { tagRegex } from "./tagger-regex.mjs";

export async function pickTagger(env) {
  const regex = { name: "regex", tag: async (p, t) => tagRegex(p, t) };
  if (env.DETENT_INDEX_TAGGER === "regex") return regex;
  const { loadTreeSitter } = await import("./tagger-ts.mjs");
  const ts = await loadTreeSitter();
  if (ts.name) return ts;
  return { ...regex, note: ts.reason };
}
