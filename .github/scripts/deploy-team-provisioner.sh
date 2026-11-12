#!/usr/bin/env bash
# Rolls the hosted-team provisioner to one release; it then rolls each team to that release's
# team Host and gateway images, one team at a time.
# Usage: deploy-team-provisioner.sh <provisioner@sha256:…> <team-host@sha256:…> <team-gateway@sha256:…> <source-sha>
set -euo pipefail

provisioner=$1
host=$2
gateway=$3
source=$4
namespace=opensteer-teams
for image in "$provisioner" "$host" "$gateway"; do
  [[ $image =~ ^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$ ]] || { echo "Image must be pinned by digest: $image" >&2; exit 1; }
done
[[ $source =~ ^[0-9a-f]{40}$ ]] || { echo "Source must be a full commit SHA: $source" >&2; exit 1; }

live=$(kubectl -n "$namespace" get deployment team-provisioner --ignore-not-found \
  -o jsonpath='{.metadata.annotations.opensteer\.dev/source-revision}')
if [[ -n $live ]]; then
  # A rerun of an older workflow must not roll the teams back.
  status=0
  git merge-base --is-ancestor "$live" "$source" || status=$?
  if ((status == 1)); then
    echo "Live provisioner runs $live, which $source does not contain; leaving it."
    exit 0
  fi
  ((status == 0)) || { echo "Cannot compare $source with live $live" >&2; exit 1; }
fi

root=$(git rev-parse --show-toplevel)
kubectl kustomize "$root/deploy/team-provisioner" |
  sed -e "s|@PROVISIONER_IMAGE@|$provisioner|g" -e "s|@TEAM_HOST_IMAGE@|$host|g" \
    -e "s|@TEAM_GATEWAY_IMAGE@|$gateway|g" -e "s|@SOURCE_REVISION@|$source|g" |
  kubectl apply -f -

if ! kubectl -n "$namespace" rollout status deployment/team-provisioner --timeout=10m; then
  kubectl -n "$namespace" rollout undo deployment/team-provisioner
  exit 1
fi
