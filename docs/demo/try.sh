#!/usr/bin/env bash
# Runs the real engine from `detent setup` to the plan gate on a throwaway repo. Offline: no network, no LLM, no curator.
# No `set -e`: the plan stage exits non-zero when it holds at the gate, and the check at the end covers every step.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/demo-env.sh" || exit 1

detent setup --repo . | say setup
detent run new --ticket acme/widgets#1 --repo . | say run
stages
detent gate open intent | say gate

expected='setup true
run true
ticket true
intake true
research true
plan held
gate true'
actual="$(cat "$DEMO_TMP/oks.log")"
if [ "$actual" != "$expected" ]; then
  echo "try.sh FAILED: a step did not report what was expected" >&2
  printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
  exit 1
fi
page="$(echo "$DETENT_ROOT"/.plans/*-intent.html)"
[ -s "$page" ] || { echo "try.sh FAILED: gate page missing: $page" >&2; exit 1; }
echo
echo "gate page: $page"
echo "scratch dir to delete when you are done: $DEMO_TMP"
