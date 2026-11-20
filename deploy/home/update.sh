#!/usr/bin/env bash
# shellcheck disable=SC2154

update_home() {
  [[ $# -le 2 ]] || fail "Usage: opensteer-home update [MANIFEST.json]"
  local current_dir candidate previous active project service id tag container old_version new_version feed
  current_dir=$(mktemp -d "$home_dir/update.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf -- '$current_dir'" EXIT
  candidate="$current_dir/images.env"
  previous="$current_dir/previous.env"
  active="$home_dir/images.env"
  if [[ $# == 2 ]]; then
    release_to_env "$2" "$candidate"
  else
    feed=$(compose config --environment | sed -n 's/^OPENSTEER_HOME_RELEASE_MANIFEST_URL=//p')
    if [[ -z $feed ]]; then
      [[ $1 == scheduled-update ]] && return 0
      fail "Set OPENSTEER_HOME_RELEASE_MANIFEST_URL in config.env or supply a release manifest."
    fi
    fetch_manifest "$feed" "$current_dir/release.json"
    release_to_env "$current_dir/release.json" "$candidate"
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
    container=$(compose ps -aq "$service")
    [[ -n $container ]] || fail "Start the Home before updating."
    id=$(docker inspect --format '{{.Image}}' "$container")
    tag="opensteer-home-rollback/$project-$service:${id#sha256:}"
    docker image tag "$id" "$tag"
    printf 'OPENSTEER_HOME_%s_IMAGE=%s\n' "$(printf %s "$service" | tr 'a-z-' 'A-Z_')" "$tag" >> "$previous"
  done

  release_env="$candidate" compose pull --quiet
  release_env="$candidate" install_browser_policy
  compose down
  if release_env="$candidate" start_pod; then
    mv -f -- "$candidate" "$active"
    echo "Updated Home to $new_version."
    return
  fi
  printf '%s\n' "Home $new_version did not become healthy. Restoring $old_version." >&2
  release_env="$candidate" compose down
  mv -f -- "$previous" "$active"
  install_browser_policy
  start_pod
  fail "The update was rolled back."
}
