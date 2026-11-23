#!/bin/bash
# fixture-authority-files.sh [--verify] <directory> <authority name> <account name>
#
# Writes a certificate authority made for one job (ca.pem, ca.key) and a server certificate it
# signs for <account name> (account.pem, account.key) into <directory>. Files only: nothing here
# is trusted, installed or resolved. The guarded guest step (`fixture-keychain.sh`) makes them in
# the guest; `tests/first-run/account-tls.test.ts` makes them here the same way and holds them to
# what a client checks. It checks what it made before it ends, and says what it made, by
# fingerprint, for the run's log. With `--verify`, it runs only that check on existing files.
#
# Always the system's /usr/bin/openssl (LibreSSL in the macOS guest, OpenSSL on Linux), as the
# guest step finds it on SSH's plain PATH: a test here must make the files with the same tool.
# Each certificate's name is in its own config: LibreSSL takes the subject from the config and
# ignores -subj (run 20261122T221025Z-d20c2ea7 made both certificates "CN=placeholder", and Node's
# client then took the leaf for self-signed).
set -euo pipefail
verify_only=0
if [ "${1:-}" = "--verify" ]; then
  verify_only=1
  shift
fi
[ "$#" -eq 3 ] || {
  echo "usage: fixture-authority-files.sh [--verify] <directory> <authority name> <account name>" >&2
  exit 64
}
openssl=/usr/bin/openssl
directory="$1"
authority_name="$2"
account_name="$3"
[ "$authority_name" != "$account_name" ] || {
  echo "fixture authority: the authority and the account service need names of their own" >&2
  exit 64
}
if [ "$verify_only" -eq 0 ]; then
  mkdir -p "$directory"
  cat >"$directory/authority.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $authority_name
[authority]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
CNF
  cat >"$directory/account.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $account_name
[account]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:$account_name
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
CNF
  "$openssl" req -x509 -new -nodes -newkey rsa:2048 -keyout "$directory/ca.key" -out "$directory/ca.pem" \
    -days 2 -config "$directory/authority.cnf" -extensions authority 2>/dev/null
  "$openssl" req -new -nodes -newkey rsa:2048 -keyout "$directory/account.key" -out "$directory/account.csr" \
    -config "$directory/account.cnf" 2>/dev/null
  "$openssl" x509 -req -in "$directory/account.csr" -CA "$directory/ca.pem" -CAkey "$directory/ca.key" \
    -CAcreateserial -out "$directory/account.pem" -days 2 -extfile "$directory/account.cnf" \
    -extensions account 2>/dev/null
fi

# What a client checks, not only what LibreSSL's verify accepts (it accepted the leaf whose issuer
# was its own name): each its own name, the leaf issued by the authority's name and key, for the
# account host. Anything else ends here, loudly, and not as a client's "self-signed" later.
# `-nameopt RFC2253` fixes the subject/issuer form across LibreSSL and OpenSSL (`CN=...`).
field() {
  "$openssl" x509 -in "$directory/$1" -noout "-$2" -nameopt RFC2253 | sed -e "s/^$2= *//"
}
extension_value() {
  "$openssl" x509 -in "$directory/$1" -noout -text |
    awk -v heading="$2" 'found { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit } index($0, heading) { found = 1 }'
}
key_id() {
  extension_value "$1" "$2" | sed -e 's/^keyid://' | tr '[:lower:]' '[:upper:]'
}
fail() {
  echo "fixture authority: $1" >&2
  exit 1
}
[ "$(field ca.pem subject)" = "CN=$authority_name" ] || fail "the authority is named $(field ca.pem subject)"
[ "$(field account.pem subject)" = "CN=$account_name" ] || fail "the account certificate is named $(field account.pem subject)"
[ "$(field account.pem issuer)" = "CN=$authority_name" ] || fail "the account certificate's issuer is $(field account.pem issuer)"
authority_key="$(key_id ca.pem "X509v3 Subject Key Identifier")"
account_authority_key="$(key_id account.pem "X509v3 Authority Key Identifier")"
[[ "$authority_key" =~ ^[0-9A-F]{2}(:[0-9A-F]{2})+$ ]] && [ "$account_authority_key" = "$authority_key" ] ||
  fail "the account certificate does not name the authority's key"
[ "$(extension_value account.pem "X509v3 Subject Alternative Name")" = "DNS:$account_name" ] ||
  fail "the account certificate is not for $account_name"
if ! verified="$("$openssl" verify -CAfile "$directory/ca.pem" "$directory/account.pem" 2>&1)"; then
  fail "the certificate made for $account_name does not verify against its authority: $verified"
fi
if [ "$verify_only" -eq 0 ]; then
  for name in ca account; do
    echo "fixture authority: $name.pem $("$openssl" x509 -in "$directory/$name.pem" -noout -fingerprint -sha256) $("$openssl" x509 -in "$directory/$name.pem" -noout -subject -nameopt RFC2253) $("$openssl" x509 -in "$directory/$name.pem" -noout -issuer -nameopt RFC2253) ($("$openssl" version))"
  done
fi
