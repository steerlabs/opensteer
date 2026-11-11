#!/usr/bin/env bash
set -euo pipefail
TEAM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
case $(uname -s) in
  Linux)
    unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    cat > "$unit_dir/opensteer-team-update.service" <<UNIT
[Unit]
Description=Update Opensteer team
[Service]
Type=oneshot
ExecStart=/bin/bash "$TEAM_DIR/update.sh"
UNIT
    cat > "$unit_dir/opensteer-team-update.timer" <<'UNIT'
[Unit]
Description=Hourly Opensteer team update
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now opensteer-team-update.timer
    ;;
  Darwin)
    plist="$HOME/Library/LaunchAgents/com.opensteer.team-update.plist"
    mkdir -p "$(dirname "$plist")"
    escaped=$(printf '%s' "$TEAM_DIR/update.sh" | sed 's/\&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g')
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.opensteer.team-update</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$escaped</string></array>
<key>StartInterval</key><integer>3600</integer>
</dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/com.opensteer.team-update" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    ;;
  *) echo 'Supported schedulers: Linux systemd and macOS launchd'; exit 1 ;;
esac
