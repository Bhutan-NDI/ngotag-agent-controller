#!/bin/sh

# GitHub Releases of this public repository are world-readable. Fails when the
# notes contain an infrastructure identifier: account IDs, ARNs, registry or
# image references, digests, task definitions, architectures, storage or
# network identifiers, or any literal private name given as an argument
# (cluster, services, image repository from the private manifest).

set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <notes-file> [private-name ...]" >&2
  exit 2
fi

notes=$1
shift
test -f "$notes" || { echo "release notes file does not exist" >&2; exit 1; }

pattern='(^|[^0-9])[0-9]{12}([^0-9]|$)|arn:aws|amazonaws\.com|dkr\.ecr|sha256:|task[ _-]?definition|taskdef|s3://|linux/(amd|arm)64|(^|[^a-z0-9])(subnet|sg|vpc|fs|fsap|eni|i)-[0-9a-f]{8,}|-services:|agent-controller-[0-9]+\.[0-9]+\.[0-9]+'
if grep -Eiq -- "$pattern" "$notes"; then
  echo "release notes contain an infrastructure identifier; refusing to publish" >&2
  exit 1
fi

for private_name in "$@"; do
  [ -n "$private_name" ] || continue
  if grep -Fiq -- "$private_name" "$notes"; then
    echo "release notes contain a private deployment name; refusing to publish" >&2
    exit 1
  fi
done
