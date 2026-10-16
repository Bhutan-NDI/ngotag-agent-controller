#!/usr/bin/env bash

# Rolls one controller image out to every controller of an environment.
#
# Every controller is checked before any is changed. Then, one at a time and in
# manifest order, a copy of the controller's current task definition is
# registered with only the controller image replaced and the CPU architecture
# pinned, and the service is updated with the deployment circuit breaker and
# rollback enabled. The next controller starts only after ECS reports the
# rollout COMPLETED and every running task of the new revision runs the expected
# image digest. The first failure stops the run; ECS rolls that service back,
# and controllers already updated keep the new image.
#
# Environment:
#   CLUSTER            ECS cluster
#   CONTROLLERS_FILE   JSON array of {name, service, container, task_definition_family}
#   IMAGE              image reference to deploy (registry/repository:tag)
#   IMAGE_DIGEST       expected manifest digest of IMAGE
#   CPU_ARCHITECTURE   ECS runtime CPU architecture (ARM64)
#   RESULT_FILE        receives {"<controller>": "<task definition ARN>"}
#   ROLLOUT_DEADLINE   optional epoch seconds; a controller is not started unless
#                      its full rollout window fits before this time

set -euo pipefail

: "${CLUSTER:?}" "${CONTROLLERS_FILE:?}" "${IMAGE:?}" "${IMAGE_DIGEST:?}" "${CPU_ARCHITECTURE:?}" "${RESULT_FILE:?}"
poll_seconds=${POLL_SECONDS:-15}
rollout_attempts=${ROLLOUT_ATTEMPTS:-80}
rollout_deadline=${ROLLOUT_DEADLINE:-}
# Registration, the service update and the digest check add about a minute.
rollout_window=$((rollout_attempts * poll_seconds + 60))
script_dir=$(cd "$(dirname "$0")" && pwd)

case "$CPU_ARCHITECTURE" in
  ARM64) docker_arch=arm64 ;;
  X86_64) docker_arch=amd64 ;;
  *) echo "unsupported CPU architecture $CPU_ARCHITECTURE" >&2; exit 1 ;;
esac
[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid image digest" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

count=$(jq -er 'length' "$CONTROLLERS_FILE")
controller() { jq -er --argjson index "$1" --arg field "$2" '.[$index][$field]' "$CONTROLLERS_FILE"; }

echo "Checking $count controllers before changing any of them"
for ((index = 0; index < count; index++)); do
  name=$(controller "$index" name)
  service=$(controller "$index" service)
  container=$(controller "$index" container)
  family=$(controller "$index" task_definition_family)

  aws ecs describe-services --cluster "$CLUSTER" --services "$service" \
    --query 'services[0]' --output json > "$work/$index-service.json"
  jq -e '.status == "ACTIVE"' "$work/$index-service.json" >/dev/null || {
    echo "controller $name: service is not active" >&2
    exit 1
  }
  current=$(jq -er '.taskDefinition' "$work/$index-service.json")
  case "$current" in
    *":task-definition/${family}:"*) ;;
    *) echo "controller $name: service task definition does not belong to the manifest family" >&2; exit 1 ;;
  esac
  jq -e '[.deployments[] | select(.status == "PRIMARY" and .rolloutState == "COMPLETED")] | length == 1' \
    "$work/$index-service.json" >/dev/null || {
    echo "controller $name: a deployment is already in progress; retry after it completes" >&2
    exit 1
  }

  aws ecs describe-task-definition --task-definition "$current" \
    --query taskDefinition --output json > "$work/$index-current.json"
  jq --arg container "$container" --arg image "$IMAGE" --arg cpu_architecture "$CPU_ARCHITECTURE" \
    -f "$script_dir/render-task-definition.jq" "$work/$index-current.json" > "$work/$index-register.json"

  # Sidecars are kept unchanged, so they must already run on the release platform.
  while IFS= read -r kept_image; do
    sh "$script_dir/require-image-platform.sh" "$kept_image" "$docker_arch" || {
      echo "controller $name: a kept sidecar image cannot run on $CPU_ARCHITECTURE" >&2
      exit 1
    }
  done < <(jq -r --arg container "$container" \
    '.containerDefinitions[] | select(.name != $container) | .image' "$work/$index-register.json")
  echo "controller $name: ready"
done

printf '{}\n' > "$RESULT_FILE"
for ((index = 0; index < count; index++)); do
  name=$(controller "$index" name)
  service=$(controller "$index" service)
  container=$(controller "$index" container)

  # Never start a rollout the job could be cancelled in the middle of.
  if [ -n "$rollout_deadline" ] && [ "$(($(date +%s) + rollout_window))" -gt "$rollout_deadline" ]; then
    completed=$(jq -r 'keys_unsorted | join(", ")' "$RESULT_FILE")
    echo "controller $name: not enough time left in this job for a full rollout; it was not changed." >&2
    echo "Already updated: ${completed:-none}. Run the release again to finish." >&2
    exit 1
  fi

  task_definition=$(aws ecs register-task-definition \
    --cli-input-json "file://$work/$index-register.json" \
    --query taskDefinition.taskDefinitionArn --output text)
  # Send the complete current configuration back with only the circuit breaker
  # changed, so no other deployment setting is reset.
  deployment_configuration=$(jq -c \
    '.deploymentConfiguration | .deploymentCircuitBreaker = {enable: true, rollback: true}' \
    "$work/$index-service.json")
  aws ecs update-service --cluster "$CLUSTER" --service "$service" \
    --task-definition "$task_definition" \
    --deployment-configuration "$deployment_configuration" >/dev/null
  echo "controller $name: rollout started"

  attempt=1
  while :; do
    aws ecs describe-services --cluster "$CLUSTER" --services "$service" \
      --query 'services[0]' --output json > "$work/state.json"
    if jq -e --arg task_definition "$task_definition" '
      .taskDefinition == $task_definition and
      .runningCount == .desiredCount and
      .pendingCount == 0 and
      ([.deployments[] | select(.taskDefinition == $task_definition and .rolloutState == "COMPLETED")] | length == 1)
    ' "$work/state.json" >/dev/null; then
      break
    fi
    if jq -e --arg task_definition "$task_definition" '
      .taskDefinition != $task_definition or
      ([.deployments[] | select(.taskDefinition == $task_definition and .rolloutState == "FAILED")] | length > 0)
    ' "$work/state.json" >/dev/null; then
      echo "controller $name: rollout failed and ECS rolled it back; later controllers were not changed" >&2
      exit 1
    fi
    if [ "$attempt" -ge "$rollout_attempts" ]; then
      echo "controller $name: rollout did not complete in time; later controllers were not changed" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep "$poll_seconds"
  done

  desired=$(jq -r '.desiredCount' "$work/state.json")
  mapfile -t tasks < <(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$service" \
    --desired-status RUNNING --query 'taskArns[]' --output text | tr '\t' '\n' | sed '/^$/d')
  verified=0
  if [ "${#tasks[@]}" -gt 0 ]; then
    verified=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "${tasks[@]}" --output json \
      | jq --arg task_definition "$task_definition" --arg container "$container" --arg digest "$IMAGE_DIGEST" '
          [.tasks[] | select(.taskDefinitionArn == $task_definition and .lastStatus == "RUNNING")
            | .containers[] | select(.name == $container and .imageDigest == $digest)] | length')
  fi
  if [ "$verified" -lt "$desired" ]; then
    echo "controller $name: only $verified of $desired running tasks run the released image digest" >&2
    exit 1
  fi

  jq --arg name "$name" --arg task_definition "$task_definition" '.[$name] = $task_definition' \
    "$RESULT_FILE" > "$work/result.json"
  mv "$work/result.json" "$RESULT_FILE"
  echo "controller $name: rollout complete on $verified tasks"
done
