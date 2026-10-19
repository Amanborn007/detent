#!/usr/bin/env bash
# scripts/sync-engine.sh — re-snapshot engine/ from an engine source checkout.
#
# The generic engine is maintained in a separate source checkout. This repo
# vendors a snapshot of its engine/** at engine/ so users get one
# self-contained clone (generic engine + wiring). Never edit engine/ by hand —
# change the engine upstream, then re-run this script.
#
# Usage:
#   scripts/sync-engine.sh <path-to-engine-source-checkout>
#
# Behavior:
#   - refuses a checkout whose engine/ has uncommitted changes (the snapshot must
#     be reproducible from a commit SHA)
#   - refuses to vendor anything containing a company-identifying string
#     (case-insensitive, patterns from engine/.local/denylist.txt only; exit 2
#     if that file is missing or empty) — the engine is generic and
#     company-agnostic by contract
#   - mirrors <src>/engine/ into engine/ (rsync --delete: removals upstream
#     are removals here), PROTECTING the two files that exist only in this
#     repo and never upstream: engine/ENGINE-VERSION (provenance, rewritten
#     below) and engine/.local/** (the gitignored local denylist)
#   - records the exact source commit in engine/ENGINE-VERSION

set -euo pipefail

SRC="${1:?usage: scripts/sync-engine.sh <path-to-engine-source-checkout>}"
DETENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$DETENT_ROOT/engine"

if [ ! -d "$SRC/engine" ]; then
  echo "sync-engine: no engine/ directory under $SRC — is this an engine source checkout?" >&2
  exit 1
fi

if [ -n "$(git -C "$SRC" status --porcelain -- engine 2>/dev/null)" ]; then
  echo "sync-engine: $SRC/engine has uncommitted changes; commit them upstream first (snapshot must map to a SHA)" >&2
  exit 1
fi

SHA="$(git -C "$SRC" rev-parse HEAD)"
BRANCH="$(git -C "$SRC" rev-parse --abbrev-ref HEAD)"
ORIGIN="$(git -C "$SRC" remote get-url origin 2>/dev/null || echo 'unknown')"

# Company-agnostic contract: nothing under engine/ may reference the company.
# Same mechanics as engine/scripts/company-strings-check.sh (fixed strings,
# case-insensitive, skip binaries), applied to the SOURCE tree before vendoring.
# The local denylist is the only pattern source; a missing or empty one exits 2.
LOCAL_DENYLIST="$DEST/.local/denylist.txt"
if [ ! -f "$LOCAL_DENYLIST" ]; then
  echo "sync-engine: FAIL (exit 2) — no denylist at $LOCAL_DENYLIST" >&2
  echo "sync-engine: create it with one company-identifying string per line ('#' comments ok); it is gitignored." >&2
  exit 2
fi
PATTERNS="$(grep -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' "$LOCAL_DENYLIST" || true)"
if [ -z "$PATTERNS" ]; then
  echo "sync-engine: FAIL (exit 2) — denylist at $LOCAL_DENYLIST has no patterns; an empty list would be a silent pass." >&2
  exit 2
fi
PATTERNS="$(printf '%s\n' "$PATTERNS" | sort -fu)"
set +e
OFFENDERS="$(printf '%s\n' "$PATTERNS" | grep -rliIF \
  --exclude-dir='.git' --exclude-dir='.local' \
  -f /dev/stdin "$SRC/engine")"
GREP_RC=$?
set -e
if [ "$GREP_RC" -eq 0 ]; then
  echo "sync-engine: REFUSING to vendor — company-identifying strings found under $SRC/engine" >&2
  echo "sync-engine: patterns checked (case-insensitive): $(printf '%s' "$PATTERNS" | tr '\n' ' ')" >&2
  echo "sync-engine: offending files:" >&2
  printf '%s\n' "$OFFENDERS" >&2
  echo "sync-engine: scrub these upstream (neutral placeholders like AcmeCo), then re-run." >&2
  exit 1
elif [ "$GREP_RC" -ne 1 ]; then
  echo "sync-engine: grep error while scanning $SRC/engine (rc=$GREP_RC) — refusing to proceed" >&2
  exit 1
fi

mkdir -p "$DEST"
# Protect the two receiver-only paths from --delete: ENGINE-VERSION lives only
# in this repo (rewritten below), and .local/ holds the gitignored denylist.
rsync -a --delete --exclude '.git' \
  --filter='P ENGINE-VERSION' \
  --filter='P .local/***' \
  "$SRC/engine/" "$DEST/"

cat >"$DEST/ENGINE-VERSION" <<EOF
Vendored engine snapshot (source: $ORIGIN).
  commit: $SHA
  branch: $BRANCH
  synced: $(date -u '+%Y-%m-%dT%H:%M:%SZ')

Reproduce: check out the engine source at the commit above and take engine/**.
Written by scripts/sync-engine.sh — do not edit engine/ (or this file) by hand;
re-run the script against an engine source checkout to re-snapshot.
EOF

echo "sync-engine: engine/ <- $SRC/engine @ $SHA ($BRANCH)"
echo "sync-engine: $(find "$DEST" -type f | wc -l | tr -d ' ') files vendored; ENGINE-VERSION written"
