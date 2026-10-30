#!/usr/bin/env bash

# Records what was deployed in the private deployment manifest. The record is
# written only after every controller is stable and the GitHub Release is
# published, and only if the reviewed part of the manifest is unchanged since
# this deployment validated it.
#
# Environment:
#   GH_TOKEN, CONFIG_REPOSITORY, CONFIG_PATH, VALIDATED_MANIFEST (file),
#   DEPLOYED_RECORD (file with the JSON object for .release.deployed), ENVIRONMENT

set -euo pipefail

: "${GH_TOKEN:?}" "${CONFIG_REPOSITORY:?}" "${CONFIG_PATH:?}" "${VALIDATED_MANIFEST:?}" \
  "${DEPLOYED_RECORD:?}" "${ENVIRONMENT:?}"

expected_request=$(jq -cS 'del(.release.deployed)' "$VALIDATED_MANIFEST")
release=$(jq -er '.github_release' "$DEPLOYED_RECORD")

for attempt in 1 2 3; do
  current=$(gh api "repos/$CONFIG_REPOSITORY/contents/$CONFIG_PATH?ref=main")
  current_sha=$(jq -r '.sha' <<<"$current")
  current_config=$(jq -r '.content' <<<"$current" | base64 --decode)
  test "$(jq -cS 'del(.release.deployed)' <<<"$current_config")" = "$expected_request" || {
    echo "the deployment manifest changed after this deployment started; refusing to overwrite its ledger" >&2
    exit 1
  }
  updated=$(jq --slurpfile deployed "$DEPLOYED_RECORD" '.release.deployed = $deployed[0]' <<<"$current_config")
  if printf '%s\n' "$updated" | base64 | tr -d '\n' > "$RUNNER_TEMP/ledger-content" &&
    gh api --method PUT "repos/$CONFIG_REPOSITORY/contents/$CONFIG_PATH" \
      -f message="chore(agent-controller): record $ENVIRONMENT release $release" \
      -F content=@"$RUNNER_TEMP/ledger-content" -f sha="$current_sha" -f branch=main >/dev/null; then
    rm -f "$RUNNER_TEMP/ledger-content"
    echo "Recorded the deployment in the private ledger"
    exit 0
  fi
  echo "warning: ledger update conflicted with another commit; retrying ($attempt/3)" >&2
  sleep $((attempt * 5))
done
echo "could not record the deployment in the private ledger; reconcile it manually" >&2
exit 1
