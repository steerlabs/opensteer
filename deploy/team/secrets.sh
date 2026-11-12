#!/usr/bin/env bash
# Usage: secrets.sh init|renew DIRECTORY
# Compose bind-mounts each file into containers running as other users, so files
# are 0644 inside an owner-only 0700 directory. Existing values are never rotated,
# except the first-owner setup token on renew.
set -euo pipefail
umask 077
[[ $# -eq 2 && ( $1 == init || $1 == renew ) ]] || { echo 'Usage: secrets.sh init|renew DIRECTORY' >&2; exit 1; }
mode=$1
dir=$2
fail() { echo "$*" >&2; exit 1; }

random_secret() { head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }

# Prints the value of an existing secret after checking it is one safe file.
read_secret() {
  local path=$dir/$1 value
  [[ ! -L $path && -f $path ]] || fail "$path is not a regular secret file"
  [[ -O $path ]] || fail "$path is not owned by the current operator"
  [[ -n $(find "$path" -maxdepth 0 -links 1) ]] || fail "$path must have exactly one filesystem link"
  [[ $(wc -c < "$path") -le 16384 ]] || fail "$path exceeds the secret byte limit"
  value=$(cat "$path")
  [[ $value =~ ^[A-Za-z0-9_-]+$ || ( $1 == database_url && $value =~ ^postgres://opensteer:[A-Za-z0-9_-]+@postgres:5432/opensteer$ ) ]] ||
    fail "$path must contain exactly one generated secret"
  chmod 0644 "$path"
  printf '%s' "$value"
}

# Publishes a new file without replacing one that already exists.
create_secret() {
  local temporary
  [[ -e $dir/$1 || -L $dir/$1 ]] && return 0
  temporary=$(mktemp "$dir/.$1.XXXXXX")
  printf '%s\n' "$2" > "$temporary"
  chmod 0644 "$temporary"
  ln "$temporary" "$dir/$1" 2>/dev/null || true
  rm -f "$temporary"
}

[[ ! -L $dir ]] || fail "$dir must not be a symbolic link"
mkdir -p "$dir"
[[ -d $dir && -O $dir ]] || fail "$dir is not a directory owned by the current operator"
chmod 0700 "$dir"

if [[ $mode == renew ]]; then
  read_secret initial_owner_enrollment_token > /dev/null
  temporary=$(mktemp "$dir/.initial_owner_enrollment_token.XXXXXX")
  printf '%s\n' "$(random_secret 48)" > "$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "$dir/initial_owner_enrollment_token"
  exit 0
fi

create_secret postgres_password "$(random_secret 32)"
password=$(read_secret postgres_password)
create_secret auth_secret "$(random_secret 48)"
create_secret initial_owner_enrollment_token "$(random_secret 48)"
create_secret database_url "postgres://opensteer:$password@postgres:5432/opensteer"
read_secret auth_secret > /dev/null
read_secret initial_owner_enrollment_token > /dev/null
[[ $(read_secret database_url) == "postgres://opensteer:$password@postgres:5432/opensteer" ]] ||
  fail "$dir/database_url does not match the persisted PostgreSQL password"
