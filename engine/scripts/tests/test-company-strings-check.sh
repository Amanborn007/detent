#!/usr/bin/env bash
# Test: company-strings-check.sh in engine scope, whole-repo scope (--repo),
# --paths-only, and the .leakgate-allow allowlist. Runs a copy of the script
# inside a throwaway fake repo with a synthetic denylist, so the real tree and
# the real denylist are never read.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REAL_CHECK="$HERE/../company-strings-check.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/csc-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

REPO="$TMP/repo"
mkdir -p "$REPO/engine/scripts" "$REPO/engine/.local" "$REPO/docs"
cp "$REAL_CHECK" "$REPO/engine/scripts/company-strings-check.sh"
CHECK="$REPO/engine/scripts/company-strings-check.sh"
DENYLIST="$REPO/engine/.local/denylist.txt"

P1="FakeCorp""Secret"
P2="internal.fakecorp"".example"
printf '# synthetic\n%s\n%s\n' "$P1" "$P2" >"$DENYLIST"

run() { RC=0; OUT="$("$@" 2>&1)" || RC=$?; }

echo "--- engine scope: clean tree passes ---"
echo "generic" >"$REPO/engine/a.txt"
run "$CHECK"; [ "$RC" -eq 0 ] || fail "clean tree flagged (rc=$RC): $OUT"
echo "PASS"

echo "--- engine scope: violation exits 1 and prints the offending line ---"
printf 'connect to %s please\n' "$P2" >"$REPO/engine/bad.txt"
run "$CHECK"; [ "$RC" -eq 1 ] || fail "expected exit 1, got $RC: $OUT"
grep -qF "$P2" <<<"$OUT" || fail "offending line not printed: $OUT"
rm "$REPO/engine/bad.txt"
echo "PASS"

echo "--- engine scope ignores files outside engine/ ---"
printf 'x %s\n' "$P1" >"$REPO/docs/outside.md"
run "$CHECK"; [ "$RC" -eq 0 ] || fail "engine scope flagged docs/ (rc=$RC): $OUT"
echo "PASS"

echo "--- --repo scope catches files outside engine/ ---"
run "$CHECK" --repo; [ "$RC" -eq 1 ] || fail "--repo expected exit 1, got $RC: $OUT"
grep -q "docs/outside.md" <<<"$OUT" || fail "--repo did not name docs/outside.md: $OUT"
echo "PASS"

echo "--- --repo scope excludes .git, .local, node_modules ---"
rm "$REPO/docs/outside.md"
mkdir -p "$REPO/.git" "$REPO/.local" "$REPO/node_modules/pkg"
for d in .git .local node_modules/pkg; do printf '%s\n' "$P1" >"$REPO/$d/f.txt"; done
run "$CHECK" --repo; [ "$RC" -eq 0 ] || fail "excluded dirs were scanned (rc=$RC): $OUT"
echo "PASS"

echo "--- --repo scope skips a worktree's .git pointer file ---"
WT="$TMP/worktree"
mkdir -p "$WT/engine/scripts" "$WT/engine/.local"
cp "$REAL_CHECK" "$WT/engine/scripts/company-strings-check.sh"
cp "$DENYLIST" "$WT/engine/.local/denylist.txt"
printf 'gitdir: /home/%s/repo/.git/worktrees/x\n' "$P1" >"$WT/.git"
run "$WT/engine/scripts/company-strings-check.sh" --repo
[ "$RC" -eq 0 ] || fail "worktree .git pointer file was scanned (rc=$RC): $OUT"
echo "PASS"

echo "--- --paths-only prints file:line and never the matched content ---"
printf 'line one\nsecret is %s here\n' "$P1" >"$REPO/docs/leak.md"
run "$CHECK" --repo --paths-only; [ "$RC" -eq 1 ] || fail "--paths-only expected exit 1, got $RC: $OUT"
grep -q "^docs/leak.md:2$" <<<"$OUT" || fail "expected 'docs/leak.md:2' line: $OUT"
grep -qiF "$P1" <<<"$OUT" && fail "--paths-only leaked matched content: $OUT"
grep -qiF "$P2" <<<"$OUT" && fail "--paths-only leaked a pattern: $OUT"
echo "PASS"

echo "--- .leakgate-allow suppresses matching globs only ---"
mkdir -p "$REPO/skills/deferred/deep"
printf '%s\n' "$P1" >"$REPO/skills/deferred/deep/x.md"
printf '%s\n' "$P1" >"$REPO/README.md"
printf '# deferred files\n\nREADME.md\nskills/deferred/**\n' >"$REPO/.leakgate-allow"
run "$CHECK" --repo --paths-only; [ "$RC" -eq 1 ] || fail "docs/leak.md must still fail (rc=$RC): $OUT"
grep -q "^docs/leak.md:2$" <<<"$OUT" || fail "unallowlisted hit missing: $OUT"
grep -q "README.md" <<<"$OUT" && fail "allowlisted README.md reported: $OUT"
grep -q "skills/deferred" <<<"$OUT" && fail "allowlisted glob reported: $OUT"
rm "$REPO/docs/leak.md"
run "$CHECK" --repo; [ "$RC" -eq 0 ] || fail "allowlisted-only tree should pass (rc=$RC): $OUT"
echo "PASS"

echo "--- unknown flag exits 2 ---"
run "$CHECK" --nope; [ "$RC" -eq 2 ] || fail "expected exit 2 for unknown flag, got $RC: $OUT"
echo "PASS"

echo "--- missing denylist exits 2 ---"
mv "$DENYLIST" "$DENYLIST.bak"
run "$CHECK" --repo; [ "$RC" -eq 2 ] || fail "missing denylist: expected exit 2, got $RC: $OUT"
echo "PASS"

echo "--- comments-only denylist exits 2 ---"
printf '# nothing\n\n' >"$DENYLIST"
run "$CHECK" --repo; [ "$RC" -eq 2 ] || fail "empty denylist: expected exit 2, got $RC: $OUT"
echo "PASS"

echo "ALL PASS: company-strings-check"
