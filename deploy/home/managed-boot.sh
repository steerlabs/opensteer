#!/usr/bin/env bash
# POST /v1/cloud-computers/{cloudComputerId}/bootstrap over HTTPS.
# Request JSON: {hostname, bootstrapToken}. The Account binds both to the ID,
# authenticates and consumes the token atomically. Return HTTP 409 or 410
# for a spent token, or HTTP 200 with the following JSON:
# {
#   "setupCodeDigest": "<64 lowercase hex SHA-256 characters>",
#   "release": {"version": "x.y.z", "images": {"host": "<ref>", "runner": "<ref>",
#     "browser-runtime": "<ref>", "browser-egress": "<ref>", "channel-runtime": "<ref>",
#     "gateway": "<ref>"}},
#   "egress": {"url": "https://isp.example:443", "username": "...", "password": "..."},
#   "backup": {"repository": "s3:https://s3.example/bucket/prefix",
#     "password": "...", "accessKeyId": "...", "secretAccessKey": "..."}
# }
# The egress object and releaseManifestUrl (an HTTPS update feed) are optional.
# A managed Home also receives "managedHome": {"cloudComputerId", "generation",
#   "oidc": {"clientId", "clientSecret"}}, the claim it accepts and the OIDC client
#   the Account registered for its owner's Account sign-in.
# CI publishes immutable digest references.
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 3 ]] || fail "Usage: managed-boot.sh SPEC OUTPUT TOKEN_FILE"
spec=$1 output=$2
private_file() {
  [[ -f "$1" && ! -L "$1" && $(stat -c '%u:%a' "$1") =~ ^0:[46]00$ ]]
}
private_file "$spec" || fail "The boot spec must be a root-owned file with mode 0400 or 0600."
private_file "$3" || fail "The bootstrap token file must be root-owned with mode 0400 or 0600."
jq -e '
  (.cloudComputerId | type == "string" and test("^cc_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
  (has("bootstrapToken") | not) and
  (.hostname | type == "string" and length <= 253 and test("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")) and
  (.accountOrigin | type == "string" and test("^https://[a-zA-Z0-9.-]+(:[0-9]+)?/?$")) and
  (.installerUrl | type == "string" and length <= 2048 and test("^https://[^@/?#[:space:]]+(/[^?#[:space:]]*)?$")) and
  (.installerSha256 | type == "string" and test("^[0-9a-f]{64}$"))
' "$spec" >/dev/null 2>&1 || fail "Invalid managed boot spec."
id=$(jq -r .cloudComputerId "$spec")
origin=$(jq -r .accountOrigin "$spec")
response=$(mktemp)
trap 'rm -f -- "$response"' EXIT
body=$(jq -ce --rawfile token "$3" '
  {hostname, bootstrapToken: ($token | sub("\r?\n$"; ""))} |
  select(.bootstrapToken | test("^[A-Za-z0-9_.-]{1,2048}$"))
' "$spec" 2>/dev/null) || fail "Invalid Cloud Computer bootstrap token."
status=$(printf '%s' "$body" | curl -q --silent --show-error --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 30 --max-filesize 131072 \
  --header 'Content-Type: application/json' --data-binary @- \
  --output "$response" --write-out '%{http_code}' \
  "${origin%/}/v1/cloud-computers/$id/bootstrap") || fail "The Account bootstrap exchange failed."
case "$status" in
  200) ;;
  409|410) fail "This Cloud Computer bootstrap token has already been used. Request a new token." ;;
  *) fail "The Account refused Cloud Computer bootstrap (HTTP $status)." ;;
esac
jq -e '
  def secret: type == "string" and length > 0 and length <= 8192 and (test("[[:cntrl:]]") | not);
  (.setupCodeDigest | type == "string" and test("^[0-9a-f]{64}$")) and
  (.release | (.images as $images |
    ["host", "runner", "browser-runtime", "browser-egress", "channel-runtime", "gateway"] |
    all(.[]; $images[.] | secret))) and
  (.releaseManifestUrl == null or (.releaseManifestUrl | secret and startswith("https://"))) and
  (.egress == null or (.egress | (.url|secret) and (.username|secret) and (.password|secret))) and
  (.managedHome == null or (.managedHome |
    (.cloudComputerId | type == "string" and test("^cc_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
    (.generation | type == "number" and . >= 1 and . == floor) and
    (.oidc.clientId | type == "string" and test("^occ_[0-9a-f-]{36}$")) and
    (.oidc.clientSecret | type == "string" and test("^ocs_[A-Za-z0-9_-]{43}$")))) and
  (.accountOrigin | type == "string" and test("^https://[a-zA-Z0-9.-]+(:[0-9]+)?$")) and
  (.backup | (.repository|secret and startswith("s3:")) and (.password|secret) and (.accessKeyId|secret) and (.secretAccessKey|secret))
' "$response" >/dev/null 2>&1 || fail "The Account returned invalid Home boot configuration."
install -m 0600 "$response" "$output"
