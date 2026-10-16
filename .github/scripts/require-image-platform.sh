#!/bin/sh

# Fails unless the image (a single manifest or an index) provides linux/<arch>.
# Kept sidecar containers must run on the platform the task is pinned to.

set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <image> <arch>" >&2
  exit 2
fi

image=$1
arch=$2

raw=$(docker buildx imagetools inspect --raw "$image") || {
  echo "could not inspect a kept container image" >&2
  exit 1
}
media_type=$(printf '%s' "$raw" | jq -r '.mediaType // empty')
case "$media_type" in
  application/vnd.oci.image.index.v1+json | application/vnd.docker.distribution.manifest.list.v2+json)
    printf '%s' "$raw" | jq -e --arg arch "$arch" \
      'any(.manifests[]; .platform.os == "linux" and .platform.architecture == $arch)' >/dev/null
    ;;
  application/vnd.oci.image.manifest.v1+json | application/vnd.docker.distribution.manifest.v2+json)
    docker buildx imagetools inspect --format '{{json .Image}}' "$image" \
      | jq -e --arg arch "$arch" '.os == "linux" and .architecture == $arch' >/dev/null
    ;;
  *)
    false
    ;;
esac || {
  echo "a kept container image does not provide linux/$arch" >&2
  exit 1
}
