#!/usr/bin/env bash
set -euo pipefail
home_dir=$1
unit_dir=/etc/systemd/system
install -m 0755 "$home_dir/opensteer-home" /usr/local/bin/opensteer-home
cat > "$unit_dir/opensteer-home.service" <<UNIT
[Unit]
Description=Opensteer Home
PartOf=docker.service
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=0
TimeoutStopSec=180
Environment=OPENSTEER_HOME_DIR=$home_dir
ExecStart=$home_dir/opensteer-home start
ExecStop=$home_dir/opensteer-home stop

[Install]
WantedBy=multi-user.target
UNIT

for task in update backup; do
  case $task in
    update) calendar=hourly ;;
    backup) calendar=daily ;;
  esac
  cat > "$unit_dir/opensteer-home-$task.service" <<UNIT
[Unit]
Description=Opensteer Home $task
After=opensteer-home.service

[Service]
Type=oneshot
Environment=OPENSTEER_HOME_DIR=$home_dir
ExecStart=$home_dir/opensteer-home scheduled-$task
UNIT
  cat > "$unit_dir/opensteer-home-$task.timer" <<UNIT
[Unit]
Description=Schedule Opensteer Home $task

[Timer]
OnCalendar=$calendar
Persistent=true

[Install]
WantedBy=timers.target
UNIT
done
systemctl daemon-reload
systemctl enable opensteer-home.service
systemctl enable --now opensteer-home-{update,backup}.timer
