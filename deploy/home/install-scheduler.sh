#!/usr/bin/env bash
set -euo pipefail
home_dir=$1
unit_dir=${OPENSTEER_HOME_UNIT_DIR:-/etc/systemd/system} # Set only by tests.
unit=${2:-opensteer-home}
# Only the Home in the default directory owns the command on the path.
if [[ $unit == opensteer-home && $home_dir == /etc/opensteer-home ]]; then
  install -m 0755 "$home_dir/opensteer-home" /usr/local/bin/opensteer-home
fi
unit_env=''
if [[ -f "$home_dir/boot/options.env" ]]; then unit_env="EnvironmentFile=$home_dir/boot/options.env"; fi
cat > "$unit_dir/$unit.service" <<UNIT
[Unit]
Description=Opensteer Home
PartOf=docker.service
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Restart=on-failure
RestartSec=10s
TimeoutStartSec=0
TimeoutStopSec=180
Environment=OPENSTEER_HOME_DIR=$home_dir
$unit_env
ExecStart=$home_dir/opensteer-home start
ExecStop=$home_dir/opensteer-home stop

[Install]
WantedBy=multi-user.target
UNIT

timers=()
# Every Home has an update timer from install: a managed Home asks its account for its feed at each
# check, so it follows one given or moved later; a Home with no feed at all checks nothing.
for task in update backup maintain; do
  timers+=("$unit-$task.timer")
  case $task in
    update) calendar=hourly ;;
    backup) calendar=daily ;;
    maintain) calendar='' ;;
  esac
  command=scheduled-$task
  if [[ $task == maintain ]]; then command=maintain; fi
  cat > "$unit_dir/$unit-$task.service" <<UNIT
[Unit]
Description=Opensteer Home $task
Requisite=$unit.service
After=$unit.service

[Service]
Type=oneshot
Environment=OPENSTEER_HOME_DIR=$home_dir
$unit_env
ExecStart=$home_dir/opensteer-home $command
UNIT
  timer="OnCalendar=$calendar
Persistent=true"
  if [[ $task == maintain ]]; then
    timer='OnBootSec=30s
OnUnitInactiveSec=15s
AccuracySec=1s'
  fi
  cat > "$unit_dir/$unit-$task.timer" <<UNIT
[Unit]
Description=Schedule Opensteer Home $task

[Timer]
$timer

[Install]
WantedBy=timers.target
UNIT
done
systemctl daemon-reload
systemctl enable "$unit.service"
systemctl enable --now "${timers[@]}"
