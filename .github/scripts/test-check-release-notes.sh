#!/bin/sh

set -eu

script=.github/scripts/check-release-notes.sh
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT HUP INT TERM
export PUBLIC_TEXT="NGOTAG Agent Controller Bhutan-NDI/ngotag-agent-controller"

accepts() {
  mode=$1
  printf '%s\n' "$2" > "$notes"
  shift 2
  sh "$script" "$mode" "$notes" "$@" || { echo "rejected clean $mode notes" >&2; exit 1; }
}

rejects() {
  mode=$1
  description=$2
  printf '%s\n' "$3" > "$notes"
  shift 3
  if sh "$script" "$mode" "$notes" "$@" 2>/dev/null; then
    echo "accepted $mode notes containing $description" >&2
    exit 1
  fi
}

# A commit SHA with a run of exactly 12 decimal digits is not an account ID.
authored='## NGOTAG Agent Controller v0.0.10-rc.1 (release candidate)

**Source commit:** `a123456789012b5c78759a0000000000000000ff`'
generated='## What'"'"'s Changed
* fix(security): close auth bypass by @someone in https://github.com/Bhutan-NDI/ngotag-agent-controller/pull/90
* fix: pin base image sha256:abc and register the task definition for linux/arm64 by @someone in https://github.com/Bhutan-NDI/ngotag-agent-controller/pull/91
* [Eth] feat: connection pool for the platform-admin wallet by @someone in https://github.com/Bhutan-NDI/ngotag-agent-controller/pull/92

**Full Changelog**: https://github.com/Bhutan-NDI/ngotag-agent-controller/compare/agent-controller/v0.0.10-rc.1...agent-controller/v0.0.10-rc.2'

# Short, generic or public names never block a release; distinctive names are matched as whole words.
names='PRIVATE_CLUSTER private-pool-service Pool eth ngotag-agent-controller agent-controller'
# shellcheck disable=SC2086
accepts authored "$authored" $names
# shellcheck disable=SC2086
accepts generated "$generated" $names
accepts generated "* fix: private-pool-services cleanup" private-pool-service

rejects authored "an account ID" "$authored
Account 123456789012"
rejects generated "an account ID" "$generated (123456789012)"
rejects generated "an ARN" "$generated arn:aws:iam::role/x"
rejects generated "a registry" "$generated 1.dkr.ecr.ap-southeast-1.amazonaws.com/x"
rejects generated "a bucket" "$generated s3://bucket/key"
rejects generated "a subnet" "$generated subnet-0123456789abcdef0"
rejects generated "a security group" "$generated (sg-0123abcd)"
rejects generated "a commit image tag" "$generated agent-controller-aaaaaaaaaaaa"
rejects generated "a version image tag" "$generated agent-controller-0.0.10-aaaaaaaaaaaa"
rejects authored "a digest" "$authored sha256:abc"
rejects authored "a task definition" "$authored new task definition"
rejects authored "a task definition family" "$authored QA-TASKDEF:3"
rejects authored "an architecture" "$authored linux/arm64"
rejects authored "an image repository tag" "$authored example-services:x"
rejects authored "a private cluster name" "$authored on private_cluster" PRIVATE_CLUSTER
rejects generated "a private service name" "$generated
* fix private-pool-service restarts" other-name private-pool-service

echo "check-release-notes: all tests passed"
