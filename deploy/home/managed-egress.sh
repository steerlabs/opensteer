#!/usr/bin/env bash
# shellcheck disable=SC2154

poll_managed_egress() {
  local destination=$1 origin=$2 id=$3 client_id=$4 secret_file=$5 secret status
  [[ $origin =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ && $id =~ ^cc_[a-f0-9-]{36}$ &&
    $client_id =~ ^occ_[a-f0-9-]{36}$ && -s $secret_file ]] ||
    fail 'Invalid managed egress polling configuration.'
  secret=$(cat "$secret_file")
  [[ $secret =~ ^ocs_[a-zA-Z0-9_-]{43}$ ]] || fail 'Invalid managed egress credential.'
  status=$(printf 'user = "%s:%s"\n' "$client_id" "$secret" |
    curl -q --config - --basic --silent --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 20 --max-filesize 16384 \
      --output "$destination" --write-out '%{http_code}' \
      -- "$origin/v1/cloud-computers/$id/egress") || fail 'The Account egress request failed.'
  [[ $status == 200 ]] || fail "The Account refused the egress request (HTTP $status)."
  if ! jq -e '. == {}' "$destination" >/dev/null 2>&1 && ! valid_managed_egress "$destination"; then
    echo 'The Account returned invalid egress configuration; browser egress remains pending.' >&2
    printf '{}\n' > "$destination"
  fi
}

maintain_managed_egress() {
  local pending="$home_dir/egress.pending" origin id client_id response
  # A pooled Cloud Computer's browser leaves through its own address on the pool host; the
  # account answers its Home {} here, every time (egressForHome).
  [[ ! -f "$home_dir/browser-pool" ]] || return 0
  if [[ ! -s "$home_dir/secrets/egress_url" && -s "$home_dir/secrets/oidc_client_secret" ]]; then
    origin=$(sed -n "s/^OPENSTEER_HOME_ACCOUNT_ORIGIN='\([^']*\)'$/\1/p" "$home_dir/config.env")
    id=$(sed -n "s/^OPENSTEER_HOME_MANAGED_ID='\([^']*\)'$/\1/p" "$home_dir/config.env")
    client_id=$(sed -n "s/^OPENSTEER_HOME_OIDC_CLIENT_ID='\([^']*\)'$/\1/p" "$home_dir/config.env")
    (
      response=$(mktemp "$home_dir/egress.XXXXXX")
      trap 'rm -f -- "$response"' EXIT
      poll_managed_egress "$response" "$origin" "$id" "$client_id" "$home_dir/secrets/oidc_client_secret"
      if jq -e 'has("egress")' "$response" >/dev/null; then
        touch "$pending"
        sync "$home_dir"
        save_managed_egress "$response"
        sync "$home_dir/secrets"
      fi
    )
  fi
  if [[ -f $pending && -s "$home_dir/secrets/egress_url" ]]; then
    compose up -d --wait --wait-timeout 240 --no-deps --pull never --force-recreate browser-egress
    rm -f -- "$pending"
    echo 'Managed browser egress is configured.'
  fi
}
