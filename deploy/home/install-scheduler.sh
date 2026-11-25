#!/usr/bin/env bash
set -euo pipefail
home_dir=$1
unit_dir=${OPENSTEER_HOME_UNIT_DIR:-/etc/systemd/system} # Set only by tests.
unit=${2:-opensteer-home}
# Only the Home in the default directory owns the command on the path.
if [[ $unit == opensteer-home && $home_dir == /etc/opensteer-home ]]; then
  install -m 0755 "$home_dir/opensteer-home" /usr/local/bin/opensteer-home
fi
# Each unit (and the restore step) is written beside itself and renamed into place: an interruption leaves the old unit
# or the new one, never an empty one a reboot would load.
put_unit() { sync "$1.new" && mv -f -- "$1.new" "$1"; }
unit_env=''
if [[ -f "$home_dir/boot/options.env" ]]; then unit_env="EnvironmentFile=$home_dir/boot/options.env"; fi
# Written with the units, so it changes only once an update has committed: before any of the
# Home's code runs, an update interrupted before its commit gets its previous recipe back, under
# the Home's lock (never while an update still runs). That recipe's own update recovery then
# rolls the images back. It reads only the journal, and nothing of the recipe being installed.
cat > "$home_dir/restore-recipe.sh.new" <<'RESTORE'
#!/bin/sh
home=$1
journal="$home/update.pending"
[ -d "$journal/recipe.previous" ] && [ ! -e "$journal/committed" ] || exit 0
exec /usr/bin/flock "$home/operation.lock" /bin/sh -c '
  journal="$1/update.pending"
  [ -d "$journal/recipe.previous" ] && [ ! -e "$journal/committed" ] || exit 0
  for file in "$journal"/recipe.previous/*; do
    [ -f "$file" ] || continue
    cp -p -- "$file" "$1/.restore.new" && mv -f -- "$1/.restore.new" "$1/${file##*/}" || exit 1
  done
  sync' restore "$home"
RESTORE
chmod 0700 "$home_dir/restore-recipe.sh.new"
put_unit "$home_dir/restore-recipe.sh"
restore="ExecStartPre=$home_dir/restore-recipe.sh $home_dir"
cat > "$unit_dir/$unit.service.new" <<UNIT
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
$restore
ExecStart=$home_dir/opensteer-home start
ExecStop=$home_dir/opensteer-home stop

[Install]
WantedBy=multi-user.target
UNIT
put_unit "$unit_dir/$unit.service"

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
  cat > "$unit_dir/$unit-$task.service.new" <<UNIT
[Unit]
Description=Opensteer Home $task
Requisite=$unit.service
After=$unit.service

[Service]
Type=oneshot
Environment=OPENSTEER_HOME_DIR=$home_dir
$unit_env
$restore
ExecStart=$home_dir/opensteer-home $command
UNIT
  put_unit "$unit_dir/$unit-$task.service"
  timer="OnCalendar=$calendar
Persistent=true"
  if [[ $task == maintain ]]; then
    timer='OnBootSec=30s
OnUnitInactiveSec=15s
AccuracySec=1s'
  fi
  cat > "$unit_dir/$unit-$task.timer.new" <<UNIT
[Unit]
Description=Schedule Opensteer Home $task

[Timer]
$timer

[Install]
WantedBy=timers.target
UNIT
  put_unit "$unit_dir/$unit-$task.timer"
done
sync "$unit_dir"
systemctl daemon-reload
systemctl enable "$unit.service"
systemctl enable --now "${timers[@]}"
