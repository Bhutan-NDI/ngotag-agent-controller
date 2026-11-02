#!/bin/sh

set -eu

script=.github/scripts/validate-deployment-manifest.sh
contract=.github/agent-controller-release-contract.json
manifest=$(mktemp)
trap 'rm -f "$manifest"' EXIT HUP INT TERM

valid() {
  jq -n --arg environment "$1" --arg branch "$2" '{
    schema_version: 1, environment: $environment, enabled: true,
    release: ({deployed: null} + (if $environment == "prod" then {} else {next_version: "0.0.10"} end)),
    deployment: {
      allowed_branch: $branch, aws_region: "ap-southeast-1", cluster: "EXAMPLE_CLUSTER",
      ecr_repository: "example-services", cpu_architecture: "ARM64",
      controllers: [
        {name: "pool", service: "pool-service", container: "Pool", task_definition_family: "POOL_TDF"},
        {name: "eth", service: "eth-service", container: "eth", task_definition_family: "ETH-TDF"}
      ]}}'
}

accepts() {
  printf '%s\n' "$3" > "$manifest"
  sh "$script" "$contract" "$1" "$manifest" 2>/dev/null || { echo "rejected a valid $1 manifest ($2)" >&2; exit 1; }
}

rejects() {
  printf '%s\n' "$3" > "$manifest"
  if sh "$script" "$contract" "$1" "$manifest" 2>/dev/null; then
    echo "accepted an invalid $1 manifest: $2" >&2
    exit 1
  fi
}

qa=$(valid qa develop)
accepts qa "baseline" "$qa"
accepts stage "baseline" "$(valid stage main)"
accepts prod "baseline" "$(valid prod main)"
accepts qa "with a deployed record" "$(printf '%s' "$qa" | jq '.release.deployed = {version: "0.0.10-qa.1"}')"

rejects qa "wrong environment" "$(valid stage develop)"
rejects qa "wrong branch" "$(valid qa main)"
rejects stage "QA branch" "$(valid stage develop)"
rejects qa "disabled" "$(printf '%s' "$qa" | jq '.enabled = false')"
rejects qa "x86 architecture" "$(printf '%s' "$qa" | jq '.deployment.cpu_architecture = "X86_64"')"
rejects qa "missing next_version" "$(printf '%s' "$qa" | jq 'del(.release.next_version)')"
rejects qa "invalid next_version" "$(printf '%s' "$qa" | jq '.release.next_version = "1.0"')"
rejects prod "own next_version" "$(valid prod main | jq '.release.next_version = "0.0.10"')"
rejects qa "no controllers" "$(printf '%s' "$qa" | jq '.deployment.controllers = []')"
rejects qa "duplicate service" "$(printf '%s' "$qa" | jq '.deployment.controllers[1].service = "pool-service"')"
rejects qa "duplicate name" "$(printf '%s' "$qa" | jq '.deployment.controllers[1].name = "pool"')"
rejects qa "unsafe service name" "$(printf '%s' "$qa" | jq '.deployment.controllers[0].service = "x; rm -rf /"')"
rejects qa "unknown deployment key" "$(printf '%s' "$qa" | jq '.deployment.secret = "x"')"
rejects qa "unknown controller key" "$(printf '%s' "$qa" | jq '.deployment.controllers[0].image = "x"')"
rejects qa "invalid region" "$(printf '%s' "$qa" | jq '.deployment.aws_region = "nowhere"')"

echo "validate-deployment-manifest: all tests passed"
