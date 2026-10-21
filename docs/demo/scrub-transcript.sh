#!/usr/bin/env bash
# scrub-transcript.sh <in.jsonl> <out.jsonl> <prompt> — make a `claude -p --output-format stream-json` capture publishable.
# Keeps user, assistant and result events (no system, hook or thinking events), opens with the prompt, rewrites machine
# paths the way scripts/export-example.sh does, then runs engine/scripts/company-strings-check.sh over the output.
#   SCRUB_PLUGIN_ROOT  checkout the plugin was loaded from (default: this repo)    -> ${CLAUDE_PLUGIN_ROOT}
#   SCRUB_WORK_ROOT    throwaway demo dir the session ran in (default: $DEMO_TMP)  -> $DEMO_TMP
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: $0 <in.jsonl> <out.jsonl> <prompt>" >&2; exit 2; }
IN="$1"; OUT="$2"; PROMPT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="${SCRUB_PLUGIN_ROOT:-$(cd "$HERE/../.." && pwd)}"
WORK_ROOT="${SCRUB_WORK_ROOT:-${DEMO_TMP:-}}"
[[ -n "$WORK_ROOT" ]] || { echo "scrub-transcript: set SCRUB_WORK_ROOT or DEMO_TMP to the directory the session ran in" >&2; exit 2; }
[[ ! -e "$OUT" ]] || { echo "scrub-transcript: $OUT already exists" >&2; exit 2; }

PROMPT="$PROMPT" node -e '
const fs = require("fs");
const clean = (v) => (typeof v === "string" ? v.replace(/^Now using node .*\n/gm, "")
  : Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v);
const rows = [{ type: "user", message: { role: "user", content: process.env.PROMPT } }];
fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).forEach((raw, i) => {
  let ev;
  try { ev = JSON.parse(raw); } catch (e) { throw new Error(`${process.argv[1]} line ${i + 1} is not JSON: ${e.message}`); }
  if (!["user", "assistant", "result"].includes(ev.type)) return;
  if (ev.message && Array.isArray(ev.message.content)) ev.message.content = ev.message.content.filter((b) => b.type !== "thinking");
  if (ev.type === "assistant" && ev.message.content.length === 0) return;
  rows.push(clean(ev));
});
fs.writeFileSync(process.argv[2], rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
' "$IN" "$OUT"

# macOS spells the same path .../code/... and .../Code/..., and /tmp or /var also as /private/...
variants() {
  printf '%s\n' "$1"
  local flipped
  flipped="${1//\/code/\/__C__}"; flipped="${flipped//\/Code/\/code}"; flipped="${flipped//\/__C__/\/Code}"
  [[ "$flipped" == "$1" ]] || printf '%s\n' "$flipped"
  return 0
}
PAIRS=()
add() { while IFS= read -r v; do PAIRS+=("$v"$'\t'"$2"); done < <(variants "$1"); }
add "$PLUGIN_ROOT" '${CLAUDE_PLUGIN_ROOT}'
[[ "$WORK_ROOT" == /var/* || "$WORK_ROOT" == /tmp/* ]] && add "/private$WORK_ROOT" '$DEMO_TMP'
add "$WORK_ROOT" '$DEMO_TMP'
add "$HOME" '~'
PAIRS+=("$(hostname)"$'\t''<host>')
[[ "$(hostname -s)" == "$(hostname)" ]] || PAIRS+=("$(hostname -s)"$'\t''<host>')
PAIRS+=("$(id -un)"$'\t''<user>')
for pair in "${PAIRS[@]}"; do
  FROM="${pair%%$'\t'*}" TO="${pair#*$'\t'}" perl -0pi -e 'my $p = quotemeta($ENV{FROM}); $p =~ s{\\/}{/+}g; s/$p/$ENV{TO}/g' "$OUT"
done

left=0
for needle in "$HOME" "$(id -un)" "$(hostname -s)"; do
  if grep -nF -- "$needle" "$OUT" | cut -d: -f1 | sed "s|^|scrub-transcript: $OUT:|" | grep .; then left=1; fi
done
[[ "$left" -eq 0 ]] || { echo "scrub-transcript: machine detail is still present (file:line above)" >&2; exit 1; }

CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/scrub-check.XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
cp "$OUT" "$CHECK_DIR/"
bash "$HERE/../../engine/scripts/company-strings-check.sh" --dir "$CHECK_DIR" --paths-only || { echo "scrub-transcript: denylisted string in $OUT" >&2; exit 1; }
