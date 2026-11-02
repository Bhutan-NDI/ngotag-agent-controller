#!/bin/sh

# GitHub Releases of this public repository are world-readable. Fails when the
# notes contain an infrastructure identifier.
#
#   check-release-notes.sh authored  <file> [private-name ...]
#   check-release-notes.sh generated <file> [private-name ...]
#
# Both modes reject unambiguous identifiers: account IDs, ARNs, registry hosts,
# storage URLs, network and storage resource IDs, workflow image tags, and the
# given private names (cluster, services, task definition families, image
# repositories) as whole words. `authored` (the text this workflow writes) also
# rejects digests, task definitions and architectures. `generated` (GitHub's
# list of already-public PR titles) does not, so an ordinary PR title such as
# "pin base image sha256:..." never blocks a release.
#
# A 12-digit run inside a longer hex token, such as a commit SHA, is not an
# account ID. Private names shorter than 6 characters, or contained in the
# public title or repository name (PUBLIC_TEXT), are too generic to check.

set -eu

if [ "$#" -lt 2 ]; then
  echo "usage: $0 authored|generated <notes-file> [private-name ...]" >&2
  exit 2
fi

mode=$1
notes=$2
shift 2
test -f "$notes" || { echo "release notes file does not exist" >&2; exit 1; }

hard='(^|[^0-9a-f])[0-9]{12}([^0-9a-f]|$)|arn:aws|amazonaws\.com|dkr\.ecr|s3://|(^|[^a-z0-9])(subnet|sg|vpc|fs|fsap|eni)-[0-9a-f]{8,}|agent-controller-[0-9a-f]{12}([^0-9a-z]|$)|agent-controller-[0-9]+\.[0-9]+\.[0-9]+'
authored_only='sha256:|task[ _-]?definition|taskdef|linux/(amd|arm)64|-services:'
case "$mode" in
  authored) pattern="$hard|$authored_only" ;;
  generated) pattern=$hard ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac

if grep -Eiq -- "$pattern" "$notes"; then
  echo "release notes contain an infrastructure identifier; refusing to publish" >&2
  exit 1
fi

public_text=$(printf '%s' "${PUBLIC_TEXT:-}" | tr '[:upper:]' '[:lower:]')
for private_name in "$@"; do
  [ "${#private_name}" -ge 6 ] || continue
  lower=$(printf '%s' "$private_name" | tr '[:upper:]' '[:lower:]')
  case "$public_text" in *"$lower"*) continue ;; esac
  # Whole words only: a name never matches inside a longer identifier.
  if grep -Fiq -- "$private_name" "$notes" &&
    LC_ALL=C awk -v name="$lower" '
      {
        line = tolower($0)
        while ((start = index(line, name)) > 0) {
          before = substr(line, start - 1, 1)
          after = substr(line, start + length(name), 1)
          if (before !~ /[a-z0-9_-]/ && after !~ /[a-z0-9_-]/) { found = 1; exit }
          line = substr(line, start + 1)
        }
      }
      END { exit found ? 0 : 1 }' "$notes"; then
    echo "release notes contain a private deployment name; refusing to publish" >&2
    exit 1
  fi
done
