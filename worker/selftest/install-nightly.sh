#!/bin/bash
# install-nightly.sh — run the JobWatch self-test every night at 3:30 AM
# (macOS LaunchAgent). The test fills live forms in a test browser and
# never submits. Remove with: bash worker/selftest/install-nightly.sh --remove
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)"
PL="$HOME/Library/LaunchAgents/com.jobwatch.selftest.plist"
launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null || true
if [ "$1" = "--remove" ]; then rm -f "$PL"; echo "Nightly self-test removed."; exit 0; fi
mkdir -p "$REPO/worker/selftest/reports" "$HOME/Library/LaunchAgents"
cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jobwatch.selftest</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/worker/selftest/run.mjs</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$REPO/worker/selftest/reports/run.log</string>
  <key>StandardErrorPath</key><string>$REPO/worker/selftest/reports/run.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin</string></dict>
</dict>
</plist>
EOF
plutil -lint "$PL" >/dev/null
launchctl bootstrap "gui/$(id -u)" "$PL"
echo "Nightly self-test installed: every day at 3:30 AM. Results: $REPO/worker/selftest/reports/latest.json"
