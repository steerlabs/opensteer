#!/usr/bin/env bash
# Usage: team-images.sh build PLATFORM OUT_DIR | publish DIGEST_DIR
# Builds and publishes the team Host and gateway images for VERSION from source SHA.
# A version tag is written once: reruns and Stable promotion reuse the published
# index after checking it records the same source.
set -euo pipefail
: "${VERSION:?}" "${SHA:?}"
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $SHA =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected numeric VERSION and exact SHA' >&2; exit 1; }
registry=ghcr.io/steerlabs
source_url=https://github.com/steerlabs/opensteer
buildkit=moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe
# target:repository:output
images="host:opensteer-team-host:host_image team-gateway:opensteer-team-gateway:gateway_image"

# Succeeds when the version is published from SHA, fails when it is absent and
# exits when it records another source or the registry cannot answer.
published() {
  local output error revision
  error=$(mktemp)
  if output=$(docker buildx imagetools inspect --raw "$1:$VERSION" 2>"$error"); then
    rm -f "$error"
    revision=$(jq -r '.annotations["org.opencontainers.image.revision"] // "unknown"' <<<"$output")
    [[ $revision == "$SHA" ]] || { echo "$1:$VERSION records source $revision, not $SHA" >&2; exit 1; }
    return 0
  fi
  # GHCR answers "denied" for a package that does not exist yet.
  grep -Eqi 'not found|manifest unknown|name unknown|denied' "$error" || { cat "$error" >&2; rm -f "$error"; exit 1; }
  rm -f "$error"
  return 1
}

build() {
  local platform=$1 out=$2 target name repository
  mkdir -p "$out"
  printf '%s\n' "$platform" > "$out/platform-${platform#linux/}"
  docker buildx create --use --driver docker-container --driver-opt "image=$buildkit" > /dev/null
  for entry in $images; do
    IFS=: read -r target name _ <<<"$entry"
    repository=$registry/$name
    if published "$repository"; then continue; fi
    docker buildx build --file deploy/container/Containerfile --target "$target" --platform "$platform" \
      --build-arg OPENSTEER_AGENT_PHONE_MODE=none \
      --build-arg OPENSTEER_RELEASE_VERSION="$VERSION" --build-arg OPENSTEER_SOURCE_REVISION="$SHA" \
      --label "org.opencontainers.image.source=$source_url" \
      --label "org.opencontainers.image.revision=$SHA" --label "org.opencontainers.image.version=$VERSION" \
      --output "type=image,name=$repository,push-by-digest=true,name-canonical=true,push=true" \
      --metadata-file "$out/$target.json" .
    jq -r '."containerimage.digest"' "$out/$target.json" > "$out/$target-${platform#linux/}"
    rm "$out/$target.json"
  done
}

publish() {
  local dir=$1 target name output repository digest arch
  local -a sources
  for entry in $images; do
    IFS=: read -r target name output <<<"$entry"
    repository=$registry/$name
    if ! published "$repository"; then
      sources=()
      for arch in amd64 arm64; do
        digest=$(cat "$dir/$target-$arch")
        [[ $digest =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid $target $arch digest" >&2; exit 1; }
        sources+=("$repository@$digest")
      done
      docker buildx imagetools create --tag "$repository:$VERSION" \
        --annotation "index:org.opencontainers.image.source=$source_url" \
        --annotation "index:org.opencontainers.image.revision=$SHA" \
        --annotation "index:org.opencontainers.image.version=$VERSION" \
        "${sources[@]}"
      published "$repository" || { echo "$repository:$VERSION is not visible after publishing" >&2; exit 1; }
    fi
    digest=$(docker buildx imagetools inspect "$repository:$VERSION" --format '{{json .Manifest}}' | jq -r .digest)
    [[ $digest =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid $repository:$VERSION digest" >&2; exit 1; }
    printf '%s=%s@%s\n' "$output" "$repository" "$digest" >> "$GITHUB_OUTPUT"
  done
}

usage() { echo 'Usage: team-images.sh build PLATFORM OUT_DIR | publish DIGEST_DIR' >&2; exit 1; }
case "${1:-}" in
  build) [[ $# -eq 3 ]] || usage; build "$2" "$3" ;;
  publish) [[ $# -eq 2 ]] || usage; publish "$2" ;;
  *) usage ;;
esac
