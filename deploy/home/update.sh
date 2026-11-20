#!/usr/bin/env bash
# shellcheck disable=SC2154

update_recovery() {
  local journal="$home_dir/update.pending" active="$home_dir/images.env"
  [[ -d $journal ]] || return 0
  if [[ -f "$journal/committed" ]]; then
    rm -rf -- "$journal"
    return
  fi
  release_env="$journal/candidate.env" compose down || return
  cp "$journal/previous.env" "$active.new" || return
  mv -f -- "$active.new" "$active" || return
  sync "$home_dir" || return
  install_sandbox_policies && start_pod || return
  echo 'Rolled back the interrupted update. The database checkpoint is retained.'
  rm -rf -- "$journal"
}

update_home() {
  [[ $# -le 2 ]] || fail "Usage: opensteer-home update [MANIFEST.json]"
  update_recovery
  local current_dir candidate previous active project service id ref tag container old_version new_version feed
  local journal="$home_dir/update.pending" checkpoint="$home_dir/update-database.dump" pinned=false
  if [[ -f "$home_dir/managed" ]]; then pinned=true; fi
  current_dir=$(mktemp -d "$home_dir/update.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf -- '$current_dir'" EXIT
  candidate="$current_dir/candidate.env"
  previous="$current_dir/previous.env"
  active="$home_dir/images.env"
  if [[ $# == 2 ]]; then
    release_to_env "$2" "$candidate" "$pinned"
  else
    feed=$(compose config --environment | sed -n 's/^OPENSTEER_HOME_RELEASE_MANIFEST_URL=//p')
    if [[ -z $feed ]]; then
      [[ $1 == scheduled-update ]] && return 0
      fail "Set OPENSTEER_HOME_RELEASE_MANIFEST_URL in config.env or supply a release manifest."
    fi
    fetch_manifest "$feed" "$current_dir/release.json"
    release_to_env "$current_dir/release.json" "$candidate" "$pinned"
  fi
  cmp -s "$active" "$candidate" && return 0
  old_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$active")
  new_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$candidate")
  if [[ $1 == scheduled-update && $(printf '%s\n%s\n' "$old_version" "$new_version" | sort -V | tail -1) != "$new_version" ]]; then
    fail "The update feed is older than the running Home."
  fi

  project=$(compose_project)
  printf 'OPENSTEER_HOME_VERSION=%s\n' "$old_version" > "$previous"
  for service in "${services[@]}"; do
    container=$(compose ps -q "$service")
    [[ -n $container ]] || fail "Start the Home before updating."
    ref=$(docker inspect --format '{{.Config.Image}}' "$container")
    if [[ ! $ref =~ @sha256:[0-9a-f]{64}$ ]]; then
      ! $pinned || fail "The running managed $service image is missing its release digest."
      id=$(docker inspect --format '{{.Image}}' "$container")
      tag="opensteer-home-rollback/$project-$service:${id#sha256:}"
      docker image tag "$id" "$tag"
      ref=$tag
    fi
    printf 'OPENSTEER_HOME_%s_IMAGE=%s\n' "$(printf %s "$service" | tr 'a-z-' 'A-Z_')" "$ref" >> "$previous"
  done

  release_env="$candidate" compose pull --quiet
  # shellcheck source=deploy/home/backup.sh
  source "$home_dir/backup.sh"
  postgres_tool pg_dump --format=custom > "$current_dir/database.dump"
  mv -f -- "$current_dir/database.dump" "$checkpoint"
  printf 'starting-candidate\n' > "$current_dir/phase"
  rm -f -- "$current_dir/release.json"
  sync "$home_dir"
  mv -- "$current_dir" "$journal"
  sync "$home_dir"
  compose down
  if release_env="$journal/candidate.env" install_sandbox_policies && release_env="$journal/candidate.env" start_pod; then
    cp "$journal/candidate.env" "$active.new"
    mv -f -- "$active.new" "$active"
    sync "$home_dir"
    touch "$journal/committed"
    sync "$home_dir"
    rm -rf -- "$journal"
    echo "Updated Home to $new_version."
    return
  fi
  printf '%s\n' "Home $new_version did not become healthy. Restoring $old_version." >&2
  update_recovery
  fail "The update was rolled back."
}
