#!/bin/sh

set -eu

script=.github/scripts/resolve-release-version.sh
contract=.github/agent-controller-release-contract.json
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
trigger=2026-10-16T08:00:00Z

release() {
  # tag commit published_at [draft]
  printf '{"tag_name":"%s","target_commitish":"%s","published_at":"%s","created_at":"2020-01-01T00:00:00Z","draft":%s}' \
    "$1" "$2" "$3" "${4:-false}"
}

releases() {
  printf '['
  separator=
  for entry in "$@"; do
    printf '%s%s' "$separator" "$entry"
    separator=,
  done
  printf ']\n'
}

resolve() {
  sh "$script" "$contract" "$1" "$2" "$work/releases.json" "$3" "$trigger"
}

assert_output() {
  expected=$1
  actual=$2
  description=$3
  if [ "$actual" != "$expected" ]; then
    echo "$description: expected" >&2
    printf '%s\n' "$expected" >&2
    echo "found" >&2
    printf '%s\n' "$actual" >&2
    exit 1
  fi
}

assert_fails() {
  description=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "$description: expected failure" >&2
    exit 1
  fi
}

# First automated releases continue from the legacy release names.
releases \
  "$(release prod-credo-0.0.9 "$a" 2026-10-15T15:26:20Z)" \
  "$(release stage-credo-0.0.9 "$a" 2026-10-08T10:33:40Z)" \
  "$(release qa-credo-0.0.20 "$a" 2026-09-29T10:50:52Z)" > "$work/releases.json"
assert_output "version=0.0.10-qa.1
release_tag=agent-controller/v0.0.10-qa.1
previous_tag=qa-credo-0.0.20
reuse=false" "$(resolve qa 0.0.10 "$a")" "first QA release"
assert_output "version=0.0.10-rc.1
release_tag=agent-controller/v0.0.10-rc.1
previous_tag=stage-credo-0.0.9
reuse=false" "$(resolve stage 0.0.10 "$a")" "first Stage release candidate"
assert_output "version=0.0.10
release_tag=agent-controller/v0.0.10
previous_tag=prod-credo-0.0.9
reuse=false" "$(resolve prod agent-controller/v0.0.10-rc.1 "$a")" "first Prod promotion"

# Pre-release numbers increase per version and channel; drafts are ignored.
releases \
  "$(release agent-controller/v0.0.10-rc.1 "$a" 2026-10-15T00:00:00Z)" \
  "$(release agent-controller/v0.0.10-rc.2 "$a" 2026-10-15T01:00:00Z)" \
  "$(release agent-controller/v0.0.10-rc.9 "$a" 2026-10-15T02:00:00Z true)" \
  "$(release agent-controller/v0.0.10-qa.4 "$a" 2026-10-15T03:00:00Z)" > "$work/releases.json"
assert_output "version=0.0.10-rc.3
release_tag=agent-controller/v0.0.10-rc.3
previous_tag=agent-controller/v0.0.10-rc.2
reuse=false" "$(resolve stage 0.0.10 "$b")" "next Stage release candidate"
assert_output "version=0.0.10-qa.5
release_tag=agent-controller/v0.0.10-qa.5
previous_tag=agent-controller/v0.0.10-qa.4
reuse=false" "$(resolve qa 0.0.10 "$b")" "next QA pre-release"

# A release of the series on the same commit published after the trigger is an
# earlier attempt of the same deployment and is reused.
releases \
  "$(release agent-controller/v0.0.10-rc.1 "$a" 2026-10-15T00:00:00Z)" \
  "$(release agent-controller/v0.0.10-rc.2 "$b" 2026-10-16T08:05:00Z)" > "$work/releases.json"
assert_output "version=0.0.10-rc.2
release_tag=agent-controller/v0.0.10-rc.2
previous_tag=agent-controller/v0.0.10-rc.1
reuse=true" "$(resolve stage 0.0.10 "$b")" "retried Stage deployment"
assert_output "version=0.0.10-rc.3
release_tag=agent-controller/v0.0.10-rc.3
previous_tag=agent-controller/v0.0.10-rc.2
reuse=false" "$(resolve stage 0.0.10 "$a")" "same series, different commit"

# After a stable release, QA and Stage move to the next patch unless the
# manifest requests a higher version.
releases \
  "$(release agent-controller/v0.0.10 "$a" 2026-10-15T00:00:00Z)" \
  "$(release agent-controller/v0.0.10-rc.2 "$a" 2026-10-14T00:00:00Z)" > "$work/releases.json"
assert_output "version=0.0.11-rc.1
release_tag=agent-controller/v0.0.11-rc.1
previous_tag=agent-controller/v0.0.10-rc.2
reuse=false" "$(resolve stage 0.0.10 "$b")" "patch after stable release"
assert_output "version=0.1.0-qa.1
release_tag=agent-controller/v0.1.0-qa.1
previous_tag=
reuse=false" "$(resolve qa 0.1.0 "$b")" "manifest requests a minor version"

# Prod never re-releases or downgrades, but a retry of the same promotion is reused.
assert_fails "re-releasing a stable version" resolve prod agent-controller/v0.0.10-rc.2 "$b"
assert_fails "promoting an older release candidate" resolve prod agent-controller/v0.0.9-rc.1 "$b"
assert_fails "promoting a QA pre-release" resolve prod agent-controller/v0.0.11-qa.1 "$b"
releases "$(release agent-controller/v0.0.10 "$a" 2026-10-16T08:10:00Z)" > "$work/releases.json"
assert_output "version=0.0.10
release_tag=agent-controller/v0.0.10
previous_tag=
reuse=true" "$(resolve prod agent-controller/v0.0.10-rc.2 "$a")" "retried Prod promotion"

# Invalid input fails closed.
assert_fails "invalid next_version" resolve qa 0.10 "$a"
assert_fails "unknown environment" resolve dev 0.0.10 "$a"
assert_fails "short commit" resolve qa 0.0.10 aaaaaaa
printf '{}\n' > "$work/releases.json"
assert_fails "unexpected release list shape" resolve qa 0.0.10 "$a"

echo "resolve-release-version: all tests passed"
