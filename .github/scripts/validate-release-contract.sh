#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <release-contract>" >&2
  exit 2
fi

contract=$1

test -f "$contract" || {
  echo "release contract does not exist: $contract" >&2
  exit 1
}

# QA releases come from develop, Stage from main, and Prod only promotes the
# image Stage runs. Every environment publishes the same single platform.
jq -e '
  .schema_version == 1 and
  (keys == ["ci", "environments", "release", "schema_version"]) and
  (.release | keys == ["image_tag_prefix", "platform", "tag_prefix", "title"]) and
  .release.tag_prefix == "agent-controller/v" and
  .release.image_tag_prefix == "agent-controller-" and
  .release.platform == "linux/arm64" and
  (.release.title | type == "string" and length > 0) and
  (.environments | keys == ["prod", "qa", "stage"]) and
  ([.environments | to_entries[] | select(
    .value.tag_prefix != ("agent-controller-" + .key + "-") or
    (.value.allowed_branch | test("^(develop|main)$") | not) or
    (.value.channel | IN("qa", "rc", "stable") | not) or
    (.value.legacy_release_pattern | type) != "string"
  )] | length == 0) and
  .environments.qa.allowed_branch == "develop" and
  .environments.qa.channel == "qa" and
  (.environments.qa | has("promote_from") | not) and
  .environments.stage.allowed_branch == "main" and
  .environments.stage.channel == "rc" and
  (.environments.stage | has("promote_from") | not) and
  .environments.prod.allowed_branch == "main" and
  .environments.prod.channel == "stable" and
  .environments.prod.promote_from == "stage" and
  (.ci | keys == ["app_slug", "check_name"]) and
  (.ci.check_name | type == "string" and length > 0) and
  (.ci.app_slug | type == "string" and length > 0)
' "$contract" >/dev/null || {
  echo "release contract failed validation: $contract" >&2
  exit 1
}
