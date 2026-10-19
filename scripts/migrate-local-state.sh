#!/usr/bin/env bash
# migrate-local-state.sh — copy legacy ~/.detent local state into the clone.
#
# Detent's per-user local state (PR inbox, team profiles) now lives INSIDE the
# detent clone at <clone>/.local/{inbox,team-profiles} — gitignored, so the
# whole detent footprint is one directory. This script migrates the legacy
# layout:
#
#   ~/.detent/inbox         -> <clone>/.local/inbox
#   ~/.detent/team-profiles -> <clone>/.local/team-profiles
#
# COPY-ONLY and IDEMPOTENT:
#   - originals under ~/.detent are never modified or deleted (remove them
#     yourself once you have verified the copy);
#   - a destination file that already exists is never overwritten (re-running
#     is safe and reports "already present" instead of duplicating work);
#   - DETENT_INBOX_DIR still overrides the inbox location at runtime — this
#     script only fills the new DEFAULT location.
#
# Usage: scripts/migrate-local-state.sh
# Env:   DETENT_LEGACY_DIR  override the legacy dir (default ~/.detent)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETENT_ROOT="$(cd "$HERE/.." && pwd)"
LEGACY="${DETENT_LEGACY_DIR:-$HOME/.detent}"
DEST="$DETENT_ROOT/.local"

if [ ! -d "$LEGACY" ]; then
  echo "migrate-local-state: nothing to migrate — no legacy dir at $LEGACY"
  exit 0
fi

copied=0
skipped=0

copy_tree() { # $1 = subdir name (inbox | team-profiles)
  local sub="$1" src="$LEGACY/$1" rel dst
  if [ ! -d "$src" ]; then
    echo "  $sub: no legacy $src — skipping"
    return 0
  fi
  while IFS= read -r -d '' f; do
    rel="${f#"$src"/}"
    dst="$DEST/$sub/$rel"
    if [ -e "$dst" ]; then
      echo "  already present, not overwritten: .local/$sub/$rel"
      skipped=$((skipped + 1))
    else
      mkdir -p "$(dirname "$dst")"
      cp -p "$f" "$dst"
      echo "  copied: $sub/$rel -> .local/$sub/$rel"
      copied=$((copied + 1))
    fi
  done < <(find "$src" -type f -print0)
}

echo "migrate-local-state: $LEGACY -> $DEST (copy-only; originals untouched)"
mkdir -p "$DEST"
copy_tree inbox
copy_tree team-profiles

echo "migrate-local-state: done — $copied file(s) copied, $skipped already present."
if [ "$copied" -gt 0 ] || [ "$skipped" -gt 0 ]; then
  echo "Originals remain at $LEGACY — verify $DEST, then remove the legacy dir yourself."
fi
