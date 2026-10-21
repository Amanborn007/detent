#!/usr/bin/env bash
# company-strings-check.sh — leak guard for company-identifying strings.
#
# The engine layer is destined to be public: no company names, internal
# hostnames, or other company-identifying strings may appear in it. Each
# company maintains its OWN denylist locally at engine/.local/denylist.txt
# (gitignored — the denylist itself is company-identifying and must never be
# committed).
#
# Usage: company-strings-check.sh [--repo | --dir <path>] [--paths-only]
#   --repo         scan the whole repo (default: engine/ only); .git, .local
#                  and node_modules are always skipped
#   --dir <path>   scan an arbitrary directory (paths print relative to it); used
#                  by scripts/export-example.sh on its output
#   --paths-only   print only file:line for each hit, never the matched text
#                  (for CI logs, where the denylist is a secret)
#
# DETENT_DENYLIST overrides the denylist path (default engine/.local/denylist.txt).
#
# Denylist format: one fixed-string pattern per line; blank lines and lines
# starting with '#' are ignored. Matching is case-insensitive.
#
# Allowlist: an optional <repo>/.leakgate-allow lists one path glob per line
# (relative to the repo root, '*' crosses '/'); matching files are not
# reported.
#
# Exit codes:
#   0  clean
#   1  violations found
#   2  misconfiguration (denylist missing or empty, bad flag) — never a silent pass
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$ENGINE_DIR/.." && pwd)"
DENYLIST="${DETENT_DENYLIST:-$ENGINE_DIR/.local/denylist.txt}"
ALLOWLIST="$REPO_ROOT/.leakgate-allow"

SCAN_DIR="$ENGINE_DIR"
SCOPE="engine/"
PATHS_ONLY=0
REL_BASE="$REPO_ROOT"
while [ $# -gt 0 ]; do
  arg="$1"; shift
  case "$arg" in
    --repo) SCAN_DIR="$REPO_ROOT"; SCOPE="repo" ;;
    --dir)
      if [ $# -eq 0 ] || [ ! -d "$1" ]; then
        echo "company-strings-check: FAIL (exit 2) — --dir needs an existing directory" >&2; exit 2
      fi
      SCAN_DIR="$(cd "$1" && pwd)"; REL_BASE="$SCAN_DIR"; SCOPE="dir"; shift ;;
    --paths-only) PATHS_ONLY=1 ;;
    *) echo "company-strings-check: FAIL (exit 2) — unknown argument '$arg' (usage: [--repo | --dir <path>] [--paths-only])" >&2; exit 2 ;;
  esac
done

if [ ! -f "$DENYLIST" ]; then
  echo "company-strings-check: FAIL (exit 2) — no denylist at $DENYLIST" >&2
  echo "Create it with one company-identifying string per line ('#' comments ok)." >&2
  echo "It is gitignored on purpose; never commit it." >&2
  exit 2
fi

PATTERNS="$(grep -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' "$DENYLIST" || true)"
if [ -z "$PATTERNS" ]; then
  echo "company-strings-check: FAIL (exit 2) — denylist at $DENYLIST has no patterns." >&2
  echo "An empty denylist would be a silent pass; add your company strings." >&2
  exit 2
fi

ALLOW_GLOBS=()
if [ -f "$ALLOWLIST" ]; then
  while IFS= read -r g; do
    [ -n "$g" ] && ALLOW_GLOBS+=("$g")
  done < <(grep -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' "$ALLOWLIST" || true)
fi

is_allowed() {
  local g
  for g in ${ALLOW_GLOBS[@]+"${ALLOW_GLOBS[@]}"}; do
    # shellcheck disable=SC2053
    [[ "$1" == $g ]] && return 0
  done
  return 1
}

# Fixed strings, case-insensitive, skip binaries.
set +e
RAW="$(printf '%s\n' "$PATTERNS" | grep -rinIF \
  --exclude-dir='.local' \
  --exclude-dir='.git' \
  --exclude='.git' \
  --exclude-dir='node_modules' \
  -f /dev/stdin "$SCAN_DIR")"
RC=$?
set -e

if [ "$RC" -gt 1 ]; then
  echo "company-strings-check: FAIL (exit 2) — grep error (rc=$RC)" >&2
  exit 2
fi

HITS=""
if [ "$RC" -eq 0 ]; then
  while IFS= read -r l; do
    path="${l%%:*}"
    rest="${l#*:}"
    rel="${path#"$REL_BASE"/}"
    is_allowed "$rel" && continue
    if [ "$PATHS_ONLY" -eq 1 ]; then
      HITS+="$rel:${rest%%:*}"$'\n'
    else
      HITS+="$rel:$rest"$'\n'
    fi
  done <<<"$RAW"
fi

if [ -n "$HITS" ]; then
  echo "company-strings-check: FAIL (exit 1) — denylisted strings found:" >&2
  printf '%s' "$HITS"
  echo "next_step: scrub the lines above (use a neutral placeholder like AcmeCo), then re-run." >&2
  exit 1
fi

echo "company-strings-check: OK — $SCOPE scope is clean against $(printf '%s\n' "$PATTERNS" | wc -l | tr -d ' ') pattern(s)."
