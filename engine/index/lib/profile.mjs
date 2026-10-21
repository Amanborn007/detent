import { clean } from "./sanitize.mjs";

const NAMED_SCRIPTS = ["test", "lint", "build", "start", "dev", "typecheck", "format", "check"];
const MAKE_TARGETS = new Set(["test", "lint", "build", "check", "run", "start", "fmt", "format", "all"]);
const LIST_CAP = 12;
const code = (s) => "`" + s.replace(/`/g, "'") + "`";

function jsonOf(text, notes, name) {
  try { return JSON.parse(text); } catch (e) { notes.push(`${name} is not valid JSON (${clean(e.message, 80)})`); return null; }
}

function packageJson(text, ctx) {
  const pkg = jsonOf(text, ctx.notes, "package.json");
  if (!pkg) return;
  for (const k of NAMED_SCRIPTS) {
    if (typeof pkg.scripts?.[k] === "string") ctx.commands.push(`npm run ${k}: ${code(clean(pkg.scripts[k]))}`);
  }
  if (typeof pkg.scripts?.test === "string") ctx.verify ??= "npm test";
  const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin || {});
  for (const b of bins) if (typeof b === "string") ctx.entries.push(`${clean(b, 120)} (package.json bin)`);
  if (typeof pkg.main === "string") ctx.entries.push(`${clean(pkg.main, 120)} (package.json main)`);
}

function makefile(text, ctx) {
  for (const m of text.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)) {
    if (MAKE_TARGETS.has(m[1])) {
      ctx.commands.push(`make ${m[1]}`);
      if (m[1] === "test") ctx.verify ??= "make test";
    }
  }
}

function pyproject(text, ctx) {
  let section = "";
  for (const raw of text.split("\n")) {
    const h = /^\[([^\]]+)\]\s*$/.exec(raw.trim());
    if (h) {
      section = h[1];
      const tool = /^tool\.([A-Za-z0-9_-]+)/.exec(section);
      if (tool) {
        const cmd = { pytest: "pytest", ruff: "ruff check .", mypy: "mypy .", black: "black --check ." }[tool[1]];
        if (cmd && !ctx.commands.includes(cmd)) { ctx.commands.push(cmd); if (tool[1] === "pytest") ctx.verify ??= "pytest"; }
      }
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/.exec(raw.trim());
    if (kv && /(^|\.)scripts$/.test(section)) ctx.entries.push(`${clean(kv[1], 60)} -> ${clean(kv[2], 80)} (pyproject scripts)`);
  }
}

function workflow(text, ctx) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-?\s*run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let cmd = m[1].trim();
    if (/^[|>][+-]?$/.test(cmd)) {
      cmd = "";
      for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) { cmd = lines[j].trim(); break; }
    }
    if (cmd) ctx.ci.push(code(clean(cmd)));
  }
}

export function buildProfile(paths, readText, langCounts, layout) {
  const ctx = { commands: [], ci: [], entries: [], notes: [], verify: null };
  const has = (p) => paths.includes(p);
  if (has("package.json")) packageJson(readText("package.json") ?? "", ctx);
  if (has("Makefile")) makefile(readText("Makefile") ?? "", ctx);
  if (has("pyproject.toml")) pyproject(readText("pyproject.toml") ?? "", ctx);
  if (has("go.mod")) { ctx.commands.push("go test ./..."); ctx.verify ??= "go test ./..."; }
  if (has("Cargo.toml")) { ctx.commands.push("cargo test"); ctx.verify ??= "cargo test"; }
  for (const p of paths) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) workflow(readText(p) ?? "", ctx);
    if (/^cmd\/[^/]+\/main\.go$/.test(p) || /(^|\/)__main__\.py$/.test(p)) ctx.entries.push(`${p} (entry file)`);
  }
  if (has("Dockerfile")) {
    for (const l of (readText("Dockerfile") ?? "").split("\n")) {
      if (/^\s*(CMD|ENTRYPOINT)\b/i.test(l)) ctx.entries.push(`Dockerfile ${clean(l, 120)}`);
    }
  }

  const owners = new Set();
  const co = paths.find((p) => /^(\.github\/|docs\/)?CODEOWNERS$/.test(p));
  if (co) {
    for (const l of (readText(co) ?? "").split("\n")) {
      if (l.trim().startsWith("#")) continue;
      for (const tok of l.split(/\s+/)) if (/^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(tok)) owners.add(tok);
    }
  }

  const pointers = ["CLAUDE.md", "AGENTS.md"].filter(has);
  pointers.push(...paths.filter((p) => /^README(\.[A-Za-z]+)?$/i.test(p)));
  if (paths.some((p) => p.startsWith("docs/"))) pointers.push("docs/");

  const list = (xs, empty = "none found") => (xs.length ? [...new Set(xs)].slice(0, LIST_CAP).map((x) => `- ${x}`) : [`- ${empty}`]);
  const lines = [
    "# Repo profile", "",
    "Read from the repo's own files by `detent index`. Nothing here was executed.", "",
    "## Commands", ...list(ctx.commands), "",
    "## Suggested verify", ctx.verify ? code(ctx.verify) : "none found", "",
    "## CI steps", ...list(ctx.ci), "",
    "## Languages", ...list(langCounts.map(([e, n]) => `${e}: ${n} file${n === 1 ? "" : "s"}`)), "",
    "## Layout", ...list(layout.map(([d, n]) => `${d}: ${n} file${n === 1 ? "" : "s"}`)), "",
    "## Entry points", ...list(ctx.entries), "",
    "## Owners (CODEOWNERS teams)", ...list([...owners].sort()), "",
    "## Read next", ...list(pointers), "",
  ];
  if (ctx.notes.length) lines.push("## Notes", ...ctx.notes.map((n) => `- ${n}`), "");
  return { text: lines.slice(0, 200).join("\n"), verify: ctx.verify };
}
