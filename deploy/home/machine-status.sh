#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2016
# What only this machine's root maintenance knows of the Home, as fixed values: each service's
# health, the last scheduled backup and the last update. The maintenance timer hands it to the
# Host as machine-status.json in the Host's own data folder; the Host reads it strictly
# (MachineStatusSchema, packages/protocol/src/problems.ts) and puts it in its problem report.
# Nothing here is ever free text: no log line, error message, path or name.

machine_status_services='["postgres","host","gateway","runner","browser-runtime","browser-egress","channel-runtime"]'

# The health of each of the seven services, from Docker's own state.
machine_services_json() {
  compose ps --all --format json 2>/dev/null | jq -sc --argjson known "$machine_status_services" '
    map(select(.Service as $name | $known | index($name)) | {
      key: .Service,
      value: (if .State != "running" then "stopped"
        elif .Health == "healthy" then "healthy"
        elif .Health == "unhealthy" then "unhealthy"
        else "starting" end)
    }) | from_entries'
}

# record_backup_result ok|failed [repository-unreachable|snapshot-failed|restart-failed|report-refused]
record_backup_result() {
  local failure=${2:-}
  case $failure in
    '' | repository-unreachable | snapshot-failed | restart-failed | report-refused) ;;
    *) failure=snapshot-failed ;;
  esac
  jq -nc --arg result "$1" --arg failure "$failure" --arg at "$(date -u +'%Y-%m-%dT%H:%M:00Z')" \
    '{result: $result, at: $at} + (if $failure == "" then {} else {failure: $failure} end)' \
    > "$home_dir/last-backup.json.new" && mv -f -- "$home_dir/last-backup.json.new" "$home_dir/last-backup.json"
}

# record_update_result updated|rolled-back|feed-older|failed [FROM_VERSION] [TO_VERSION]
record_update_result() {
  local version='^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$' from=${2:-} to=${3:-}
  [[ $from =~ $version ]] || from=''
  [[ $to =~ $version ]] || to=''
  jq -nc --arg result "$1" --arg from "$from" --arg to "$to" --arg at "$(date -u +'%Y-%m-%dT%H:%M:00Z')" '
    {result: $result, at: $at}
    + (if $from == "" then {} else {fromVersion: $from} end)
    + (if $to == "" then {} else {toVersion: $to} end)' \
    > "$home_dir/last-update.json.new" && mv -f -- "$home_dir/last-update.json.new" "$home_dir/last-update.json"
  touch "$home_dir/update.recorded"
}

machine_status_json() {
  local services backup=null update=null
  services=$(machine_services_json) || services=''
  [[ -n $services ]] || services='{}'
  [[ -s "$home_dir/last-backup.json" ]] && backup=$(jq -c . "$home_dir/last-backup.json" 2>/dev/null || echo null)
  [[ -s "$home_dir/last-update.json" ]] && update=$(jq -c . "$home_dir/last-update.json" 2>/dev/null || echo null)
  jq -nc --argjson services "$services" --argjson backup "$backup" --argjson update "$update" '
    {services: $services}
    + (if $backup == null then {} else {lastBackup: $backup} end)
    + (if $update == null then {} else {lastUpdate: $update} end)'
}

# Hands the status to the running Host when it changed, or every five minutes so the Host knows
# it is current. Best effort: a Host that is not running gets it on a later pass.
publish_machine_status() {
  local status last="$home_dir/machine-status.last"
  status=$(machine_status_json) || return 0
  if [[ -f $last && $(cat "$last") == "$status" && -z $(find "$last" -mmin +5 2>/dev/null) ]]; then
    return 0
  fi
  printf '%s' "$status" | compose exec -T host sh -c '
    dir=${OPENSTEER_HOST_DATA_DIR:-/var/lib/opensteer}
    cat > "$dir/machine-status.json.new" && mv -f "$dir/machine-status.json.new" "$dir/machine-status.json"
  ' >/dev/null 2>&1 || return 0
  printf '%s' "$status" > "$last"
}
