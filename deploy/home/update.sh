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
  # Units a committed update could not write yet: tried again, never blocking the start.
  if [[ -f "$home_dir/units.stale" && ! -e $journal ]]; then
    refresh_installed_units && rm -f -- "$home_dir/units.stale" ||
      echo "This Home's units are not refreshed yet; the next start tries again." >&2
  fi
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
    # Committed: a unit refresh that fails never keeps the Home from starting.
    refresh_installed_units || touch "$home_dir/units.stale"
    retire_journal "$journal"
    return
  fi
  if ! cmp -s "$journal/candidate.env" "$active" && ! cmp -s "$journal/original.env" "$active" &&
    ! cmp -s "$journal/previous.env" "$active"; then
    recovery_needs_operator "$journal"
    return
  fi
  # The previous recipe comes back first (a unit's restore step may already have put it back);
  # the candidate is then stopped with the previous recipe's Compose files under the Home's own
  # project, never with the candidate's, which need not even parse.
  if [[ -d "$journal/recipe.previous" ]]; then
    put_recipe "$journal/recipe.previous" "$journal/recipe.new/recipe.files" || return
  fi
  release_env="$journal/candidate.env" compose down --remove-orphans || return
  cp "$journal/previous.env" "$active.new" || return
  publish_file "$active.new" "$active" || return
  install_sandbox_policies && start_pod || return
  # The units the previous recipe writes (a boot may have written the candidate's meanwhile).
  if [[ -d "$journal/recipe.previous" ]]; then refresh_installed_units || return; fi
  echo 'Rolled back to the previous recipe and images. The pre-update dump is retained for manual recovery.'
  retire_journal "$journal"
}

# mark_committed JOURNAL: the commit marker; one whose sync failed still marks the commit (it is
# what recovery decides by), and says so.
mark_committed() {
  durable_marker "$1/committed" && return 0
  [[ -f "$1/committed" ]] || return 1
  echo 'The update committed, but its commit marker could not be synced; it stands.' >&2
}

# recipe_installed RECIPE_JSON: whether the Home runs that recipe already (no recipe named: yes).
recipe_installed() {
  [[ ! -s $1 ]] || [[ $(jq -r .sha256 "$1") == "$(cat "$home_dir/recipe.sha256" 2>/dev/null)" ]]
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
  # A managed Home's release is its images and its account's pinned recipe together: without the
  # pin (the account did not answer, or named none) it does not update, and the next check tries.
  if $pinned && [[ ! -s "$current_dir/recipe.json" ]]; then
    fail 'The Opensteer account gave no recipe for this release: not updating now; the next check tries again.'
  fi
  old_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$active")
  new_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$candidate")
  # A release is its version and its image digests together.
  case $(release_change "$active" "$candidate") in
    same)
      # The same images; the same release only if the recipe is the same too (a Home left with a
      # release's images and an older recipe takes its recipe now).
      if recipe_installed "$current_dir/recipe.json"; then
        echo "Already on this release ($old_version)."
        return 0
      fi
      echo "Same images, another recipe: updating the recipe of $new_version."
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
  cp "$active" "$current_dir/original.env" || fail 'The update could not record the running release. Nothing was changed.'

  project=$(compose_project) || fail "The Home's Compose project could not be read. Nothing was changed."
  printf 'OPENSTEER_HOME_VERSION=%s\n' "$old_version" > "$previous" ||
    fail 'The update could not record the running images. Nothing was changed.'
  for service in "${services[@]}"; do
    if ! running_services | grep -qx -- "$service"; then
      # Not run on this Home (a Cloud Computer's browser is in the pool): it keeps its selection.
      grep -m1 "^OPENSTEER_HOME_$(printf %s "$service" | tr 'a-z-' 'A-Z_')_IMAGE=" "$active" >> "$previous" ||
        fail "The selected $service image is missing."
      continue
    fi
    container=$(compose ps -q "$service") || fail 'The running services could not be read. Nothing was changed.'
    [[ -n $container ]] || fail "Start the Home before updating."
    ref=$(docker inspect --format '{{.Config.Image}}' "$container") && [[ -n $ref ]] ||
      fail "The running $service image could not be read. Nothing was changed."
    if [[ ! $ref =~ @sha256:[0-9a-f]{64}$ ]]; then
      ! $pinned || fail "The running managed $service image is missing its release digest."
      id=$(docker inspect --format '{{.Image}}' "$container") && [[ -n $id ]] &&
        tag="opensteer-home-rollback/$project-$service:${id#sha256:}" &&
        docker image tag "$id" "$tag" ||
        fail "The running $service image could not be kept for a rollback. Nothing was changed."
      ref=$tag
    fi
    # The way back must exist before the Home stops.
    docker image inspect "$ref" >/dev/null 2>&1 ||
      fail "The running $service image $ref is not on this machine for a rollback. Nothing was changed."
    printf 'OPENSTEER_HOME_%s_IMAGE=%s\n' "$(printf %s "$service" | tr 'a-z-' 'A-Z_')" "$ref" >> "$previous" ||
      fail 'The update could not record the running images. Nothing was changed.'
  done

  # The release's images are here before anything stops: obtained, and each one present.
  fetch_release_images "$candidate" "$(uses_local_images)" ||
    fail "The release's images could not be obtained. Nothing was changed."
  if $pinned; then
    check_release_stamps "$candidate" || fail "The release's images are not this release. Nothing was changed."
  fi
  for service in $(running_services); do
    ref=$(sed -n "s/^OPENSTEER_HOME_$(printf %s "$service" | tr 'a-z-' 'A-Z_')_IMAGE=//p" "$candidate")
    [[ -n $ref ]] && docker image inspect "$ref" >/dev/null 2>&1 ||
      fail "The release's $service image is not on this machine. Nothing was changed."
  done
  # A release is one thing: its recipe (scripts and Compose files) rides with its images, checked
  # against its SHA-256 before anything is stopped, and journalled beside the previous one.
  if [[ -s "$current_dir/recipe.json" ]]; then
    fetch_recipe "$(jq -r .url "$current_dir/recipe.json")" "$(jq -r .sha256 "$current_dir/recipe.json")" \
      "$current_dir/recipe.new" "$pinned" || fail "The release's recipe could not be used. Nothing was changed."
    rm -f -- "$current_dir/recipe.new.bundle" "$current_dir/recipe.new.tgz"
    # The recipe and the images are published apart; they are one release only when both name it
    # (the installer's version file and the images' stamps come from the same build). Between the
    # two publications nothing changes; the next check tries again.
    if [[ $(cat "$current_dir/recipe.new/version" 2>/dev/null) != "$new_version" ]]; then
      echo 'The release is still being published (its recipe and its images name different releases): not updating now; the next check tries again.'
      return 0
    fi
    # Which recipe each side is, so a later check knows the release is whole.
    jq -r .sha256 "$current_dir/recipe.json" > "$current_dir/recipe.new/recipe.sha256" &&
      mkdir -- "$current_dir/recipe.previous" ||
      fail 'The update could not stage the recipe. Nothing was changed.'
    # The running recipe, by its own list: what a rollback puts back and what it removes.
    : > "$current_dir/recipe.previous/recipe.files" ||
      fail 'The update could not keep the running recipe. Nothing was changed.'
    # Its list as the Home recorded it when it installed it (or this code's, for a Home installed
    # before the list was recorded).
    for service in $(cat "$home_dir/recipe.files" 2>/dev/null || printf '%s\n' "${recipe_files[@]}"); do
      [[ $service =~ ^[a-z0-9][a-z0-9._-]*$ ]] || continue
      if [[ -f "$home_dir/$service" ]]; then
        cp -p -- "$home_dir/$service" "$current_dir/recipe.previous/$service" &&
          printf '%s\n' "$service" >> "$current_dir/recipe.previous/recipe.files" ||
          fail 'The update could not keep the running recipe. Nothing was changed.'
      fi
    done
    { cat "$home_dir/recipe.sha256" 2>/dev/null || echo unknown; } > "$current_dir/recipe.previous/recipe.sha256" ||
      fail 'The update could not keep the running recipe. Nothing was changed.'
  else
    echo 'This release names no recipe: only its images are updated; the recipe was not updated.'
  fi
  # shellcheck source=deploy/home/backup.sh
  source "$home_dir/backup.sh"
  postgres_tool pg_dump --format=custom > "$current_dir/database.dump" &&
    publish_file "$current_dir/database.dump" "$dump" ||
    fail 'The database could not be dumped before the update. Nothing was changed.'
  rm -f -- "$current_dir/release.json"
  # From the journal on, no step is taken for granted (this runs with errexit off): each write
  # either leads to the commit, or to the rollback below, or leaves the journal for recovery.
  sync -f "$home_dir" && mv -- "$current_dir" "$journal" && sync "$home_dir" ||
    fail 'The update journal could not be written. Nothing was changed.'
  # The Home stops; the new recipe replaces its own (each file by a rename); that recipe's code
  # starts the release and runs one maintenance check; the selector and the commit marker follow.
  if compose down && { [[ ! -d "$journal/recipe.new" ]] || put_recipe "$journal/recipe.new" "$journal/recipe.previous/recipe.files"; } &&
    OPENSTEER_HOME_UPDATE_JOURNAL="$journal" "$home_dir/opensteer-home" update-gate &&
    cp "$journal/candidate.env" "$active.new" && publish_file "$active.new" "$active" &&
    mark_committed "$journal"; then
    # Committed. Units, timers and the command on the path follow the committed recipe only; what
    # fails from here is finished from the committed journal at the next start.
    if ! refresh_installed_units; then
      touch "$home_dir/units.stale"
      echo "Updated to $new_version, but its units could not be written yet: the next start writes them." >&2
    fi
    retire_journal "$journal" ||
      fail "Updated to $new_version; its journal could not be retired yet: the next start does it."
    echo "Updated Home to $new_version."
    if declare -F record_update_result >/dev/null; then
      record_update_result updated "$old_version" "$new_version"
    fi
    return
  fi
  # One decision, the one recovery takes: a commit marker on disk means the update committed.
  if [[ -f "$journal/committed" ]]; then
    update_recovery ||
      fail "Updated to $new_version (committed), but finishing it failed: the next start finishes it."
    echo "Updated Home to $new_version."
    return
  fi
  printf '%s\n' "Home $new_version did not become healthy. Restoring $old_version." >&2
  if update_recovery; then
    if declare -F record_update_result >/dev/null; then
      record_update_result rolled-back "$old_version" "$new_version"
    fi
    fail "The update was rolled back."
  fi
  if declare -F record_update_result >/dev/null; then
    record_update_result failed "$old_version" "$new_version"
  fi
  fail "The update failed, and $old_version did not start again: its journal is kept for the next start (sudo opensteer-home logs host)."
)
