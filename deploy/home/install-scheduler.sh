#!/usr/bin/env bash
set -euo pipefail
home_dir=$1
unit_dir=${OPENSTEER_HOME_UNIT_DIR:-/etc/systemd/system} # Set only by tests.
unit=${2:-opensteer-home}
# The units run the Home's current release (`current`), so an ordinary release changes none of
# them. A release's own check writes them into a staging directory only, to read them.
check=${OPENSTEER_HOME_UNITS_CHECK:-}
staged=$check
if [[ -z $check ]]; then
  staged=$(mktemp -d)
  trap 'rm -rf -- "$staged"' EXIT
fi
command="$home_dir/current/opensteer-home"
unit_env=''
if [[ -f "$home_dir/boot/options.env" ]]; then unit_env="EnvironmentFile=$home_dir/boot/options.env"; fi
cat > "$staged/$unit.service" <<UNIT
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
ExecStart=$command start
ExecStop=$command stop

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
  subcommand=scheduled-$task
  if [[ $task == maintain ]]; then subcommand=maintain; fi
  # Backups and maintenance need the Home started; an update does not: a Home that is down can still
  # take the release that fixes it.
  requisite="Requisite=$unit.service"
  if [[ $task == update ]]; then requisite=''; fi
  cat > "$staged/$unit-$task.service" <<UNIT
[Unit]
Description=Opensteer Home $task
$requisite
After=$unit.service

[Service]
Type=oneshot
Environment=OPENSTEER_HOME_DIR=$home_dir
$unit_env
ExecStart=$command $subcommand
UNIT
  timer="OnCalendar=$calendar
Persistent=true"
  # A fleet on one feed takes a release over a quarter of an hour, not all at :00; each Home keeps
  # its own fixed offset, so it still checks once an hour.
  if [[ $task == update ]]; then timer+=$'\nRandomizedDelaySec=15min\nFixedRandomDelay=true'; fi
  if [[ $task == maintain ]]; then
    timer='OnBootSec=30s
OnUnitInactiveSec=15s
AccuracySec=1s'
  fi
  cat > "$staged/$unit-$task.timer" <<UNIT
[Unit]
Description=Schedule Opensteer Home $task

[Timer]
$timer

[Install]
WantedBy=timers.target
UNIT
done
[[ -z $check ]] || exit 0

# Only the Home in the default directory owns the command on the path: a link to its current one.
if [[ $unit == opensteer-home && $home_dir == /etc/opensteer-home && $(readlink /usr/local/bin/opensteer-home || true) != "$command" ]]; then
  ln -sfn -- "$command" /usr/local/bin/opensteer-home.new
  mv -fT -- /usr/local/bin/opensteer-home.new /usr/local/bin/opensteer-home
fi
# A unit is written only where it differs from the installed one, beside itself and renamed into
# place: an interruption leaves the old unit or the new one, never an empty one a reboot would load.
changed=false
for file in "$staged"/*; do
  name=${file##*/}
  cmp -s -- "$file" "$unit_dir/$name" && continue
  install -m 0644 -- "$file" "$unit_dir/$name.new"
  sync "$unit_dir/$name.new"
  mv -f -- "$unit_dir/$name.new" "$unit_dir/$name"
  changed=true
done
# systemd is told when something changed, or when any one unit is not loaded as written or not
# enabled; a query that fails counts as not.
for file in "$staged"/*; do
  [[ $(systemctl show --property NeedDaemonReload --value "${file##*/}" 2>/dev/null) == no ]] || changed=true
done
for name in "$unit.service" "${timers[@]}"; do systemctl is-enabled --quiet "$name" 2>/dev/null || changed=true; done
$changed || exit 0
sync "$unit_dir"
systemctl daemon-reload
systemctl enable "$unit.service"
systemctl enable --now "${timers[@]}"
