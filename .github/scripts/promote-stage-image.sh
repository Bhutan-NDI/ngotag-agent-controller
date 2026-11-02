#!/usr/bin/env bash

# Prod never rebuilds. This proves that every Stage controller runs the release
# candidate recorded in the Stage ledger, then copies that exact image, by
# digest, into the Prod image repository.
#
# Environment:
#   REGISTRY                 ECR registry host
#   SOURCE_CLUSTER           Stage ECS cluster
#   SOURCE_CONTROLLERS_FILE  Stage controllers (JSON array, as in the manifest)
#   SOURCE_REPOSITORY        Stage image repository
#   SOURCE_TAG               image tag recorded in the Stage ledger
#   SOURCE_DIGEST            image digest recorded in the Stage ledger
#   TARGET_REPOSITORY        Prod image repository
#   TARGET_TAG               Prod image tag

set -euo pipefail

: "${REGISTRY:?}" "${SOURCE_CLUSTER:?}" "${SOURCE_CONTROLLERS_FILE:?}" "${SOURCE_REPOSITORY:?}" \
  "${SOURCE_TAG:?}" "${SOURCE_DIGEST:?}" "${TARGET_REPOSITORY:?}" "${TARGET_TAG:?}"
[[ "$SOURCE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid Stage image digest" >&2; exit 1; }

image_digest() {
  aws ecr describe-images --repository-name "$1" --image-ids imageTag="$2" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true
}

test "$(image_digest "$SOURCE_REPOSITORY" "$SOURCE_TAG")" = "$SOURCE_DIGEST" || {
  echo "the Stage image tag no longer resolves to the digest in the Stage ledger" >&2
  exit 1
}

source_image="$REGISTRY/$SOURCE_REPOSITORY:$SOURCE_TAG"
count=$(jq -er 'length' "$SOURCE_CONTROLLERS_FILE")
for ((index = 0; index < count; index++)); do
  name=$(jq -er --argjson index "$index" '.[$index].name' "$SOURCE_CONTROLLERS_FILE")
  service=$(jq -er --argjson index "$index" '.[$index].service' "$SOURCE_CONTROLLERS_FILE")
  container=$(jq -er --argjson index "$index" '.[$index].container' "$SOURCE_CONTROLLERS_FILE")
  service_json=$(aws ecs describe-services --cluster "$SOURCE_CLUSTER" --services "$service" \
    --query 'services[0]' --output json)
  task_definition=$(jq -er '.taskDefinition' <<<"$service_json")
  jq -e --arg task_definition "$task_definition" '
    .status == "ACTIVE" and
    ([.deployments[] | select(.status == "PRIMARY" and .taskDefinition == $task_definition
      and .rolloutState == "COMPLETED")] | length == 1)
  ' <<<"$service_json" >/dev/null || {
    echo "Stage controller $name is not settled on one completed deployment" >&2
    exit 1
  }
  aws ecs describe-task-definition --task-definition "$task_definition" \
    --query taskDefinition --output json \
    | jq -e --arg container "$container" --arg image "$source_image" '
        .runtimePlatform.cpuArchitecture == "ARM64" and
        ([.containerDefinitions[] | select(.name == $container and .image == $image)] | length == 1)
      ' >/dev/null || {
    echo "Stage controller $name does not run the release candidate image" >&2
    exit 1
  }
  mapfile -t tasks < <(aws ecs list-tasks --cluster "$SOURCE_CLUSTER" --service-name "$service" \
    --desired-status RUNNING --query 'taskArns[]' --output text | tr '\t' '\n' | sed '/^$/d')
  [ "${#tasks[@]}" -gt 0 ] || { echo "Stage controller $name has no running tasks" >&2; exit 1; }
  aws ecs describe-tasks --cluster "$SOURCE_CLUSTER" --tasks "${tasks[@]}" --output json \
    | jq -e --arg container "$container" --arg digest "$SOURCE_DIGEST" '
        [.tasks[] | .containers[] | select(.name == $container)] as $containers
        | ($containers | length) > 0 and all($containers[]; .imageDigest == $digest)
      ' >/dev/null || {
    echo "Stage controller $name has running tasks with a different image digest" >&2
    exit 1
  }
  echo "Stage controller $name runs the release candidate"
done

existing=$(image_digest "$TARGET_REPOSITORY" "$TARGET_TAG")
case "$existing" in
  "$SOURCE_DIGEST")
    echo "The Prod image already exists with the Stage digest (earlier attempt)"
    ;;
  "" | None)
    skopeo copy --preserve-digests --retry-times 3 \
      "docker://$REGISTRY/$SOURCE_REPOSITORY@$SOURCE_DIGEST" \
      "docker://$REGISTRY/$TARGET_REPOSITORY:$TARGET_TAG"
    ;;
  *)
    echo "the Prod image tag already exists with a different digest; refusing to overwrite it" >&2
    exit 1
    ;;
esac

test "$(image_digest "$TARGET_REPOSITORY" "$TARGET_TAG")" = "$SOURCE_DIGEST" || {
  echo "the Prod image digest differs from the Stage image digest" >&2
  exit 1
}
echo "Prod image is byte-identical to the Stage release candidate"
