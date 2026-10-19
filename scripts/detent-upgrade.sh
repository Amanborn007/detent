#!/usr/bin/env bash
# detent-upgrade.sh — upgrade BOTH halves of a detent install in one command.
#
# Why this exists: a detent install is two physical copies —
#   1. the Claude Code PLUGIN (skills + hooks + the in-session engine that
#      skills call via $CLAUDE_PLUGIN_ROOT), served from the `detent`
#      marketplace and cached under ~/.claude/plugins/cache/, and
#   2. the SHELL CLONE at $DETENT_ROOT (the `detent`/`curator`/`engine`/`sentinel`
#      CLIs on your PATH, your run-state under .sdlc/, and the config the hooks
#      resolve from $DETENT_ROOT/config/sentinel/default.json).
# Upgrading one without the other leaves them on different commits. This script
# moves both to the merged `main` so "everything works as it is".
#
# Usage:
#   scripts/detent-upgrade.sh              # pull clone to main + update plugin
#   scripts/detent-upgrade.sh --reinstall  # force a clean plugin reinstall
#                                           # (use if a same-version release
#                                           #  wasn't picked up by plugin update)
#
# Idempotent and loud: it refuses rather than clobbering (dirty tree, non
# fast-forward), and never silently swallows a failed step.
set -uo pipefail

REINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --reinstall) REINSTALL=1 ;;
    -h|--help) sed -n '2,/^set /p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "detent-upgrade: FAILED — $1" >&2; exit 1; }

# --- resolve the shell clone (DETENT_ROOT) ------------------------------------
# Prefer the exported DETENT_ROOT (the clone the user actually runs from); fall
# back to the clone that contains this script, so it works before the profile is
# sourced.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${DETENT_ROOT:-$(cd "$HERE/.." && pwd)}"
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || fail "DETENT_ROOT ($ROOT) is not a git clone — set DETENT_ROOT to your detent clone and re-run"
echo "detent-upgrade: shell clone at $ROOT"

# --- 1. move the shell clone to the merged main --------------------------------
echo "[1/4] update the shell clone -> main"
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  fail "the clone at $ROOT has uncommitted changes — commit/stash them first, then re-run (refusing to clobber your work)"
fi
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || echo "  note: clone is on '$BRANCH'; switching to main for the upgrade"
git -C "$ROOT" fetch --quiet origin main || fail "git fetch origin main failed (network? auth?)"
git -C "$ROOT" checkout --quiet main || fail "could not switch to main"
git -C "$ROOT" merge --ff-only --quiet origin/main \
  || fail "main is not a fast-forward of origin/main (local commits on main?) — reconcile manually, then re-run"
echo "  now at $(git -C "$ROOT" rev-parse --short HEAD) ($(git -C "$ROOT" log -1 --format=%s | cut -c1-60))"

# --- 2. re-link the CLIs (picks up any new/renamed bins) -----------------------
echo "[2/4] re-link curator/engine (detent) CLIs"
(cd "$ROOT/engine/curator" && npm link --silent >/dev/null 2>&1) \
  && echo "  relinked: curator" \
  || echo "  WARN: curator npm link failed — run: (cd $ROOT/engine/curator && npm link)"
(cd "$ROOT/engine/cli" && npm link --silent >/dev/null 2>&1) \
  && echo "  relinked: detent" \
  || echo "  WARN: detent npm link failed — run: (cd $ROOT/engine/cli && npm link)"

# --- 3. update the Claude Code plugin ------------------------------------------
echo "[3/4] update the detent plugin"
if ! command -v claude >/dev/null 2>&1; then
  echo "  WARN: 'claude' CLI not on PATH — skipping plugin update."
  echo "        Update it yourself: claude plugin marketplace update detent && claude plugin update detent@detent"
else
  claude plugin marketplace update detent || fail "claude plugin marketplace update detent failed"
  # plugin@marketplace, not the bare name: `claude plugin update detent`
  # exits non-zero with "Plugin detent not found" against a real install.
  if [ "$REINSTALL" = "1" ]; then
    echo "  --reinstall: uninstall + reinstall for a clean pull"
    claude plugin uninstall detent@detent >/dev/null 2>&1 || true
    claude plugin install detent@detent || fail "claude plugin install detent@detent failed"
  else
    claude plugin update detent@detent || fail "claude plugin update detent@detent failed"
  fi
  # Surface the installed version so a silent version no-op is visible, not
  # hidden behind "done" (a same-version re-release needs --reinstall).
  echo "  installed: $(claude plugin list 2>/dev/null | grep -iA1 'detent@detent' | grep -i version | tr -s ' ' || echo '(version not reported — check `claude plugin list`)')"
fi

# --- 4. health check ------------------------------------------------------------
# Gate on what the relink WARNs could have left broken: the linked CLIs must
# actually run, and the config the hooks default to must resolve.
echo "[4/4] health check"
command -v detent >/dev/null 2>&1 && detent help >/dev/null 2>&1 \
  || fail "'detent' not working after relink — run: (cd $ROOT/engine/cli && npm link), then open a new shell"
command -v curator >/dev/null 2>&1 && curator status >/dev/null 2>&1 \
  || fail "'curator' not working after relink — run: (cd $ROOT/engine/curator && npm link), then open a new shell"
node "$ROOT/engine/sentinel/sentinel.mjs" config-check \
      --config "$ROOT/config/sentinel/default.json" >/dev/null 2>&1 \
  || fail "sentinel config-check failed on $ROOT/config/sentinel/default.json — the clone may be mid-rename; check the pull"
echo "  PASS: detent + curator run; sentinel config-check on the default path"

echo
echo "detent-upgrade: done. RESTART Claude Code to load the updated plugin (skills + hooks)."
