#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2154

payload_volumes=(host-data runner-data agent-home engine-home browser-profiles channel-data caddy-data caddy-config)

backup_config() {
  local setting name path
  for setting in repository password accessKeyId secretAccessKey; do
    case $setting in
      repository) name=RESTIC_REPOSITORY_FILE ;;
      password) name=RESTIC_PASSWORD_FILE ;;
      accessKeyId) name=AWS_ACCESS_KEY_ID_FILE ;;
      secretAccessKey) name=AWS_SECRET_ACCESS_KEY_FILE ;;
    esac
    path=${!name:-"$home_dir/secrets/backup_$setting"}
    [[ -s $path && -r $path ]] || return 1
    backup_mounts+=(--mount "type=bind,src=$path,dst=/backups/$setting,readonly")
  done
  if [[ -s "$home_dir/backup-ca.pem" ]]; then
    backup_mounts+=(--mount "type=bind,src=$home_dir/backup-ca.pem,dst=/backups/ca.pem,readonly")
  fi
}

volume_mounts() {
  local directory=$1 volume
  volume_args=()
  for volume in "${payload_volumes[@]}"; do
    volume_args+=(--mount "type=volume,src=${volume_set}_$volume,dst=$directory/$volume${2:-}")
  done
}

restic_container() {
  local restic_image=${OPENSTEER_HOME_RESTIC_IMAGE:-restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76}
  docker run --rm --user 0:0 --network "${OPENSTEER_HOME_BACKUP_NETWORK:-bridge}" \
    --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER \
    --security-opt no-new-privileges:true --entrypoint /bin/sh \
    "${backup_mounts[@]}" --mount "type=bind,src=$staging,dst=/snapshot" \
    "${volume_args[@]}" "$restic_image" -euc "$1" home-backup "${@:2}"
}

restic_script='
  export RESTIC_REPOSITORY_FILE=/backups/repository RESTIC_PASSWORD_FILE=/backups/password
  export AWS_ACCESS_KEY_ID="$(cat /backups/accessKeyId)" AWS_SECRET_ACCESS_KEY="$(cat /backups/secretAccessKey)"
  snapshot() {
    if [ -f /backups/ca.pem ]; then
      restic --no-cache --cacert /backups/ca.pem "$@"
    else
      restic --no-cache "$@"
    fi
  }
  # restic retries an unreachable repository for many minutes; the check gives up after 30s.
  probe() {
    if [ -f /backups/ca.pem ]; then
      timeout 30 restic --no-cache --cacert /backups/ca.pem "$@"
    else
      timeout 30 restic --no-cache "$@"
    fi
  }
'

postgres_tool() {
  local tool=$1
  shift
  compose exec -T postgres sh -ec '
    export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"
    exec "$@" --host=/var/run/postgresql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"
  ' postgres-tool "$tool" "$@"
}

report_backup() {
  local snapshot_id=$1 completed_at=$2 origin id client_id secret status
  local secret_file="$home_dir/secrets/oidc_client_secret"
  [[ -s $secret_file ]] || return 0
  origin=$(sed -n "s/^OPENSTEER_HOME_ACCOUNT_ORIGIN='\([^']*\)'$/\1/p" "$home_dir/config.env")
  id=$(sed -n "s/^OPENSTEER_HOME_MANAGED_ID='\([^']*\)'$/\1/p" "$home_dir/config.env")
  client_id=$(sed -n "s/^OPENSTEER_HOME_OIDC_CLIENT_ID='\([^']*\)'$/\1/p" "$home_dir/config.env")
  secret=$(cat "$secret_file")
  [[ $origin =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ && $id =~ ^cc_[a-f0-9-]{36}$ &&
    $client_id =~ ^occ_[a-f0-9-]{36}$ && $secret =~ ^ocs_[a-zA-Z0-9_-]{43}$ ]] ||
    fail 'Backup saved. The Home credentials for reporting it are invalid.'
  status=$(printf 'user = "%s:%s"\n' "$client_id" "$secret" |
    curl -q --config - --basic --silent --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 20 --max-filesize 16384 \
      --header 'Content-Type: application/json' \
      --data-binary "$(jq -nc --arg completedAt "$completed_at" --arg snapshotId "$snapshot_id" '{$completedAt, $snapshotId}')" \
      --output /dev/null --write-out '%{http_code}' \
      -- "$origin/v1/cloud-computers/$id/backup") || fail 'Backup saved. Reporting it to the Opensteer account failed.'
  [[ $status == 204 ]] || fail "Backup saved. The Opensteer account refused the report (HTTP $status)."
}

# Reads the repository and takes and releases a restic lock in it, which writes to it, before
# anything is stopped. restic's own message explains a failure.
check_backup_repository() {
  echo 'Checking that the backup repository can be reached and written.'
  if ! restic_container "$restic_script"'
    probe cat config >/dev/null || probe init >/dev/null || exit
    probe snapshots --latest 1 >/dev/null
  ' >&2; then
    fail 'The backup repository could not be reached or written. The Home was not stopped.'
  fi
}

backup_home() {
  local snapshot_id completed_at
  check_backup_repository
  echo 'Stopping Home services to capture the database and files together.'
  durable_marker "$home_dir/backup.resume"
  resume_after_backup=true
  compose stop "${services[@]}"
  echo 'Saving the database.'
  postgres_tool pg_dump --format=custom > "$staging/database.dump"
  cp "$identity_secrets/"{auth_secret,environment_id} "$staging/"
  volume_mounts /snapshot/volumes ,readonly
  echo 'Uploading the encrypted snapshot.'
  restic_container "$restic_script"'
    export RESTIC_PROGRESS_FPS=0.2
    snapshot backup --json --host "$1" --tag opensteer-home \
      /snapshot/database.dump /snapshot/auth_secret /snapshot/environment_id /snapshot/volumes
  ' "$hostname" | tee "$staging/restic-result.jsonl" | jq --unbuffered -r '
    select(.message_type == "status") |
    "Uploaded \((.percent_done // 0) * 100 | floor)% (\(.files_done // 0) of \(.total_files // 0) files)"'
  completed_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  snapshot_id=$(jq -ser '.[] | select(.message_type == "summary") | .snapshot_id | select(test("^[0-9a-f]{8,64}$"))' "$staging/restic-result.jsonl")
  printf 'snapshot %s saved\n' "$snapshot_id"
  echo 'Starting Home services.'
  start_pod
  rm -f -- "$home_dir/backup.resume"
  resume_after_backup=false
  if [[ $action == scheduled-backup ]]; then report_backup "$snapshot_id" "$completed_at"; fi
}

restore_state() {
  local config
  config=$(compose config --format json) || return
  volume_set=$(jq -er '.volumes["postgres-data"].name | sub("_postgres-data$"; "")' <<< "$config") || return
  identity_secrets=$(jq -er '.secrets.auth_secret.file | sub("/auth_secret$"; "")' <<< "$config")
}

restore_selector() {
  printf 'OPENSTEER_HOME_VOLUME_SET=%s\nOPENSTEER_HOME_IDENTITY_SECRETS=%s/identity/%s\n' "$1" "$home_dir" "$1"
}

restore_set_exists() {
  local set=$1 volume
  for volume in postgres-data postgres-socket "${payload_volumes[@]}"; do
    docker volume inspect "${set}_$volume" >/dev/null 2>&1 || return
  done
}

restore_evidence() {
  local active="$home_dir/volumes.env" project marker
  failed_set=$(cat "$journal/volume-set") || return
  previous_set=$(cat "$journal/previous-set") || return
  project=$(compose_project) || return
  [[ ! -L $active && $project =~ ^[a-z0-9_-]+$ &&
    $failed_set == "$project"-restore-* && $failed_set =~ ^[a-z0-9_-]+-restore-[0-9a-f]{12}$ &&
    $failed_set != "$previous_set" ]] || return 1
  if [[ -L "$journal/previous.env" || -L "$journal/previous-default" ]]; then return 1; fi
  if [[ -f "$journal/previous.env" && ! -e "$journal/previous-default" ]]; then
    [[ $previous_set == "$project"-restore-* && $previous_set =~ ^[a-z0-9_-]+-restore-[0-9a-f]{12}$ ]] &&
      cmp -s "$journal/previous.env" <(restore_selector "$previous_set") || return 1
  elif [[ -f "$journal/previous-default" && ! -e "$journal/previous.env" ]]; then
    [[ $previous_set == "$project" ]] || return 1
  else
    return 1
  fi
  for marker in cutover committed managed previous-empty; do
    [[ ! -L "$journal/$marker" ]] || return 1
    [[ ! -e "$journal/$marker" || ( -f "$journal/$marker" && ! -s "$journal/$marker" ) ]] || return 1
  done
  if [[ -f "$journal/previous-empty" ]]; then
    [[ -f "$journal/managed" && -f "$journal/previous-default" ]] || return 1
  fi
  restore_state || return
  if [[ $volume_set == "$failed_set" && -f "$journal/cutover" ]]; then
    cmp -s "$active" <(restore_selector "$failed_set")
  elif [[ $volume_set == "$previous_set" && ! -e "$journal/committed" ]]; then
    if [[ -f "$journal/previous.env" ]]; then
      cmp -s "$active" "$journal/previous.env"
    else
      [[ ! -e $active && ! -L $active ]]
    fi
  else
    return 1
  fi
}

restore_rollback() {
  local journal="$home_dir/restore.pending" failed_set previous_set volume volume_set identity_secrets staged
  clean_retired_journal "$journal" || return
  [[ -e $journal || -L $journal ]] || return 0
  if [[ ! -d $journal || -L $journal ]] || ! restore_evidence; then
    recovery_needs_operator "$journal"
    return
  fi
  if [[ -f "$journal/committed" ]]; then
    restore_set_exists "$failed_set" || { recovery_needs_operator "$journal"; return 1; }
    sync "$home_dir/volumes.env" "$home_dir" "$journal/committed" "$journal" || return
    if [[ -f "$journal/managed" ]]; then
      durable_marker "$home_dir/boot/restored" || return
    fi
    rm -f -- "$home_dir/setup-link.pending" || return
    for volume in postgres-data postgres-socket "${payload_volumes[@]}"; do
      if docker volume inspect "${previous_set}_$volume" >/dev/null 2>&1; then
        docker volume rm "${previous_set}_$volume" >/dev/null || return
      fi
    done
    rm -rf -- "$home_dir/identity/$previous_set" && retire_journal "$journal"
    return
  fi
  if [[ ! -f "$journal/previous-empty" ]]; then
    restore_set_exists "$previous_set" || { recovery_needs_operator "$journal"; return 1; }
  fi
  staged="$home_dir/identity/$failed_set/volumes.env"
  if [[ -e $staged || -L $staged ]]; then
    if [[ -L $staged ]] || ! cmp -s "$staged" <(restore_selector "$failed_set"); then
      recovery_needs_operator "$journal"
      return
    fi
  fi
  if [[ -f "$journal/cutover" ]]; then
    compose down || return
    if [[ -f "$journal/previous.env" ]]; then
      cp "$journal/previous.env" "$home_dir/volumes.env.new" || return
      publish_file "$home_dir/volumes.env.new" "$home_dir/volumes.env" || return
    else
      rm -f -- "$home_dir/volumes.env" || return
    fi
    sync "$home_dir" || return
    if [[ ! -f "$journal/managed" ]]; then start_pod || return; fi
  fi
  restore_evidence && [[ $volume_set == "$previous_set" ]] ||
    { recovery_needs_operator "$journal"; return 1; }
  sync "$home_dir" || return
  if [[ -f $staged ]]; then
    volume_env="$staged" stage_project="$failed_set" compose down --volumes || return
  fi
  for volume in postgres-data postgres-socket "${payload_volumes[@]}"; do
    if docker volume inspect "${failed_set}_$volume" >/dev/null 2>&1; then
      docker volume rm "${failed_set}_$volume" >/dev/null || return
    fi
  done
  retire_journal "$journal" && rm -rf -- "$home_dir/identity/$failed_set"
}

restore_home() {
  local replace=false source_stopped=false state snapshot_id=latest managed_replace=$1
  shift
  while (($#)); do
    case "$1" in
      --replace) replace=true ;;
      --source-stopped) source_stopped=true ;;
      *) [[ "$snapshot_id" == latest && $1 =~ ^[0-9a-f]{8,64}$ ]] || fail "Usage: opensteer-home restore --source-stopped [--replace] [SNAPSHOT_ID]"; snapshot_id=$1 ;;
    esac
    shift
  done
  $managed_replace || $source_stopped || fail "Permanently stop the source Home, then acknowledge it with --source-stopped."
  restore_rollback
  if $managed_replace && [[ -f "$home_dir/boot/restored" ]]; then return; fi
  if ! $managed_replace; then
    if ! claimed_state >/dev/null 2>&1; then start_pod; fi
    state=$(claimed_state) || fail "Could not establish whether this Home is already claimed."
    [[ $state == required ]] || $replace || fail "This Home is claimed. Use --replace to overwrite it."
  fi
  printf '%s\n' 'Restore will overwrite the database, Host identity and secrets, Runner and engine data, Agent home, browser profiles, messaging identity, and TLS data.'

  volume_args=()
  restic_container "$restic_script"'
    snapshot restore "$1" --host "$2" --tag opensteer-home --verify --target /snapshot/restored
  ' "$snapshot_id" "$hostname"
  restored="$staging/restored/snapshot"
  [[ -s "$restored/database.dump" && -s "$restored/auth_secret" && -s "$restored/environment_id" &&
    -d "$restored/volumes" ]] || fail "The selected snapshot is missing required Home data."
  for volume in "${payload_volumes[@]}"; do
    [[ -d "$restored/volumes/$volume" ]] || fail "The selected snapshot is missing $volume."
  done

  local stage_id stage_dir stage_env previous_volumes journal="$home_dir/restore.pending" old_set=$volume_set
  stage_id="$project-restore-$(openssl rand -hex 6)"
  stage_dir="$home_dir/identity/$stage_id"
  mkdir "$staging/cutover"
  printf '%s\n' "$stage_id" > "$staging/cutover/volume-set"
  printf '%s\n' "$old_set" > "$staging/cutover/previous-set"
  if [[ -f "$home_dir/volumes.env" ]]; then
    cp "$home_dir/volumes.env" "$staging/cutover/previous.env"
  else
    touch "$staging/cutover/previous-default"
  fi
  if $managed_replace; then
    touch "$staging/cutover/managed"
    previous_volumes=$(docker volume ls --format '{{.Name}}' --filter "name=^${old_set}_")
    if [[ -z $previous_volumes ]]; then touch "$staging/cutover/previous-empty"; fi
  fi
  sync -f "$home_dir"
  cleanup_restore=true
  mv -- "$staging/cutover" "$journal"
  sync "$home_dir"
  install -d -m 0700 "$stage_dir"
  stage_env="$stage_dir/volumes.env"
  restore_selector "$stage_id" > "$staging/volumes.env"
  publish_file "$staging/volumes.env" "$stage_env"
  save_secret "$stage_dir/auth_secret" < "$restored/auth_secret"
  save_secret "$stage_dir/environment_id" < "$restored/environment_id"
  volume_env="$stage_env" stage_project="$stage_id" compose create --no-build
  volume_env="$stage_env" stage_project="$stage_id" compose up -d --wait --wait-timeout 240 --pull never postgres
  volume_env="$stage_env" stage_project="$stage_id" postgres_tool pg_restore --single-transaction --exit-on-error < "$restored/database.dump"
  volume_set=$stage_id
  volume_mounts /target
  restic_container '
    set -o pipefail
    for target in /target/*; do
      source=/snapshot/restored/snapshot/volumes/${target##*/}
      tar -C "$source" -cpf - . | tar -C "$target" -xpf -
    done
  '
  volume_env="$stage_env" stage_project="$stage_id" compose down

  durable_marker "$journal/cutover"
  if ! $managed_replace; then
    compose stop gateway runner browser-runtime browser-egress channel-runtime
    state=$(claimed_state) || fail "Could not establish claim state before restore cutover."
    [[ $state == required ]] || $replace || fail "This Home was claimed while the snapshot was staging. Use --replace to overwrite it."
  fi
  compose down
  cp "$stage_env" "$home_dir/volumes.env.new"
  sync -f "$home_dir"
  cleanup_restore=false
  publish_file "$home_dir/volumes.env.new" "$home_dir/volumes.env"
  if ! start_pod; then
    restore_rollback
    fail "The restored Home did not become healthy. The previous volume set was preserved."
  fi
  durable_marker "$journal/committed"
  restore_rollback
}

cleanup_backup() {
  local result=$?
  trap - EXIT
  if $cleanup_restore; then
    restore_rollback || echo 'Restore recovery is pending. The journal was retained.' >&2
  fi
  rm -rf -- "$staging"
  if ${resume_after_backup:-false}; then
    echo 'The backup did not finish after Home services were stopped. Starting them again.' >&2
    if start_pod; then
      rm -f -- "$home_dir/backup.resume"
      echo 'Home services were started again.' >&2
    else
      echo 'Could not restart the Home after backup.' >&2
      result=1
    fi
  fi
  exit "$result"
}

backup_command() {
  local action=$1
  shift
  local backup_mounts=() volume_args=() project hostname staging resume_after_backup=false cleanup_restore=false restored volume_set identity_secrets
  if ! backup_config; then
    [[ $action == scheduled-backup ]] && return 0
    fail "Configure RESTIC_REPOSITORY_FILE, RESTIC_PASSWORD_FILE, AWS_ACCESS_KEY_ID_FILE, and AWS_SECRET_ACCESS_KEY_FILE."
  fi
  hostname=$(compose config --format json | jq -er .services.gateway.environment.OPENSTEER_HOME_HOSTNAME)
  if [[ $action != snapshots ]]; then
    project=$(compose_project)
    restore_state
  fi
  staging=$(mktemp -d "$home_dir/backup.XXXXXX")
  # The EXIT trap must run while these local variables and the operation lock are in scope.
  (
    trap cleanup_backup EXIT
    if [[ $action == snapshots ]]; then
      [[ $# == 0 ]] || fail "Usage: opensteer-home snapshots"
      restic_container "$restic_script"'snapshot snapshots --no-lock --host "$1" --tag opensteer-home' "$hostname"
    elif [[ $action == restore ]]; then
      restore_home false "$@"
    elif [[ $action == managed-restore ]]; then
      restore_home true "$@"
    else
      [[ $# == 0 ]] || fail "Usage: opensteer-home backup"
      backup_home
    fi
  )
}
