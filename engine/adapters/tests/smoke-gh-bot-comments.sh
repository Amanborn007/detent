#!/usr/bin/env bash
# Smoke test: gh-bot-comments adapter against a public PR on cli/cli.
# Requires: gh (authenticated), node.
set -euo pipefail
ADAPTER="$(cd "$(dirname "$0")/.." && pwd)/gh-bot-comments"

# cli/cli PR with both human and bot activity; adjust if it ever 404s.
PR_JSON='{"repo":"cli/cli","number":9088}'

echo "--- gh-bot-comments: happy path ($PR_JSON) ---"
OUT=$(echo "$PR_JSON" | "$ADAPTER")
echo "$OUT" | head -c 1500; echo
node -e '
const o = JSON.parse(process.argv[1]);
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (!o.pr) fail("missing pr");
if (!Array.isArray(o.comments)) fail("comments must be an array");
for (const c of o.comments) {
  if (!["bot","human"].includes(c.author_type)) fail("bad author_type: " + c.author_type);
  if (!["actionable","informational"].includes(c.classification)) fail("bad classification: " + c.classification);
  if (!c.author || !c.excerpt) fail("comment missing author/excerpt");
}
if (!o.counts || typeof o.counts.bot !== "number" || typeof o.counts.human !== "number") fail("missing counts");
if (!o.next_step) fail("missing next_step hint");
console.error("PASS: " + o.comments.length + " comments, " + o.counts.bot + " bot / " + o.counts.human + " human");
' "$OUT"

echo "--- gh-bot-comments: invalid input must exit 2 ---"
set +e
echo '{}' | "$ADAPTER" >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -eq 2 ] || { echo "FAIL: expected exit 2, got $RC"; exit 1; }
echo "PASS: exit 2 on contract violation"

echo "ALL PASS: gh-bot-comments"
