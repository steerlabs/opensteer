#!/usr/bin/env bash
set -euo pipefail
home_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ $# == 1 ]] || { echo 'Usage: package-installer.sh OUTPUT.sh' >&2; exit 2; }
version=$(jq -er .version "$home_source/../../package.json")
package=$(mktemp -d)
trap 'rm -rf -- "$package"' EXIT
printf '%s\n' "$version" > "$package/version"
# The release's files, as common.sh lists them for the installer and for an update.
release_files=$(sed -n 's/^release_files=(\(.*\))$/\1/p' "$home_source/common.sh")
[[ -n $release_files ]] || { echo 'common.sh lists no release files.' >&2; exit 1; }
for file in $release_files; do
  install -m 0700 "$home_source/$file" "$package/$file"
done
{
  cat <<'HEADER'
#!/usr/bin/env bash
set -euo pipefail
umask 077
package=$(mktemp -d)
trap 'rm -rf -- "$package"' EXIT
base64 -d <<'OPENSTEER_HOME_FILES' | tar -xzf - -C "$package"
HEADER
  tar -C "$package" -czf - . | base64 | fold -w 76
  cat <<'FOOTER'
OPENSTEER_HOME_FILES
bash "$package/install.sh" "$@"
FOOTER
} > "$1"
chmod 0755 "$1"
