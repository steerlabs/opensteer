#!/usr/bin/env bash
set -euo pipefail
umask 077
home_dir=${OPENSTEER_HOME_DIR:-/etc/opensteer-home}
unset release_env volume_env stage_project
services=(host gateway runner browser-runtime browser-egress channel-runtime)
fail() { printf '%s\n' "$*" >&2; exit 1; }

lock_home() {
  exec 9>"$home_dir/operation.lock"
  flock -x 9
}

compose() {
  local project
  project=$(sed -n "s/^COMPOSE_PROJECT_NAME='\([^']*\)'$/\1/p" "$home_dir/config.env") || return
  local args=(--project-directory "$home_dir" --env-file "$home_dir/config.env"
    --env-file "${release_env:-$home_dir/images.env}" -f "$home_dir/compose.yaml")
  local apparmor='' oidc_path='' work_marker=''
  if [[ -s "$home_dir/runner-apparmor.name" ]]; then
    apparmor=$(cat "$home_dir/runner-apparmor.name") || return
    args+=(-f "$home_dir/compose.apparmor.yaml")
  fi
  if [[ -f "$home_dir/ipv6.enabled" ]]; then args+=(-f "$home_dir/compose.ipv6.yaml"); fi
  if [[ -s "$home_dir/secrets/egress_url" ]]; then
    args+=(-f "$home_dir/compose.egress.yaml")
  elif [[ -f "$home_dir/managed" ]]; then
    args+=(-f "$home_dir/compose.egress-pending.yaml")
  fi
  if [[ -s "$home_dir/secrets/oidc_client_secret" ]]; then
    oidc_path=/run/secrets/oidc_client_secret
  fi
  if [[ -s "$home_dir/managed-work.json" ]]; then
    work_marker=$(cat "$home_dir/managed-work.json") || return
  fi
  if [[ -n ${volume_env:-} ]]; then args+=(--env-file "$volume_env");
  elif [[ -f "$home_dir/volumes.env" ]]; then args+=(--env-file "$home_dir/volumes.env"); fi
  if [[ -n ${stage_project:-$project} ]]; then args+=(--project-name "${stage_project:-$project}"); fi
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    OPENSTEER_HOME_RUNNER_APPARMOR="$apparmor" OPENSTEER_HOME_OIDC_CLIENT_SECRET_PATH="$oidc_path" \
    OPENSTEER_HOME_WORK_MARKER="$work_marker" docker compose "${args[@]}" "$@"
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
  tmp=$(mktemp "${destination}.XXXXXX")
  printf 'OPENSTEER_HOME_VERSION=%s\n' "$version" > "$tmp"
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
    printf 'OPENSTEER_HOME_%s_IMAGE=%s\n' "$(printf %s "$service" | tr 'a-z-' 'A-Z_')" "$ref" >> "$tmp"
  done
  publish_file "$tmp" "$destination"
}

compose_project() { compose config --format json | jq -er '.name'; }

check_release_stamps() {
  local selector=$1 version service image actual config
  version=$(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$selector") || return
  config=$(release_env="$selector" compose config --format json) || return
  for service in "${services[@]}"; do
    image=$(jq -er --arg service "$service" '.services[$service].image' <<< "$config") || return
    actual=$(docker run --rm --network none --user 0:0 --entrypoint cat "$image" /usr/local/share/opensteer/release.json |
      jq -er '.version') || fail "Could not read the $service release stamp."
    [[ $actual == "$version" ]] || fail "The $service image does not match release $version."
  done
}

install_sandbox_policies() {
  local service policy image tmp
  for service in browser-runtime runner; do
    case "$service" in
      browser-runtime) policy=chromium-oci.json ;;
      runner) policy=runner-oci.json ;;
    esac
    image=$(compose config --format json | jq -er --arg service "$service" '.services[$service].image') || return
    tmp=$(mktemp "$home_dir/$policy.XXXXXX") || return
    if docker run --rm --network none --entrypoint cat "$image" "/usr/local/share/opensteer/$policy" > "$tmp"; then
      mv -f -- "$tmp" "$home_dir/$policy"
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

remove_runner_apparmor() {
  if [[ -s "$home_dir/runner-apparmor.name" ]]; then
    runner_apparmor_rules "$(cat "$home_dir/runner-apparmor.name")" | apparmor_parser -R
    rm -f -- "$home_dir/runner-apparmor.name"
  fi
}

host_pid() {
  local owner
  owner=$(compose ps -q host) && [[ -n $owner ]] && docker inspect --format '{{.State.Pid}}' "$owner"
}

apply_firewall() {
  local pid=$1
  if [[ -f "$home_dir/ipv6.enabled" ]]; then
    "$home_dir/firewall.sh" "$pid" apply true
  else
    "$home_dir/firewall.sh" "$pid"
  fi
}

check_firewall() {
  local ipv6=false
  if [[ -f "$home_dir/ipv6.enabled" ]]; then ipv6=true; fi
  "$home_dir/firewall.sh" "$1" check "$ipv6"
}

start_pod() {
  local pid namespace
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

# Fetches a release's images. A Home installed with --local-images uses the six Home images
# already on this machine (deploy/home/build-images.sh builds them) and checks their release
# stamps instead of pulling them; PostgreSQL is still pulled.
fetch_release_images() {
  local selector=${1:-$home_dir/images.env} config service image missing=()
  if [[ ! -f "$home_dir/local-images" ]]; then
    release_env="$selector" compose pull --quiet
    return
  fi
  release_env="$selector" compose pull --quiet postgres
  config=$(release_env="$selector" compose config --format json) || return
  for service in "${services[@]}"; do
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

# The installer run again with a manifest installs it on a Home that was never claimed and
# refuses a claimed Home, naming the commands that change or remove it.
reinstall_release() {
  local manifest=$1 state
  state=$(installed_claim_state) ||
    fail "Could not tell whether this Home was claimed. Start it with: sudo opensteer-home start. Or remove it with: sudo opensteer-home uninstall --purge"
  [[ $state == required ]] ||
    fail "This Home is already claimed, so the installer will not replace its release. Change its release with: sudo opensteer-home update $manifest. Or remove it with: sudo opensteer-home uninstall --purge"
  release_to_env "$manifest" "$home_dir/images.env" false
  echo "This Home was never claimed. Installing the release in $manifest."
}

print_setup_link() {
  local host
  host=$(compose config --format json | jq -er .services.gateway.environment.OPENSTEER_HOME_HOSTNAME)
  printf 'https://%s/setup#token=%s\n' "$host" "$1"
}
