// yaml.mjs — the YAML subset provider packs use: block maps, block lists
// (scalar, `- key: v` map, or flow items), flow maps/lists, quoted and plain
// scalars, null/~, booleans, numbers, `#` comments. Anything else (anchors,
// multi-line scalars, tabs, duplicate keys) throws YamlError with a line number.
// engine.mjs and eval.mjs each carry a parser without flow maps, which packs need.

export class YamlError extends Error {
  constructor(message, line) {
    super(`parse error at line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const prev = i === 0 ? " " : raw[i - 1];
    if (quote) {
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && /[\s[{,:]/.test(prev)) {
      quote = c;
    } else if (c === "#" && /\s/.test(prev)) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function plainScalar(t) {
  if (t === "null" || t === "~" || t === "") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

// Reads a quoted scalar starting at s[pos]; returns [value, nextPos].
function readQuoted(s, pos, line) {
  const q = s[pos];
  let out = "";
  for (let i = pos + 1; i < s.length; i++) {
    const c = s[i];
    if (q === "'" && c === "'") {
      if (s[i + 1] === "'") { out += "'"; i++; continue; }
      return [out, i + 1];
    }
    if (q === '"' && c === '"') return [out, i + 1];
    if (q === '"' && c === "\\") {
      const n = s[++i];
      const esc = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/" }[n];
      if (esc === undefined) throw new YamlError(`unsupported escape \\${n}`, line);
      out += esc;
      continue;
    }
    out += c;
  }
  throw new YamlError("unterminated quoted string", line);
}

function parseFlow(text, line) {
  let pos = 0;
  const ws = () => { while (pos < text.length && /\s/.test(text[pos])) pos++; };

  function value() {
    ws();
    const c = text[pos];
    if (c === "{") return map();
    if (c === "[") return list();
    if (c === '"' || c === "'") {
      const [v, next] = readQuoted(text, pos, line);
      pos = next;
      return v;
    }
    const start = pos;
    while (pos < text.length && !",}]".includes(text[pos])) pos++;
    return plainScalar(text.slice(start, pos).trim());
  }

  function map() {
    pos++;
    const obj = {};
    ws();
    if (text[pos] === "}") { pos++; return obj; }
    for (;;) {
      ws();
      let key;
      if (text[pos] === '"' || text[pos] === "'") {
        [key, pos] = readQuoted(text, pos, line);
      } else {
        const start = pos;
        while (pos < text.length && !(text[pos] === ":" && /[\s,}]|^$/.test(text[pos + 1] ?? " "))) {
          if (",}]".includes(text[pos])) throw new YamlError(`flow map entry '${text.slice(start, pos).trim()}' has no ':'`, line);
          pos++;
        }
        key = text.slice(start, pos).trim();
      }
      if (text[pos] !== ":") throw new YamlError("expected ':' in flow map", line);
      pos++;
      if (Object.hasOwn(obj, key)) throw new YamlError(`duplicate key '${key}'`, line);
      obj[key] = value();
      ws();
      if (text[pos] === ",") { pos++; ws(); if (text[pos] === "}") { pos++; return obj; } continue; }
      if (text[pos] === "}") { pos++; return obj; }
      throw new YamlError("unterminated flow map", line);
    }
  }

  function list() {
    pos++;
    const arr = [];
    ws();
    if (text[pos] === "]") { pos++; return arr; }
    for (;;) {
      arr.push(value());
      ws();
      if (text[pos] === ",") { pos++; ws(); if (text[pos] === "]") { pos++; return arr; } continue; }
      if (text[pos] === "]") { pos++; return arr; }
      throw new YamlError("unterminated flow list", line);
    }
  }

  const v = value();
  ws();
  if (pos < text.length) throw new YamlError(`unexpected '${text.slice(pos)}' after flow value`, line);
  return v;
}

function parseInline(text, line) {
  const t = text.trim();
  if (t[0] === "{" || t[0] === "[") return parseFlow(t, line);
  if (t[0] === '"' || t[0] === "'") {
    const [v, next] = readQuoted(t, 0, line);
    if (t.slice(next).trim()) throw new YamlError(`unexpected '${t.slice(next).trim()}' after quoted string`, line);
    return v;
  }
  if (/^[&*!|>]/.test(t)) throw new YamlError(`unsupported YAML construct '${t[0]}'`, line);
  return plainScalar(t);
}

export function parseYaml(text, sourceName = "yaml") {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const no = idx + 1;
    const body = stripComment(raw);
    if (!body.trim()) return;
    if (/^ *\t/.test(body)) throw new YamlError("tab in indentation", no);
    lines.push({ no, indent: body.length - body.trimStart().length, text: body.trim() });
  });
  if (!lines.length) return {};

  let i = 0;
  const isItem = (l) => l.text === "-" || l.text.startsWith("- ");

  function keyVal(l) {
    const m = /^([^:\s"'{[][^:]*?|"[^"]*"|'[^']*'):(?:\s+(.*))?$/.exec(l.text);
    if (!m) throw new YamlError(`expected 'key: value' in ${sourceName}, got '${l.text}'`, l.no);
    const key = /^["']/.test(m[1]) ? m[1].slice(1, -1) : m[1].trim();
    return [key, m[2] === undefined ? "" : m[2].trim()];
  }

  function block(indent) {
    return isItem(lines[i]) ? list(indent) : map(indent);
  }

  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i])) {
      const l = lines[i];
      const [key, val] = keyVal(l);
      if (Object.hasOwn(obj, key)) throw new YamlError(`duplicate key '${key}'`, l.no);
      i++;
      if (val !== "") {
        obj[key] = parseInline(val, l.no);
      } else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isItem(lines[i])))) {
        obj[key] = block(lines[i].indent);
      } else {
        obj[key] = null;
      }
    }
    if (i < lines.length && lines[i].indent > indent) {
      throw new YamlError(`unexpected indentation: '${lines[i].text}'`, lines[i].no);
    }
    return obj;
  }

  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
      const l = lines[i];
      const rest = l.text.slice(1).trim();
      if (rest === "") {
        i++;
        if (i < lines.length && lines[i].indent > indent) arr.push(block(lines[i].indent));
        else arr.push(null);
      } else if (/^["'{[]/.test(rest) || !/^[^:\s][^:]*?:(\s|$)/.test(rest)) {
        arr.push(parseInline(rest, l.no));
        i++;
      } else {
        // `- key: v` opens a map whose keys align with `key`.
        const offset = l.text.length - rest.length;
        lines[i] = { no: l.no, indent: indent + offset, text: rest };
        arr.push(map(indent + offset));
      }
    }
    return arr;
  }

  const doc = block(lines[0].indent);
  if (i < lines.length) throw new YamlError(`unexpected content '${lines[i].text}'`, lines[i].no);
  return doc;
}
