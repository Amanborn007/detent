import { isIdent } from "./sanitize.mjs";

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else", "do", "with",
  "typeof", "new", "super", "import", "await", "yield", "throw", "delete", "void", "in", "of"]);

const EXT = {
  js: ["js", "mjs", "cjs", "jsx"], ts: ["ts", "tsx", "mts", "cts"], py: ["py"], go: ["go"], java: ["java"], rs: ["rs"],
};
const LANG = {};
for (const [lang, exts] of Object.entries(EXT)) for (const e of exts) LANG[e] = lang;

export const langOf = (path) => LANG[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] || null;

const JS_MODS = String.raw`(?:export\s+)?(?:default\s+)?`;
const JS_METHOD = new RegExp(String.raw`^\s+(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$#][^\s(<]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{]+)?\{`);
const JS = [
  [new RegExp(String.raw`^\s*${JS_MODS}(?:async\s+)?function\s*\*?\s*([^\s(<]+)`), () => "function"],
  [new RegExp(String.raw`^\s*${JS_MODS}(?:abstract\s+)?class\s+([^\s{<(]+)`), () => "class"],
  [new RegExp(String.raw`^\s*export\s+(?:declare\s+)?(?:const\s+)?(interface|type|enum)\s+([^\s={<(]+)`), (m) => m[1], 2],
  [new RegExp(String.raw`^\s*export\s+(?:const|let|var)\s+([^\s=:;]+)`), () => "const"],
  [JS_METHOD, () => "method"],
];
const RULES = {
  js: JS,
  ts: JS,
  py: [
    [/^(\s*)(?:async\s+)?def\s+([^\s(]+)/, (m) => (m[1] ? "method" : "function"), 2],
    [/^\s*class\s+([^\s(:]+)/, () => "class"],
  ],
  go: [
    [/^func\s+\([^)]*\)\s*([^\s(\[]+)/, () => "method"],
    [/^func\s+([^\s(\[]+)/, () => "function"],
    [/^type\s+([^\s\[=]+)\s+(struct|interface)\b/, (m) => m[2]],
    [/^type\s+([^\s\[=(]+)\s+\S/, () => "type"],
  ],
  java: [
    [/^\s*(?:(?:public|protected|private|static|final|abstract|sealed|strictfp)\s+)*(class|interface|enum|record)\s+([^\s<({]+)/, (m) => m[1], 2],
    [/^\s+(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)+(?:<[^>]+>\s+)?[\w.<>\[\]?,]+\s+([^\s(]+)\s*\(/, () => "method"],
  ],
  rs: [
    [/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([^\s(<]+)/, (m) => (m[1] ? "method" : "function"), 2],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|union)\s+([^\s<{(;=]+)/, (m) => m[1], 2],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_0-9]+)\s*:/, () => "const"],
  ],
};

export function tagRegex(path, text) {
  const lang = langOf(path);
  if (!lang) return [];
  const out = [];
  const seen = new Set();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < 200; i++) {
    const line = lines[i];
    if (line.length > 500) continue;
    for (const [re, kindOf, grp = 1] of RULES[lang]) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[grp];
      if (!name || KEYWORDS.has(name) || !isIdent(name)) break;
      const key = `${i}:${name}`;
      if (!seen.has(key)) { seen.add(key); out.push({ name, kind: kindOf(m), line: i + 1 }); }
      break;
    }
  }
  return out;
}
