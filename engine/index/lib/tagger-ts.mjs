// Optional tree-sitter tagger. Loaded lazily; any missing piece makes load()
// return a reason instead of throwing, and the caller falls back to regex.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isIdent } from "./sanitize.mjs";
import { langOf } from "./tagger-regex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "..", "package.json"));

const JS_Q = `
(function_declaration name: (identifier) @name.definition.function)
(generator_function_declaration name: (identifier) @name.definition.function)
(class_declaration name: (identifier) @name.definition.class)
(method_definition name: (property_identifier) @name.definition.method)
(export_statement (lexical_declaration (variable_declarator name: (identifier) @name.definition.const)))`;
const TS_Q = `
(function_declaration name: (identifier) @name.definition.function)
(class_declaration name: (type_identifier) @name.definition.class)
(abstract_class_declaration name: (type_identifier) @name.definition.class)
(method_definition name: (property_identifier) @name.definition.method)
(interface_declaration name: (type_identifier) @name.definition.interface)
(type_alias_declaration name: (type_identifier) @name.definition.type)
(enum_declaration name: (identifier) @name.definition.enum)
(export_statement (lexical_declaration (variable_declarator name: (identifier) @name.definition.const)))`;
const SPEC = {
  js: { wasm: "javascript", q: JS_Q },
  ts: { wasm: "typescript", q: TS_Q },
  tsx: { wasm: "tsx", q: TS_Q },
  py: { wasm: "python", q: `(function_definition name: (identifier) @name.definition.function)
(class_definition name: (identifier) @name.definition.class)` },
  go: { wasm: "go", q: `(function_declaration name: (identifier) @name.definition.function)
(method_declaration name: (field_identifier) @name.definition.method)
(type_spec name: (type_identifier) @name.definition.type)` },
  java: { wasm: "java", q: `(class_declaration name: (identifier) @name.definition.class)
(interface_declaration name: (identifier) @name.definition.interface)
(enum_declaration name: (identifier) @name.definition.enum)
(method_declaration name: (identifier) @name.definition.method)` },
  rs: { wasm: "rust", q: `(function_item name: (identifier) @name.definition.function)
(struct_item name: (type_identifier) @name.definition.struct)
(enum_item name: (type_identifier) @name.definition.enum)
(trait_item name: (type_identifier) @name.definition.trait)
(type_item name: (type_identifier) @name.definition.type)
(const_item name: (identifier) @name.definition.const)` },
};

function specKey(path) {
  if (path.endsWith(".tsx")) return "tsx";
  return langOf(path);
}

const INSTALL = "--registry=https://registry.npmjs.org/";

// Resolution only, no wasm init, so doctor can stay synchronous. `dir` is injectable for tests.
export function detectTagger(env = process.env, dir = env.DETENT_INDEX_DIR || join(HERE, "..")) {
  if (env.DETENT_INDEX_TAGGER === "regex") return { tagger: "regex", reason: "forced by DETENT_INDEX_TAGGER=regex", forced: true };
  const req = createRequire(join(dir, "package.json"));
  try {
    req.resolve("web-tree-sitter");
    req.resolve("tree-sitter-wasms/package.json");
  } catch (e) {
    return { tagger: "regex", reason: `tree-sitter not installed; for better symbols run: npm i --prefix ${dir} ${INSTALL}`, code: e.code };
  }
  return { tagger: "tree-sitter", reason: "" };
}

export async function loadTreeSitter() {
  let mod, wasmDir;
  try {
    mod = await import(require.resolve("web-tree-sitter"));
    wasmDir = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
  } catch (e) {
    return { reason: `tree-sitter not installed (${e.code || "load error"}); run npm i --prefix engine/index to enable` };
  }
  try {
    const Parser = mod.Parser ?? mod.default;
    await Parser.init();
    const langs = new Map();
    const parser = new Parser();
    const prepare = async (key) => {
      if (langs.has(key)) return langs.get(key);
      const s = SPEC[key];
      const Language = Parser.Language ?? mod.Language;
      const lang = await Language.load(join(wasmDir, `tree-sitter-${s.wasm}.wasm`));
      const query = lang.query ? lang.query(s.q) : new mod.Query(lang, s.q);
      langs.set(key, { lang, query });
      return langs.get(key);
    };
    // Prove one grammar loads before committing to this tagger.
    await prepare("js");
    return {
      name: "tree-sitter",
      async tag(path, text) {
        const key = specKey(path);
        if (!key) return [];
        const { lang, query } = await prepare(key);
        parser.setLanguage(lang);
        const tree = parser.parse(text);
        const out = [];
        const seen = new Set();
        for (const c of query.captures(tree.rootNode)) {
          if (!c.name.startsWith("name.definition.")) continue;
          let kind = c.name.slice("name.definition.".length);
          const name = c.node.text;
          const line = c.node.startPosition.row + 1;
          if (key === "py" && kind === "function" && c.node.parent?.parent?.parent?.type === "class_definition") kind = "method";
          const k = `${line}:${name}`;
          if (!isIdent(name) || seen.has(k)) continue;
          seen.add(k);
          out.push({ name, kind, line });
          if (out.length >= 200) break;
        }
        tree.delete?.();
        return out;
      },
    };
  } catch (e) {
    return { reason: `tree-sitter failed to initialise (${String(e.message).slice(0, 80)})` };
  }
}
