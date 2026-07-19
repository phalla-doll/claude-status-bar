#!/bin/bash
# Demo helper for the multi-account feature (issue #41).
# Seeds two fake LIVE sessions — one on the default account, one on "claude-2" — into the
# shared ~/.claude/statusbar/state.d hub, launches the freshly built dev app, and cleans up
# (restoring your real session state) when you press Enter. Use it to open the menu-bar
# dropdown and record the [default][CLI] / [claude-2][CLI] account badges.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE="$HOME/.claude/statusbar/state.d"
APP="$PWD/build/Claude Status Bar.app"
[ -d "$APP" ] || { echo "Build first: ./build.sh"; exit 1; }
mkdir -p "$STATE"

# Back up any real session files so we can restore them afterwards.
BACKUP="$(mktemp -d)"
cp -a "$STATE/." "$BACKUP/" 2>/dev/null || true
echo "Backed up existing state to $BACKUP"

# Two long-lived background procs give us real, live PIDs (the app uses kill(pid,0) for liveness).
sleep 600 & PID_A=$!
sleep 600 & PID_B=$!
NOW=$(date +%s)

cat > "$STATE/demo-acct-default.json" <<JSON
{"state":"tool","label":"Editing","tool":"Edit","project":"my-project","cwd":"$HOME","sessionId":"demo-acct-default","transcript":"","entrypoint":"cli","term_program":"Apple_Terminal","account":"","pid":$PID_A,"started":true,"startedAt":$((NOW-42)),"ts":$NOW}
JSON
cat > "$STATE/demo-acct-two.json" <<JSON
{"state":"thinking","label":"Thinking…","tool":"","project":"api-server","cwd":"$HOME","sessionId":"demo-acct-two","transcript":"","entrypoint":"cli","term_program":"iTerm.app","account":"claude-2","pid":$PID_B,"started":true,"startedAt":$((NOW-75)),"ts":$NOW}
JSON

echo "Launching dev build… click the menu-bar icon to see the two account rows."
pkill -x "Claude Status Bar" 2>/dev/null || true
sleep 1
open "$APP"

read -r -p "Press Enter to clean up and restore your real state… " _

pkill -x "Claude Status Bar" 2>/dev/null || true
kill "$PID_A" "$PID_B" 2>/dev/null || true
rm -f "$STATE/demo-acct-default.json" "$STATE/demo-acct-two.json"
cp -a "$BACKUP/." "$STATE/" 2>/dev/null || true
rm -rf "$BACKUP"
echo "Cleaned up. Restored real state from backup."
