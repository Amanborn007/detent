#!/usr/bin/env bash
# test-sync-engine.sh — scripted temp-dir test for scripts/sync-engine.sh.
#
# Proves, against a fake source tree:
#   1. a normal sync mirrors the source (upstream deletions propagate),
#      rewrites engine/ENGINE-VERSION with the new source SHA, and PRESERVES
#      both engine/ENGINE-VERSION (not rsync-deleted mid-run) and
#      engine/.local/denylist.txt (receiver-only, never upstream);
#   2. the vendoring guard is case-insensitive: a lowercase hit against an
#      uppercase denylist pattern in the SOURCE tree is refused loudly, listing
#      the offending file;
#   3. every pattern in the local denylist is enforced (the denylist is the
#      only pattern source);
#   4. a missing or empty denylist exits 2 instead of passing silently.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/../sync-engine.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/sync-engine-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# --- fixture: fake detent checkout (script must run from ITS scripts/ dir) ---
GB="$TMP/detent"
mkdir -p "$GB/scripts" "$GB/engine/.local"
cp "$SYNC" "$GB/scripts/sync-engine.sh"
chmod +x "$GB/scripts/sync-engine.sh"
echo "OLD-PROVENANCE sha=deadbeef" >"$GB/engine/ENGINE-VERSION"
printf 'acmesecret\nPROJ-\n# a comment\n\n' >"$GB/engine/.local/denylist.txt"
echo "stale upstream-removed file" >"$GB/engine/stale.txt"

# --- fixture: fake engine source checkout ---
SRC="$TMP/src"
mkdir -p "$SRC/engine/sub"
git -C "$SRC" init -q
echo "generic engine file" >"$SRC/engine/a.txt"
echo "nested" >"$SRC/engine/sub/b.txt"
git -C "$SRC" add -A
git -C "$SRC" -c user.email=t@test -c user.name=t commit -qm "engine v1"
SHA="$(git -C "$SRC" rev-parse HEAD)"

# --- 1. clean sync: mirrors, preserves, rewrites provenance ---
out="$("$GB/scripts/sync-engine.sh" "$SRC" 2>&1)" || fail "clean sync exited nonzero: $out"
[ -f "$GB/engine/a.txt" ] || fail "a.txt not vendored"
[ -f "$GB/engine/sub/b.txt" ] || fail "sub/b.txt not vendored"
[ ! -f "$GB/engine/stale.txt" ] || fail "stale.txt survived --delete (upstream removals must propagate)"
[ -f "$GB/engine/ENGINE-VERSION" ] || fail "ENGINE-VERSION missing after sync"
grep -q "$SHA" "$GB/engine/ENGINE-VERSION" || fail "ENGINE-VERSION not rewritten with new SHA $SHA"
grep -q "deadbeef" "$GB/engine/ENGINE-VERSION" && fail "ENGINE-VERSION still has old content"
[ -f "$GB/engine/.local/denylist.txt" ] || fail "engine/.local/denylist.txt wiped by rsync --delete"
grep -q "acmesecret" "$GB/engine/.local/denylist.txt" || fail "denylist content corrupted"
grep -q "ENGINE-VERSION written" <<<"$out" || fail "script did not report ENGINE-VERSION written: $out"
echo "ok 1 - clean sync: mirror + delete propagation + ENGINE-VERSION rewrite + denylist survival"; pass=$((pass+1))

# --- 2. refusal: lowercase hit against an uppercase denylist pattern (PROJ-) ---
echo "see ticket proj-2270 for details" >"$SRC/engine/bad-lower.txt"
git -C "$SRC" add -A && git -C "$SRC" -c user.email=t@test -c user.name=t commit -qm "bad lower"
if out="$("$GB/scripts/sync-engine.sh" "$SRC" 2>&1)"; then
  fail "sync accepted a lowercase 'proj-' hit: $out"
fi
grep -q "REFUSING" <<<"$out" || fail "no loud refusal message: $out"
grep -q "bad-lower.txt" <<<"$out" || fail "offending file not listed: $out"
echo "ok 2 - case-insensitive refusal (proj-2270 vs pattern PROJ-), offender listed"; pass=$((pass+1))

# --- 3. refusal: mixed-case hit; every denylist pattern enforced ---
git -C "$SRC" rm -q engine/bad-lower.txt
echo "token AcmeSecret here" >"$SRC/engine/bad-denylist.txt"
git -C "$SRC" add -A && git -C "$SRC" -c user.email=t@test -c user.name=t commit -qm "bad mixed"
if out="$("$GB/scripts/sync-engine.sh" "$SRC" 2>&1)"; then
  fail "sync accepted a denylisted mixed-case string: $out"
fi
grep -q "bad-denylist.txt" <<<"$out" || fail "denylist pattern (acmesecret) not enforced: $out"
echo "ok 3 - mixed-case refusal against the local denylist (AcmeSecret caught)"; pass=$((pass+1))

# --- 4. no baked-in patterns: a string no denylist names must vendor cleanly ---
git -C "$SRC" rm -q engine/bad-denylist.txt
printf 'mentions widgetcorp and webhookdesk but the denylist does not\n' >"$SRC/engine/neutral.txt"
git -C "$SRC" add -A && git -C "$SRC" -c user.email=t@test -c user.name=t commit -qm "neutral"
out="$("$GB/scripts/sync-engine.sh" "$SRC" 2>&1)" || fail "sync refused a string absent from the denylist: $out"
[ -f "$GB/engine/neutral.txt" ] || fail "neutral.txt not vendored"
echo "ok 4 - denylist is the only pattern source (no hardcoded list)"; pass=$((pass+1))

# --- 5. missing / empty denylist: exit 2, loud ---
rm -f "$GB/engine/.local/denylist.txt"
rc=0; out="$("$GB/scripts/sync-engine.sh" "$SRC" 2>&1)" || rc=$?
[ "$rc" -eq 2 ] || fail "missing denylist: expected exit 2, got $rc: $out"
grep -q "denylist" <<<"$out" || fail "missing-denylist message does not name the denylist: $out"
printf '# only a comment\n\n' >"$GB/engine/.local/denylist.txt"
rc=0; out="$("$GB/scripts/sync-engine.sh" "$SRC" 2>&1)" || rc=$?
[ "$rc" -eq 2 ] || fail "empty denylist: expected exit 2, got $rc: $out"
echo "ok 5 - missing and empty denylist exit 2"; pass=$((pass+1))

echo "test-sync-engine: all $pass tests passed"
