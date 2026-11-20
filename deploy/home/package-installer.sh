#!/usr/bin/env bash
set -euo pipefail
home_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ $# == 1 ]] || { echo 'Usage: package-installer.sh OUTPUT.sh' >&2; exit 2; }
version=$(jq -er .version "$home_source/../../package.json")
package=$(mktemp -d)
trap 'rm -rf -- "$package"' EXIT
printf '%s\n' "$version" > "$package/version"
for file in install.sh managed-boot.sh common.sh firewall.sh backup.sh update.sh opensteer-home install-scheduler.sh install-managed-unit.sh compose.yaml compose.egress.yaml compose.egress-pending.yaml managed-egress.sh compose.apparmor.yaml compose.ipv6.yaml; do
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
