#!/usr/bin/env bash
# Smoke test: repo-docs-knowledge adapter against a freshly cloned public repo (cli/cli).
# Requires: git, node. Clones shallow into a temp dir.
set -euo pipefail
ADAPTER="$(cd "$(dirname "$0")/.." && pwd)/repo-docs-knowledge"

WORK="${TMPDIR:-/tmp}/rdk-smoke.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
git clone --depth 1 --quiet https://github.com/cli/cli "$WORK/cli"

echo "--- repo-docs-knowledge: query 'installation' in cli/cli docs ---"
OUT=$(printf '{"query":"installation","repo_path":"%s"}' "$WORK/cli" | "$ADAPTER")
echo "$OUT" | head -c 1200; echo
node -e '
const o = JSON.parse(process.argv[1]);
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (o.provider !== "repo-docs") fail("provider must be repo-docs, got " + o.provider);
if (!Array.isArray(o.results)) fail("results must be an array");
if (o.results.length === 0) fail("expected at least one hit for installation in cli/cli");
const r = o.results[0];
if (!r.source || !r.excerpt) fail("result missing source/excerpt");
if (typeof r.confidence !== "number") fail("result missing numeric confidence");
if (!o.next_step) fail("missing next_step hint");
console.error("PASS: happy path (" + o.results.length + " hits)");
' "$OUT"

echo "--- repo-docs-knowledge: empty result set is still exit 0 ---"
OUT2=$(printf '{"query":"zzqxjv-no-such-token","repo_path":"%s"}' "$WORK/cli" | "$ADAPTER")
node -e '
const o = JSON.parse(process.argv[1]);
if (!Array.isArray(o.results) || o.results.length !== 0) { console.error("FAIL: expected empty results"); process.exit(1); }
console.error("PASS: empty results, exit 0");
' "$OUT2"

echo "--- repo-docs-knowledge: missing repo_path must exit 2 ---"
set +e
echo '{"query":"x"}' | "$ADAPTER" >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -eq 2 ] || { echo "FAIL: expected exit 2, got $RC"; exit 1; }
echo "PASS: exit 2 on contract violation"

echo "ALL PASS: repo-docs-knowledge"
