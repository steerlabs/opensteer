#!/usr/bin/env bash
# shellcheck disable=SC2154

# release_recipe MANIFEST OUT: the recipe a self-hosted Home's release manifest names, if any.
release_recipe() {
  jq -ce '.recipe | select(type == "object" and (.url | type) == "string" and
    (.sha256 | type) == "string" and (.sha256 | test("^[0-9a-f]{64}$")))' "$1" > "$2" 2>/dev/null ||
    rm -f -- "$2"
}

# release_waiting OLD NEW BUNDLE: a release whose installer (BUNDLE) and images (NEW) name different
# releases changes nothing. The same mismatch at a later check is recorded as waiting since the
# first, for the Home's problems; an update that goes through clears it.
release_waiting() {
  local waiting="$home_dir/update.waiting" seen="$1 $2 $3"
  echo 'The release is still being published (its recipe and its images name different releases): not updating now; the next check tries again.'
  if [[ -f $waiting && $(sed -n 2p "$waiting") == "$seen" ]]; then
    record_update_result waiting "$1" "$2" "$(head -1 "$waiting")"
  else
    printf '%s\n%s\n' "$(date -u +'%Y-%m-%dT%H:%M:00Z')" "$seen" > "$waiting" ||
      echo 'The waiting release could not be noted.' >&2
  fi
}

# update_home [MANIFEST.json]: the Home's next release, prepared whole in its own directory beside
# the running one (nothing outside it is written), then switched to by cutover.
update_home() (
  [[ $# -le 2 ]] || fail "Usage: opensteer-home update [MANIFEST.json]"
  local feed old_version new_version bundle_version change pinned=false unwritten='The release could not be written. Nothing was changed.'
  if [[ -f "$home_dir/managed" ]]; then
    pinned=true
    [[ $# == 1 ]] || fail 'Managed Homes update only from the Account feed.'
  fi
  from=$(current_release) || fail 'This Home has no current release.'
  to='' prepared=false
  # Releases a stopped preparation or a rolled-back candidate left: nothing names them.
  prune_releases
  manifest=$(mktemp "$home_dir/releases/.manifest.XXXXXX") ||
    fail 'The update could not start. Nothing was changed.'
  trap 'rm -f -- "$manifest"*; if ! $prepared && [[ -n $to ]]; then rm -rf -- "$to"; fi' EXIT
  if [[ $# == 2 ]]; then
    cp -- "$2" "$manifest" || fail 'The release manifest could not be read. Nothing was changed.'
  else
    if $pinned; then
      # The feed its account gives now, checked as at boot; its own when the account is silent.
      # The recipe comes only from the account's answer, never from a manifest.
      feed=$(managed_feed "$manifest.recipe") || fail 'No update feed passed the checks.'
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
    fetch_manifest "$feed" "$manifest" "$pinned" ||
      fail 'The release manifest could not be fetched. Nothing was changed.'
  fi
  if ! $pinned; then release_recipe "$manifest" "$manifest.recipe"; fi
  # A managed Home's release is its images and its account's pinned recipe together: without the
  # pin (the account did not answer, or named none) it does not update, and the next check tries.
  if $pinned && [[ ! -s "$manifest.recipe" ]]; then
    fail 'The Opensteer account gave no recipe for this release: not updating now; the next check tries again.'
  fi
  release_to_env "$manifest" "$manifest.env" "$pinned"
  old_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$from/images.env")
  new_version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$manifest.env")
  # A release is its version, its image digests and its recipe together.
  change=$(release_change "$from/images.env" "$manifest.env")
  case $change in
    same)
      if [[ ! -s "$manifest.recipe" || $(jq -r .sha256 "$manifest.recipe") == "$(cat "$from/recipe.sha256" 2>/dev/null)" ]]; then
        rm -f -- "$home_dir/update.waiting"
        echo "Already on this release ($old_version)."
        return 0
      fi
      echo "Same images, another recipe: updating the recipe of $new_version."
      ;;
    rebuild) echo "Same version, different build: updating $new_version." ;;
    newer) echo "Updating from $old_version to $new_version." ;;
    older)
      if [[ $1 == scheduled-update ]]; then
        record_update_result feed-older "$old_version" "$new_version"
        fail "The feed's release $new_version is older than the running $old_version: older: refused."
      fi
      echo "Release $new_version is older than the running $old_version: updating, as asked by hand."
      ;;
  esac

  # shellcheck source=deploy/home/backup.sh
  source "$release_dir/backup.sh"
  if [[ $change == same ]]; then room_for_release; else room_for_release images; fi ||
    fail 'There is not enough room on this machine for the release. Nothing was changed.'
  to=$(new_release "$new_version") || fail "$unwritten"
  if [[ -s "$manifest.recipe" ]]; then
    fetch_recipe "$(jq -r .url "$manifest.recipe")" "$(jq -r .sha256 "$manifest.recipe")" "$to" "$pinned" ||
      fail "The release's recipe could not be used. Nothing was changed."
    # The recipe and the images are published apart; they are one release only when both name it
    # (the installer's version file and the images' stamps come from the same build).
    bundle_version=$(cat "$to/version")
    if [[ $bundle_version != "$new_version" ]]; then
      release_waiting "$old_version" "$new_version" "$bundle_version"
      return 0
    fi
    jq -r .sha256 "$manifest.recipe" > "$to/recipe.sha256" || fail "$unwritten"
  else
    # A release that names no recipe runs the running one's, copied whole into its directory.
    for name in "${release_files[@]}" version recipe.sha256; do
      if [[ -f "$from/$name" ]]; then cp -p -- "$from/$name" "$to/$name" || fail "$unwritten"; fi
    done
    echo 'This release names no recipe: only its images are updated; the recipe was not updated.'
  fi
  mv -- "$manifest.env" "$to/images.env" || fail "$unwritten"
  rm -f -- "$home_dir/update.waiting"
  # The way back is on this machine before anything stops: every image the running release runs.
  images_present || fail "The running release's images are not all on this machine for a rollback. Nothing was changed."
  # The release readies itself with its own code: its images, sandbox policies and units.
  run_release "$to" release-prepare || fail 'The release could not be prepared. Nothing was changed.'
  postgres_tool pg_dump --format=custom > "$to/database.dump" ||
    fail 'The database could not be dumped before the update. Nothing was changed.'

  prepared=true
  local status=0
  cutover "$from" "$to" || status=$?
  case $status in
    0)
      echo "Updated Home to $new_version."
      refresh_units || echo "The new release's units could not be written yet: the next start writes them." >&2
      record_update_result updated "$old_version" "$new_version"
      ;;
    1)
      printf '%s\n' "Home $new_version did not pass its check. Restoring $old_version." >&2
      if start_pod; then
        record_update_result rolled-back "$old_version" "$new_version"
        fail "The update was rolled back. The database dump taken before it is kept in $to/database.dump until the next update."
      fi
      record_update_result failed "$old_version" "$new_version"
      fail "The update failed, and $old_version did not start again (sudo opensteer-home logs host)."
      ;;
    2)
      rm -rf -- "$to"
      fail 'The update could not be recorded. Nothing was changed.'
      ;;
    *)
      record_update_result failed "$old_version" "$new_version"
      fail "The update failed, and going back to $old_version is not finished: the next start finishes it."
      ;;
  esac
)
