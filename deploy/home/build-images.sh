#!/usr/bin/env bash
# Builds the six Home images from this source for this machine and writes a release manifest
# that names them, for `install.sh --local-images --manifest MANIFEST.json HOSTNAME`.
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: sudo bash deploy/home/build-images.sh MANIFEST.json' >&2; exit 2; }
output=$1
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
services=(host gateway runner browser-runtime browser-egress channel-runtime)
fail() { echo "$*" >&2; exit 1; }

for program in docker git jq; do
  command -v "$program" >/dev/null || fail "Missing $program."
done
docker buildx version >/dev/null 2>&1 ||
  fail 'Docker Buildx is required. On Ubuntu 24.04 run: apt-get install docker-buildx'
version=$(jq -er .version "$source_root/package.json")
# The images record the exact source they were built from.
revision=${OPENSTEER_SOURCE_REVISION:-$(git -c safe.directory="$source_root" -C "$source_root" rev-parse HEAD 2>/dev/null || true)}
[[ $revision =~ ^[0-9a-f]{40}$ ]] ||
  fail 'Build from a Git checkout of the release, or set OPENSTEER_SOURCE_REVISION to its 40-character commit.'
case $(uname -m) in
  x86_64) platform=linux/amd64 ;;
  aarch64 | arm64) platform=linux/arm64 ;;
  *) fail "Home images are built for amd64 and arm64, not $(uname -m)." ;;
esac

cd "$source_root"
echo "Building the six Home images for $platform from $revision."
REGISTRY=local TAG="$version" RELEASE_VERSION="$version" SOURCE_REVISION="$revision" \
  CACHE_BACKEND=none CACHE_EXPORT=false \
  docker buildx bake --builder default -f deploy/container/docker-bake.hcl \
  --set "home-*.platform=$platform" --load home

images='{}'
for service in "${services[@]}"; do
  ref="local/opensteer-home-$service:$version"
  digest=$(docker image inspect --format '{{.Id}}' "$ref")
  # Name the image by its digest where this Docker can find it that way.
  if docker image inspect "local/opensteer-home-$service@$digest" >/dev/null 2>&1; then
    ref="local/opensteer-home-$service@$digest"
  fi
  images=$(jq -c --arg service "$service" --arg ref "$ref" '. + {($service): $ref}' <<< "$images")
done
jq -n --arg version "$version" --argjson images "$images" '{version: $version, images: $images}' > "$output"
echo "Wrote $output. Install with:"
echo "  sudo bash deploy/home/install.sh --local-images --manifest $output HOSTNAME"
