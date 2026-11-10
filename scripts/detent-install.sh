#!/usr/bin/env bash
# detent-install.sh — the SHELL-LEVEL half of a detent install.
#
# Division of labour (plugin-first):
#   The Claude Code PLUGIN owns skills, hooks, and in-session executable calls
#   (skills invoke ${CLAUDE_PLUGIN_ROOT}/engine/.../cli.mjs; hooks/hooks.json
#   wires every hook automatically). Install it with:
#       claude plugin marketplace add Amanborn007/detent
#       claude plugin install detent@detent
#
#   THIS SCRIPT only does the parts a plugin cannot: expose the CLIs on your
#   PATH for manual shell use, set DETENT_ROOT so state resolves from any
#   directory, and seed your personal config. It NEVER edits ~/.claude/settings.json
#   (hooks come from the plugin) and is idempotent (safe to re-run).
#
#   Env override (mainly for tests):
#     DETENT_PROFILE   shell profile to mark (default: by $SHELL)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETENT_ROOT="$(cd "$HERE/.." && pwd)"
MARKER_BEGIN="# >>> detent begin (managed by scripts/detent-install.sh) >>>"
MARKER_END="# <<< detent end <<<"

echo "detent-install (shell-level): clone at $DETENT_ROOT"
echo "  (skills + hooks + in-session executables come from the Claude Code plugin —"
echo "   run: claude plugin marketplace add Amanborn007/detent && claude plugin install detent@detent)"
echo

# --- 1. CLIs on PATH (for manual shell use; the plugin handles in-session use) -
echo "[1/3] curator/engine/sentinel on PATH (npm link engine/curator provides curator)"
if (cd "$DETENT_ROOT/engine/curator" && npm link --silent >/dev/null 2>&1); then
  echo "  linked: $(command -v curator || echo '(open a new shell to pick up PATH)')"
else
  echo "  WARN: npm link failed — run manually: (cd $DETENT_ROOT/engine/curator && npm link)"
fi
(cd "$DETENT_ROOT/engine/cli" && npm link --silent >/dev/null 2>&1) \
  && echo "  linked: $(command -v detent || echo 'detent (new shell)')" \
  || echo "  WARN: detent npm link failed — run: (cd $DETENT_ROOT/engine/cli && npm link)"
echo

# --- 2. DETENT_ROOT in the shell profile (marker block, idempotent) -----------
echo "[2/3] DETENT_ROOT in the shell profile"
case "${DETENT_PROFILE:-}" in
  "")
    case "${SHELL:-}" in
      */zsh)  PROFILE="$HOME/.zshrc" ;;
      */bash) PROFILE="$HOME/.bashrc" ;;
      *)      PROFILE="$HOME/.profile" ;;
    esac ;;
  *) PROFILE="$DETENT_PROFILE" ;;
esac
touch "$PROFILE"
if grep -qF "$MARKER_BEGIN" "$PROFILE"; then
  echo "  already set in $PROFILE (marker found) — not touching it"
else
  {
    echo ""
    echo "$MARKER_BEGIN"
    echo "export DETENT_ROOT=\"$DETENT_ROOT\""
    echo "alias detent-upgrade='bash \"\$DETENT_ROOT/scripts/detent-upgrade.sh\"'"
    echo "$MARKER_END"
  } >>"$PROFILE"
  echo "  appended DETENT_ROOT=$DETENT_ROOT to $PROFILE"
fi
echo

# --- 3. personal config --------------------------------------------------------
echo "[3/3] detent.user.yaml"
if [ -f "$DETENT_ROOT/detent.user.yaml" ]; then
  echo "  already present — not touching it"
else
  cp "$DETENT_ROOT/detent.user.example.yaml" "$DETENT_ROOT/detent.user.yaml"
  echo "  created from detent.user.example.yaml — edit it with YOUR values"
fi
echo

# --- verify + health table ------------------------------------------------------
echo "verify"
declare -a ROWS=()
fails=0
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then ROWS+=("PASS  $label"); else ROWS+=("FAIL  $label  ($*)"); fails=$((fails + 1)); fi; }
CURATOR_BIN="$(command -v curator || true)"
if [ -n "$CURATOR_BIN" ]; then check "curator status" "$CURATOR_BIN" status; else ROWS+=("FAIL  curator status  (not on PATH — open a new shell or re-run npm link)"); fails=$((fails + 1)); fi
check "engine help exits 0" node "$DETENT_ROOT/engine/cli/engine.mjs" help
DETENT_BIN="$(command -v detent || true)"; if [ -n "$DETENT_BIN" ]; then check "detent on PATH" "$DETENT_BIN" help; else ROWS+=("WARN  detent on PATH  (open a new shell)"); fi
check "sentinel config-check" node "$DETENT_ROOT/engine/sentinel/sentinel.mjs" config-check --config "$DETENT_ROOT/config/sentinel/default.json"
check "DETENT_ROOT marker in profile" grep -qF "$MARKER_BEGIN" "$PROFILE"
check "detent.user.yaml present" test -f "$DETENT_ROOT/detent.user.yaml"
echo "  ------------------------------------------------------------"
printf '  %s\n' "${ROWS[@]}"
echo "  ------------------------------------------------------------"
if [ "$fails" -gt 0 ]; then echo "detent-install: $fails check(s) FAILED — fix the rows above and re-run."; exit 1; fi
echo "detent-install: shell-level setup done. Install the plugin for skills+hooks. Open a new shell to pick up DETENT_ROOT/PATH."
