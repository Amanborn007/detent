#!/usr/bin/env bash
# install-notify.sh — install the morning-brief NOTIFICATION LaunchAgent (macOS).
#
# What it installs: a per-user LaunchAgent that posts ONE desktop notification
# each morning, reminding you to open a session and run the brief. It does NOT
# assemble any data, call any connector, or open a browser — a headless launchd
# job cannot reach the interactive-only connectors the full brief needs. The
# brief itself runs interactively (`detent herald` / the herald skill); the
# SessionStart hook also offers it on your first session of the day.
#
# Usage:
#   engine/herald/install-notify.sh [--time HH:MM] [--uninstall]
#
# Defaults: 08:30 local time.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$HERE/morning-brief-notify.plist.template"
LABEL="com.detent.herald.notify"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENTS_DIR/$LABEL.plist"
TIME="08:30"
UNINSTALL="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --time) TIME="${2:?--time needs HH:MM}"; shift 2 ;;
    --uninstall) UNINSTALL="yes"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname)" != "Darwin" ]; then
  echo "install-notify: this notification helper is macOS-only (launchd). On other" >&2
  echo "platforms, rely on the SessionStart hook to offer the brief instead." >&2
  exit 1
fi

launchctl_unload() { launchctl unload "$PLIST" 2>/dev/null || launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; }

if [ "$UNINSTALL" = "yes" ]; then
  launchctl_unload
  rm -f "$PLIST"
  echo "install-notify: uninstalled $LABEL (removed $PLIST)."
  exit 0
fi

[ -f "$TEMPLATE" ] || { echo "install-notify: template missing at $TEMPLATE" >&2; exit 1; }
case "$TIME" in
  [0-2][0-9]:[0-5][0-9]) : ;;
  *) echo "install-notify: --time must be HH:MM (24h), got '$TIME'" >&2; exit 2 ;;
esac
HOUR="${TIME%%:*}"; MINUTE="${TIME##*:}"
HOUR="$((10#$HOUR))"; MINUTE="$((10#$MINUTE))"
MESSAGE="Open a Claude session and run your morning brief (detent herald)."

mkdir -p "$AGENTS_DIR"
sed -e "s/__LABEL__/$LABEL/g" \
    -e "s/__HOUR__/$HOUR/g" \
    -e "s/__MINUTE__/$MINUTE/g" \
    -e "s/__MESSAGE__/$MESSAGE/g" \
    "$TEMPLATE" > "$PLIST"

launchctl_unload
if launchctl load "$PLIST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  echo "install-notify: installed $LABEL — a notification will fire daily at $TIME."
  echo "  It only reminds you; the brief runs interactively via 'detent herald'."
  echo "  Uninstall: engine/herald/install-notify.sh --uninstall"
else
  echo "install-notify: wrote $PLIST but launchctl load failed — load it manually:" >&2
  echo "  launchctl bootstrap gui/$(id -u) \"$PLIST\"" >&2
  exit 1
fi
