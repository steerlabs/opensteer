#!/usr/bin/env bash
# Rolls the hosted Account service to one image built from a main commit.
# Usage: deploy-account.sh <registry/control-plane@sha256:digest> <source-sha>
set -euo pipefail

image=$1
source=$2
namespace=opensteer-system
[[ $image =~ @sha256:[0-9a-f]{64}$ ]] || { echo "Image must be pinned by digest: $image" >&2; exit 1; }
[[ $source =~ ^[0-9a-f]{40}$ ]] || { echo "Source must be a full commit SHA: $source" >&2; exit 1; }

live=$(kubectl -n "$namespace" get deployment account --ignore-not-found \
  -o jsonpath='{.metadata.annotations.opensteer\.dev/source-revision}')
if [[ -n $live ]]; then
  # A rerun of an older workflow must not roll the Account back.
  status=0
  git merge-base --is-ancestor "$live" "$source" || status=$?
  if ((status == 1)); then
    echo "Live Account runs $live, which $source does not contain; leaving it."
    exit 0
  fi
  ((status == 0)) || { echo "Cannot compare $source with live $live" >&2; exit 1; }
fi

root=$(git rev-parse --show-toplevel)
kubectl kustomize "$root/deploy/account" |
  sed -e "s|@ACCOUNT_IMAGE@|$image|g" -e "s|@SOURCE_REVISION@|$source|g" |
  kubectl apply -f -

if ! kubectl -n "$namespace" rollout status deployment/account --timeout=10m; then
  # The previous release is still serving; put its pods back and report the failure.
  kubectl -n "$namespace" rollout undo deployment/account
  exit 1
fi
