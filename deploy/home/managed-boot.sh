#!/usr/bin/env bash
# HTTPS POST /v1/cloud-computers/:id/boot with {hostname, bootstrapToken}.
# The Account returns CloudComputerBootResponseSchema. The token permits replay
# until expiry or completion. POST /boot-complete on the same resource adds
# identity:{deploymentId,hostKeyFingerprint} and expects {completed:true}.
# Repeating completion with the same identity recovers a lost acknowledgement.
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 4 && ( $1 == boot || $1 == boot-complete ) ]] || fail "Usage: managed-boot.sh ACTION SPEC TOKEN_FILE OUTPUT_OR_IDENTITY"
action=$1 spec=$2 token_file=$3 destination=$4
private_file() {
  [[ -f "$1" && ! -L "$1" && $(stat -c '%u:%a' "$1") =~ ^0:[46]00$ ]]
}
private_file "$spec" || fail "The boot spec must be a root-owned file with mode 0400 or 0600."
private_file "$token_file" || fail "The bootstrap token file must be root-owned with mode 0400 or 0600."
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
body=$(jq -ce --rawfile token "$token_file" '
  {hostname, bootstrapToken: ($token | sub("\r?\n$"; ""))} |
  select(.bootstrapToken | test("^[A-Za-z0-9_.-]{1,2048}$"))
' "$spec" 2>/dev/null) || fail "Invalid Cloud Computer bootstrap token."
if [[ $action == boot-complete ]]; then
  body=$(jq -ce --argjson identity "$destination" '. + {$identity}' <<< "$body")
fi
status=$(printf '%s' "$body" | curl -q --silent --show-error --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 30 --max-filesize 131072 \
  --header 'Content-Type: application/json' --data-binary @- \
  --output "$response" --write-out '%{http_code}' \
  "${origin%/}/v1/cloud-computers/$id/$action") || fail "The Account $action request failed."
case "$status" in
  200) ;;
  401|403|409|410) echo "The Account refused Cloud Computer $action: the bootstrap token is invalid, spent, or expired (HTTP $status)." >&2; exit 78 ;;
  *) fail "The Account refused Cloud Computer $action (HTTP $status)." ;;
esac
if [[ $action == boot-complete ]]; then
  jq -e '. == {completed:true}' "$response" >/dev/null || fail "The Account returned an invalid boot acknowledgement."
  exit 0
fi
jq -e --arg hostname "$(jq -r .hostname "$spec")" --arg origin "${origin%/}" --arg id "$id" '
  def secret: type == "string" and length > 0 and length <= 8192 and (test("[[:cntrl:]]") | not);
  (.hostname == $hostname and .accountOrigin == $origin) and
  (.ipv6Enabled | type == "boolean") and
  (.releaseManifestUrl == null or (.releaseManifestUrl |
    type == "string" and length <= 2048 and test("^https://[a-zA-Z0-9.:/_=%+-]+$"))) and
  (.restoreSnapshot == null or (.restoreSnapshot | type == "string" and test("^[0-9a-f]{8,64}$"))) and
  (.setupCodeDigest | type == "string" and test("^[0-9a-f]{64}$")) and
  (.release | (.images as $images |
    ["host", "runner", "browser-runtime", "browser-egress", "channel-runtime", "gateway"] |
    all(.[]; $images[.] | secret))) and
  (.egress == null or (.egress | (.url|secret) and (.username|secret) and (.password|secret))) and
  (.managedHome == null or (.managedHome |
    (.cloudComputerId == $id) and
    (.generation | type == "number" and . >= 1 and . == floor) and
    (.oidc.clientId | type == "string" and test("^occ_[0-9a-f-]{36}$")) and
    (.oidc.clientSecret | type == "string" and test("^ocs_[A-Za-z0-9_-]{43}$")))) and
  (.work == null or (.work |
    (.organizationId | type == "string" and test("^org_[0-9a-f-]{36}$")) and
    (.assignmentId | type == "string" and test("^was_[0-9a-f-]{36}$")) and
    (.organizationName | type == "string" and length > 0 and length <= 120))) and
  (.accountOrigin | type == "string" and test("^https://[a-zA-Z0-9.-]+(:[0-9]+)?$")) and
  (.backup |
    (.endpoint | type == "string" and test("^https://[a-zA-Z0-9.-]+(:[0-9]+)?$")) and
    (.bucket | type == "string" and test("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")) and
    (.prefix | type == "string" and length <= 512 and test("^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$")) and
    .repository == ("s3:" + .endpoint + "/" + .bucket + "/" + .prefix) and
    (.password|secret) and (.accessKeyId|secret) and (.secretAccessKey|secret))
' "$response" >/dev/null 2>&1 || fail "The Account returned invalid Home boot configuration."
tmp=$(mktemp "${destination}.XXXXXX")
install -m 0600 "$response" "$tmp"
mv -f -- "$tmp" "$destination"
