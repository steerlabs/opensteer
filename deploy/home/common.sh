#!/usr/bin/env bash
set -euo pipefail
umask 077
home_dir=${OPENSTEER_HOME_DIR:-/etc/opensteer-home}
unset release_env volume_env stage_project
services=(host gateway runner browser-runtime browser-egress channel-runtime)
default_home_dir=/etc/opensteer-home
# A Home keeps each release whole in its own directory, releases/<id>: these files (the installer
# bundles exactly these, beside its version), the release's image selector (images.env), its
# sandbox policies and the database dump taken before it. `current` names the one the Home runs.
# The Home's own state (config.env, volumes.env, secrets, backups, results) lives beside
# releases/, never in it. The packager, the installer and an update all read this one list.
release_files=(install.sh managed-boot.sh install-managed-unit.sh common.sh firewall.sh backup.sh update.sh machine-status.sh opensteer-home install-scheduler.sh compose.yaml compose.egress.yaml compose.egress-pending.yaml managed-egress.sh compose.apparmor.yaml compose.ipv6.yaml compose.browser-pool.yaml)
# The release this code belongs to: its own directory.
release_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fail() { printf '%s\n' "$*" >&2; exit 1; }

lock_home() {
  exec 9>"$home_dir/operation.lock"
  flock -x 9
}

compose() {
  local project
  project=$(sed -n "s/^COMPOSE_PROJECT_NAME='\([^']*\)'$/\1/p" "$home_dir/config.env") || return
  local args=(--project-directory "$home_dir" --env-file "$home_dir/config.env"
    --env-file "${release_env:-$release_dir/images.env}" -f "$release_dir/compose.yaml")
  local apparmor='' oidc_path=''
  if [[ -s "$home_dir/runner-apparmor.name" ]]; then
    apparmor=$(cat "$home_dir/runner-apparmor.name") || return
    args+=(-f "$release_dir/compose.apparmor.yaml")
  fi
  if [[ -f "$home_dir/ipv6.enabled" ]]; then args+=(-f "$release_dir/compose.ipv6.yaml"); fi
  # A Cloud Computer whose boot answer said browserPool: its browser runs on a pool host, and
  # its services' limits come from the machine it is on.
  local limits=() sized line
  if [[ -f "$home_dir/browser-pool" ]]; then args+=(-f "$release_dir/compose.browser-pool.yaml"); fi
  if [[ -f "$home_dir/browser-pool" ]]; then
    # Only what creates or starts containers needs this machine's limits: an operator can stop,
    # inspect, back up or uninstall a Home on any machine, so the rest gets placeholders that
    # are never applied.
    if [[ " up create start restart run " == *" ${1:-} "* ]]; then
      # shellcheck disable=SC2046 # machine_size prints two numbers.
      sized=$(home_limits $(machine_size)) || return
    else
      sized=$(home_limits_unused)
    fi
    while IFS= read -r line; do limits+=("$line"); done <<< "$sized"
  fi
  if [[ -s "$home_dir/secrets/egress_url" ]]; then
    args+=(-f "$release_dir/compose.egress.yaml")
  elif [[ -f "$home_dir/managed" && ! -f "$home_dir/browser-pool" ]]; then
    # A pooled Cloud Computer's browser leaves through its own address on the pool host.
    args+=(-f "$release_dir/compose.egress-pending.yaml")
  fi
  if [[ -s "$home_dir/secrets/oidc_client_secret" ]]; then
    oidc_path=/run/secrets/oidc_client_secret
  fi
  if [[ -n ${volume_env:-} ]]; then args+=(--env-file "$volume_env");
  elif [[ -f "$home_dir/volumes.env" ]]; then args+=(--env-file "$home_dir/volumes.env"); fi
  if [[ -n ${stage_project:-$project} ]]; then args+=(--project-name "${stage_project:-$project}"); fi
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    OPENSTEER_HOME_RUNNER_APPARMOR="$apparmor" OPENSTEER_HOME_OIDC_CLIENT_SECRET_PATH="$oidc_path" \
    OPENSTEER_HOME_RELEASE_DIR="$release_dir" \
    "${limits[@]}" docker compose "${args[@]}" "$@"
}

# The services that run on this Home, one per line. On a Cloud Computer the browser runs in the
# browser pool, so neither the Browser Runtime nor its egress proxy runs here
# (compose.browser-pool.yaml scales both to zero); every Home still selects all six images.
running_services() {
  local service
  for service in "${services[@]}"; do
    if [[ -f "$home_dir/browser-pool" && ( $service == browser-runtime || $service == browser-egress ) ]]; then
      continue
    fi
    printf '%s\n' "$service"
  done
}

# This machine's memory in MiB (what Linux reports as MemTotal) and its CPU count.
machine_size() {
  printf '%s %s\n' "$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)" "$(nproc)"
}

# clamp <value> <lowest> <highest>
clamp() { if (($1 < $2)); then echo "$2"; elif (($1 > $3)); then echo "$3"; else echo "$1"; fi; }

# home_limits <memory MiB> <cpus>: the CPU and memory limit of each service that runs on a Cloud
# Computer's Home, whose browser runs in the browser pool (no Browser Runtime or egress proxy
# runs here). The memory limits add up to the machine less what the kernel, Docker and the system
# keep, so the services together can never take more than the machine has. The other services'
# limits are about twice what they used at the peak of a Run, and the Runner gets the rest:
# measured on a scratch e2-medium Cloud Computer (3,908 MiB) on Nov 25, during one Run of OpenCode
# 1.18.32 writing a 500-word essay, the Host used 330 MiB, PostgreSQL 97, the gateway 17, the
# Channel Runtime 75, and the machine about 670 outside its containers. CPU limits are each
# service's ceiling of CPU time, not a reservation: none is above the machine's CPU count, and
# the Runner may use them all. The Runner runs as many Runs at once as its memory holds at
# run_allowance MiB each beside its own, at least one; the Host holds the next one back.
home_limits() {
  local memory=$1 cpus=$2 reserve budget postgres host gateway channel agents runs two
  # Memory for one Run of the person's own agents. Measured on that machine and Run: OpenCode's
  # engine peaked at 0.98 to 1.06 GiB of anonymous memory, in a garbage collector's sawtooth that
  # touched the Runner's old 1,092 MiB limit (two Runs of three were killed for memory). Allowed:
  # that peak and half again. The other engines are not measured yet (they need a sign-in).
  local run_allowance=1536
  # The Runner's own process and its supervisor: 131 MiB at rest there, 152 at that peak.
  local runner_itself=192
  [[ $memory =~ ^[0-9]+$ ]] || fail "Invalid machine memory: $memory"
  if [[ ! $cpus =~ ^[0-9]+$ ]] || ((cpus < 1)); then fail "Invalid machine CPU count: $cpus"; fi
  # An eighth of the machine, at least 768 MiB: about 670 were in use outside the containers.
  reserve=$(clamp $((memory / 8)) 768 "$memory")
  budget=$((memory - reserve))
  postgres=$(clamp $((budget / 16)) 256 2048)
  host=$(clamp $((budget / 8)) 640 2048)
  gateway=$(clamp $((budget / 64)) 64 256)
  channel=$(clamp $((budget / 32)) 160 512)
  agents=$((budget - postgres - host - gateway - channel))
  ((agents >= runner_itself + run_allowance)) ||
    fail "This machine (${memory} MiB) is too small for a Cloud Computer's Home."
  # At most the Runner's own limit of 1,000 Runs at once.
  runs=$(clamp $(((agents - runner_itself) / run_allowance)) 1 1000)
  two=$(clamp 2 1 "$cpus")
  printf '%s\n' \
    "OPENSTEER_HOME_LIMIT_POSTGRES_CPUS=$two" "OPENSTEER_HOME_LIMIT_POSTGRES_MEMORY=${postgres}m" \
    "OPENSTEER_HOME_LIMIT_HOST_CPUS=$two" "OPENSTEER_HOME_LIMIT_HOST_MEMORY=${host}m" \
    "OPENSTEER_HOME_LIMIT_GATEWAY_CPUS=1" "OPENSTEER_HOME_LIMIT_GATEWAY_MEMORY=${gateway}m" \
    "OPENSTEER_HOME_LIMIT_RUNNER_CPUS=$cpus" "OPENSTEER_HOME_LIMIT_RUNNER_MEMORY=${agents}m" \
    "OPENSTEER_HOME_LIMIT_RUNNER_RUNS=$runs" \
    "OPENSTEER_HOME_LIMIT_CHANNEL_CPUS=1" "OPENSTEER_HOME_LIMIT_CHANNEL_MEMORY=${channel}m"
}

# Limits for a command that creates no container (down, stop, logs, config, pull, ...): Compose
# reads every file even then, so each variable is set, to a value nothing applies.
home_limits_unused() {
  local name
  for name in POSTGRES HOST GATEWAY RUNNER CHANNEL; do
    printf '%s\n' "OPENSTEER_HOME_LIMIT_${name}_CPUS=1" "OPENSTEER_HOME_LIMIT_${name}_MEMORY=64m"
  done
  printf '%s\n' "OPENSTEER_HOME_LIMIT_RUNNER_RUNS=1"
}

publish_file() {
  sync "$1" && mv -f -- "$1" "$2" && sync "${2%/*}"
}

durable_marker() {
  touch "$1" && sync "$1" && sync "${1%/*}"
}

recovery_needs_operator() {
  printf '%s recovery evidence is inconsistent. Leaving both sets in place; operator intervention is required.\n' "$1" >&2
  return 1
}

clean_retired_journal() {
  local journal=$1 retired="$1.retired"
  [[ -e $retired || -L $retired ]] || return 0
  [[ ! -e $journal && ! -L $journal && -d $retired && ! -L $retired ]] ||
    { recovery_needs_operator "$journal"; return 1; }
  sync "${journal%/*}" && rm -rf -- "$retired"
}

retire_journal() {
  mv -- "$1" "$1.retired" && clean_retired_journal "$1"
}

random_secret() { openssl rand -hex 32; }

save_secret() {
  local path=$1 tmp
  tmp=$(mktemp "${path}.XXXXXX") || return
  if ! { cat > "$tmp" && chmod 0444 "$tmp" && publish_file "$tmp" "$path"; }; then
    rm -f -- "$tmp"
    return 1
  fi
}

valid_managed_egress() {
  jq -e '
    def credential: type == "string" and length <= 255 and test("[^[:space:]]") and (test("[[:cntrl:]]") | not);
    .egress | type == "object" and keys == ["password", "url", "username"] and
    (.url | type == "string" and length <= 2048 and
      test("^https://(\\[[a-fA-F0-9:.]+\\]|[a-zA-Z0-9.-]+)(:[0-9]{1,5})?/?\\z") and
      ((rtrimstr("/") | capture(":(?<port>[0-9]+)$").port | tonumber) // 443 | . > 0 and . <= 65535)) and
    (.username | credential and (contains(":") | not)) and (.password | credential)
  ' "$1" >/dev/null 2>&1
}

save_managed_egress() {
  local upstream name
  upstream=$(jq -er '.egress.url | rtrimstr("/")' "$1") || return
  if [[ ! $upstream =~ :[0-9]+$ ]]; then upstream+=:443; fi
  for name in username password; do
    jq -er ".egress.$name" "$1" | save_secret "$home_dir/secrets/egress_$name" || return
  done
  printf '%s\n' "$upstream" | save_secret "$home_dir/secrets/egress_url"
}

digest() { openssl dgst -sha256 -r | cut -d ' ' -f 1; }

valid_hostname() {
  local label
  [[ ${#1} -le 253 && $1 =~ ^[a-z0-9.-]+$ && $1 == *.* && $1 != .* && $1 != *. && $1 != *..* ]] || return 1
  local labels
  IFS=. read -ra labels <<< "$1"
  for label in "${labels[@]}"; do
    [[ $label =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
  done
  [[ ${labels[-1]} =~ ^[a-z] ]]
}

managed_feed_resolution() {
  timeout 10s python3 -I - "$1" <<'PY'
import ipaddress
import re
import socket
import sys
from urllib.parse import urlsplit

try:
    url = sys.argv[1]
    if not re.fullmatch(r"https://[a-zA-Z0-9.:/_=%+-]{1,2040}", url):
        raise ValueError()
    parsed = urlsplit(url)
    host = parsed.hostname
    port = parsed.port if parsed.port is not None else 443
    if not host or not re.fullmatch(r"[a-z0-9.-]+", host) or port == 0:
        raise ValueError()
    if host.rstrip('.').endswith('.localhost') or host.rstrip('.') == 'localhost':
        raise ValueError()
    addresses = dict.fromkeys(ipaddress.ip_address(item[4][0]) for item in
                             socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
    if not addresses:
        raise ValueError()
    for address in addresses:
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        if (not address.is_global or address.is_multicast or address.is_reserved or
                (address.version == 6 and (address.sixtofour or address.teredo or
                                           address.is_site_local))):
            raise ValueError()
    print(f"{host}:{port}:" + ",".join(f"[{ip}]" if ip.version == 6 else str(ip) for ip in addresses))
except (OSError, ValueError):
    sys.exit(1)
PY
}

# The feed address in config.env, quoted ('https://…') or bare; empty when there is none.
configured_feed() {
  local line pattern='https://[a-zA-Z0-9.:/_=%+-]+'
  line=$(grep -m1 '^OPENSTEER_HOME_RELEASE_MANIFEST_URL=' "$home_dir/config.env") || return 0
  if [[ $line =~ ^OPENSTEER_HOME_RELEASE_MANIFEST_URL=\'($pattern)\'$ ||
    $line =~ ^OPENSTEER_HOME_RELEASE_MANIFEST_URL=($pattern)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return
  fi
  fail "config.env has an OPENSTEER_HOME_RELEASE_MANIFEST_URL line this Home cannot read. Write it as OPENSTEER_HOME_RELEASE_MANIFEST_URL='https://…'."
}

# Whether a feed address passes the checks boot applies: plain HTTPS of the allowed characters,
# resolving only to public addresses.
valid_managed_feed() {
  [[ ${#1} -le 2048 && $1 =~ ^https://[a-zA-Z0-9.:/_=%+-]+$ ]] &&
    managed_feed_resolution "$1" >/dev/null
}

# ask_account <route> <answer file>: GET a managed Home's own route on its Opensteer account
# (/v1/cloud-computers/<id>/<route>) with its OIDC client credentials, as the egress check does.
# Succeeds only on HTTP 200, with the answer in the file.
ask_account() {
  local route=$1 answer=$2 origin id client_id status
  origin=$(sed -n "s/^OPENSTEER_HOME_ACCOUNT_ORIGIN='\([^']*\)'$/\1/p" "$home_dir/config.env")
  id=$(sed -n "s/^OPENSTEER_HOME_MANAGED_ID='\([^']*\)'$/\1/p" "$home_dir/config.env")
  client_id=$(sed -n "s/^OPENSTEER_HOME_OIDC_CLIENT_ID='\([^']*\)'$/\1/p" "$home_dir/config.env")
  [[ $origin =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ && $id =~ ^cc_[a-f0-9-]{36}$ &&
    $client_id =~ ^occ_[a-f0-9-]{36}$ && -s "$home_dir/secrets/oidc_client_secret" ]] || return
  status=$(printf 'user = "%s:%s"\n' "$client_id" "$(cat "$home_dir/secrets/oidc_client_secret")" |
    curl -q --config - --basic --silent --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 20 --max-filesize 16384 \
      --output "$answer" --write-out '%{http_code}' \
      -- "$origin/v1/cloud-computers/$id/$route") && [[ $status == 200 ]]
}

# The feed a managed Home updates from, on stdout: the one its Opensteer account gives now, when it
# answers and the address passes the boot checks (config.env is rewritten when it changed), and
# otherwise the one config.env has. An address that fails the checks is never used.
managed_feed() {
  local configured asked='' answer recipe=${1:-}
  configured=$(configured_feed) || return
  answer=$(mktemp "$home_dir/feed.XXXXXX") || return
  if ask_account release-feed "$answer"; then
    asked=$(jq -r '.releaseManifestUrl | select(type == "string")' "$answer" 2>/dev/null) || asked=''
    if [[ -n $asked ]] && valid_managed_feed "$asked"; then
      # The recipe of the account's release, pinned in its own config, taken with the feed it
      # names only once that feed passed the checks: kept for the update to fetch.
      if [[ -n $recipe ]]; then
        jq -ce '.recipe | select(type == "object" and (.url | type) == "string" and
          (.sha256 | type) == "string" and (.sha256 | test("^[0-9a-f]{64}$")))' "$answer" \
          > "$recipe" 2>/dev/null || rm -f -- "$recipe"
      fi
      rm -f -- "$answer"
      if [[ $asked != "$configured" ]]; then
        set_configured_feed "$asked" || return
        echo "This Home now follows the update feed its Opensteer account gives: $asked" >&2
      fi
      printf '%s\n' "$asked"
      return
    fi
    echo "The Opensteer account's update feed failed the checks; keeping this Home's own." >&2
  else
    echo "The Opensteer account did not answer for its update feed; using this Home's own." >&2
  fi
  rm -f -- "$answer"
  [[ -z $configured ]] && return 0
  valid_managed_feed "$configured" || fail "This Home's update feed failed the checks: $configured"
  printf '%s\n' "$configured"
}

set_configured_feed() {
  local tmp status=0
  tmp=$(mktemp "$home_dir/config.env.XXXXXX") || return
  # grep finding no other line is fine (1); a failed read or write (2) never replaces config.env.
  grep -v '^OPENSTEER_HOME_RELEASE_MANIFEST_URL=' "$home_dir/config.env" > "$tmp" || status=$?
  if ((status > 1)) || ! printf "OPENSTEER_HOME_RELEASE_MANIFEST_URL='%s'\n" "$1" >> "$tmp" ||
    ! publish_file "$tmp" "$home_dir/config.env"; then
    rm -f -- "$tmp"
    return 1
  fi
}

# release_change <active selection> <candidate selection>: same (this exact release), rebuild (the
# same version with other images), newer or older.
release_change() {
  local old new
  if cmp -s "$1" "$2"; then echo same; return; fi
  old=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$1")
  new=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$2")
  if [[ $old == "$new" ]]; then echo rebuild
  elif [[ $(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -1) == "$new" ]]; then echo newer
  else echo older; fi
}

fetch_manifest() {
  local resolution args=()
  if [[ ${3:-false} == true ]]; then
    resolution=$(managed_feed_resolution "$1") || fail 'The Account update feed must resolve only to public HTTPS addresses.'
    args=(--noproxy '*' --resolve "$resolution")
  fi
  curl -q --fail --silent --show-error --proto '=https' --tlsv1.2 \
    "${args[@]}" --connect-timeout 10 --max-time 30 --max-filesize 131072 --output "$2" -- "$1"
}

release_to_env() {
  local manifest=$1 destination=$2 pinned=${3:-false} service ref version tmp
  version=$(jq -er '.version | select(type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\z") and length <= 79 and . != "0.0.0")' "$manifest") ||
      fail "Invalid Home release version."
  if "$pinned"; then
    jq -e '.images | keys == ["browser-egress","browser-runtime","channel-runtime","gateway","host","runner"]' "$manifest" >/dev/null ||
      fail 'Managed Home releases require exactly six images.'
  fi
  tmp=$(mktemp "${destination}.XXXXXX") || fail 'The release selector could not be written.'
  printf 'OPENSTEER_HOME_VERSION=%s\n' "$version" > "$tmp" || fail 'The release selector could not be written.'
  for service in "${services[@]}"; do
    if ! ref=$(jq -er --arg service "$service" --arg version "$version" --argjson pinned "$pinned" '
      (if $pinned then .images[$service]
       else .images[$service] // ("ghcr.io/steerlabs/opensteer-home-" + $service + ":" + $version)
       end) |
      select(type == "string" and length <= 512 and
        (if $pinned then test("^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}\\z")
         else test("^[a-z0-9][a-z0-9./:_-]*[a-z0-9_.-](@sha256:[a-f0-9]{64})?\\z"; "i") end))
    ' "$manifest"); then
      rm -f -- "$tmp"
      if "$pinned"; then fail "Managed Home releases require a digest for $service."; fi
      fail "Invalid image reference for $service."
    fi
    printf 'OPENSTEER_HOME_%s_IMAGE=%s\n' "$(printf %s "$service" | tr 'a-z-' 'A-Z_')" "$ref" >> "$tmp" ||
      fail 'The release selector could not be written.'
  done
  publish_file "$tmp" "$destination" || { rm -f -- "$tmp"; fail 'The release selector could not be written.'; }
}

compose_project() { compose config --format json | jq -er '.name'; }

check_release_stamps() {
  local selector=$1 version service image actual config
  version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$selector") || return
  config=$(release_env="$selector" compose config --format json) || return
  # Only the images this Home runs: a Cloud Computer never runs the two browser ones.
  for service in $(running_services); do
    image=$(jq -er --arg service "$service" '.services[$service].image' <<< "$config") || return
    actual=$(docker run --rm --network none --user 0:0 --entrypoint cat "$image" /usr/local/share/opensteer/release.json |
      jq -er '.version') || fail "Could not read the $service release stamp."
    [[ $actual == "$version" ]] || fail "The $service image does not match release $version."
  done
}

install_sandbox_policies() {
  local destination=${1:-$release_dir} service policy image tmp
  for service in browser-runtime runner; do
    # No Browser Runtime runs on a Cloud Computer: Compose needs no policy for a service it
    # never creates, and its image is never pulled there.
    if ! running_services | grep -qx -- "$service"; then continue; fi
    case "$service" in
      browser-runtime) policy=chromium-oci.json ;;
      runner) policy=runner-oci.json ;;
    esac
    image=$(compose config --format json | jq -er --arg service "$service" '.services[$service].image') || return
    tmp=$(mktemp "$destination/$policy.XXXXXX") || return
    if docker run --rm --network none --entrypoint cat "$image" "/usr/local/share/opensteer/$policy" > "$tmp"; then
      mv -f -- "$tmp" "$destination/$policy"
    else
      rm -f -- "$tmp"
      return 1
    fi
  done
}

runner_apparmor_rules() {
  printf 'abi <abi/4.0>,\nprofile %s flags=(unconfined) {\n  userns,\n}\n' "$1"
}

prepare_runner_apparmor() {
  local profile name
  name=$(compose_project) || return
  profile="${name}-runner-userns"
  if docker info --format '{{json .SecurityOptions}}' | jq -e 'any(.[]; startswith("name=apparmor"))' >/dev/null; then
    command -v apparmor_parser >/dev/null || fail "Install the apparmor package for the Home Runner profile."
    runner_apparmor_rules "$profile" | apparmor_parser -r -K || return
    printf '%s\n' "$profile" > "$home_dir/runner-apparmor.name"
  else
    rm -f -- "$home_dir/runner-apparmor.name"
  fi
}

# Unloads the Runner profile this Home loaded; one that is no longer loaded (after a reboot,
# say) is already gone.
remove_runner_apparmor() {
  local profile
  if [[ -s "$home_dir/runner-apparmor.name" ]]; then
    profile=$(cat "$home_dir/runner-apparmor.name")
    if [[ -r /sys/kernel/security/apparmor/profiles ]] &&
      grep -q "^$profile (" /sys/kernel/security/apparmor/profiles; then
      runner_apparmor_rules "$profile" | apparmor_parser -R
    fi
    rm -f -- "$home_dir/runner-apparmor.name"
  fi
}

host_pid() {
  local owner
  owner=$(compose ps -q host) && [[ -n $owner ]] && docker inspect --format '{{.State.Pid}}' "$owner"
}

# This Home's own Compose project, as compose() names it outside a staged restore: the name it
# passes, or compose.yaml's own (compose_project asks Compose itself, at a Compose CLI's cost).
pod_project() {
  local project
  project=$(sed -n "s/^COMPOSE_PROJECT_NAME='\([^']*\)'$/\1/p" "$home_dir/config.env") || return
  printf '%s\n' "${project:-opensteer-home}"
}

# The pod as Docker has it: one line per container of this Home's project (no one-off runs) with
# its service, state, health (none without a check) and PID. Two docker calls in place of a
# Compose CLI each for the Host's PID, the health check and the machine status: each of those
# parses every recipe file, most of a maintenance pass's CPU.
pod_snapshot() {
  local project ids
  project=$(pod_project) || return
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project" \
    --filter label=com.docker.compose.oneoff=False) || return
  [[ -n $ids ]] || return 0
  # shellcheck disable=SC2086 # One container ID per word.
  docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.Pid}}' $ids
}

# snapshot_host_pid SNAPSHOT: the Host's PID while it runs; fails when it does not.
snapshot_host_pid() {
  local service state health pid
  while read -r service state health pid; do
    if [[ $service == host && $state == running && $pid =~ ^[1-9][0-9]*$ ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
  done <<< "$1"
  return 1
}

# pod_healthy SNAPSHOT: as many containers of the Home's services as run here, all healthy.
pod_healthy() {
  local service state health pid count=0 expected
  expected=$(($(running_services | wc -l) + 1))
  while read -r service state health pid; do
    [[ " postgres ${services[*]} " == *" $service "* ]] || continue
    [[ $health == healthy ]] || return 1
    count=$((count + 1))
  done <<< "$1"
  ((count == expected))
}

# The pool network (CIDR, then agent,relay ports) a Cloud Computer's firewall lets it reach.
# The pool network (CIDR, then agent,relay ports) a Cloud Computer's firewall lets its Host reach:
# read only on a Home whose boot answer said browserPool, so a file left behind opens nothing.
pool_network_args() {
  local cidr ports
  [[ -f "$home_dir/browser-pool" && -f "$home_dir/pool-network" ]] || return 0
  read -r cidr ports < "$home_dir/pool-network" || return
  printf '%s\n' "$cidr" "$ports"
}

firewall() {
  local pid=$1 action=$2 ipv6=false pool=() line listed
  if [[ -f "$home_dir/ipv6.enabled" ]]; then ipv6=true; fi
  listed=$(pool_network_args) || return
  if [[ -n $listed ]]; then while IFS= read -r line; do pool+=("$line"); done <<< "$listed"; fi
  "$release_dir/firewall.sh" "$pid" "$action" "$ipv6" "${pool[@]}"
}

apply_firewall() { firewall "$1" apply; }

check_firewall() { firewall "$1" check; }

# Whether firewall.sh (beside this file) accepts this pool network: one check for every source.
valid_pool_network() {
  bash "$(dirname -- "${BASH_SOURCE[0]}")/firewall.sh" validate-pool "$1" "$2"
}

# The pool network in a JSON answer's browserPoolNetwork, as "CIDR AGENT,RELAY", when valid.
pool_network_from() {
  local network cidr ports
  network=$(jq -er '.browserPoolNetwork |
    select((.cidr | type) == "string" and (.agentPort | type) == "number" and
      (.relayPort | type) == "number" and .agentPort == (.agentPort | floor) and
      .relayPort == (.relayPort | floor)) |
    "\(.cidr) \(.agentPort),\(.relayPort)"' "$1" 2>/dev/null) || return
  [[ $network =~ ^([0-9./]+)\ ([0-9]+,[0-9]+)$ ]] || return
  cidr=${BASH_REMATCH[1]} ports=${BASH_REMATCH[2]}
  valid_pool_network "$cidr" "$ports" || return
  printf '%s\n' "$network"
}

# Whether a saved boot answer may be used again: a JSON object holding what install.sh reads
# from it next (the release and the credentials), and for a pooled Home a valid pool network (one
# saved by an install before this release may not). A file that does not parse is not usable.
usable_boot_answer() {
  local pooled
  pooled=$(jq -r 'def text: type == "string" and length > 0;
    select(type == "object" and (.release | type) == "object" and (.setupCodeDigest | text) and
      all(.backup.repository, .backup.password, .backup.accessKeyId, .backup.secretAccessKey; text) and
      (.managedHome == null or ((.accountOrigin | text) and (.managedHome.cloudComputerId | text) and
        (.managedHome.generation | type) == "number" and
        (.managedHome.oidc.clientId | text) and (.managedHome.oidc.clientSecret | text)))) |
    .browserPool == true' "$1" 2>/dev/null) || return 1
  case $pooled in false) ;; true) pool_network_from "$1" >/dev/null ;; *) return 1 ;; esac
}

# Keeps a pooled Cloud Computer's pool network from its boot answer for its firewall. A pooled
# Home without one, or with one firewall.sh refuses, would have no path to its browser: refused.
save_pool_network() {
  local result=$1 network
  jq -e '.browserPool == true' "$result" >/dev/null || return 0
  network=$(pool_network_from "$result") ||
    fail 'The boot answer has no valid pool network: this Cloud Computer could not reach its browser.'
  printf '%s\n' "$network" > "$home_dir/pool-network"
}

# A pooled Home asks its Opensteer account for its pool network after each start (start_pod
# forgets the last ask) and then at most once every five minutes: it changes only when an
# operator moves the pool. Succeeds only when it changed and was saved (the caller re-applies the
# firewall); a network that fails the checks, or no answer, keeps the one it has, and says so.
refresh_pool_network() {
  local answer network current='' asked="$home_dir/pool-network-asked"
  [[ -f "$home_dir/managed" && -f "$home_dir/browser-pool" ]] || return 1
  if [[ -f $asked && -z $(find "$asked" -mmin +5 2>/dev/null) ]]; then return 1; fi
  touch "$asked" || return 1
  answer=$(mktemp "$home_dir/pool-network.XXXXXX") || return 1
  if ! ask_account pool-network "$answer"; then
    rm -f -- "$answer"
    echo "The Opensteer account did not answer for its pool network; keeping this Home's own." >&2
    return 1
  fi
  if ! network=$(pool_network_from "$answer"); then
    rm -f -- "$answer"
    echo "The Opensteer account's pool network failed the checks; keeping this Home's own." >&2
    return 1
  fi
  [[ -f "$home_dir/pool-network" ]] && current=$(cat "$home_dir/pool-network")
  if [[ $network == "$current" ]]; then
    rm -f -- "$answer"
    return 1
  fi
  printf '%s\n' "$network" > "$answer"
  publish_file "$answer" "$home_dir/pool-network" || return 1
  echo "This Home now reaches the pool network its Opensteer account gives: $network" >&2
}

start_pod() {
  local pid namespace
  # The next maintenance pass asks for the pool network again.
  rm -f -- "$home_dir/pool-network-asked"
  prepare_runner_apparmor || return
  if compose up -d --wait --wait-timeout 240 --pull never postgres host &&
    pid=$(host_pid) && namespace=$(readlink "/proc/$pid/ns/net") &&
    apply_firewall "$pid" && check_firewall "$pid" &&
    [[ $(host_pid) == "$pid" && $(readlink "/proc/$pid/ns/net") == "$namespace" ]] &&
    compose up -d --wait --wait-timeout 240 --no-recreate --pull never &&
    [[ $(host_pid) == "$pid" && $(readlink "/proc/$pid/ns/net") == "$namespace" ]] &&
    check_firewall "$pid" && printf '%s\n' "$pid" > "$home_dir/host.pid"; then
    return 0
  fi
  compose logs --no-color --tail 20 >&2 || true
  compose down
  return 1
}

local_discovery() {
  compose exec -T host node -e '
    const {createHash,createPublicKey}=require("node:crypto");
    const origin=new URL(process.env.OPENSTEER_CANONICAL_ORIGIN);
    (async () => {
      const response=await fetch("http://127.0.0.1:4310/.well-known/opensteer",{
        headers:{host:origin.host,"x-forwarded-proto":"https"}, signal:AbortSignal.timeout(5000)
      });
      if (!response.ok) throw Error("Discovery returned HTTP "+response.status);
      const {authority:{document,publicKey}}=await response.json();
      const localKey=createPublicKey(require("node:fs").readFileSync(process.env.OPENSTEER_HOST_PUBLIC_KEY_PATH));
      const spki=localKey.export({format:"der",type:"spki"});
      if (!spki.equals(Buffer.from(publicKey.spki,"base64url"))) throw Error("Discovery key differs from local Host key");
      console.log(JSON.stringify({deploymentId:document.deploymentId,hostKeyFingerprint:"sha256:"+createHash("sha256").update(spki).digest("base64url")}));
    })().catch(e=>{console.error(e.message);process.exitCode=1});
  '
}

claimed_state() {
  local config
  config=$(compose exec -T host node -e '
    const origin=process.env.OPENSTEER_CANONICAL_ORIGIN;
    const local="http://127.0.0.1:4310";
    (async () => {
      const headers={host:new URL(origin).host,origin,"x-forwarded-proto":"https"};
      const discovery=await fetch(local+"/.well-known/opensteer",{headers});
      const {apiVersion}=await discovery.json();
      const response=await fetch(local+"/v1/rpc/auth.config?input=%7B%7D",{
        headers:{...headers,"x-opensteer-api-version":String(apiVersion)}
      });
      if (!response.ok) throw new Error("Host RPC returned HTTP "+response.status);
      console.log(JSON.stringify(await response.json()));
    })().catch(e=>{console.error(e.message);process.exitCode=1});
  ') || return
  jq -er '.data.setupState | select(. == "complete" or . == "required")' <<< "$config"
}

# Fetches a release's images: pulled, or with LOCAL true the six Home images already on this
# machine (deploy/home/build-images.sh builds them), their release stamps checked; PostgreSQL
# is still pulled.
fetch_release_images() {
  local selector=$1 local=$2 config service image missing=()
  if [[ $local != true ]]; then
    if [[ -f "$home_dir/browser-pool" ]]; then
      # A Cloud Computer never runs the two browser images: they are not pulled.
      # shellcheck disable=SC2046 # one service per word.
      release_env="$selector" compose pull --quiet postgres $(running_services)
    else
      release_env="$selector" compose pull --quiet
    fi
    return
  fi
  release_env="$selector" compose pull --quiet postgres || return
  config=$(release_env="$selector" compose config --format json) || return
  for service in $(running_services); do
    image=$(jq -er --arg service "$service" '.services[$service].image' <<< "$config") || return
    docker image inspect "$image" >/dev/null 2>&1 || missing+=("$image")
  done
  ((${#missing[@]} == 0)) ||
    fail "These Home images are not on this machine: ${missing[*]}. Build them with: sudo bash deploy/home/build-images.sh MANIFEST.json"
  check_release_stamps "$selector"
}

# Whether an installed Home was ever claimed: its running Host says so, and a Home whose
# database was never created was never claimed. Anything else needs the Home started.
installed_claim_state() {
  local volume
  if [[ -n $(compose ps -q host 2>/dev/null) ]]; then
    claimed_state
    return
  fi
  volume=$(compose config --format json | jq -er '.volumes["postgres-data"].name') || return
  if docker volume inspect "$volume" >/dev/null 2>&1; then return 1; fi
  echo required
}

# Stops the Home's containers even when its release selector is gone.
compose_down_home() {
  local selector="$release_dir/images.env" placeholder='' service status=0
  if [[ ! -f $selector ]]; then
    placeholder=$(mktemp "$home_dir/images.placeholder.XXXXXX")
    {
      echo 'OPENSTEER_HOME_VERSION=0.0.1'
      for service in "${services[@]}"; do
        printf 'OPENSTEER_HOME_%s_IMAGE=placeholder\n' "$(printf %s "$service" | tr 'a-z-' 'A-Z_')"
      done
    } > "$placeholder"
    selector=$placeholder
  fi
  release_env="$selector" compose down "$@" || status=$?
  if [[ -n $placeholder ]]; then rm -f -- "$placeholder"; fi
  return "$status"
}

# Everything an install, its operations and its interrupted ones leave in the Home directory.
remove_home_files() {
  rm -rf -- "${home_dir:?}/"{secrets,boot,identity,releases,restore.pending,restore.pending.retired}
  rm -rf -- "$home_dir/"{install,backup,egress,images.placeholder,feed,config.env,pool-network}.??????
  rm -f -- "$home_dir/"{current,current.new,previous,previous.new,update.pending,update.pending.new,update.waiting,config.env,volumes.env,tls.caddy,setup-link.pending,operation.lock,egress.pending,host.pid,managed,ipv6.enabled,browser-pool,pool-network,pool-network-asked,backup-ca.pem,local-images,backup.resume,runner-apparmor.name,unit-prefix}
}

# Whether this Home was installed with --local-images.
uses_local_images() {
  if [[ -f "$home_dir/local-images" ]]; then echo true; else echo false; fi
}

# The units this Home was installed under, as its install recorded them.
installed_unit_prefix() {
  local unit=opensteer-home
  if [[ -s "$home_dir/unit-prefix" ]]; then unit=$(cat "$home_dir/unit-prefix"); fi
  printf '%s\n' "$unit"
}

# Only the Home in the default directory, with the default units, owns the command on the path.
owns_operator_command() {
  [[ $home_dir == "$default_home_dir" && ${OPENSTEER_HOME_UNIT_PREFIX:-opensteer-home} == opensteer-home ]]
}

# fetch_recipe URL SHA256 DIRECTORY PINNED: a release from its standalone installer, checked against
# its SHA-256 and unpacked into the new, empty DIRECTORY without running anything of it: exactly
# the files its own list names and its version, each a regular file. PINNED (a managed Home)
# fetches only from public addresses, as the feed does.
fetch_recipe() {
  local url=$1 sha=$2 directory=$3 pinned=$4 bundle="$3/.bundle" archive="$3/.bundle.tgz" name list args=()
  [[ ${#url} -le 2048 && $url =~ ^https://[^@/?#[:space:]]+(/[^?#[:space:]]*)?$ && $sha =~ ^[0-9a-f]{64}$ ]] ||
    { echo 'The release names an invalid recipe.' >&2; return 1; }
  if $pinned; then
    name=$(managed_feed_resolution "$url") || { echo 'The recipe must resolve only to public HTTPS addresses.' >&2; return 1; }
    args=(--noproxy '*' --resolve "$name")
  fi
  curl -q --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 \
    --max-filesize 16777216 "${args[@]}" --output "$bundle" -- "$url" ||
    { echo 'The recipe could not be downloaded.' >&2; return 1; }
  [[ $(openssl dgst -sha256 -r "$bundle" | cut -d' ' -f1) == "$sha" ]] ||
    { echo 'The recipe does not match its SHA-256.' >&2; return 1; }
  sed -n "/^base64 -d <<'OPENSTEER_HOME_FILES'/,/^OPENSTEER_HOME_FILES\$/p" "$bundle" | sed '1d;$d' |
    base64 -d > "$archive" 2>/dev/null && list=$(tar -tzf "$archive") || { echo 'The recipe is not an installer.' >&2; return 1; }
  while IFS= read -r name; do
    name=${name#./}
    [[ -z $name || $name =~ ^[a-z0-9][a-z0-9._-]*$ ]] || { echo 'The recipe holds an unexpected path.' >&2; return 1; }
  done <<< "$list"
  tar -xzf "$archive" -C "$directory" && rm -f -- "$bundle" "$archive" || return 1
  list=" $(sed -n 's/^release_files=(\(.*\))$/\1/p' "$directory/common.sh" 2>/dev/null) version "
  for name in $list; do
    [[ -f "$directory/$name" && ! -L "$directory/$name" ]] || { echo "The recipe lacks $name." >&2; return 1; }
  done
  # Nothing else: the Home writes the rest of a release (its selector, policies and dump) itself.
  for name in "$directory"/*; do
    [[ $list == *" ${name##*/} "* ]] || { echo "The recipe holds ${name##*/}, which it does not list." >&2; return 1; }
  done
}

# The release the Home runs: the directory `current` names.
current_release() {
  local target
  target=$(readlink -- "$home_dir/current") && [[ $target =~ ^releases/[a-zA-Z0-9._-]+$ && -d "$home_dir/$target" ]] ||
    { echo 'This Home has no current release.' >&2; return 1; }
  printf '%s\n' "$home_dir/$target"
}

# switch_link TARGET LINK: LINK names TARGET from one rename on, never a moment without it.
switch_link() {
  local keep=-T
  if [[ $(uname -s) == Darwin ]]; then keep=-h; fi # macOS, where only the tests run
  ln -sfn -- "$1" "$2.new" && mv -f "$keep" -- "$2.new" "$2" && sync "${2%/*}"
}

# new_release NAME: a new, empty release directory beside the others.
new_release() { install -d -m 0700 "$home_dir/releases" && mktemp -d "$home_dir/releases/${1:-release}-XXXXXX"; }

# install_release SOURCE: a new release holding the release files (and version) of SOURCE, an
# unpacked installer or this checkout.
install_release() {
  local release name
  release=$(new_release "$(cat "$1/version" 2>/dev/null)") || return
  for name in "${release_files[@]}"; do install -m 0700 "$1/$name" "$release/$name" || return; done
  if [[ -f "$1/version" ]]; then install -m 0600 "$1/version" "$release/version" || return; fi
  printf '%s\n' "$release"
}

# images_present: every image this Home runs of this release, PostgreSQL's too, is on this machine.
images_present() {
  local config service image
  config=$(compose config --format json) || return
  for service in postgres $(running_services); do
    image=$(jq -er --arg service "$service" '.services[$service].image' <<< "$config") || return
    docker image inspect "$image" >/dev/null 2>&1 || { echo "The image $image is not on this machine." >&2; return 1; }
  done
}

# One release's images where Docker keeps them, in MiB, as measured (docs/cloud-computer-operations.md,
# Disk); a Cloud Computer runs no browser images.
release_image_mib() { if [[ -f "$home_dir/browser-pool" ]]; then echo 4600; else echo 9900; fi; }

# room_for_release [images]: room for one more release before anything of it is fetched: its images
# where Docker keeps them (with `images`), and the database's dump beside the Home.
room_for_release() {
  local root database free need=256
  if [[ ${1:-} == images ]]; then
    root=$(docker info --format '{{.DockerRootDir}}') || return
    free=$(df -Pm -- "$root" | awk 'NR == 2 { print $4 }')
    ((free >= $(release_image_mib))) ||
      { echo "Docker's disk has $free MiB free; a release's images take about $(release_image_mib)." >&2; return 1; }
  fi
  database=$(postgres_tool psql -tAc 'select pg_database_size(current_database())') && [[ $database =~ ^[0-9]+$ ]] || return
  need=$((need + database / 1048576))
  free=$(df -Pm -- "$home_dir" | awk 'NR == 2 { print $4 }')
  ((free >= need)) || { echo "The Home's disk has $free MiB free; its database dump takes about $need." >&2; return 1; }
}

# run_release RELEASE STEP: RELEASE's own code runs a step of a switch to it, under its caller's lock.
run_release() { OPENSTEER_HOME_SWITCHING=${1##*/} "$1/opensteer-home" "$2"; }

# prepare_release (release-prepare): this release readied while another runs: every image its own
# Compose files name obtained and here, its sandbox policies read from them, its units checked.
prepare_release() {
  fetch_release_images "$release_dir/images.env" "$(uses_local_images)" || fail "The release's images could not be obtained."
  if [[ -f "$home_dir/managed" ]]; then
    check_release_stamps "$release_dir/images.env" || fail "The release's images are not this release."
  fi
  images_present || fail "The release's images are not all on this machine."
  install_sandbox_policies || fail "The release's sandbox policies could not be read."
  check_units || fail "The release's units are incomplete."
}

# check_units: the units this release writes, in staging: the main service and each scheduled task's
# service and timer, each running the Home's current command.
check_units() {
  local units="$release_dir/units.check" unit task command="$home_dir/current/opensteer-home"
  unit=$(installed_unit_prefix)
  rm -rf -- "$units" && mkdir -- "$units" &&
    OPENSTEER_HOME_UNITS_CHECK="$units" "$release_dir/install-scheduler.sh" "$home_dir" "$unit" &&
    grep -qxF "ExecStart=$command start" "$units/$unit.service" || return
  for task in update backup maintain; do
    grep -qF "ExecStart=$command " "$units/$unit-$task.service" && grep -qxF '[Timer]' "$units/$unit-$task.timer" || return
  done
  rm -rf -- "$units"
}

# gate_release (release-gate): this release started and checked once, as maintenance checks.
gate_release() {
  local pid
  start_pod || fail 'The new release did not start.'
  pid=$(host_pid) || fail 'The new release has no running Host.'
  check_firewall "$pid" || fail "The new release's firewall check failed."
  pod_healthy "$(pod_snapshot)" || fail "The new release's services are not all healthy."
}

# cutover FROM TO: the switch from the running release FROM to the prepared TO: update.pending is
# written, FROM stops with its own files, TO starts with its own code and passes its gate, and
# `current` is renamed to TO: the commit. Returns 0 when TO is current; 1 when FROM is, TO stopped
# (the caller starts FROM); 2 when nothing changed; 3 when the next start must finish going back.
cutover() {
  local from=$1 to=$2 pending="$home_dir/update.pending"
  if ! { printf '%s %s\n' "${from##*/}" "${to##*/}" > "$pending.new" && publish_file "$pending.new" "$pending"; }; then
    rm -f -- "$pending.new" "$pending"
    [[ -e $pending ]] && return 3
    return 2
  fi
  if ! { release_dir=$from compose down && run_release "$to" release-gate &&
    switch_link "releases/${to##*/}" "$home_dir/current"; } && [[ $(current_release) != "$to" ]]; then
    release_dir=$from stop_switch || return 3
    return 1
  fi
  # TO is current (the words follow the link, also when its sync failed).
  finish_switch || echo 'The switch is made; what follows it is finished at the next start.' >&2
}

# stop_switch: a switch that did not commit is undone: the Home's whole Compose project stops with
# the current release's files (--remove-orphans; volumes kept); the caller starts that release.
stop_switch() { compose down --remove-orphans && rm -f -- "$home_dir/update.pending" && sync "$home_dir"; }

# finish_switch: after a commit the release before stays as `previous`, the way back; older ones go
# with their images. None of it undoes the commit; what fails is tried again at the next start.
finish_switch() {
  local pending="$home_dir/update.pending" from to
  [[ -f $pending ]] || return 0
  read -r from to < "$pending" && switch_link "releases/$from" "$home_dir/previous" || return
  rm -f -- "$home_dir/releases/$from/database.dump"
  prune_releases images
  rm -f -- "$pending" && sync "$home_dir"
}

# recover_switch: a switch a stop left halfway, decided by `current` alone: FROM goes back, TO finishes.
recover_switch() {
  local pending="$home_dir/update.pending" from to current
  [[ -e $pending || -L $pending ]] || return 0
  current=$(current_release) || return
  read -r from to < "$pending" || from=''
  case ${current##*/} in
    "$to") finish_switch || echo 'The last update is made; what follows it is finished at the next start.' >&2 ;;
    "$from")
      stop_switch || return
      echo 'An update stopped before it switched releases: the Home runs its previous release.' ;;
    *) recovery_needs_operator "$pending" ;;
  esac
}

# prune_releases [images]: removes each release neither current nor previous and, with `images`, the
# images it names that those two do not. A failure is said, never fatal, and tried again later.
prune_releases() {
  local keep='' kept='' link dir image
  for link in current previous; do
    if [[ -L "$home_dir/$link" ]]; then
      keep+=" $(readlink -- "$home_dir/$link") "
      kept+=$(release_named_images "$home_dir/$link")$'\n'
    fi
  done
  rm -f -- "$home_dir/releases/".manifest.*
  for dir in "$home_dir/releases"/*/; do
    dir=${dir%/}
    [[ $keep != *" releases/${dir##*/} "* ]] || continue
    if [[ ${1:-} == images ]]; then
      for image in $(release_named_images "$dir"); do
        grep -qxF -- "$image" <<< "$kept" || docker image rm -- "$image" >/dev/null 2>&1 ||
          echo "An earlier release's image could not be removed: $image" >&2
      done
    fi
    rm -rf -- "$dir" || echo "An earlier release could not be removed: ${dir##*/}" >&2
  done
  return 0
}

# release_named_images RELEASE: its selector's images, and the fixed ones its Compose files name.
release_named_images() {
  sed -n 's/^OPENSTEER_HOME_[A-Z_]*_IMAGE=//p' "$1/images.env" 2>/dev/null
  sed -n 's/^ *image: *\([a-z0-9][^${}[:space:]]*\) *$/\1/p' "$1"/compose*.yaml 2>/dev/null
}

# refresh_units: the installed units follow what the current release writes, where they differ.
refresh_units() {
  [[ -d /run/systemd/system || -n ${OPENSTEER_HOME_UNIT_DIR:-} ]] || return 0
  "$(current_release)/install-scheduler.sh" "$home_dir" "$(installed_unit_prefix)"
}

# The installer run again by hand on an installed Home: it changes nothing unless the whole release
# is prepared beside the running one, and refuses a managed or claimed Home, another name, another
# TLS choice, or --local-images without a manifest. Then the Home switches to it (cutover).
rerun_installed_home() {
  local hostname=$1 manifest=$2 local_images=$3 local_tls=$4 source=$5
  local configured state local_mode tls installed_tls from to='' running=false status=0 release_dir
  local unchanged='Nothing was changed.'
  release_dir=$(current_release) || fail "This Home has no current release. $unchanged"
  from=$release_dir
  configured=$(compose config --format json | jq -er .services.gateway.environment.OPENSTEER_HOME_HOSTNAME) ||
    fail "The installed Home's configuration could not be read. $unchanged"
  [[ $hostname == "$configured" ]] || fail "This installation already uses $configured. $unchanged"
  [[ ! -e "$home_dir/managed" ]] ||
    fail "This Home is managed by its Opensteer account; the installer run by hand does not change it. $unchanged"
  if [[ -z $manifest ]] && $local_images; then
    fail "--local-images applies to the release given with --manifest. $unchanged"
  fi
  if $local_tls; then tls=internal; else tls=public; fi
  installed_tls=public
  if grep -qx 'tls internal' "$home_dir/tls.caddy"; then installed_tls=internal; fi
  [[ $tls == "$installed_tls" ]] ||
    fail "This Home was installed $([[ $installed_tls == internal ]] && echo with || echo without) --local, and the installer does not change that. $unchanged"
  state=$(installed_claim_state) ||
    fail "Could not tell whether this Home was claimed. Start it with: sudo opensteer-home start. Or remove it with: sudo opensteer-home uninstall --purge. $unchanged"
  [[ $state == required ]] ||
    fail "This Home is already claimed, so the installer will not change it. Change its release with: sudo opensteer-home update ${manifest:-MANIFEST.json}. Or remove it with: sudo opensteer-home uninstall --purge. $unchanged"

  to=$(install_release "$source") || fail "The release could not be written. $unchanged"
  # refuse MESSAGE: nothing of the new release stays.
  refuse() { rm -rf -- "$to"; fail "$1 $unchanged"; }
  if [[ -n $manifest ]]; then
    (release_to_env "$manifest" "$to/images.env" false) || refuse 'The release could not be written.'
    local_mode=$local_images
  else
    cp -- "$from/images.env" "$to/images.env" || refuse 'The release could not be written.'
    local_mode=$(uses_local_images)
  fi
  release_dir=$to fetch_release_images "$to/images.env" "$local_mode" ||
    refuse "The release's images could not be obtained."
  release_dir=$to install_sandbox_policies || refuse "The release's sandbox policies could not be read."
  if [[ -n $(compose ps -q host 2>/dev/null) ]]; then running=true; fi
  cutover "$from" "$to" || status=$?
  if ((status == 2)); then refuse 'The switch could not be recorded.'; fi
  if ((status != 0)); then
    echo 'The new release did not start. Putting the previous one back.' >&2
    ((status == 1)) || fail 'The previous one is not back yet: the next start puts it back.'
    if $running && ! start_pod; then fail 'The previous release did not start again either. See: sudo opensteer-home logs host'; fi
    fail 'The Home is back on its previous release.'
  fi
  release_dir=$to
  if [[ $local_mode == true ]]; then touch "$home_dir/local-images"; else rm -f -- "$home_dir/local-images"; fi
  echo "This Home was never claimed. It now runs release $(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$to/images.env")."
  if [[ -f "$home_dir/setup-link.pending" ]]; then
    print_setup_link "$(cat "$home_dir/setup-link.pending")"
    rm -f -- "$home_dir/setup-link.pending"
  else
    echo 'The setup link printed by the first install still works. Run sudo opensteer-home setup-link for a new one.'
  fi
}

print_setup_link() {
  local host
  host=$(compose config --format json | jq -er .services.gateway.environment.OPENSTEER_HOME_HOSTNAME)
  printf 'https://%s/setup#token=%s\n' "$host" "$1"
}
