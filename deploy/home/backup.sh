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
}

volume_mounts() {
  local directory=$1 volume
  volume_args=()
  for volume in "${payload_volumes[@]}"; do
    volume_args+=(--mount "type=volume,src=${project}_$volume,dst=$directory/$volume${2:-}")
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
  snapshot() { restic --no-cache "$@"; }
'

postgres_tool() {
  local tool=$1
  shift
  compose exec -T postgres sh -ec '
    export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"
    exec "$@" --host=/var/run/postgresql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"
  ' postgres-tool "$tool" "$@"
}

backup_home() {
  echo 'Stopping Home services to capture the database and files together.'
  resume_after_backup=true
  compose stop "${services[@]}"
  postgres_tool pg_dump --format=custom > "$staging/database.dump"
  cp "$home_dir/secrets/"{auth_secret,environment_id} "$staging/"
  volume_mounts /snapshot/volumes ,readonly
  restic_container "$restic_script"'
    snapshot cat config >/dev/null 2>&1 || snapshot init
    snapshot backup --host "$1" --tag opensteer-home \
      /snapshot/database.dump /snapshot/auth_secret /snapshot/environment_id /snapshot/volumes
  ' "$hostname"
  resume_after_backup=false
  start_pod
}

restore_home() {
  local replace=false state snapshot_id=latest
  while (($#)); do
    case "$1" in
      --replace) replace=true ;;
      *) [[ "$snapshot_id" == latest && $1 =~ ^[0-9a-f]{8,64}$ ]] || fail "Usage: opensteer-home restore [--replace] [SNAPSHOT_ID]"; snapshot_id=$1 ;;
    esac
    shift
  done

  compose up -d --wait --pull never postgres host
  state=$(claimed_state) || fail "Could not establish whether this Home is already claimed."
  [[ $state == required ]] || $replace || fail "This Home is claimed. Use --replace to overwrite it."
  printf 'Restore will overwrite the database, Host identity and secrets, Runner and engine data, Agent home, browser profiles, messaging identity, and TLS data.\n'
  printf 'The source Home must be stopped before its identity is restored.\n'

  volume_args=()
  restic_container "$restic_script"'
    snapshot restore "$1" --host "$2" --tag opensteer-home --target /snapshot/restored
  ' "$snapshot_id" "$hostname"
  restored="$staging/restored/snapshot"
  [[ -s "$restored/database.dump" && -s "$restored/auth_secret" && -s "$restored/environment_id" &&
    -d "$restored/volumes" ]] || fail "The selected snapshot is missing required Home data."

  compose down
  compose up -d --wait --pull never postgres
  compose create --no-build
  postgres_tool pg_restore --single-transaction --exit-on-error --clean --if-exists < "$restored/database.dump"
  volume_mounts /target
  restic_container '
    for target in /target/*; do
      source=/snapshot/restored/snapshot/volumes/${target##*/}
      test -d "$source"
    done
    for target in /target/*; do
      source=/snapshot/restored/snapshot/volumes/${target##*/}
      find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      tar -C "$source" -cpf - . | tar -C "$target" -xpf -
    done
  '
  save_secret "$home_dir/secrets/auth_secret" < "$restored/auth_secret"
  save_secret "$home_dir/secrets/environment_id" < "$restored/environment_id"
  rm -f -- "$home_dir/setup-link.pending"
  start_pod
}

cleanup_backup() {
  local result=$?
  trap - EXIT
  rm -rf -- "$staging"
  if ${resume_after_backup:-false}; then
    start_pod || echo 'Could not restart the Home after backup.' >&2
  fi
  exit "$result"
}

backup_command() {
  local action=$1
  shift
  local backup_mounts=() volume_args=() project hostname staging resume_after_backup=false restored
  if ! backup_config; then
    [[ $action == scheduled-backup ]] && return 0
    fail "Configure RESTIC_REPOSITORY_FILE, RESTIC_PASSWORD_FILE, AWS_ACCESS_KEY_ID_FILE, and AWS_SECRET_ACCESS_KEY_FILE."
  fi
  project=$(compose_project)
  hostname=$(compose config --format json | jq -er .services.gateway.environment.OPENSTEER_HOME_HOSTNAME)
  staging=$(mktemp -d "$home_dir/backup.XXXXXX")
  # The EXIT trap must run while these local variables and the operation lock are in scope.
  (
    trap cleanup_backup EXIT
    if [[ $action == restore ]]; then
      restore_home "$@"
    else
      [[ $# == 0 ]] || fail "Usage: opensteer-home backup"
      backup_home
    fi
  )
}
