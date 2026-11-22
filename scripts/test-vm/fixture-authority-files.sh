#!/bin/bash
# fixture-authority-files.sh <directory> <authority name> <account name>
#
# Writes a certificate authority made for one job (ca.pem, ca.key) and a server certificate it
# signs for <account name> (account.pem, account.key) into <directory>. Files only: nothing here
# is trusted, installed or resolved. The guarded guest step (`fixture-keychain.sh`) trusts the
# authority in the guest; `tests/first-run/account-tls.integration.test.ts` uses the files on its
# own, here.
set -euo pipefail
[ "$#" -eq 3 ] || {
  echo "usage: fixture-authority-files.sh <directory> <authority name> <account name>" >&2
  exit 64
}
directory="$1"
authority_name="$2"
account_name="$3"
mkdir -p "$directory"
cat >"$directory/authority.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = placeholder
[authority]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[account]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:$account_name
CNF
openssl req -x509 -new -nodes -newkey rsa:2048 -keyout "$directory/ca.key" -out "$directory/ca.pem" \
  -days 2 -subj "/CN=$authority_name" -config "$directory/authority.cnf" -extensions authority 2>/dev/null
openssl req -new -nodes -newkey rsa:2048 -keyout "$directory/account.key" -out "$directory/account.csr" \
  -subj "/CN=$account_name" -config "$directory/authority.cnf" 2>/dev/null
openssl x509 -req -in "$directory/account.csr" -CA "$directory/ca.pem" -CAkey "$directory/ca.key" \
  -CAcreateserial -out "$directory/account.pem" -days 2 -extfile "$directory/authority.cnf" \
  -extensions account 2>/dev/null
