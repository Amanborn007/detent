#!/usr/bin/env bash
# Sourced by terminal.tape and terminal-smoke.sh. A throwaway clone of acme/widgets, a throwaway detent home, and
# `detent` pointed at this checkout. Stand-ins: claude, gh and the ticket socket (all offline); the engine is real.
DEMO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
DEMO_TMP="${DEMO_TMP:-$(mktemp -d "${TMPDIR:-/tmp}/detent-term.XXXXXX")}"
[ -n "$DEMO_TMP" ] || return 1
export DEMO_TMP DEMO_SRC
FIX="$DEMO_SRC/docs/demo/fixtures"
mkdir -p "$DEMO_TMP/repo" "$DEMO_TMP/home"
export ENGINE_CLAUDE_BIN="$FIX/stub-claude.mjs" DETENT_ROOT="$DEMO_TMP/home" DETENT_GH_CMD="$FIX/stub-gh-term" DETENT_INDEX_TAGGER=regex
export GIT_AUTHOR_NAME="Demo User" GIT_AUTHOR_EMAIL="demo@example.com" GIT_COMMITTER_NAME="Demo User" GIT_COMMITTER_EMAIL="demo@example.com"
git -C "$DEMO_TMP/repo" init -q
printf '{"name":"widgets","scripts":{"test":"node --test"}}\n' > "$DEMO_TMP/repo/package.json"
printf 'export function retryDelay(retryAfter) {\n  return retryAfter * 1000;\n}\n' > "$DEMO_TMP/repo/retry.mjs"
git -C "$DEMO_TMP/repo" add -A
git -C "$DEMO_TMP/repo" commit -q -m "widgets: retry delay"
git -C "$DEMO_TMP/repo" remote add origin https://github.com/acme/widgets.git

# After start has run setup, swap the ticket socket for the offline stub and give drive the stack it reads from $DETENT_ROOT.
detent() {
  node "$DEMO_SRC/engine/cli/detent.mjs" "$@"
  local rc=$?
  if [ "$1" = start ] && [ -f "$DEMO_TMP/repo/stack.yaml" ]; then
    node -e 'const fs=require("fs"),[f,cmd]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^( *command: ).*gh-ticket.*$/m,(_,p)=>p+JSON.stringify(cmd)))' "$DEMO_TMP/repo/stack.yaml" "$FIX/stub-ticket" || return 1
    cp "$DEMO_TMP/repo/stack.yaml" "$DETENT_ROOT/stack.yaml"
  fi
  return $rc
}
unset CLAUDECODE DETENT_DRIVE_CHILD
export PATH="$FIX/bin:$PATH"
export PS1='$ '
cd "$DEMO_TMP/repo" || return 1
