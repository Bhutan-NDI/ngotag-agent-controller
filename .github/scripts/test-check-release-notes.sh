#!/bin/sh

set -eu

script=.github/scripts/check-release-notes.sh
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT HUP INT TERM

accepts() {
  printf '%s\n' "$1" > "$notes"
  shift
  sh "$script" "$notes" "$@" || { echo "rejected clean notes" >&2; exit 1; }
}

rejects() {
  description=$1
  printf '%s\n' "$2" > "$notes"
  shift 2
  if sh "$script" "$notes" "$@" 2>/dev/null; then
    echo "accepted notes containing $description" >&2
    exit 1
  fi
}

clean='## NGOTAG Agent Controller v0.0.10-rc.1 (release candidate)

**Source commit:** `5249ed7a92a28f6150449ff46ab41e26b20512f2`

## What'"'"'s Changed
* fix(security): close auth bypass by @someone in https://github.com/Bhutan-NDI/ngotag-agent-controller/pull/90

**Full Changelog**: https://github.com/Bhutan-NDI/ngotag-agent-controller/compare/agent-controller/v0.0.10-rc.1...agent-controller/v0.0.10-rc.2'
accepts "$clean" PRIVATE_CLUSTER private-service

rejects "an account ID" "$clean
Account 123456789012"
rejects "an ARN" "$clean arn:aws:iam::role/x"
rejects "a registry" "$clean 1.dkr.ecr.ap-southeast-1.amazonaws.com/x"
rejects "a digest" "$clean sha256:abc"
rejects "a task definition" "$clean QA-TASKDEF:3"
rejects "a task definition word" "$clean new task definition"
rejects "a bucket" "$clean s3://bucket/key"
rejects "an architecture" "$clean linux/arm64"
rejects "a subnet" "$clean subnet-0123456789abcdef0"
rejects "a security group" "$clean (sg-0123abcd)"
rejects "an image repository tag" "$clean example-services:x"
rejects "an image tag" "$clean agent-controller-0.0.10-rc.1-aaaaaaaaaaaa"
rejects "a private cluster name" "$clean on private_cluster" PRIVATE_CLUSTER
rejects "a private service name" "$clean private-service" other-name private-service

echo "check-release-notes: all tests passed"
