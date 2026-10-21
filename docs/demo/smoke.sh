#!/usr/bin/env bash
# Replays the demo against the real engine and fails on any unexpected `ok`. Offline: no network, no LLM.
set -u
command -v curator >/dev/null 2>&1 || { echo "smoke.sh needs curator on PATH (see docs/demo/README.md)" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
export DEMO_TMP="$(mktemp -d "${TMPDIR:-/tmp}/detent-demo.XXXXXX")"
trap 'rm -rf "$DEMO_TMP"' EXIT
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
  echo "smoke FAILED: ok values differ" >&2
  printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
  exit 1
fi
html="$(echo "$DETENT_ROOT"/.plans/*-intent.html)"
[ -s "$html" ] || { echo "smoke FAILED: gate page missing: $html" >&2; exit 1; }
bash "$here/terminal-smoke.sh" || exit 1
echo "smoke ok"
