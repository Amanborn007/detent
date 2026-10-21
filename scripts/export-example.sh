#!/usr/bin/env bash
# export-example.sh — copy a finished run directory into a publishable folder.
#
# Usage: scripts/export-example.sh <run-dir> <dest-dir>
#
# Copies the run directory without worktree/, node_modules and .detent/ (the repo index), copies the
# run's plans (<DETENT_ROOT>/.plans/<run-id>-*.html) into <dest>/plans/, then
# rewrites text files so the output holds no machine-specific detail:
#   DETENT_ROOT path -> $DETENT_ROOT      home directory -> ~
#   hostname         -> <host>            local username -> <user>
# Em dashes in the run data are left alone. After rewriting, the script exits 1
# and lists file:line if the home path, username or hostname still appear in
# any text file. It then runs engine/scripts/company-strings-check.sh over the
# destination and exits 1 on any denylisted string (file:line only, never the text).
#
#   Env override:
#     DETENT_ROOT   the root that holds the run (default: the nearest ancestor of
#                   the run dir with a .plans/ folder, else the run dir's parent)
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <run-dir> <dest-dir>" >&2
  exit 2
fi

RUN="$(cd "$1" && pwd)"
DEST="$2"
RUN_ID="$(basename "$RUN")"
if [[ -z "${DETENT_ROOT:-}" ]]; then
  DETENT_ROOT="$(dirname "$RUN")"
  d="$DETENT_ROOT"
  while [[ "$d" != "/" ]]; do
    [[ -d "$d/.plans" ]] && { DETENT_ROOT="$d"; break; }
    d="$(dirname "$d")"
  done
fi
ROOT="$(cd "$DETENT_ROOT" && pwd)"
USER_NAME="$(id -un)"
HOST_FULL="$(hostname)"
HOST_SHORT="$(hostname -s)"

[[ ! -e "$DEST" ]] || { echo "export-example: $DEST already exists" >&2; exit 2; }
mkdir -p "$DEST/plans"

echo "export-example: $RUN -> $DEST"
rsync -a --exclude 'worktree/' --exclude 'node_modules/' --exclude '.detent/' "$RUN/" "$DEST/"
for plan in "$ROOT/.plans/$RUN_ID"-*.html; do
  [[ -f "$plan" ]] && cp "$plan" "$DEST/plans/"
done

# macOS paths show up as both .../code/... and .../Code/...; flip every
# segment spelling so both forms of a path are matched.
variants() {
  printf '%s\n' "$1"
  local flipped
  flipped="${1//\/code/\/__C__}"; flipped="${flipped//\/Code/\/code}"; flipped="${flipped//\/__C__/\/Code}"
  [[ "$flipped" == "$1" ]] || printf '%s\n' "$flipped"
  return 0
}

# Longest match first so a root under $HOME becomes $DETENT_ROOT, not ~/...
PAIRS=()
# macOS also spells /var and /tmp paths through their /private alias.
ROOTS=("$ROOT")
[[ "$ROOT" == /var/* || "$ROOT" == /tmp/* ]] && ROOTS+=("/private$ROOT")
for r in "${ROOTS[@]}"; do
  while IFS= read -r v; do PAIRS+=("$v"$'\t''$DETENT_ROOT'); done < <(variants "$r")
done
while IFS= read -r v; do PAIRS+=("$v"$'\t''~'); done < <(variants "$HOME")
PAIRS+=("$HOST_FULL"$'\t''<host>')
[[ "$HOST_SHORT" == "$HOST_FULL" ]] || PAIRS+=("$HOST_SHORT"$'\t''<host>')
PAIRS+=("$USER_NAME"$'\t''<user>')

scrub() {
  local pair from to
  for pair in "${PAIRS[@]}"; do
    from="${pair%%$'\t'*}"; to="${pair#*$'\t'}"
    # A path can be written with doubled slashes (a TMPDIR or DETENT_ROOT ending in /).
    FROM="$from" TO="$to" perl -0pi -e 'my $p = quotemeta($ENV{FROM}); $p =~ s{\\/}{/+}g; s/$p/$ENV{TO}/g' "$1"
  done
}

while IFS= read -r -d '' f; do
  scrub "$f"
done < <(find "$DEST" -type f \( -name '*.md' -o -name '*.json' -o -name '*.jsonl' \
  -o -name '*.txt' -o -name '*.html' -o -name '*.mjs' -o -name '*.yaml' \) -print0)

# Check every text file, including types the rewriter skips.
status=0
for needle in "$HOME" "$USER_NAME" "$HOST_FULL" "$HOST_SHORT"; do
  while IFS=: read -r file line _; do
    echo "LEAK: ${file#"$DEST"/}:$line still holds the home path, username or hostname" >&2
    status=1
  done < <(grep -rInF -e "$needle" "$DEST" || true)
done
if [[ $status -ne 0 ]]; then
  echo "export-example: leftovers found, do not publish $DEST" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! bash "$HERE/../engine/scripts/company-strings-check.sh" --dir "$DEST" --paths-only >&2; then
  echo "export-example: company-identifying strings found, do not publish $DEST" >&2
  exit 1
fi
echo "export-example: done, no leftovers"
