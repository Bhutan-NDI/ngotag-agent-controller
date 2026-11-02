#!/bin/sh

set -eu

filter=.github/scripts/render-task-definition.jq
image=registry.example/repository:agent-controller-0.0.10-rc.1-aaaaaaaaaaaa

source_definition='{
  "taskDefinitionArn": "arn:example:task-definition/family:7",
  "family": "family",
  "revision": 7,
  "status": "ACTIVE",
  "requiresAttributes": [{"name": "ecs.capability.execution-role-awslogs"}],
  "compatibilities": ["EC2", "FARGATE"],
  "registeredAt": "2026-01-01T00:00:00Z",
  "registeredBy": "someone",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "execution-role",
  "taskRoleArn": "task-role",
  "runtimePlatform": {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
  "volumes": [{"name": "data"}],
  "containerDefinitions": [
    {"name": "controller", "image": "old:image", "environmentFiles": [{"type": "s3", "value": "env-file"}]},
    {"name": "pgbouncer", "image": "edoburu/pgbouncer:v1.25.1-p0"}
  ]
}'

render() {
  printf '%s' "$1" | jq --arg container "$2" --arg image "$image" --arg cpu_architecture "$3" -f "$filter"
}

rendered=$(render "$source_definition" controller ARM64)
printf '%s' "$rendered" | jq -e --arg image "$image" '
  (has("taskDefinitionArn") or has("revision") or has("status") or has("requiresAttributes")
    or has("compatibilities") or has("registeredAt") or has("registeredBy")) == false and
  .runtimePlatform == {cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX"} and
  .containerDefinitions[0].image == $image and
  .containerDefinitions[0].environmentFiles == [{type: "s3", value: "env-file"}] and
  .containerDefinitions[1] == {name: "pgbouncer", image: "edoburu/pgbouncer:v1.25.1-p0"} and
  .cpu == "1024" and .memory == "2048" and .executionRoleArn == "execution-role" and
  .taskRoleArn == "task-role" and .volumes == [{name: "data"}] and
  .requiresCompatibilities == ["FARGATE"]
' >/dev/null || {
  echo "rendered task definition is not the expected register request" >&2
  printf '%s\n' "$rendered" >&2
  exit 1
}

without_platform=$(printf '%s' "$source_definition" | jq 'del(.runtimePlatform)')
render "$without_platform" controller ARM64 \
  | jq -e '.runtimePlatform == {cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX"}' >/dev/null || {
  echo "missing runtimePlatform was not pinned to ARM64/LINUX" >&2
  exit 1
}

if render "$source_definition" missing ARM64 >/dev/null 2>&1; then
  echo "rendering accepted a task definition without the controller container" >&2
  exit 1
fi
duplicate=$(printf '%s' "$source_definition" | jq '.containerDefinitions += [{name: "controller", image: "x"}]')
if render "$duplicate" controller ARM64 >/dev/null 2>&1; then
  echo "rendering accepted a duplicated controller container" >&2
  exit 1
fi
if render "$source_definition" controller arm64 >/dev/null 2>&1; then
  echo "rendering accepted an unsupported CPU architecture value" >&2
  exit 1
fi

echo "render-task-definition: all tests passed"
