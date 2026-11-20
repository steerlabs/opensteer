#!/usr/bin/env bash
set -euo pipefail
umask 077
home_dir=$1
unit=$2-managed.service
temporary=$(mktemp "/etc/systemd/system/$unit.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary" <<UNIT
[Unit]
Description=Finish installing Opensteer Home
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=exec
Environment=OPENSTEER_HOME_DIR=$home_dir
Environment=OPENSTEER_HOME_UNIT_PREFIX=$2
EnvironmentFile=$home_dir/boot/options.env
ExecStart=$home_dir/boot/install.sh --resume-managed
Restart=on-failure
RestartPreventExitStatus=78
RestartSec=10s
RestartSteps=5
RestartMaxDelaySec=60s

[Install]
WantedBy=multi-user.target
UNIT
sync "$temporary"
mv -f -- "$temporary" "/etc/systemd/system/$unit"
sync /etc/systemd/system
systemctl daemon-reload
systemctl enable "$unit"
systemctl start --no-block "$unit"
