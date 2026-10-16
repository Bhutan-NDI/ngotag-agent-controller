#!/usr/bin/env bash

# Exercises deploy-controllers.sh against fake aws and docker commands.

set -euo pipefail

script=$(pwd)/.github/scripts/deploy-controllers.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

digest=sha256:$(printf 'a%.0s' $(seq 64))
mkdir -p "$work/bin" "$work/state"

cat > "$work/bin/aws" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state=$FAKE_STATE
echo "$*" >> "$state/calls"
arg() { local key=$1; shift; while [ "$#" -gt 0 ]; do [ "$1" = "$key" ] && { echo "$2"; return; }; shift; done; }
service_family() { case "$1" in svc-a) echo family-a ;; svc-b) echo family-b ;; esac; }
case "$2" in
  describe-services)
    service=$(arg --services "$@")
    family=$(service_family "$service")
    current=$(cat "$state/$service.td" 2>/dev/null || echo "arn:aws:ecs:region:account:task-definition/${FAKE_FAMILY_OVERRIDE:-$family}:1")
    rollout=COMPLETED
    if [ -f "$state/$service.updated" ]; then
      polls=$(( $(cat "$state/$service.polls" 2>/dev/null || echo 0) + 1 ))
      echo "$polls" > "$state/$service.polls"
      if [ "$polls" -lt 2 ]; then rollout=IN_PROGRESS; fi
      if [ "${FAKE_FAIL_SERVICE:-}" = "$service" ] && [ "$polls" -ge 2 ]; then
        rollout=FAILED
      fi
    fi
    jq -n --arg td "$current" --arg rollout "$rollout" '{
      status: "ACTIVE", taskDefinition: $td, desiredCount: 2, runningCount: 2, pendingCount: 0,
      deploymentConfiguration: {maximumPercent: 200, minimumHealthyPercent: 100,
        deploymentCircuitBreaker: {enable: false, rollback: false}, alarms: {alarmNames: [], enable: false, rollback: false}},
      deployments: [{status: "PRIMARY", taskDefinition: $td, rolloutState: $rollout}]}'
    ;;
  describe-task-definition)
    td=$(arg --task-definition "$@")
    family=${td#*task-definition/}; family=${family%%:*}
    jq -n --arg family "$family" --arg sidecar "${FAKE_SIDECAR:-edoburu/pgbouncer:v1}" '{
      taskDefinitionArn: "arn", revision: 1, status: "ACTIVE", family: $family,
      runtimePlatform: {cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX"},
      containerDefinitions: [{name: "controller", image: "old"}, {name: "sidecar", image: $sidecar}]}'
    ;;
  register-task-definition)
    file=$(arg --cli-input-json "$@"); file=${file#file://}
    family=$(jq -r .family "$file")
    cp "$file" "$state/registered-$family.json"
    echo "arn:aws:ecs:region:account:task-definition/$family:2"
    ;;
  update-service)
    service=$(arg --service "$@")
    arg --task-definition "$@" > "$state/$service.td"
    arg --deployment-configuration "$@" > "$state/$service.config"
    touch "$state/$service.updated"
    ;;
  list-tasks)
    printf 'task-1\ttask-2\n'
    ;;
  describe-tasks)
    service=$(cat "$state/last-service" 2>/dev/null || true)
    td=$(ls -t "$state"/*.td | head -1 | xargs cat)
    jq -n --arg td "$td" --arg digest "${FAKE_TASK_DIGEST:-$FAKE_DIGEST}" '{tasks: [
      {taskDefinitionArn: $td, lastStatus: "RUNNING", containers: [{name: "controller", imageDigest: $digest}]},
      {taskDefinitionArn: $td, lastStatus: "RUNNING", containers: [{name: "controller", imageDigest: $digest}]}]}'
    ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
FAKE

cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *"--raw edoburu/pgbouncer:v1") echo '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}' ;;
  *"--raw amd64-only:v1") echo '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}' ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$work/bin/aws" "$work/bin/docker"

jq -n '[
  {name: "first", service: "svc-a", container: "controller", task_definition_family: "family-a"},
  {name: "second", service: "svc-b", container: "controller", task_definition_family: "family-b"}
]' > "$work/controllers.json"

run() {
  rm -rf "$work/state" && mkdir -p "$work/state"
  PATH="$work/bin:$PATH" FAKE_STATE="$work/state" FAKE_DIGEST="$digest" \
    CLUSTER=cluster CONTROLLERS_FILE="$work/controllers.json" IMAGE=registry/repo:tag \
    IMAGE_DIGEST="$digest" CPU_ARCHITECTURE=ARM64 RESULT_FILE="$work/result.json" \
    POLL_SECONDS=0 ROLLOUT_ATTEMPTS=5 "$@" bash "$script"
}

fail() { echo "$1" >&2; exit 1; }

# Successful rollout of both controllers, in order.
run env > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "successful rollout failed"; }
jq -e '. == {first: "arn:aws:ecs:region:account:task-definition/family-a:2", second: "arn:aws:ecs:region:account:task-definition/family-b:2"}' \
  "$work/result.json" >/dev/null || fail "unexpected result file"
for family in family-a family-b; do
  jq -e '.runtimePlatform.cpuArchitecture == "ARM64" and .containerDefinitions[0].image == "registry/repo:tag"
    and .containerDefinitions[1].image == "edoburu/pgbouncer:v1" and (has("revision") | not)' \
    "$work/state/registered-$family.json" >/dev/null || fail "unexpected registered task definition for $family"
done
jq -e '.deploymentCircuitBreaker == {enable: true, rollback: true} and .maximumPercent == 200
  and .minimumHealthyPercent == 100 and .alarms.enable == false' "$work/state/svc-a.config" >/dev/null \
  || fail "deployment configuration was not preserved with the circuit breaker enabled"
first_update=$(grep -n 'update-service.*svc-a' "$work/state/calls" | cut -d: -f1)
second_register=$(grep -n 'register-task-definition.*' "$work/state/calls" | sed -n 2p | cut -d: -f1)
[ "$first_update" -lt "$second_register" ] || fail "second controller was registered before the first rolled out"

# A failed rollout stops before the next controller changes.
if run env FAKE_FAIL_SERVICE=svc-a > "$work/out" 2>&1; then fail "failed rollout was accepted"; fi
grep -q 'rolled it back' "$work/out" || fail "failed rollout was not reported"
grep -q 'update-service.*svc-b' "$work/state/calls" && fail "second controller changed after a failure"

# Tasks running a different digest fail verification.
if run env FAKE_TASK_DIGEST="sha256:$(printf 'b%.0s' $(seq 64))" > "$work/out" 2>&1; then
  fail "wrong running digest was accepted"
fi

# Preflight problems stop the run before any change.
if run env FAKE_FAMILY_OVERRIDE=other > "$work/out" 2>&1; then fail "foreign task definition family was accepted"; fi
grep -q 'update-service\|register-task-definition' "$work/state/calls" && fail "a change was made after a failed preflight"
if run env FAKE_SIDECAR=amd64-only:v1 > "$work/out" 2>&1; then fail "amd64-only sidecar was accepted"; fi
grep -q 'update-service\|register-task-definition' "$work/state/calls" && fail "a change was made after a failed sidecar check"

echo "deploy-controllers: all tests passed"
