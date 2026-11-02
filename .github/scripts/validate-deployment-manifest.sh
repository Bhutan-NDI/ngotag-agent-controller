#!/bin/sh

# Validates one environment file of the private deployment manifest
# (agent-controller/environments/<environment>.json). The manifest names the
# ECS cluster, services, containers and task definition families, which never
# appear in this public repository, and records the last deployed release.

set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <release-contract> <environment> <manifest>" >&2
  exit 2
fi

contract=$1
environment=$2
manifest=$3

test -f "$contract" || { echo "release contract does not exist: $contract" >&2; exit 1; }
test -f "$manifest" || { echo "deployment manifest does not exist" >&2; exit 1; }

jq -e --arg environment "$environment" --slurpfile contract "$contract" '
  def name: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$");
  def semver: type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");
  $contract[0].environments[$environment] as $policy
  | $policy != null and
    .schema_version == 1 and
    .environment == $environment and
    .enabled == true and
    (.release | type == "object") and
    (if $policy.channel == "stable"
      then (.release | keys == ["deployed"])
      else (.release | keys == ["deployed", "next_version"]) and (.release.next_version | semver) end) and
    (.release.deployed == null or (.release.deployed | type == "object")) and
    (.deployment | keys == ["allowed_branch", "aws_region", "cluster", "controllers", "cpu_architecture", "ecr_repository"]) and
    .deployment.allowed_branch == $policy.allowed_branch and
    (.deployment.aws_region | type == "string" and test("^[a-z]{2}(-[a-z]+)+-[0-9]$")) and
    (.deployment.cluster | name) and
    (.deployment.ecr_repository | name) and
    .deployment.cpu_architecture == "ARM64" and
    (.deployment.controllers | type == "array" and length > 0) and
    all(.deployment.controllers[];
      keys == ["container", "name", "service", "task_definition_family"] and
      (.name | name) and (.service | name) and (.container | name) and (.task_definition_family | name)) and
    (.deployment.controllers | map(.name) | unique | length) == (.deployment.controllers | length) and
    (.deployment.controllers | map(.service) | unique | length) == (.deployment.controllers | length)
' "$manifest" >/dev/null || {
  echo "deployment manifest for $environment failed validation" >&2
  exit 1
}
