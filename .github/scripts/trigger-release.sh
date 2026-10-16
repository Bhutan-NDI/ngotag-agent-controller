#!/bin/sh

# Starts a release for one environment. Run it through `make deploy-<environment>`.
#
# QA and Stage release the current head of their branch (develop, main). Prod
# promotes the commit Stage runs, as recorded in the private Stage ledger, and
# asks for typed confirmation. The script waits for CI on the exact commit,
# validates the private manifest, and pushes an immutable trigger tag that pins
# the manifest commit and the source commit; the workflow repeats every check
# before it can obtain AWS credentials.
#
# Environment:
#   DEPLOY_ENV                     qa | stage | prod
#   DEPLOYMENT_CONFIG_REPOSITORY   owner/name of the private manifest repository
#   DEPLOY_WAIT                    true (default) watches the workflow run
#   CONFIRM                        set to the environment name to skip the Prod prompt

set -eu

contract=.github/agent-controller-release-contract.json
scripts=.github/scripts
environment=${DEPLOY_ENV:?DEPLOY_ENV is required}
config_repository=${DEPLOYMENT_CONFIG_REPOSITORY:-}
deploy_wait=${DEPLOY_WAIT:-true}

for tool in gh jq git base64 cut date; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done
test -n "$config_repository" || {
  echo "DEPLOYMENT_CONFIG_REPOSITORY is required (owner/name of the private manifest repository)" >&2
  exit 1
}

sh "$scripts/validate-release-contract.sh" "$contract"
required_branch=$(jq -er --arg environment "$environment" '.environments[$environment].allowed_branch // empty' "$contract") || {
  echo "unknown environment: $environment" >&2
  exit 1
}
tag_prefix=$(jq -er --arg environment "$environment" '.environments[$environment].tag_prefix' "$contract")
channel=$(jq -er --arg environment "$environment" '.environments[$environment].channel' "$contract")

test "$(git rev-parse --abbrev-ref HEAD)" = "$required_branch" || {
  echo "deploy-$environment must be run from $required_branch" >&2
  exit 1
}
test -z "$(git status --porcelain)" || { echo "working tree must be clean before deployment" >&2; exit 1; }
git fetch origin "$required_branch" --tags
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$required_branch")" || {
  echo "local HEAD must exactly match origin/$required_branch" >&2
  exit 1
}

repository=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
manifest_ref=$(gh api "repos/$config_repository/git/ref/heads/main" --jq '.object.sha')
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

read_manifest() {
  gh api "repos/$config_repository/contents/agent-controller/environments/$1.json?ref=$manifest_ref" \
    --jq '.content' | base64 --decode > "$2"
  sh "$scripts/validate-deployment-manifest.sh" "$contract" "$1" "$2"
}
read_manifest "$environment" "$work/manifest.json"

if [ "$channel" = "stable" ]; then
  source_environment=$(jq -er '.environments.prod.promote_from' "$contract")
  read_manifest "$source_environment" "$work/source.json"
  jq -e '.release.deployed | type == "object" and (.github_release | type == "string") and (.commit | type == "string")' \
    "$work/source.json" >/dev/null || {
    echo "$source_environment has no automated release to promote; run make deploy-$source_environment first" >&2
    exit 1
  }
  source_release=$(jq -r '.release.deployed.github_release' "$work/source.json")
  source_sha=$(jq -r '.release.deployed.commit' "$work/source.json")
  git merge-base --is-ancestor "$source_sha" "origin/$required_branch" || {
    echo "the $source_environment release $source_release is not on $required_branch" >&2
    exit 1
  }
  gh release view "$source_release" --json isDraft,isPrerelease --jq '.isDraft == false and .isPrerelease == true' \
    | grep -qx true || {
    echo "$source_release is not a published release candidate" >&2
    exit 1
  }
  echo "This promotes $source_release (commit $source_sha) to $environment unchanged."
  confirmation=${CONFIRM:-}
  if [ "$confirmation" != "$environment" ]; then
    printf 'Type %s to continue: ' "$environment"
    read -r confirmation
  fi
  test "$confirmation" = "$environment" || { echo "not confirmed; nothing was released" >&2; exit 1; }
else
  source_sha=$(git rev-parse HEAD)
fi

sh "$scripts/wait-for-ci.sh" "$repository" "$source_sha" "$contract"

source_short=$(printf '%s' "$source_sha" | cut -c1-12)
release_tag="${tag_prefix}${manifest_ref}-${source_short}-$(date -u +%Y%m%dT%H%M%SZ)"
git check-ref-format "refs/tags/$release_tag" >/dev/null

set +e
git ls-remote --exit-code --tags origin "refs/tags/$release_tag" >/dev/null 2>&1
remote_tag_status=$?
set -e
case "$remote_tag_status" in
  2) ;;
  0) echo "release trigger tag already exists: $release_tag" >&2; exit 1 ;;
  *) echo "could not verify release trigger tag absence" >&2; exit "$remote_tag_status" ;;
esac

git tag "$release_tag" "$source_sha" || {
  echo "release trigger tag already exists locally: $release_tag" >&2
  exit 1
}
set +e
git push origin "refs/tags/$release_tag:refs/tags/$release_tag"
push_status=$?
set -e
if [ "$push_status" -ne 0 ]; then
  git tag -d "$release_tag" >/dev/null 2>&1 || echo "warning: could not remove the local tag $release_tag" >&2
  echo "failed to push the release trigger tag (git exit $push_status); verify the remote before retrying" >&2
  exit "$push_status"
fi
echo "Release triggered: $release_tag"

if [ "$deploy_wait" != "true" ]; then
  echo "Track the release in the repository Actions page: $release_tag"
  exit 0
fi

run_id=
attempts=0
while [ -z "$run_id" ] && [ "$attempts" -lt 90 ]; do
  if runs=$(gh api --paginate "repos/$repository/actions/runs?head_sha=$source_sha&event=push&per_page=100"); then
    run_id=$(printf '%s' "$runs" | jq -sr --arg tag "$release_tag" --arg source_sha "$source_sha" \
      -f "$scripts/select-workflow-run.jq")
  else
    echo "warning: GitHub API request failed while locating the release run; retrying" >&2
  fi
  [ -n "$run_id" ] || sleep 2
  attempts=$((attempts + 1))
done
test -n "$run_id" || { echo "could not locate the release workflow run" >&2; exit 1; }
gh run watch "$run_id" --repo "$repository" --exit-status
