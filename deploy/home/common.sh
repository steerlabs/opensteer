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
  if [[ -s "$home_dir/secrets/egress_url" ]]; then args+=(-f "$home_dir/compose.egress.yaml"); fi
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
  local manifest=$1 destination=$2 service ref version tmp
  version=$(jq -er '.version | select(type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$") and length <= 79 and . != "0.0.0")' "$manifest") ||
    fail "Invalid Home release version."
  tmp=$(mktemp "${destination}.XXXXXX")
  printf 'OPENSTEER_HOME_VERSION=%s\n' "$version" > "$tmp"
  for service in "${services[@]}"; do
    if ! ref=$(jq -er --arg service "$service" --arg version "$version" '
      (.images[$service] // ("ghcr.io/steerlabs/opensteer-home-" + $service + ":" + $version)) |
      select(type == "string" and length <= 512 and test("^[a-z0-9][a-z0-9./:_-]*[a-z0-9_.-](@sha256:[a-f0-9]{64})?$"; "i"))
    ' "$manifest"); then
      rm -f -- "$tmp"
      fail "Invalid image reference for $service."
    fi
    printf 'OPENSTEER_HOME_%s_IMAGE=%s\n' "$(printf %s "$service" | tr 'a-z-' 'A-Z_')" "$ref" >> "$tmp"
  done
  mv -f -- "$tmp" "$destination"
}

compose_project() { compose config --format json | jq -er '.name'; }

install_browser_policy() {
  local image tmp
  image=$(compose config --format json | jq -er '.services["browser-runtime"].image') || return
  tmp=$(mktemp "$home_dir/chromium-oci.XXXXXX") || return
  if docker run --rm --network none --entrypoint cat "$image" /usr/local/share/opensteer/chromium-oci.json > "$tmp"; then
    mv -f -- "$tmp" "$home_dir/chromium-oci.json"
  else
    rm -f -- "$tmp"
    return 1
  fi
}

start_host() {
  local owner pid
  compose up -d --wait --pull never postgres host || return
  owner=$(compose ps -q host) || return
  pid=$(docker inspect --format '{{.State.Pid}}' "$owner") || return
  "$home_dir/firewall.sh" "$pid"
}

start_pod() {
  start_host || return
  compose up -d --wait --pull never || return
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
