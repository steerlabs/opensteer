#!/usr/bin/env bash
# shellcheck disable=SC2154

valid_image_selector() {
  local file=$1 service key
  [[ -f $file && ! -L $file ]] || return 1
  [[ $(wc -l < "$file") -eq $((${#services[@]} + 1)) ]] || return 1
  grep -qxE 'OPENSTEER_HOME_VERSION=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)' "$file" || return
  for service in "${services[@]}"; do
    key="OPENSTEER_HOME_$(printf %s "$service" | tr 'a-z-' 'A-Z_')_IMAGE"
    grep -qxE "$key=[a-zA-Z0-9./:_-]+(@sha256:[a-fA-F0-9]{64})?" "$file" || return
  done
}

update_recovery() {
  local journal="$home_dir/update.pending" active="$home_dir/images.env"
  clean_retired_journal "$journal" || return
  [[ -e $journal || -L $journal ]] || return 0
  if [[ ! -d $journal || -L $journal || -L "$journal/committed" || -L $active ]] ||
     ! valid_image_selector "$journal/candidate.env" || ! valid_image_selector "$journal/previous.env" ||
     ! valid_image_selector "$journal/original.env"; then
    recovery_needs_operator "$journal"
    return
  fi
  if [[ -e "$journal/committed" && ( ! -f "$journal/committed" || -s "$journal/committed" ) ]]; then
    recovery_needs_operator "$journal"
    return
  fi
  if [[ -f "$journal/committed" ]]; then
    cmp -s "$journal/candidate.env" "$active" || { recovery_needs_operator "$journal"; return 1; }
    sync "$active" "$home_dir" "$journal/committed" "$journal" || return
    retire_journal "$journal"
    return
  fi
  if ! cmp -s "$journal/candidate.env" "$active" && ! cmp -s "$journal/original.env" "$active" &&
    ! cmp -s "$journal/previous.env" "$active"; then
    recovery_needs_operator "$journal"
    return
  fi
  release_env="$journal/candidate.env" compose down || return
  cp "$journal/previous.env" "$active.new" || return
  publish_file "$active.new" "$active" || return
  install_sandbox_policies && start_pod || return
  echo 'Rolled back to the previous images. The pre-update dump is retained for manual recovery.'
  retire_journal "$journal"
}

update_home() (
  [[ $# -le 2 ]] || fail "Usage: opensteer-home update [MANIFEST.json]"
  update_recovery
  local current_dir candidate previous active project service id ref tag container old_version new_version feed
  local journal="$home_dir/update.pending" dump="$home_dir/update-database.dump" pinned=false
  if [[ -f "$home_dir/managed" ]]; then
    pinned=true
    [[ $# == 1 ]] || fail 'Managed Homes update only from the Account feed.'
  fi
  current_dir=$(mktemp -d "$home_dir/update.XXXXXX")
  trap 'rm -rf -- "$current_dir"' EXIT
  candidate="$current_dir/candidate.env"
  previous="$current_dir/previous.env"
  active="$home_dir/images.env"
  if [[ $# == 2 ]]; then
    release_to_env "$2" "$candidate" "$pinned"
  else
    if $pinned; then
      feed=$(sed -n "s/^OPENSTEER_HOME_RELEASE_MANIFEST_URL='\([^']*\)'$/\1/p" "$home_dir/config.env")
    else
      feed=$(compose config --environment | sed -n 's/^OPENSTEER_HOME_RELEASE_MANIFEST_URL=//p')
    fi
    if [[ -z $feed ]]; then
      [[ $1 == scheduled-update ]] && return 0
      fail "Set OPENSTEER_HOME_RELEASE_MANIFEST_URL in config.env or supply a release manifest."
    fi
    fetch_manifest "$feed" "$current_dir/release.json" "$pinned"
    release_to_env "$current_dir/release.json" "$candidate" "$pinned"
  fi
  cmp -s "$active" "$candidate" && return 0
  old_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$active")
  cp "$active" "$current_dir/original.env"
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
  if $pinned; then check_release_stamps "$candidate"; fi
  # shellcheck source=deploy/home/backup.sh
  source "$home_dir/backup.sh"
  postgres_tool pg_dump --format=custom > "$current_dir/database.dump"
  publish_file "$current_dir/database.dump" "$dump"
  rm -f -- "$current_dir/release.json"
  sync -f "$home_dir"
  mv -- "$current_dir" "$journal"
  sync "$home_dir"
  compose down
  if release_env="$journal/candidate.env" install_sandbox_policies && release_env="$journal/candidate.env" start_pod; then
    cp "$journal/candidate.env" "$active.new"
    publish_file "$active.new" "$active"
    durable_marker "$journal/committed"
    retire_journal "$journal"
    echo "Updated Home to $new_version."
    return
  fi
  printf '%s\n' "Home $new_version did not become healthy. Restoring $old_version." >&2
  update_recovery
  fail "The update was rolled back."
)
