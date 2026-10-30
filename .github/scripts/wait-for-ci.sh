#!/bin/sh

set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <repository> <source-sha> <release-contract>" >&2
  exit 2
fi

repository=$1
source_sha=$2
contract=$3
state_filter=.github/scripts/select-ci-state.jq
max_attempts=120
wait_seconds=5
# Transient GitHub API errors are retried; persistent ones (e.g. authentication)
# fail after this many consecutive failed requests.
max_api_failures=6
api_failures=0

test -f "$contract" || {
  echo "release contract does not exist: $contract" >&2
  exit 1
}
test -f "$state_filter" || {
  echo "CI state filter does not exist: $state_filter" >&2
  exit 1
}

check_name=$(jq -er '.ci.check_name // empty' "$contract")
app_slug=$(jq -er '.ci.app_slug // empty' "$contract")
attempt=1

while [ "$attempt" -le "$max_attempts" ]; do
  # Slurp pages with jq rather than `gh api --slurp`, which needs gh 2.48+.
  if check_runs=$(gh api --paginate \
    "repos/${repository}/commits/${source_sha}/check-runs?per_page=100"); then
    api_failures=0
    state=$(printf '%s' "$check_runs" | jq -sr \
      --arg check_name "$check_name" \
      --arg app_slug "$app_slug" \
      -f "$state_filter")
  else
    api_failures=$((api_failures + 1))
    if [ "$api_failures" -ge "$max_api_failures" ]; then
      echo "GitHub API failed $api_failures consecutive times while checking CI for $source_sha" >&2
      exit 1
    fi
    echo "warning: GitHub API request failed; retrying ($api_failures/$max_api_failures)" >&2
    state=pending
  fi

  case "$state" in
    success)
      exit 0
      ;;
    failed:*)
      echo "CI did not pass for $source_sha ($state)" >&2
      exit 1
      ;;
    missing|pending)
      ;;
    *)
      echo "unexpected CI state for $source_sha: $state" >&2
      exit 1
      ;;
  esac

  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "timed out waiting for $check_name on $source_sha" >&2
    exit 1
  fi

  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
