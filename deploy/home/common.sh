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
  # Always named, so no release's own Compose files can move the Home to another project.
  args+=(--project-name "${stage_project:-${project:-opensteer-home}}")
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
# runs here). The rule: the machine keeps an eighth of itself, at least 768 MiB, for the kernel,
# Docker, the system and the page cache, and every part's ordinary peak must fit beside that, the
# plugin engine's and one Run's at the same time included; a machine where they do not is
# refused. A memory limit is a ceiling that stops a runaway, well above the part's ordinary peak,
# not a ration: the Runner's is what the machine has for it while the others are at their
# ordinary peaks and no plugin runs, so the limits together can be more than the machine. Should
# the plugin engine and a Run both outgrow that at once, the kernel ends the plugin engine first
# (plugins/memory-pressure.ts) and never the Host or PostgreSQL before a Run (their
# oom_score_adj in compose.browser-pool.yaml). CPU limits are each service's ceiling of CPU time,
# not a reservation: none is above the machine's CPU count, and the Runner may use them all. The
# Runner runs as many Runs at once as fit at run_allowance MiB each beside every ordinary peak, at
# least one; the Host holds the next one back.
home_limits() {
  local memory=$1 cpus=$2 reserve budget ordinary postgres host gateway channel agents runs two
  # Ordinary peaks (MiB), measured on a scratch e2-medium Cloud Computer (3,908 MiB) on Nov 25,
  # cgroup v2 sampled every half second. The Host serving connected agents' browser and
  # computer_use calls (in-process worker threads): 324 (its node 346); the packaged Host 281 at
  # rest, 97 more for a first browser script and 80 for a first computer_use read: 460.
  local host_peak=460
  # Its plugin engine and that engine's workerd, in the Host's container while a plugin call runs:
  # 553 to 559 and 126 to 127 at the engine's start.
  local plugin_peak=680
  local postgres_peak=110 channel_peak=100 gateway_peak=20
  # The Runner's own process and its supervisor: 131 MiB at rest, 152 at a Run's peak.
  local runner_itself=192
  # One Run of the person's own agents: OpenCode 1.18.32's engine peaked at 0.98 to 1.06 GiB of
  # anonymous memory in a garbage collector's sawtooth; allowed: that and half again. The other
  # engines are not measured yet (they need a sign-in).
  local run_allowance=1536
  [[ $memory =~ ^[0-9]+$ ]] || fail "Invalid machine memory: $memory"
  if [[ ! $cpus =~ ^[0-9]+$ ]] || ((cpus < 1)); then fail "Invalid machine CPU count: $cpus"; fi
  # An eighth of the machine, at least 768 MiB: about 570 to 670 were in use outside the
  # containers, and the rest is page cache.
  reserve=$(clamp $((memory / 8)) 768 "$memory")
  budget=$((memory - reserve))
  ordinary=$((host_peak + plugin_peak + postgres_peak + channel_peak + gateway_peak + runner_itself))
  ((budget - ordinary >= run_allowance)) ||
    fail "This machine (${memory} MiB) is too small for a Cloud Computer's Home."
  # At most the Runner's own limit of 1,000 Runs at once.
  runs=$(clamp $(((budget - ordinary) / run_allowance)) 1 1000)
  # Ceilings: about two and a half times or more each ordinary peak, and a share of a bigger
  # machine. The Host's holds its own peak and the plugin engine's together.
  postgres=$(clamp $((budget / 16)) 256 2048)
  host=$(clamp $((budget / 8)) 1536 2048)
  gateway=$(clamp $((budget / 64)) 64 256)
  channel=$(clamp $((budget / 32)) 256 512)
  agents=$((budget - host_peak - postgres_peak - channel_peak - gateway_peak))
  # Below a further Run's allowance beside its Runs: the Runner keeps warm engines only in that
  # room (warmEngineIdleCap), and none here, where the room is the others' and the page cache's.
  agents=$(clamp "$agents" 0 $((runner_itself + (runs + 1) * run_allowance - 1)))
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
  local line pattern='https://[a-zA-Z0-9.:/_=%+-]+' status=0
  line=$(grep -m1 '^OPENSTEER_HOME_RELEASE_MANIFEST_URL=' "$home_dir/config.env") || status=$?
  ((status <= 1)) || fail "config.env could not be read."
  # No line: no feed; but the key written any other way is a line this Home cannot read.
  if ((status == 1)); then
    status=0
    grep -q 'OPENSTEER_HOME_RELEASE_MANIFEST_URL' "$home_dir/config.env" || status=$?
    ((status == 1)) && return 0
    ((status == 0)) || fail "config.env could not be read."
  fi
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
      follow_account_portal "$answer" || echo "The account's portal could not be written to config.env." >&2
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

set_configured_feed() { set_config_line OPENSTEER_HOME_RELEASE_MANIFEST_URL "$1"; }

# set_config_line KEY VALUE: config.env's line for KEY becomes KEY='VALUE', by one rename.
set_config_line() {
  local tmp status=0
  tmp=$(mktemp "$home_dir/config.env.XXXXXX") || return
  # grep finding no other line is fine (1); a failed read or write (2) never replaces config.env.
  grep -v "^$1=" "$home_dir/config.env" > "$tmp" || status=$?
  if ((status > 1)) || ! printf "%s='%s'\n" "$1" "$2" >> "$tmp" ||
    ! publish_file "$tmp" "$home_dir/config.env"; then
    rm -f -- "$tmp"
    return 1
  fi
}

# account_portal ANSWER: the account's portal origin in a boot or release-feed answer, when it is a
# plain HTTPS origin; nothing otherwise.
account_portal() {
  local portal
  portal=$(jq -r '.portalOrigin | select(type == "string")' "$1" 2>/dev/null) || return 0
  # The whole value, one line: an origin and nothing else.
  if [[ $portal =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]; then printf '%s\n' "$portal"; fi
}

# follow_account_portal ANSWER: config.env names the portal the account's answer gives, so the Host
# links to it from the next start of its containers (a Home made before the boot answer had it
# gets it this way). An answer that names none changes nothing.
follow_account_portal() {
  local portal
  portal=$(account_portal "$1")
  [[ -n $portal ]] || return 0
  grep -qxF "OPENSTEER_HOME_PORTAL_ORIGIN='$portal'" "$home_dir/config.env" && return 0
  set_config_line OPENSTEER_HOME_PORTAL_ORIGIN "$portal" &&
    echo "This Home now links to its Opensteer account's portal: $portal" >&2
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
    docker run --rm --network none --entrypoint cat "$image" "/usr/local/share/opensteer/$policy" > "$tmp" &&
      mv -f -- "$tmp" "$destination/$policy" || { rm -f -- "$tmp"; return 1; }
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
  rm -f -- "$home_dir/"{current,current.new,previous,previous.new,update.pending,update.pending.new,update.waiting,update.failed,update.failed.new,units.enabled,database.size,config.env,volumes.env,tls.caddy,setup-link.pending,operation.lock,egress.pending,host.pid,managed,ipv6.enabled,browser-pool,pool-network,pool-network-asked,backup-ca.pem,local-images,backup.resume,runner-apparmor.name,unit-prefix}
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
  local images service image
  images=$(service_images) || return
  while read -r service image; do
    docker image inspect "$image" >/dev/null 2>&1 || { echo "The image $image is not on this machine." >&2; return 1; }
  done <<< "$images"
}

# service_images: "SERVICE IMAGE" for PostgreSQL and each service this Home runs, from one reading
# of this release's Compose configuration; fails when one of them names no image.
service_images() {
  local config wanted listed service image
  config=$(compose config --format json) || return
  wanted=" postgres $(running_services | tr '\n' ' ')"
  listed=$(jq -r '.services | to_entries[] | select(.value.image | type == "string") | "\(.key) \(.value.image)"' <<< "$config") ||
    return
  while read -r service image; do
    [[ $wanted == *" $service "* ]] || continue
    printf '%s %s\n' "$service" "$image"
    wanted=${wanted/" $service "/ }
  done <<< "$listed"
  [[ -z ${wanted// /} ]] || { echo "This release names no image for:$wanted" >&2; return 1; }
}

# release_named RELEASE: its images as its manifest names them (release.env, what "the same
# release" compares); images.env holds what they resolved to on this machine.
release_named() {
  if [[ -f $1/release.env ]]; then printf '%s\n' "$1/release.env"; else printf '%s\n' "$1/images.env"; fi
}

# pin_release: this release's images as their own identities on this machine: images.ids lists the
# id of every image it runs (PostgreSQL's too), and images.env names each selected image by its
# digest or by a tag of the Home's own made from its id, so a tag moved later never changes what
# this release starts. Cleanup compares those ids.
pin_release() {
  local images_of service image id key line tag pins=() images="$release_dir/images.env" inventory="$release_dir/images.ids" acquired
  [[ -f "$release_dir/release.env" ]] || cp -p -- "$images" "$release_dir/release.env" || return
  images_of=$(service_images) || return
  acquired=$(cut -d' ' -f2 "$inventory" 2>/dev/null || :)
  while read -r service image; do
    id=$(docker image inspect --format '{{.Id}}' "$image") && [[ $id =~ ^sha256:[0-9a-f]{64}$ ]] ||
      { echo "The image $image is not on this machine." >&2; return 1; }
    printf '%s %s\n' "$id" "$image" >> "$inventory.used" || return
    if grep -qxF -- "$image" <<< "$acquired"; then printf '%s %s\n' "$id" "$image" >> "$inventory" || return; fi
    [[ $service == postgres || $image =~ @sha256:[0-9a-f]{64}$ ]] && continue
    # Recorded before it is made, so whatever stops this leaves nothing the cleanup cannot name.
    tag="opensteer-home-image/$service:${id#sha256:}"
    printf '%s %s\n' "$id" "$tag" >> "$inventory" && docker image tag "$id" "$tag" || return
    key="OPENSTEER_HOME_$(printf %s "$service" | tr 'a-z-' 'A-Z_')_IMAGE"
    pins+=("$key=$tag")
  done <<< "$images_of"
  while IFS= read -r line; do
    for key in "${pins[@]}"; do [[ ${key%%=*} != "${line%%=*}" ]] || line=$key; done
    printf '%s\n' "$line"
  done < "$images" > "$images.new" || return
  publish_file "$images.new" "$images" && sync -- "$inventory" && mv -f -- "$inventory.used" "$release_dir/images.used"
}

# plan_inventory LOCAL: before a release's images are fetched, the names this Home is about to pull
# for it (PostgreSQL's; and, unless LOCAL is true, the selected ones), so the cleanup can name
# whatever a stopped fetch left. Only what the Home pulled or made is ever removed.
plan_inventory() {
  local images_of service image
  images_of=$(service_images) || return
  while read -r service image; do
    [[ $service == postgres || $1 != true ]] || continue
    printf -- '- %s\n' "$image" >> "$release_dir/images.ids" || return
  done <<< "$images_of"
  sync -- "$release_dir/images.ids"
}

# One release's images where Docker keeps them, in MiB, as measured (docs/cloud-computer-operations.md,
# Disk); a Cloud Computer runs no browser images.
release_image_mib() { if [[ -f "$home_dir/browser-pool" ]]; then echo 4600; else echo 9900; fi; }

# room_for_release [images]: room for one more release before anything of it is fetched: its images
# where Docker keeps them (with `images`), and the database's dump beside the Home.
room_for_release() {
  local root database free state need=256
  if [[ ${1:-} == images ]]; then
    root=$(docker info --format '{{.DockerRootDir}}') && free=$(df -Pm -- "$root" | awk 'NR == 2 { print $4 }') &&
      [[ $free =~ ^[0-9]+$ ]] || { echo "Docker's free disk could not be read." >&2; return 1; }
    ((free >= $(release_image_mib))) ||
      { echo "Docker's disk has $free MiB free; a release's images take about $(release_image_mib)." >&2; return 1; }
  fi
  # The database's size, measured while it runs and kept for when it does not.
  state=$(pod_state) || return
  if [[ $state == running ]]; then
    database=$(postgres_tool psql -tAc 'select pg_database_size(current_database())') && [[ $database =~ ^[0-9]+$ ]] &&
      printf '%s\n' "$database" > "$home_dir/database.size" || { echo "The database's size could not be read." >&2; return 1; }
  fi
  database=$(cat "$home_dir/database.size" 2>/dev/null) && [[ $database =~ ^[0-9]+$ ]] || database=0
  need=$((need + database / 1048576))
  free=$(df -Pm -- "$home_dir" | awk 'NR == 2 { print $4 }') && [[ $free =~ ^[0-9]+$ ]] ||
    { echo "The Home's free disk could not be read." >&2; return 1; }
  ((free >= need)) || { echo "The Home's disk has $free MiB free; its database dump takes about $need." >&2; return 1; }
}

# pod_state: running or down (whether the Home's database runs, which a dump needs); a failed
# query of Docker is neither, and fails.
pod_state() {
  local snapshot
  snapshot=$(pod_snapshot) || { echo "Docker could not say whether this Home runs." >&2; return 1; }
  if awk '$1 == "postgres" && $2 == "running" { found = 1 } END { exit !found }' <<< "$snapshot"; then
    echo running
  else
    echo down
  fi
}

# run_release RELEASE STEP: RELEASE's own code runs a step of a switch to it, under its caller's lock.
run_release() { OPENSTEER_HOME_SWITCHING=${1##*/} "$1/opensteer-home" "$2"; }

# prepare_release (release-prepare): this release readied while another runs: every image its own
# Compose files name obtained and here, its sandbox policies read from them, its units checked.
prepare_release() {
  local answer
  [[ $(compose_project) == "$(pod_project)" ]] || fail "The release's Compose project is not this Home's."
  # A managed Home follows what its account gives now, which this release's containers read when
  # its gate starts them (a Home whose running code predates that learns it here).
  if [[ -f "$home_dir/managed" ]] && answer=$(mktemp "$home_dir/feed.XXXXXX"); then
    if ask_account release-feed "$answer"; then follow_account_portal "$answer" || :; fi
    rm -f -- "$answer"
  fi
  plan_inventory "$(uses_local_images)" || fail "The release's images could not be recorded."
  fetch_release_images "$release_dir/images.env" "$(uses_local_images)" || fail "The release's images could not be obtained."
  if [[ -f "$home_dir/managed" ]]; then
    check_release_stamps "$release_dir/images.env" || fail "The release's images are not this release."
  fi
  pin_release || fail "The release's images are not all on this machine."
  install_sandbox_policies || fail "The release's sandbox policies could not be read."
  check_units || fail "The release's units are incomplete."
}

# check_units: the units this release writes, in staging: the main service and each scheduled task's
# service and timer, each running the Home's current command.
check_units() {
  local units="$release_dir/units.check" unit command="$home_dir/current/opensteer-home"
  unit=$(installed_unit_prefix)
  rm -rf -- "$units" && mkdir -- "$units" &&
    OPENSTEER_HOME_UNITS_CHECK="$units" "$release_dir/install-scheduler.sh" "$home_dir" "$unit" || return
  grep -qxF "ExecStart=$command start" "$units/$unit.service" && grep -qxF "ExecStop=$command stop" "$units/$unit.service" &&
    grep -qxF "ExecStart=$command scheduled-update" "$units/$unit-update.service" &&
    grep -qxF "ExecStart=$command scheduled-backup" "$units/$unit-backup.service" &&
    grep -qxF "ExecStart=$command maintain" "$units/$unit-maintain.service" &&
    grep -qxE 'OnCalendar=.+' "$units/$unit-update.timer" && grep -qxE 'OnCalendar=.+' "$units/$unit-backup.timer" &&
    grep -qxE 'OnUnitInactiveSec=.+' "$units/$unit-maintain.timer" || return
  # Each schedule as systemd itself reads it, where it is there to ask.
  if command -v systemd-analyze >/dev/null; then
    while IFS='=' read -r key value; do
      case $key in
        OnCalendar) systemd-analyze calendar -- "$value" >/dev/null 2>&1 || return ;;
        OnBootSec | OnUnitInactiveSec | AccuracySec | RandomizedDelaySec)
          systemd-analyze timespan -- "$value" >/dev/null 2>&1 || return ;;
      esac
    done < <(cat "$units/$unit"-*.timer)
  fi
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
# `current` is renamed to TO: the commit. Returns 0 when TO is current; 1 when TO's own gate
# rejected it and FROM is current, TO stopped (the caller starts FROM); 5 when the switch itself
# failed otherwise (stopping FROM, a sync, the rename), FROM current and TO stopped; 2 when nothing
# changed; 3 when the next start must finish going back; 4 when TO is current but what follows the
# switch is not finished.
cutover() {
  local from=$1 to=$2 pending="$home_dir/update.pending"
  # What a record or the link names is on disk before it is named.
  if ! { sync -f -- "$to" && printf '%s %s\n' "${from##*/}" "${to##*/}" > "$pending.new" &&
    publish_file "$pending.new" "$pending"; }; then
    rm -f -- "$pending.new" "$pending"
    [[ -e $pending ]] && return 3
    return 2
  fi
  local rejected=false
  if ! { release_dir=$from compose down && { run_release "$to" release-gate || { rejected=true && false; }; } &&
    sync -f -- "$to" && switch_link "releases/${to##*/}" "$home_dir/current"; } && [[ $(current_release) != "$to" ]]; then
    release_dir=$from stop_switch || return 3
    $rejected && return 1
    return 5
  fi
  # TO is current (the words follow the link, also when its sync failed); until what follows the
  # switch is finished, no other switch starts.
  finish_switch || return 4
}

# stop_switch: a switch that did not commit is undone: the Home's whole Compose project stops with
# the current release's files (--remove-orphans; volumes kept); the caller starts that release.
stop_switch() { compose down --remove-orphans && rm -f -- "$home_dir/update.pending" && sync "$home_dir"; }

# finish_switch: after a commit the release before stays as `previous`, the way back, with its dump;
# older ones go with their images. None of it undoes the commit; until it is done, no other switch
# starts, and the next start tries it again.
finish_switch() {
  local pending="$home_dir/update.pending" from to
  [[ -f $pending ]] || return 0
  read -r from to < "$pending" && [[ -d "$home_dir/releases/$from" ]] &&
    switch_link "releases/$from" "$home_dir/previous" || return
  rm -f -- "$home_dir/update.failed"
  prune_releases
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

# prune_releases [RELEASE…]: removes each release (all of them by default) that neither `current`,
# `previous`, an unfinished switch nor a failed release's memory names, with the images only it ran.
# A failure is said, never fatal, and tried again later.
prune_releases() {
  local keep=' ' kept='' link dir
  for link in current previous; do
    if [[ -L "$home_dir/$link" ]]; then keep+="$(readlink -- "$home_dir/$link") "; fi
  done
  # A switch not finished keeps both its releases; releases that failed their gate keep their
  # directories, with their dumps, until another release commits.
  if [[ -f "$home_dir/update.pending" ]]; then keep+="$(sed -E 's,([^ ]+),releases/\1,g' "$home_dir/update.pending") "; fi
  if [[ -f "$home_dir/update.failed" ]]; then keep+="$(awk '{ printf "releases/%s ", $1 }' "$home_dir/update.failed") "; fi
  # What the kept releases name, by id and by name: never removed.
  for dir in $keep; do
    kept+=$(cat "$home_dir/$dir/images.ids" "$home_dir/$dir/images.used" 2>/dev/null || :)$'\n'
    kept+=$(sed -n 's/^OPENSTEER_HOME_[A-Z_]*_IMAGE=/- /p' "$home_dir/$dir/images.env" 2>/dev/null || :)$'\n'
  done
  if (($# == 0)); then rm -f -- "$home_dir/releases/".manifest.*; set -- "$home_dir/releases"/*/; fi
  for dir in "$@"; do
    dir=${dir%/}
    [[ $keep != *" releases/${dir##*/} "* ]] || continue
    forget_release "$dir" "$kept" || echo "An earlier release is kept to be removed later: ${dir##*/}" >&2
  done
  return 0
}

# forget_release RELEASE KEPT: removes a release and the image names it pulled or made that no kept
# release uses (KEPT: "ID NAME" lines); when one cannot be removed, or Docker cannot say whether
# it is gone, the release stays, to try again later.
forget_release() {
  local id name gone
  while read -r id name; do
    [[ -n $name ]] || continue
    # Never a name or an image a kept release uses; only the name this Home pulled or made, never
    # by id: an image goes only when nothing else names it.
    awk -v id="$id" -v name="$name" '$2 == name || (id != "-" && $1 == id) { found = 1 } END { exit !found }' <<< "$2" &&
      continue
    docker image rm -- "$name" >/dev/null 2>&1 && continue
    gone=$(docker image inspect -- "$name" 2>&1 >/dev/null) && return 1
    [[ $gone == *"No such image"* ]] || return 1
  done < <(cat "$1/images.ids" 2>/dev/null || :)
  rm -rf -- "$1"
}

# install_units: the units the current release writes, written where they differ (an install).
install_units() {
  [[ -d /run/systemd/system || -n ${OPENSTEER_HOME_UNIT_DIR:-} ]] || return 0
  "$(current_release)/install-scheduler.sh" "$home_dir" "$(installed_unit_prefix)"
}

# refresh_units: the installed units follow what the current release writes, where they differ. A
# Home installed without units (--prepare) gets none from a start or an update.
refresh_units() {
  [[ -f "${OPENSTEER_HOME_UNIT_DIR:-/etc/systemd/system}/$(installed_unit_prefix).service" ]] || return 0
  install_units
}

# The installer run again by hand on an installed Home: it changes nothing unless the whole release
# is prepared beside the running one, and refuses a managed or claimed Home, another name, another
# TLS choice, or --local-images without a manifest. Then the Home switches to it (cutover).
rerun_installed_home() {
  local hostname=$1 manifest=$2 local_images=$3 local_tls=$4 source=$5 prepare=${6:-false}
  local configured state local_mode fetch_mode tls installed_tls from to='' running=false status=0 release_dir
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

  recover_switch && [[ ! -e "$home_dir/update.pending" ]] ||
    fail "The last switch of releases is not finished yet; start the Home first: sudo opensteer-home start. $unchanged"
  to=$(install_release "$source") || fail "The release could not be written. $unchanged"
  # refuse MESSAGE: nothing of the new release stays.
  refuse() { prune_releases "$to"; fail "$1 $unchanged"; }
  if [[ -n $manifest ]]; then
    (release_to_env "$manifest" "$to/images.env" false) || refuse 'The release could not be written.'
    local_mode=$local_images fetch_mode=$local_images
  else
    # The running release's images, as they are on this machine: nothing is asked of a registry.
    cp -- "$from/images.env" "$to/images.env" && cp -- "$(release_named "$from")" "$to/release.env" ||
      refuse 'The release could not be written.'
    local_mode=$(uses_local_images) fetch_mode=true
  fi
  release_dir=$to plan_inventory "$fetch_mode" && release_dir=$to fetch_release_images "$to/images.env" "$fetch_mode" ||
    refuse "The release's images could not be obtained."
  release_dir=$to pin_release || refuse "The release's images are not all on this machine."
  release_dir=$to install_sandbox_policies || refuse "The release's sandbox policies could not be read."
  if [[ -n $(compose ps -q host 2>/dev/null) ]]; then running=true; fi
  cutover "$from" "$to" || status=$?
  if ((status == 2)); then refuse 'The switch could not be recorded.'; fi
  ((status != 4)) || fail 'The Home runs the new release; what follows the switch is finished at the next start: sudo opensteer-home start.'
  if ((status != 0)); then
    echo 'The new release did not start. Putting the previous one back.' >&2
    ((status == 1 || status == 5)) || fail 'The previous one is not back yet: the next start puts it back.'
    if $running && ! start_pod; then fail 'The previous release did not start again either. See: sudo opensteer-home logs host'; fi
    fail 'The Home is back on its previous release.'
  fi
  release_dir=$to
  if [[ $local_mode == true ]]; then touch "$home_dir/local-images"; else rm -f -- "$home_dir/local-images"; fi
  # Its units (a first install cut short before it wrote them gets them here): no success without
  # them, unless it is prepared without units.
  $prepare || install_units ||
    fail "The Home runs the new release, but its units could not be written; run this installer again."
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
