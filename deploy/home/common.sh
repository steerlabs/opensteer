#!/usr/bin/env bash
set -euo pipefail
umask 077
home_dir=${OPENSTEER_HOME_DIR:-/etc/opensteer-home}
unset release_env volume_env stage_project
services=(host gateway runner browser-runtime browser-egress channel-runtime)
default_home_dir=/etc/opensteer-home
# The recipe a Home keeps in its directory and runs from.
recipe_files=(compose.yaml compose.egress.yaml compose.egress-pending.yaml managed-egress.sh compose.apparmor.yaml compose.ipv6.yaml compose.browser-pool.yaml common.sh firewall.sh backup.sh update.sh opensteer-home install-scheduler.sh)
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
  # A Cloud Computer whose boot answer said browserPool: its browser runs on a pool host.
  if [[ -f "$home_dir/browser-pool" ]]; then args+=(-f "$home_dir/compose.browser-pool.yaml"); fi
  if [[ -s "$home_dir/secrets/egress_url" ]]; then
    args+=(-f "$home_dir/compose.egress.yaml")
  elif [[ -f "$home_dir/managed" && ! -f "$home_dir/browser-pool" ]]; then
    # A pooled Cloud Computer's browser leaves through its own address on the pool host.
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
  local destination=${1:-$home_dir} service policy image tmp
  for service in browser-runtime runner; do
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

# Fetches a release's images: pulled, or with LOCAL true the six Home images already on this
# machine (deploy/home/build-images.sh builds them), their release stamps checked; PostgreSQL
# is still pulled.
fetch_release_images() {
  local selector=$1 local=$2 config service image missing=()
  if [[ $local != true ]]; then
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

# Stops the Home's containers even when its release selector is gone.
compose_down_home() {
  local selector="$home_dir/images.env" placeholder='' service status=0
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
  rm -rf -- "${home_dir:?}/"{secrets,boot,identity,restore.pending,update.pending,restore.pending.retired,update.pending.retired}
  rm -rf -- "$home_dir/"{install,backup,update,egress,images.placeholder}.??????
  rm -f -- "$home_dir/"{config.env,images.env,volumes.env,tls.caddy,chromium-oci.json,runner-oci.json,setup-link.pending,operation.lock,compose.yaml,compose.egress.yaml,compose.egress-pending.yaml,managed-egress.sh,egress.pending,compose.apparmor.yaml,compose.ipv6.yaml,compose.browser-pool.yaml,common.sh,firewall.sh,backup.sh,update.sh,opensteer-home,install-scheduler.sh,host.pid,managed,ipv6.enabled,browser-pool,update-database.dump,managed-work.json,backup-ca.pem,local-images,backup.resume,runner-apparmor.name,unit-prefix}
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

install_recipe() {
  local source=$1 destination=$2 name
  for name in "${recipe_files[@]}"; do
    if [[ "$source/$name" != "$destination/$name" ]]; then
      install -m 0600 "$source/$name" "$destination/$name"
    fi
  done
  chmod 0700 "$destination/"{firewall.sh,opensteer-home,install-scheduler.sh}
}

# The installer run again by hand on an installed Home. It first reads what is on the machine
# and obtains the whole release, and changes nothing unless all of it is in hand: a managed
# Home, a claimed Home, another name, a different TLS choice, or --local-images without a
# manifest is refused. Only then does it stop the Home, replace its release and recipe and start
# it; if that release does not start, the previous one is put back and started again.
rerun_installed_home() {
  local hostname=$1 manifest=$2 local_images=$3 local_tls=$4 source=$5 staging=$6
  local configured state selector local_mode tls installed_tls name running=false
  local unchanged='Nothing was changed.'
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

  selector="$staging/images.env"
  if [[ -n $manifest ]]; then
    release_to_env "$manifest" "$selector" false
    local_mode=$local_images
  else
    cp -- "$home_dir/images.env" "$selector"
    local_mode=$(uses_local_images)
  fi
  fetch_release_images "$selector" "$local_mode" ||
    fail "The release's images could not be obtained. $unchanged"
  mkdir -- "$staging/recipe" "$staging/previous"
  install_recipe "$source" "$staging/recipe"
  release_env="$selector" install_sandbox_policies "$staging/recipe" ||
    fail "The release's sandbox policies could not be read. $unchanged"

  for name in "${recipe_files[@]}" images.env local-images chromium-oci.json runner-oci.json; do
    if [[ -e "$home_dir/$name" ]]; then cp -p -- "$home_dir/$name" "$staging/previous/$name"; fi
  done
  if [[ -n $(compose ps -q host 2>/dev/null) ]]; then running=true; fi
  compose down
  for name in "${recipe_files[@]}" chromium-oci.json runner-oci.json; do
    cp -p -- "$staging/recipe/$name" "$home_dir/$name"
  done
  cp -- "$selector" "$home_dir/images.env"
  if [[ $local_mode == true ]]; then touch "$home_dir/local-images"; else rm -f -- "$home_dir/local-images"; fi
  sync "$home_dir"
  if ! start_pod; then
    echo 'The new release did not start. Putting the previous one back.' >&2
    rm -f -- "$home_dir/local-images"
    for name in "$staging/previous/"*; do cp -p -- "$name" "$home_dir/${name##*/}"; done
    sync "$home_dir"
    if $running && ! start_pod; then
      fail 'The previous release did not start again either. See: sudo opensteer-home logs host'
    fi
    fail 'The Home is back on its previous release.'
  fi
  if owns_operator_command; then install -m 0755 "$home_dir/opensteer-home" /usr/local/bin/opensteer-home; fi
  echo "This Home was never claimed. It now runs release $(sed -n 's/^OPENSTEER_HOME_VERSION=//p' "$home_dir/images.env")."
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
