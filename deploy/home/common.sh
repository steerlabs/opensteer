#!/usr/bin/env bash
set -euo pipefail
umask 077
home_dir=${OPENSTEER_HOME_DIR:-/etc/opensteer-home}
services=(host gateway runner browser-runtime browser-egress channel-runtime)
fail() { printf '%s\n' "$*" >&2; exit 1; }

lock_home() {
  exec 9>"$home_dir/operation.lock"
  flock -x 9
}

compose() {
  local args=(--project-directory "$home_dir" --env-file "$home_dir/config.env"
    --env-file "${release_env:-$home_dir/images.env}" -f "$home_dir/compose.yaml")
  if [[ -s "$home_dir/runner-apparmor.name" ]]; then
    export OPENSTEER_HOME_RUNNER_APPARMOR
    OPENSTEER_HOME_RUNNER_APPARMOR=$(cat "$home_dir/runner-apparmor.name")
    args+=(-f "$home_dir/compose.apparmor.yaml")
  fi
  if [[ -f "$home_dir/ipv6.enabled" ]]; then args+=(-f "$home_dir/compose.ipv6.yaml"); fi
  if [[ -s "$home_dir/secrets/egress_url" ]]; then
    args+=(-f "$home_dir/compose.egress.yaml")
  elif [[ -f "$home_dir/managed" ]]; then
    args+=(-f "$home_dir/compose.egress-pending.yaml")
  fi
  local -x OPENSTEER_HOME_OIDC_CLIENT_SECRET_PATH=''
  if [[ -s "$home_dir/secrets/oidc_client_secret" ]]; then
    OPENSTEER_HOME_OIDC_CLIENT_SECRET_PATH=/run/secrets/oidc_client_secret
  fi
  local -x OPENSTEER_HOME_WORK_MARKER=''
  if [[ -s "$home_dir/managed-work.json" ]]; then
    OPENSTEER_HOME_WORK_MARKER=$(cat "$home_dir/managed-work.json")
  fi
  if [[ -n ${volume_env:-} ]]; then args+=(--env-file "$volume_env");
  elif [[ -f "$home_dir/volumes.env" ]]; then args+=(--env-file "$home_dir/volumes.env"); fi
  if [[ -n ${stage_project:-} ]]; then args+=(--project-name "$stage_project"); fi
  docker compose "${args[@]}" "$@"
}

random_secret() { openssl rand -hex 32; }

save_secret() {
  local path=$1 tmp
  tmp=$(mktemp "${path}.XXXXXX")
  cat > "$tmp"
  # The root-only parent stays on the VM. Compose mounts only the individual file.
  chmod 0444 "$tmp"
  mv -f -- "$tmp" "$path"
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

fetch_manifest() {
  curl -q --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 30 --max-filesize 131072 --output "$2" -- "$1"
}

release_to_env() {
  local manifest=$1 destination=$2 pinned=${3:-false} service ref version tmp
  if "$pinned"; then
    version=$(jq -er '.version | select(type == "string" and test("^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$"))' "$manifest") ||
      fail "Invalid managed Home release version."
  else
  version=$(jq -er '.version | select(type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$") and length <= 79 and . != "0.0.0")' "$manifest") ||
      fail "Invalid Home release version."
  fi
  tmp=$(mktemp "${destination}.XXXXXX")
  printf 'OPENSTEER_HOME_VERSION=%s\n' "$version" > "$tmp"
  for service in "${services[@]}"; do
    if ! ref=$(jq -er --arg service "$service" --arg version "$version" --argjson pinned "$pinned" '
      (if $pinned then .images[$service]
       else .images[$service] // ("ghcr.io/steerlabs/opensteer-home-" + $service + ":" + $version)
       end) |
      select(type == "string" and length <= 512 and test("^[a-z0-9][a-z0-9./:_-]*[a-z0-9_.-](@sha256:[a-f0-9]{64})?$"; "i"))
    ' "$manifest"); then
      rm -f -- "$tmp"
      fail "Invalid image reference for $service."
    fi
    if "$pinned" && [[ ! $ref =~ ^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$ ]]; then
      rm -f -- "$tmp"
      fail "Managed Home releases require a digest for $service."
    fi
    printf 'OPENSTEER_HOME_%s_IMAGE=%s\n' "$(printf %s "$service" | tr 'a-z-' 'A-Z_')" "$ref" >> "$tmp"
  done
  mv -f -- "$tmp" "$destination"
}

compose_project() { compose config --format json | jq -er '.name'; }

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

start_host() {
  local pid
  compose up -d --wait --pull never postgres host || return
  pid=$(host_pid) || return
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
  local pid
  prepare_runner_apparmor || return
  if start_host && pid=$(host_pid) && compose up -d --wait --no-recreate --pull never &&
    [[ $(host_pid) == "$pid" ]] && check_firewall "$pid"; then
    printf '%s\n' "$pid" > "$home_dir/host.pid"
    return
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

print_setup_link() {
  local host
  host=$(compose config --format json | jq -er .services.gateway.environment.OPENSTEER_HOME_HOSTNAME)
  printf 'https://%s/setup#token=%s\n' "$host" "$1"
}
