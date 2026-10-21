#!/usr/bin/env bash
# Sourced by demo.tape and smoke.sh. Builds a throwaway work repo and detent home, then defines the demo helpers.
DEMO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
DEMO_TMP="${DEMO_TMP:-$(mktemp -d "${TMPDIR:-/tmp}/detent-demo.XXXXXX")}"
[ -n "$DEMO_TMP" ] || return 1
export DEMO_TMP DEMO_SRC
FIX="$DEMO_SRC/docs/demo/fixtures"
mkdir -p "$DEMO_TMP/repo"
git -C "$DEMO_TMP/repo" init -q
git -C "$DEMO_TMP/repo" config user.name "Demo User"
git -C "$DEMO_TMP/repo" config user.email "demo@example.com"
git -C "$DEMO_TMP/repo" commit -q --allow-empty -m init
export DETENT_ROOT="$DEMO_TMP/home"
mkdir -p "$DETENT_ROOT"
export DETENT_GH_CMD="$FIX/stub-gh"
: > "$DEMO_TMP/oks.log"
echo '{"ticket_ref":"acme/widgets#1"}' > "$DEMO_TMP/ticket.json"

# The real engine. After a successful `setup`, point the ticket socket at the offline stub so the demo needs no network.
detent() {
  local o rc
  o=$(node "$DEMO_SRC/engine/cli/engine.mjs" "$@"); rc=$?
  if [ "$1" = setup ] && [ $rc -eq 0 ]; then
    node -e 'const fs=require("fs"),[f,cmd]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^( *command: ).*gh-ticket.*$/m,(_,p)=>p+JSON.stringify(cmd)))' "$DEMO_TMP/repo/stack.yaml" "$FIX/stub-ticket" || return 1
  fi
  printf '%s\n' "$o"
  return $rc
}
# Engine JSON on stdin -> one human line. See say.mjs.
say() { node "$DEMO_SRC/docs/demo/say.mjs" "$@"; }

# Stands in for Claude: writes each stage's artifact from docs/demo/fixtures, and every transition is the real engine.
stages() {
  detent socket call ticket --payload-file "$DEMO_TMP/ticket.json" | say ticket
  local run; run="$(echo "$DETENT_ROOT"/.sdlc/*)"
  detent stage begin intake >/dev/null || return 1
  cp "$FIX/brief.md" "$run/brief.md"
  detent stage end intake | say intake brief.md
  detent stage begin research >/dev/null || return 1
  cp "$FIX/research.md" "$FIX/access-report.json" "$run/"
  detent stage end research | say research "research.md, access-report.json"
  detent stage begin plan >/dev/null || return 1
  mkdir -p "$run/plan" && cp "$FIX/plan.md" "$run/plan/plan.md"
  detent stage end plan | say plan
  return 0
}
export PS1='$ '
cd "$DEMO_TMP/repo" || return 1
