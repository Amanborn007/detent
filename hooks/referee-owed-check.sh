#!/bin/bash
# Stop hook — durable fallback for the referee auto-review.
#
# The PostToolUse directive that asks the session to run `referee` is advisory
# and is lost if the session ends right after the push (no model turn follows).
# sentinel-autoscan records every dispatched review durably in each PR inbox's
# `referee-owed` (TSV: ts, pr_url, head_sha). referee appends the head SHA to a
# sibling `referee-done` when it completes a review. This hook surfaces
# owed-minus-done once, so a review is never silently dropped.
#
# Conservative by construction: self-disables in background jobs and on the
# re-stop after its own block (stop_hook_active), and only considers owed files
# touched in the last day so stale/merged PRs stop nagging.
[ "${PR_AUTOREVIEW:-on}" = "off" ] && exit 0
[ "${REFEREE_AUTOREVIEW:-on}" = "off" ] && exit 0
[ -n "$CLAUDE_JOB_DIR" ] && exit 0            # headless/overnight drives referee itself

payload="$(cat)"
[ "$(jq -r '.stop_hook_active // false' <<<"$payload" 2>/dev/null)" = "true" ] && exit 0

BASE="${DETENT_INBOX_DIR:-${DETENT_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}/.local/inbox}"
[ -d "$BASE" ] || exit 0

pending=""
count=0
while IFS= read -r owed; do
  [ -f "$owed" ] || continue
  donef="$(dirname "$owed")/referee-done"
  while IFS=$'\t' read -r _ts pr sha; do
    [ -n "$pr" ] && [ -n "$sha" ] || continue
    if [ -f "$donef" ] && grep -qF "$sha" "$donef" 2>/dev/null; then continue; fi
    pending="${pending}- ${pr} (head ${sha})"$'\n'
    count=$((count + 1))
  done < "$owed"
done < <(find "$BASE" -mindepth 2 -maxdepth 2 -name referee-owed -mtime -1 2>/dev/null)

[ "$count" -gt 0 ] || exit 0

reason="$count referee review(s) were dispatched by the detent hook this session but not confirmed run (the push-time reminder can be missed if the turn ended right after the push). Run the \`referee\` skill on each open PR below. When a review completes, referee records the head SHA in that PR inbox's \`referee-done\` and this stops reminding. If you have already reviewed these, note that and re-stop.

$pending"
jq -cn --arg r "$reason" '{decision:"block",reason:$r}'
exit 0
