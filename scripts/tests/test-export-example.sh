#!/usr/bin/env bash
# test-export-example.sh — scripted temp-dir test for scripts/export-example.sh.
#
# Proves, against a fake run directory with planted paths, username and host:
#   1. worktree/ and node_modules are not copied;
#   2. DETENT_ROOT, HOME (both Code/code spellings), hostname and username are
#      scrubbed from md/json/jsonl/txt/html/mjs/yaml, em dashes survive;
#   3. the run's plans/<run-id>-*.html are copied into <dest>/plans/ and scrubbed;
#   4. a leftover in a file type the rewriter skips fails the export (exit 1)
#      and the output names file:line.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPORT="$HERE/../export-example.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/export-example-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# The export runs the company-strings check; give it a synthetic denylist.
LEAK="FakeCorp""Secret"
printf '%s\n' "$LEAK" >"$TMP/denylist.txt"
export DETENT_DENYLIST="$TMP/denylist.txt"

USER_NAME="$(id -un)"
HOST_FULL="$(hostname)"
HOST_SHORT="$(hostname -s)"
ROOT="$TMP/detent-root"
RUN="$ROOT/.sdlc/demo-run-1"
mkdir -p "$RUN/worktree/src" "$RUN/node_modules/pkg" "$RUN/research" "$ROOT/.plans"

alt_home="$HOME"
case "$HOME" in
  */code/*|*/code) alt_home="${HOME//\/code/\/Code}" ;;
  */Code/*|*/Code) alt_home="${HOME//\/Code/\/code}" ;;
esac

echo "keep $USER_NAME out" >"$RUN/worktree/src/secret.txt"
echo "dep $USER_NAME" >"$RUN/node_modules/pkg/index.js"
printf '# Brief\n\nroot %s/.sdlc/demo-run-1 \xe2\x80\x94 kept\nhome %s/notes and %s/notes\nhost %s and %s\nuser %s\n' \
  "$ROOT" "$HOME" "$alt_home" "$HOST_FULL" "$HOST_SHORT" "$USER_NAME" >"$RUN/brief.md"
printf '{"path":"%s/x","by":"%s","host":"%s"}\n' "$ROOT" "$USER_NAME" "$HOST_SHORT" >"$RUN/research/state.json"
printf '{"p":"%s/a"}\n{"p":"%s/b"}\n' "$HOME" "$alt_home" >"$RUN/events.jsonl"
printf 'k: %s/z\n' "$HOME" >"$RUN/cfg.yaml"
printf '<p>%s on %s</p>\n' "$USER_NAME" "$HOST_FULL" >"$ROOT/.plans/demo-run-1-plan.html"
printf '<p>other run %s</p>\n' "$USER_NAME" >"$ROOT/.plans/other-run-plan.html"

mkdir -p "$RUN/.detent/index" "$RUN/research/.detent"
echo "map $USER_NAME" >"$RUN/.detent/index/map.md"
echo "profile $USER_NAME" >"$RUN/research/.detent/profile.md"

# --- 1-3: clean export ---
DEST="$TMP/out"
"$EXPORT" "$RUN" "$DEST" >"$TMP/log" 2>&1 || { cat "$TMP/log" >&2; fail "clean export exited non-zero"; }

[[ ! -e "$DEST/worktree" ]] || fail "worktree/ was copied"
[[ -z "$(find "$DEST" -name node_modules)" ]] || fail "node_modules was copied"
[[ -f "$DEST/brief.md" ]] || fail "brief.md missing"
if grep -rIn -e "$HOME" -e "$alt_home" -e "$USER_NAME" -e "$HOST_FULL" -e "$HOST_SHORT" "$DEST" >"$TMP/leaks"; then
  cat "$TMP/leaks" >&2; fail "leaks remain after export"
fi
grep -q '\$DETENT_ROOT/.sdlc/demo-run-1' "$DEST/brief.md" || fail "DETENT_ROOT not rewritten"
grep -q '~/notes' "$DEST/brief.md" || fail "home not rewritten to ~"
grep -q '<host>' "$DEST/brief.md" || fail "host not rewritten"
grep -q '<user>' "$DEST/brief.md" || fail "user not rewritten"
grep -q '—' "$DEST/brief.md" || fail "em dash was altered"
[[ "$(grep -c '^{"p":"~/' "$DEST/events.jsonl")" == 2 ]] || fail "jsonl home variants not both rewritten"
[[ -f "$DEST/plans/demo-run-1-plan.html" ]] || fail "plan html not copied"
[[ ! -e "$DEST/plans/other-run-plan.html" ]] || fail "unrelated plan copied"
grep -q '<user>' "$DEST/plans/demo-run-1-plan.html" || fail "plan html not scrubbed"

[[ -z "$(find "$DEST" -name .detent)" ]] || fail ".detent/ was copied"

# --- 3b: a denylisted string fails the export, naming file:line, never the text ---
printf 'one\ntwo %s\n' "$LEAK" >"$RUN/notes.txt"
DEST3="$TMP/out3"
set +e
"$EXPORT" "$RUN" "$DEST3" >"$TMP/log3" 2>&1
rc=$?
set -e
[[ "$rc" == 1 ]] || { cat "$TMP/log3" >&2; fail "expected exit 1 on denylisted string, got $rc"; }
grep -q 'notes.txt:2' "$TMP/log3" || { cat "$TMP/log3" >&2; fail "output did not list notes.txt:2"; }
grep -qiF "$LEAK" "$TMP/log3" && fail "denylisted text was printed"
rm "$RUN/notes.txt"

# --- 4: leftover in a type the rewriter skips must fail loudly ---
printf 'line one\nran by %s\n' "$USER_NAME" >"$RUN/run.log"
DEST2="$TMP/out2"
set +e
"$EXPORT" "$RUN" "$DEST2" >"$TMP/log2" 2>&1
rc=$?
set -e
[[ "$rc" == 1 ]] || fail "expected exit 1 on leftover, got $rc"
grep -q 'run.log:2' "$TMP/log2" || { cat "$TMP/log2" >&2; fail "output did not list run.log:2"; }

echo "OK: export-example"
