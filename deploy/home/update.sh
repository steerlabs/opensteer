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
    refresh_installed_units || return
    retire_journal "$journal"
    return
  fi
  if ! cmp -s "$journal/candidate.env" "$active" && ! cmp -s "$journal/original.env" "$active" &&
    ! cmp -s "$journal/previous.env" "$active"; then
    recovery_needs_operator "$journal"
    return
  fi
  release_env="$journal/candidate.env" compose down || return
  # The previous recipe comes back with the previous images (a unit's restore step may already
  # have put it back before this code ran).
  if [[ -d "$journal/recipe.previous" ]]; then put_recipe "$journal/recipe.previous" || return; fi
  cp "$journal/previous.env" "$active.new" || return
  publish_file "$active.new" "$active" || return
  install_sandbox_policies && start_pod || return
  echo 'Rolled back to the previous images. The pre-update dump is retained for manual recovery.'
  retire_journal "$journal"
}

# release_recipe MANIFEST OUT: the recipe a self-hosted Home's release manifest names, if any.
release_recipe() {
  jq -ce '.recipe | select(type == "object" and (.url | type) == "string" and
    (.sha256 | type) == "string" and (.sha256 | test("^[0-9a-f]{64}$")))' "$1" > "$2" 2>/dev/null ||
    rm -f -- "$2"
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
    release_recipe "$2" "$current_dir/recipe.json"
  else
    if $pinned; then
      # The feed its account gives now, checked as at boot; its own when the account is silent.
      # The recipe comes only from the account's answer, never from a manifest.
      feed=$(managed_feed "$current_dir/recipe.json") || fail 'No update feed passed the checks.'
    else
      feed=$(compose config --environment | sed -n 's/^OPENSTEER_HOME_RELEASE_MANIFEST_URL=//p')
    fi
    if [[ -z $feed ]]; then
      if [[ $1 == scheduled-update ]]; then
        echo 'No update feed is set; nothing to check.'
        return 0
      fi
      fail "Set OPENSTEER_HOME_RELEASE_MANIFEST_URL='https://…' in config.env or supply a release manifest."
    fi
    fetch_manifest "$feed" "$current_dir/release.json" "$pinned"
    release_to_env "$current_dir/release.json" "$candidate" "$pinned"
    if ! $pinned; then release_recipe "$current_dir/release.json" "$current_dir/recipe.json"; fi
  fi
  old_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$active")
  new_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$candidate")
  # A release is its version and its image digests together.
  case $(release_change "$active" "$candidate") in
    same)
      echo "Already on this release ($old_version)."
      return 0
      ;;
    rebuild) echo "Same version, different build: updating $new_version." ;;
    newer) echo "Updating from $old_version to $new_version." ;;
    older)
      if [[ $1 == scheduled-update ]]; then
        if declare -F record_update_result >/dev/null; then
          record_update_result feed-older "$old_version" "$new_version"
        fi
        fail "The feed's release $new_version is older than the running $old_version: older: refused."
      fi
      echo "Release $new_version is older than the running $old_version: updating, as asked by hand."
      ;;
  esac
  cp "$active" "$current_dir/original.env"

  project=$(compose_project)
  printf 'OPENSTEER_HOME_VERSION=%s\n' "$old_version" > "$previous"
  for service in "${services[@]}"; do
    if ! running_services | grep -qx -- "$service"; then
      # Not run on this Home (a Cloud Computer's browser is in the pool): it keeps its selection.
      grep -m1 "^OPENSTEER_HOME_$(printf %s "$service" | tr 'a-z-' 'A-Z_')_IMAGE=" "$active" >> "$previous" ||
        fail "The selected $service image is missing."
      continue
    fi
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

  fetch_release_images "$candidate" "$(uses_local_images)"
  if $pinned; then check_release_stamps "$candidate"; fi
  # A release is one thing: its recipe (scripts and Compose files) rides with its images, checked
  # against its SHA-256 before anything is stopped, and journalled beside the previous one.
  if [[ -s "$current_dir/recipe.json" ]]; then
    fetch_recipe "$(jq -r .url "$current_dir/recipe.json")" "$(jq -r .sha256 "$current_dir/recipe.json")" \
      "$current_dir/recipe.new" "$pinned" || fail "The release's recipe could not be used. Nothing was changed."
    rm -f -- "$current_dir/recipe.new.bundle" "$current_dir/recipe.new.tgz"
    mkdir -- "$current_dir/recipe.previous"
    for service in "${recipe_files[@]}"; do
      if [[ -f "$home_dir/$service" ]]; then cp -p -- "$home_dir/$service" "$current_dir/recipe.previous/$service"; fi
    done
  elif $pinned; then
    echo 'The Opensteer account named no recipe for this release: only its images are updated.'
  else
    echo 'This release names no recipe: only its images are updated; the recipe was not updated.'
  fi
  # shellcheck source=deploy/home/backup.sh
  source "$home_dir/backup.sh"
  postgres_tool pg_dump --format=custom > "$current_dir/database.dump"
  publish_file "$current_dir/database.dump" "$dump"
  rm -f -- "$current_dir/release.json"
  sync -f "$home_dir"
  mv -- "$current_dir" "$journal"
  sync "$home_dir"
  compose down
  # The new recipe replaces the Home's (each file by a rename); its own code then starts the release
  # and runs one maintenance check. Only then is the update committed.
  if { [[ ! -d "$journal/recipe.new" ]] || put_recipe "$journal/recipe.new"; } &&
    OPENSTEER_HOME_UPDATE_JOURNAL="$journal" "$home_dir/opensteer-home" update-gate; then
    cp "$journal/candidate.env" "$active.new"
    publish_file "$active.new" "$active"
    durable_marker "$journal/committed"
    # Units, timers and the command on the path follow the committed recipe only.
    refresh_installed_units || fail 'Updated; its units could not be written yet: the next start writes them.'
    retire_journal "$journal"
    echo "Updated Home to $new_version."
    if declare -F record_update_result >/dev/null; then
      record_update_result updated "$old_version" "$new_version"
    fi
    return
  fi
  printf '%s\n' "Home $new_version did not become healthy. Restoring $old_version." >&2
  update_recovery
  if declare -F record_update_result >/dev/null; then
    record_update_result rolled-back "$old_version" "$new_version"
  fi
  fail "The update was rolled back."
)
