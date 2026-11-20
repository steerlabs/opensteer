#!/usr/bin/env bash
set -euo pipefail
umask 077
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/home/common.sh
source "$source_dir/common.sh"

usage() {
  printf '%s\n' "Usage: install.sh [--local] [--prepare] [--manifest FILE] HOSTNAME" \
    "       install.sh [--local] [--prepare] --boot-spec BOOT_SPEC.json --bootstrap-token-file FILE"
  exit 2
}

[[ $(uname -s) == Linux && $EUID == 0 ]] || fail "Run the Home installer as root on a Linux Docker host."
local_tls=false prepare=false managed='' token_path='' manifest='' hostname='' resume_managed=false
while (($#)); do
  case "$1" in
    --resume-managed) resume_managed=true; shift ;;
    --local) local_tls=true; shift ;;
    --prepare) prepare=true; shift ;;
    --managed|--boot-spec) (($# >= 2)) || usage; managed=$2; shift 2 ;;
    --bootstrap-token-file) (($# >= 2)) || usage; token_path=$2; shift 2 ;;
    --manifest) (($# >= 2)) || usage; manifest=$2; shift 2 ;;
    --*) usage ;;
    *) [[ -z $hostname ]] || usage; hostname=$1; shift ;;
  esac
done

[[ $home_dir =~ ^/[a-zA-Z0-9._/-]+$ && $home_dir != / && ${home_dir##*/} != .. ]] ||
  fail "OPENSTEER_HOME_DIR must be an absolute configuration directory."
[[ ! -L $home_dir ]] || fail "The Home configuration directory must be a real directory."
if [[ -e $home_dir ]]; then
  [[ -d $home_dir && $(stat -c '%u:%a' "$home_dir") == 0:700 ]] || fail "The Home configuration directory must be root-owned with mode 0700."
else
  install -d -m 0700 "$home_dir"
fi
unit_prefix=${OPENSTEER_HOME_UNIT_PREFIX:-opensteer-home}
[[ $unit_prefix =~ ^opensteer-home(-[a-z0-9-]+)?$ ]] || fail "Invalid Home systemd unit prefix."
if $resume_managed; then
  [[ $# == 0 && -s "$home_dir/boot/spec.json" ]] || usage
  managed="$home_dir/boot/spec.json"
  token_path="$home_dir/boot/token"
  if [[ ${OPENSTEER_HOME_LOCAL_TLS:-false} == true ]]; then local_tls=true; fi
fi
if [[ -n $managed ]]; then
  [[ -z $hostname && -z $manifest && -n $token_path ]] || usage
  [[ $token_path == /* ]] || token_path="$PWD/$token_path"
  if ! $resume_managed && ! $prepare; then
    lock_home
    for input in "$managed" "$token_path"; do
      [[ -f $input && ! -L $input && $(stat -c '%u:%a' "$input") =~ ^0:[46]00$ ]] ||
        fail "Managed boot inputs must be root-owned files with mode 0400 or 0600."
    done
    boot="$home_dir/boot"
    install -d -m 0700 "$boot"
    if [[ -f "$boot/completed" ]]; then
      cmp -s "$managed" "$boot/spec.json" || fail "This Home already completed a different managed install."
      rm -f -- "$token_path"
      exit 0
    fi
    if [[ -f "$boot/spec.json" ]]; then
      cmp -s "$managed" "$boot/spec.json" || fail "A different managed install is already staged."
    fi
    if [[ -f "$boot/refused" ]]; then
      rm -f -- "$token_path"
      exit 0
    fi
    for file in install.sh managed-boot.sh common.sh firewall.sh backup.sh update.sh opensteer-home install-scheduler.sh compose.yaml compose.egress.yaml compose.egress-pending.yaml managed-egress.sh compose.apparmor.yaml compose.ipv6.yaml; do
      install -m 0700 "$source_dir/$file" "$boot/$file"
    done
    install -m 0600 "$managed" "$boot/spec.json.new"
    mv -f -- "$boot/spec.json.new" "$boot/spec.json"
    if [[ ! -s "$boot/token" ]]; then
      install -m 0600 "$token_path" "$boot/token.new"
      mv -f -- "$boot/token.new" "$boot/token"
    elif ! cmp -s "$token_path" "$boot/token"; then
      fail "A different bootstrap token is already staged."
    fi
    printf '%s\n' "$token_path" > "$boot/original-token-path"
    {
      printf 'OPENSTEER_HOME_LOCAL_TLS=%s\n' "$local_tls"
      for key in COMPOSE_PROJECT_NAME CURL_CA_BUNDLE OPENSTEER_HOME_BIND_IP OPENSTEER_HOME_HTTP_PORT OPENSTEER_HOME_HTTPS_PORT OPENSTEER_HOME_BACKUP_NETWORK; do
        value=${!key:-}
        if [[ -n $value ]]; then
          [[ $value =~ ^[a-zA-Z0-9./_:-]+$ ]] || fail "Invalid value for $key."
          printf '%s=%s\n' "$key" "$value"
        fi
      done
    } > "$boot/options.env"
    sync -f "$boot"
    "$source_dir/install-managed-unit.sh" "$home_dir" "$unit_prefix"
    exit 0
  fi
else
  [[ -n $hostname && -z $token_path ]] || usage
fi

if [[ -n $managed && $prepare == false ]]; then
  missing=false
  for program in docker curl jq openssl flock nsenter iptables-restore ip6tables-restore; do
    command -v "$program" >/dev/null || missing=true
  done
  docker compose version >/dev/null 2>&1 || missing=true
  if [[ -d /sys/kernel/security/apparmor ]]; then
    command -v apparmor_parser >/dev/null || missing=true
  fi
  if $missing; then
    # shellcheck source=/dev/null
    source /etc/os-release
    [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] ||
      fail "Managed package provisioning requires Ubuntu 24.04 LTS, or an image with Docker Compose and the installer tools preinstalled."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    packages=(apparmor ca-certificates curl jq openssl util-linux iptables)
    if ! docker compose version >/dev/null 2>&1; then packages+=(docker.io docker-compose-v2); fi
    apt-get install -y --no-install-recommends "${packages[@]}"
  fi
  systemctl enable --now docker.service
fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  fail "Docker Engine with Compose v2 is required. On Ubuntu 24.04 run: apt-get update && apt-get install docker.io docker-compose-v2"
fi
docker info >/dev/null 2>&1 || fail "Start Docker Engine with systemctl start docker."
for program in curl jq openssl flock nsenter iptables-restore ip6tables-restore; do
  command -v "$program" >/dev/null || fail "Missing $program. On Debian/Ubuntu run: apt-get install curl jq openssl util-linux iptables"
done
if ! $prepare; then
  command -v systemctl >/dev/null || fail "systemd is required for scheduled Home operation."
fi

install -d -m 0700 "$home_dir/secrets"
lock_home
staging=$(mktemp -d "$home_dir/install.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
setup_code=''
finish_managed_boot() {
  local outcome=$1 original
  durable_marker "$home_dir/boot/$outcome"
  original=$(cat "$home_dir/boot/original-token-path")
  rm -f -- "$original" "$token_path" "$home_dir/boot/token.new" "$home_dir/boot/"{result.json,result.json.new}
  sync "${original%/*}" "$home_dir/boot"
  if [[ $outcome == refused ]]; then
    if [[ -f "$home_dir/config.env" ]]; then compose down; fi
    exit 78
  fi
  "$home_dir/install-scheduler.sh" "$home_dir" "$unit_prefix"
  flock -u 9
  systemctl start "$unit_prefix.service"
  exit 0
}
if $resume_managed; then
  for outcome in refused completed; do
    if [[ -f "$home_dir/boot/$outcome" ]]; then finish_managed_boot "$outcome"; fi
  done
fi
if [[ -n $managed ]]; then
  if $resume_managed; then result="$home_dir/boot/result.json"; else result="$staging/result.json"; fi
  if [[ ! -s $result ]]; then
    if "$source_dir/managed-boot.sh" boot "$managed" "$token_path" "$result"; then
      :
    else
      status=$?
      if $resume_managed && [[ $status == 78 ]]; then finish_managed_boot refused; fi
      exit "$status"
    fi
  fi
fi

if [[ -f "$home_dir/config.env" ]]; then
  configured_host=$(compose config --format json | jq -er .services.gateway.environment.OPENSTEER_HOME_HOSTNAME)
  if [[ -n $managed ]]; then hostname=$(jq -er .hostname "$managed"); fi
  [[ $hostname == "$configured_host" ]] || fail "This installation already uses $configured_host."
else
  if [[ -n $managed ]]; then
    hostname=$(jq -er .hostname "$managed")
    computer=$(jq -er .cloudComputerId "$managed")
    if [[ ! $computer =~ ^cc_[a-f0-9-]{36}$ ]] || ! valid_hostname "$hostname"; then
      fail "Invalid managed boot spec."
    fi
    manifest="$staging/release.json"
    jq -e .release "$result" > "$manifest"
    jq -er .setupCodeDigest "$result" | save_secret "$home_dir/secrets/setup_digest"
  else
    if [[ -z $manifest && -n ${OPENSTEER_HOME_RELEASE_MANIFEST_URL:-} ]]; then
      manifest="$staging/release.json"
      fetch_manifest "$OPENSTEER_HOME_RELEASE_MANIFEST_URL" "$manifest"
    fi
    if [[ -z $manifest ]]; then
      manifest="$staging/release.json"
      version=${OPENSTEER_HOME_VERSION:-}
      if [[ -z $version && -f "$source_dir/version" ]]; then version=$(cat "$source_dir/version"); fi
      if [[ -z $version && -f "$source_dir/../../package.json" ]]; then
        version=$(jq -er .version "$source_dir/../../package.json")
      fi
      jq -n --arg version "$version" '{version:$version}' > "$manifest"
    fi
    setup_code=$(random_secret)
    printf '%s' "$setup_code" > "$home_dir/setup-link.pending"
    printf '%s' "$setup_code" | digest | save_secret "$home_dir/secrets/setup_digest"
  fi

  valid_hostname "$hostname" || fail "Use a fully qualified lowercase DNS hostname."
  pinned=false
  if [[ -n $managed ]]; then pinned=true; fi
  release_to_env "$manifest" "$home_dir/images.env" "$pinned"
  db_password=$(random_secret)
  printf '%s\n' "$db_password" | save_secret "$home_dir/secrets/postgres_password"
  printf 'postgresql://opensteer:%s@localhost/opensteer?host=%%2Fvar%%2Frun%%2Fpostgresql\n' "$db_password" |
    save_secret "$home_dir/secrets/database_url"
  for name in auth_secret main_token messaging_token browser_token; do
    random_secret | save_secret "$home_dir/secrets/$name"
  done
  printf 'env_%s\n' "$(cat /proc/sys/kernel/random/uuid)" | save_secret "$home_dir/secrets/environment_id"

  if [[ -n $managed ]]; then
    if jq -e '.ipv6Enabled' "$result" >/dev/null; then touch "$home_dir/ipv6.enabled"; fi
    touch "$home_dir/managed"
    if jq -e '.work != null' "$result" >/dev/null; then
      jq -ce .work "$result" | save_secret "$home_dir/managed-work.json"
    fi
    OPENSTEER_HOME_RELEASE_MANIFEST_URL=$(jq -r '.releaseManifestUrl // empty' "$result")
    if valid_managed_egress "$result"; then
      save_managed_egress "$result"
    fi
    for item in repository password accessKeyId secretAccessKey; do
      jq -er ".backup.$item" "$result" > "$home_dir/secrets/backup_$item"
    done
    # A Cloud Computer's Home is claimed by its Account and signs its owner in with it.
    # shellcheck disable=SC2034 # Written to config.env through ${!key} below.
    if jq -e '.managedHome != null' "$result" >/dev/null; then
      jq -er .managedHome.oidc.clientSecret "$result" | save_secret "$home_dir/secrets/oidc_client_secret"
      OPENSTEER_HOME_LOCAL_PASSWORD_ENABLED=false
      OPENSTEER_HOME_MANAGED_ID=$(jq -er .managedHome.cloudComputerId "$result")
      OPENSTEER_HOME_MANAGED_GENERATION=$(jq -er .managedHome.generation "$result")
      OPENSTEER_HOME_ACCOUNT_ORIGIN=$(jq -er .accountOrigin "$result")
      OPENSTEER_HOME_OIDC_CLIENT_ID=$(jq -er .managedHome.oidc.clientId "$result")
    fi
  elif [[ -n ${OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL:-} || -n ${OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME:-} || -n ${OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE:-} ]]; then
    [[ -n ${OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL:-} && -n ${OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME:-} &&
      -s ${OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE:-} ]] || fail "Configure all three browser egress upstream inputs."
    printf '%s\n' "$OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL" | save_secret "$home_dir/secrets/egress_url"
    printf '%s\n' "$OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME" | save_secret "$home_dir/secrets/egress_username"
    save_secret "$home_dir/secrets/egress_password" < "$OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE"
  fi
  valid_value='^[a-zA-Z0-9.:/_?&=%+-]+$'
  {
    printf 'OPENSTEER_HOME_HOSTNAME=%s\n' "$hostname"
    if [[ -n ${COMPOSE_PROJECT_NAME:-} ]]; then
      [[ $COMPOSE_PROJECT_NAME =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Invalid Compose project name.'
      printf "COMPOSE_PROJECT_NAME='%s'\n" "$COMPOSE_PROJECT_NAME"
    fi
    for suffix in BIND_IP HTTP_PORT HTTPS_PORT RUNNER_CPUS RUNNER_MEMORY BROWSER_CPUS BROWSER_MEMORY RELEASE_MANIFEST_URL \
      LOCAL_PASSWORD_ENABLED MANAGED_ID MANAGED_GENERATION ACCOUNT_ORIGIN OIDC_CLIENT_ID; do
      key="OPENSTEER_HOME_$suffix"
      value=${!key:-}
      if [[ -n $value ]]; then
        [[ $value =~ $valid_value ]] || fail "Invalid value for $key."
        printf "%s='%s'\n" "$key" "$value"
      fi
    done
  } > "$staging/config.env"
  if [[ -z $managed ]]; then
    case ${OPENSTEER_HOME_IPV6_ENABLED:-false} in
      true) touch "$home_dir/ipv6.enabled" ;;
      false) ;;
      *) fail "OPENSTEER_HOME_IPV6_ENABLED must be true or false." ;;
    esac
  fi
  if $local_tls; then printf 'tls internal\n'; else printf '# Automatic public TLS\n'; fi > "$home_dir/tls.caddy"
fi

for name in compose.yaml compose.egress.yaml compose.egress-pending.yaml managed-egress.sh compose.apparmor.yaml compose.ipv6.yaml common.sh firewall.sh backup.sh update.sh opensteer-home install-scheduler.sh; do
  if [[ "$source_dir/$name" != "$home_dir/$name" ]]; then
    install -m 0600 "$source_dir/$name" "$home_dir/$name"
  fi
done
chmod 0700 "$home_dir/"{firewall.sh,opensteer-home,install-scheduler.sh}
# Compose mounts it on every Home; a bring-your-own Home's stays empty.
[[ -e "$home_dir/secrets/oidc_client_secret" ]] || : | save_secret "$home_dir/secrets/oidc_client_secret"
chmod 0444 "$home_dir/tls.caddy"
if [[ -f "$staging/config.env" ]]; then
  sync -f "$home_dir"
  publish_file "$staging/config.env" "$home_dir/config.env"
fi
if $prepare; then
  install_sandbox_policies
else
  compose pull --quiet
  if $resume_managed; then check_release_stamps "$home_dir/images.env"; fi
  install_sandbox_policies
  if $resume_managed; then
    snapshot=$(jq -r '.restoreSnapshot // empty' "$result")
    if [[ -n $snapshot ]]; then
      # shellcheck source=deploy/home/backup.sh
      source "$home_dir/backup.sh"
      backup_command managed-restore "$snapshot"
    fi
    start_pod
    identity=$(local_discovery)
    if [[ -s "$home_dir/boot/identity.json" ]]; then
      [[ $identity == "$(cat "$home_dir/boot/identity.json")" ]] || finish_managed_boot refused
    else
      printf '%s\n' "$identity" > "$staging/identity.json"
      publish_file "$staging/identity.json" "$home_dir/boot/identity.json"
    fi
    if "$source_dir/managed-boot.sh" boot-complete "$managed" "$token_path" "$identity"; then
      :
    else
      status=$?
      if [[ $status == 78 ]]; then finish_managed_boot refused; fi
      exit "$status"
    fi
    finish_managed_boot completed
  fi
  "$home_dir/install-scheduler.sh" "$home_dir" "$unit_prefix"
  flock -u 9
  systemctl start "$unit_prefix.service"
fi
if [[ -z $managed && -f "$home_dir/setup-link.pending" ]]; then
  print_setup_link "$(cat "$home_dir/setup-link.pending")"
  rm -f -- "$home_dir/setup-link.pending"
fi
