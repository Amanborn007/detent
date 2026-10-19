#!/usr/bin/env bash
# Smoke test: gh-ticket adapter against a public repo (cli/cli issue #1).
# Requires: gh (authenticated), node.
set -euo pipefail
ADAPTER="$(cd "$(dirname "$0")/.." && pwd)/gh-ticket"

echo "--- gh-ticket: happy path (cli/cli#9008) ---"
OUT=$(echo '{"repo":"cli/cli","number":9008}' | "$ADAPTER")
echo "$OUT"
node -e '
const o = JSON.parse(process.argv[1]);
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (!o.id) fail("missing id");
if (!o.title) fail("missing title");
if (!o.status) fail("missing status");
if (!o.url || !o.url.includes("github.com")) fail("missing/bad url");
if (!o.next_step) fail("missing next_step hint");
console.error("PASS: happy path");
' "$OUT"

echo "--- gh-ticket: invalid input must exit 2 ---"
set +e
echo 'not json' | "$ADAPTER" >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -eq 2 ] || { echo "FAIL: expected exit 2 on bad input, got $RC"; exit 1; }
echo "PASS: exit 2 on invalid input"

echo "ALL PASS: gh-ticket"
