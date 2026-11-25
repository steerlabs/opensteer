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

# release_identity SELECTOR RECIPE_SHA: a release named by its images and its installer.
release_identity() { { cat "$1"; printf '%s\n' "$2"; } | digest; }

# remember_failed RELEASE: a release that failed its gate here, or that the operator rolled back
# from, is not tried again by itself, until another release commits. One line each ("ID
# IDENTITY SINCE"): the directory of its first failure stays, with the dump taken before it.
remember_failed() {
  local memory="$home_dir/update.failed" identity
  identity=$(release_identity "$(release_named "$1")" "$(cat "$1/recipe.sha256" 2>/dev/null)")
  [[ -z $(failed_release "$identity") ]] || return 0
  { cat "$memory" 2>/dev/null; printf '%s %s %s\n' "${1##*/}" "$identity" "$(date -u +'%Y-%m-%dT%H:%M:00Z')"; } > "$memory.new" &&
    publish_file "$memory.new" "$memory" ||
    echo 'The failed release could not be remembered: the next check tries it again.' >&2
}

# failed_release IDENTITY: the line that remembers that release, if any.
failed_release() { awk -v id="$1" '$2 == id { print; exit }' "$home_dir/update.failed" 2>/dev/null || :; }

# main_state: how this Home's main unit stands: active; inactive (a person stopped it); failed (its
# last start failed). A Home without systemd counts as active.
main_state() {
  local state=''
  [[ -d /run/systemd/system || -n ${OPENSTEER_HOME_UNIT_DIR:-} ]] || { echo active; return; }
  state=$(systemctl show --property ActiveState --value "$(installed_unit_prefix).service" 2>/dev/null) || state=''
  case $state in inactive | failed) echo "$state" ;; *) echo active ;; esac
}

# own_home STATE: after a switch, the current release runs as the main unit had the Home: running
# while the unit is active; stopped when a person stopped it; started through the unit when its
# last start had failed, so that systemd owns what runs.
own_home() {
  case $1 in
    inactive) release_dir=$(current_release) compose down ;;
    failed) systemctl start --no-block "$(installed_unit_prefix).service" ;;
    *) release_dir=$(current_release) start_pod ;;
  esac
}

# settled VERSION: the Home runs the release its feed names; a result left from before (waiting, a
# failed check, an update whose result was never written) says so now.
settled() {
  [[ $(jq -r '"\(.result) \(.toVersion)"' "$home_dir/last-update.json" 2>/dev/null) == "updated $1" ]] ||
    record_update_result updated '' "$1"
}

# update_home [MANIFEST.json]: the Home's next release, prepared whole in its own directory beside
# the running one (nothing outside it is written), then switched to by cutover.
update_home() (
  [[ $# -le 2 ]] || fail "Usage: opensteer-home update [MANIFEST.json]"
  local feed old_version new_version bundle_version change identity remembered since first unit pod pinned=false unwritten='The release could not be written. Nothing was changed.'
  if [[ -f "$home_dir/managed" ]]; then
    pinned=true
    [[ $# == 1 ]] || fail 'Managed Homes update only from the Account feed.'
  fi
  from=$(current_release) || fail 'This Home has no current release.'
  # One switch at a time: a switch the last start could not finish is finished first.
  [[ ! -e "$home_dir/update.pending" ]] ||
    fail 'The last switch of releases is not finished yet; the next start finishes it. Nothing was changed.'
  to='' prepared=false
  manifest=$(mktemp "$home_dir/releases/.manifest.XXXXXX") ||
    fail 'The update could not start. Nothing was changed.'
  # A release this run made and did not switch to goes, with the images only it pulled.
  trap 'rm -f -- "$manifest"*; if ! $prepared && [[ -n $to ]]; then prune_releases "$to"; fi' EXIT
  if [[ $# == 2 ]]; then
    cp -- "$2" "$manifest" || fail 'The release manifest could not be read. Nothing was changed.'
  else
    if $pinned; then
      # The feed its account gives now, checked as at boot; its own when the account is silent.
      # The recipe comes only from the account's answer, never from a manifest.
      feed=$(managed_feed "$manifest.recipe") || fail 'No update feed passed the checks.'
    else
      feed=$(configured_feed) || fail "This Home's update feed could not be read from config.env."
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
  change=$(release_change "$(release_named "$from")" "$manifest.env")
  case $change in
    same)
      if [[ ! -s "$manifest.recipe" || $(jq -r .sha256 "$manifest.recipe") == "$(cat "$from/recipe.sha256" 2>/dev/null)" ]]; then
        rm -f -- "$home_dir/update.waiting"
        echo "Already on this release ($old_version)."
        settled "$old_version"
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
  # A release that failed its gate here waits for the next one, or the operator's `update --retry`.
  identity=$(release_identity "$manifest.env" "$(if [[ -s "$manifest.recipe" ]]; then jq -r .sha256 "$manifest.recipe"; else cat "$from/recipe.sha256" 2>/dev/null; fi)")
  remembered=$(failed_release "$identity")
  if [[ ${retry_failed:-false} != true && -n $remembered ]]; then
    read -r _ _ since <<< "$remembered"
    echo "Release $new_version did not start here: waiting for the next one (sudo opensteer-home update --retry tries it again)."
    record_update_result not-retried "$old_version" "$new_version" "$since"
    return 0
  fi
  pod=$(pod_state) || fail 'Docker could not say whether this Home runs. Nothing was changed.'
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
  # The database as it is before the switch, kept with this release for as long as its directory.
  if [[ $pod == running ]]; then
    postgres_tool pg_dump --format=custom > "$to/database.dump" ||
      fail 'The database could not be dumped before the update. Nothing was changed.'
  else
    echo 'The Home is not running: no dump is taken before this update (the last backup is the copy).'
  fi

  prepared=true
  # A Home a person stopped is switched and left stopped; one whose start failed is started through
  # its main unit afterwards.
  unit=$(main_state)
  local status=0
  cutover "$from" "$to" || status=$?
  case $status in
    0)
      echo "Updated Home to $new_version."
      own_home "$unit" || echo "The Home is on $new_version but did not start: the next start starts it." >&2
      refresh_units || echo "The new release's units could not be written yet: the next start writes them." >&2
      record_update_result updated "$old_version" "$new_version"
      ;;
    1 | 5)
      if ((status == 1)); then
        printf '%s\n' "Home $new_version did not pass its check. Restoring $old_version." >&2
        remember_failed "$to"
      else
        printf '%s\n' "The switch to $new_version failed before it was made. Restoring $old_version." >&2
      fi
      if own_home "$unit"; then
        if ((status == 5)); then
          record_update_result failed "$old_version" "$new_version"
          fail "The update failed and was undone; the next check tries it again."
        fi
        record_update_result rolled-back "$old_version" "$new_version"
        read -r first _ < <(failed_release "$identity")
        if [[ -s "$home_dir/releases/${first:-${to##*/}}/database.dump" ]]; then
          fail "The update was rolled back. This release is not tried again by itself; the database dump taken before its first attempt is kept in $home_dir/releases/${first:-${to##*/}}/database.dump until another release updates this Home."
        fi
        fail 'The update was rolled back. This release is not tried again by itself; no dump was taken before it (the Home was not running).'
      fi
      record_update_result failed "$old_version" "$new_version"
      fail "The update failed, and $old_version did not start again (sudo opensteer-home logs host)."
      ;;
    2)
      prune_releases "$to"
      fail 'The update could not be recorded. Nothing was changed.'
      ;;
    4)
      echo "Updated Home to $new_version."
      own_home "$unit" || echo "The Home is on $new_version but did not start: the next start starts it." >&2
      record_update_result updated "$old_version" "$new_version"
      fail 'What follows the switch could not be finished; the next start finishes it, and no update runs until then.'
      ;;
    *)
      record_update_result failed "$old_version" "$new_version"
      fail "The update failed, and going back to $old_version is not finished: the next start finishes it."
      ;;
  esac
)

# rollback_home: the way back after a committed release turns out bad (opensteer-home rollback):
# `previous` becomes current by the same switch an update makes, once its images are known to be
# here, and the release left is remembered as one that failed here, so no timer installs it again.
# Never automatic: the database is as the bad release migrated it, and going back is a person's
# decision.
rollback_home() (
  local back from unit status=0
  [[ ! -e "$home_dir/update.pending" ]] || fail 'The last switch of releases is not finished yet; the next start finishes it.'
  back=$(readlink -- "$home_dir/previous") && [[ $back =~ ^releases/[a-zA-Z0-9._-]+$ && -d "$home_dir/$back" ]] ||
    fail 'This Home has no previous release to go back to.'
  release_dir=$home_dir/$back images_present ||
    fail "The previous release's images are not all on this machine. Nothing was changed."
  from=$(current_release) || exit
  unit=$(main_state)
  cutover "$from" "$home_dir/$back" || status=$?
  case $status in
    0 | 4)
      echo "Back on the previous release ($(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$home_dir/$back/images.env"))."
      remember_failed "$from"
      own_home "$unit" || echo 'The previous release is current but did not start: the next start starts it.' >&2
      ((status == 0)) || fail 'What follows the switch could not be finished; the next start finishes it.'
      refresh_units || echo "This Home's units could not be refreshed; the next start tries again." >&2
      ;;
    1 | 5)
      if own_home "$unit"; then fail 'The previous release did not pass its check; this one runs again.'; fi
      fail 'The previous release did not pass its check, and this one did not start again.'
      ;;
    2) fail 'The switch could not be recorded. Nothing was changed.' ;;
    *) fail 'The previous release did not pass its check; the next start puts this one back.' ;;
  esac
)
