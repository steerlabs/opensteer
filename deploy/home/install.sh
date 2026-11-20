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
local_tls=false prepare=false managed='' token_path='' manifest='' hostname=''
while (($#)); do
  case "$1" in
    --local) local_tls=true; shift ;;
    --prepare) prepare=true; shift ;;
    --managed|--boot-spec) (($# >= 2)) || usage; managed=$2; shift 2 ;;
    --bootstrap-token-file) (($# >= 2)) || usage; token_path=$2; shift 2 ;;
    --manifest) (($# >= 2)) || usage; manifest=$2; shift 2 ;;
    --*) usage ;;
    *) [[ -z $hostname ]] || usage; hostname=$1; shift ;;
  esac
done

if [[ -n $managed ]]; then
  [[ -z $hostname && -z $manifest && -n $token_path ]] || usage
else
  [[ -n $hostname && -z $token_path ]] || usage
fi

if [[ -n $managed && $prepare == false ]]; then
  missing=false
  for program in docker curl jq openssl flock nsenter iptables-restore ip6tables-restore; do
    command -v "$program" >/dev/null || missing=true
  done
  docker compose version >/dev/null 2>&1 || missing=true
  if $missing; then
    # shellcheck source=/dev/null
    source /etc/os-release
    [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] ||
      fail "Managed package provisioning requires Ubuntu 24.04 LTS, or an image with Docker Compose and the installer tools preinstalled."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    packages=(ca-certificates curl jq openssl util-linux iptables)
    if ! docker compose version >/dev/null 2>&1; then packages+=(docker.io docker-compose-v2); fi
    apt-get install -y --no-install-recommends "${packages[@]}"
    systemctl enable --now docker.service
  fi
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

[[ $home_dir =~ ^/[a-zA-Z0-9._/-]+$ && $home_dir != / && ${home_dir##*/} != .. ]] ||
  fail "OPENSTEER_HOME_DIR must be an absolute configuration directory."
[[ ! -L $home_dir ]] || fail "The Home configuration directory must be a real directory."
if [[ -e $home_dir ]]; then
  [[ -d $home_dir && $(stat -c '%u:%a' "$home_dir") == 0:700 ]] || fail "The Home configuration directory must be root-owned with mode 0700."
else
  install -d -m 0700 "$home_dir"
fi
install -d -m 0700 "$home_dir/secrets"
lock_home
staging=$(mktemp -d "$home_dir/install.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
setup_code=''

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
    result="$home_dir/managed-boot.$computer.$hostname.pending"
    if [[ ! -s $result ]]; then
      "$source_dir/managed-boot.sh" "$managed" "$result" "$token_path"
    fi
    if [[ -z ${OPENSTEER_HOME_RELEASE_MANIFEST_URL:-} ]]; then
      OPENSTEER_HOME_RELEASE_MANIFEST_URL=$(jq -r '.releaseManifestUrl // empty' "$result")
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
  release_to_env "$manifest" "$home_dir/images.env"
  db_password=$(random_secret)
  printf '%s\n' "$db_password" | save_secret "$home_dir/secrets/postgres_password"
  printf 'postgresql://opensteer:%s@localhost/opensteer?host=%%2Fvar%%2Frun%%2Fpostgresql\n' "$db_password" |
    save_secret "$home_dir/secrets/database_url"
  for name in auth_secret main_token messaging_token browser_token; do
    random_secret | save_secret "$home_dir/secrets/$name"
  done
  printf 'env_%s\n' "$(cat /proc/sys/kernel/random/uuid)" | save_secret "$home_dir/secrets/environment_id"

  if [[ -n $managed ]]; then
    if jq -e '.egress != null' "$result" >/dev/null; then
      for name in url username password; do
        jq -er ".egress.$name" "$result" | save_secret "$home_dir/secrets/egress_$name"
      done
    fi
    for item in repository password accessKeyId secretAccessKey; do
      jq -er ".backup.$item" "$result" > "$home_dir/secrets/backup_$item"
    done
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
    for suffix in BIND_IP HTTP_PORT HTTPS_PORT RUNNER_CPUS RUNNER_MEMORY BROWSER_CPUS BROWSER_MEMORY RELEASE_MANIFEST_URL; do
      key="OPENSTEER_HOME_$suffix"
      value=${!key:-}
      if [[ -n $value ]]; then
        [[ $value =~ $valid_value ]] || fail "Invalid value for $key."
        printf "%s='%s'\n" "$key" "$value"
      fi
    done
  } > "$staging/config.env"
  if $local_tls; then printf 'tls internal\n'; else printf '# Automatic public TLS\n'; fi > "$home_dir/tls.caddy"
fi

for name in compose.yaml compose.egress.yaml common.sh firewall.sh backup.sh update.sh opensteer-home install-scheduler.sh; do
  if [[ "$source_dir/$name" != "$home_dir/$name" ]]; then
    install -m 0600 "$source_dir/$name" "$home_dir/$name"
  fi
done
chmod 0700 "$home_dir/"{firewall.sh,opensteer-home,install-scheduler.sh}
chmod 0444 "$home_dir/tls.caddy"
if [[ -f "$staging/config.env" ]]; then
  mv -- "$staging/config.env" "$home_dir/config.env"
  if [[ -n $managed ]]; then rm -f -- "$result"; fi
fi
if $prepare; then
  install_browser_policy
else
  compose pull --quiet
  install_browser_policy
  "$home_dir/install-scheduler.sh" "$home_dir"
  # The service takes the same operation lock.
  flock -u 9
  systemctl start opensteer-home.service
fi
if [[ -z $managed && -f "$home_dir/setup-link.pending" ]]; then
  print_setup_link "$(cat "$home_dir/setup-link.pending")"
  rm -f -- "$home_dir/setup-link.pending"
fi
