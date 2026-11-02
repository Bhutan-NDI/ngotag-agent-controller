#!/bin/sh

# Keeps the deployment workflow synchronized with the release contract and
# proves that neither the release-trigger tags nor the GitHub Release tags can
# start any other workflow in this repository.

set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <release-contract> <deployment-workflow> <workflow-directory>" >&2
  exit 2
fi

contract=$1
workflow=$2
workflow_directory=$3

test -f "$contract" || { echo "release contract does not exist: $contract" >&2; exit 1; }
test -f "$workflow" || { echo "deployment workflow does not exist: $workflow" >&2; exit 1; }
test -d "$workflow_directory" || { echo "workflow directory does not exist: $workflow_directory" >&2; exit 1; }

# mikefarah yq v4 is preinstalled on GitHub-hosted Ubuntu runners.
yq --version 2>/dev/null | grep -q 'mikefarah/yq.* v4\.' || {
  echo "mikefarah yq v4 is required" >&2
  exit 1
}

tag_globs() {
  yq -r '(.on.push.tags // []) | select(tag == "!!seq") | .[] | select(tag == "!!str")' "$1"
}

expected=$(jq -r '.environments[].tag_prefix + "*"' "$contract" | LC_ALL=C sort)
actual=$(tag_globs "$workflow" | LC_ALL=C sort)
if [ "$actual" != "$expected" ]; then
  echo "deployment trigger globs do not match the release contract" >&2
  printf 'Expected:\n%s\nFound:\n%s\n' "$expected" "$actual" >&2
  exit 1
fi

if [ -n "$(yq -r '.on | keys | .[] | select(. != "push")' "$workflow")" ] ||
  [ -n "$(yq -r '.on.push | keys | .[] | select(. != "tags")' "$workflow")" ]; then
  echo "the deployment workflow must be triggered only by release-trigger tags" >&2
  exit 1
fi

mappings=$(jq -r '.environments | to_entries[] | [.key, .value.tag_prefix] | @tsv' "$contract")
expected_group='agent-controller-release-resolver-${{ '
separator=
tab=$(printf '\t')
while IFS="$tab" read -r environment tag_prefix; do
  expected_group="${expected_group}${separator}startsWith(github.ref_name, '${tag_prefix}') && '${environment}'"
  separator=' || '
done <<MAPPINGS
$mappings
MAPPINGS
expected_group="${expected_group} || 'invalid' }}"
actual_group=$(yq -r '.jobs.resolve.concurrency.group' "$workflow")
if [ "$actual_group" != "$expected_group" ]; then
  echo "resolver concurrency mapping does not match the release contract" >&2
  printf 'Expected:\n%s\nFound:\n%s\n' "$expected_group" "$actual_group" >&2
  exit 1
fi

# Shell patterns let '*' match '/', unlike GitHub's filters, so this check is
# stricter than GitHub and never misses a match.
release_prefix=$(jq -r '.release.tag_prefix' "$contract")
samples=$(jq -r '.environments[].tag_prefix + "0000000000000000000000000000000000000000-000000000000-20260101T000000Z"' "$contract")
samples="$samples
${release_prefix}1.2.3
${release_prefix}1.2.3-qa.1
${release_prefix}1.2.3-rc.1"

other_workflows=$(find "$workflow_directory" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) | LC_ALL=C sort)
# Tag globs must not expand against local files.
set -f
for other in $other_workflows; do
  [ "$(basename "$other")" = "$(basename "$workflow")" ] && continue
  for glob in $(tag_globs "$other"); do
    for sample in $samples; do
      # shellcheck disable=SC2254
      case "$sample" in
        $glob)
          echo "$(basename "$other") tag filter '$glob' would be triggered by release tag $sample" >&2
          exit 1
          ;;
      esac
    done
  done
done
