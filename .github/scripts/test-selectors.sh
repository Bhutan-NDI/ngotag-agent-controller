#!/bin/sh

set -eu

ci_filter=.github/scripts/select-ci-state.jq
workflow_filter=.github/scripts/select-workflow-run.jq

assert_equal() {
  expected=$1
  actual=$2
  description=$3

  if [ "$actual" != "$expected" ]; then
    echo "$description: expected '$expected', found '$actual'" >&2
    exit 1
  fi
}

ci_state=$(jq -n '[
  {check_runs: [
    {name: "Other", app: {slug: "github-actions"}, started_at: "2026-01-04T00:00:00Z", status: "completed", conclusion: "success"},
    {name: "Validate", app: {slug: "other-app"}, started_at: "2026-01-03T00:00:00Z", status: "completed", conclusion: "success"},
    {name: "Validate", app: {slug: "github-actions"}, started_at: "2026-01-01T00:00:00Z", status: "completed", conclusion: "success"}
  ]},
  {check_runs: [
    {name: "Validate", app: {slug: "github-actions"}, started_at: "2026-01-02T00:00:00Z", status: "in_progress", conclusion: null}
  ]}
]' | jq -r --arg check_name "Validate" --arg app_slug "github-actions" -f "$ci_filter")
assert_equal pending "$ci_state" "CI selector identity, pagination, and newest-run selection"

ci_state=$(jq -n '[{check_runs: [
  {name: "Validate", app: {slug: "github-actions"}, started_at: "2026-01-01T00:00:00Z", status: "completed", conclusion: "success"}
]}]' | jq -r --arg check_name "Validate" --arg app_slug "github-actions" -f "$ci_filter")
assert_equal success "$ci_state" "CI selector successful state"

ci_state=$(jq -n '[{check_runs: [
  {name: "Validate", app: {slug: "github-actions"}, started_at: "2026-01-01T00:00:00Z", status: "completed", conclusion: "cancelled"}
]}]' | jq -r --arg check_name "Validate" --arg app_slug "github-actions" -f "$ci_filter")
assert_equal failed:cancelled "$ci_state" "CI selector failed state"

ci_state=$(jq -n '[{check_runs: []}]' | jq -r \
  --arg check_name "Validate" --arg app_slug "github-actions" -f "$ci_filter")
assert_equal missing "$ci_state" "CI selector missing state"

if jq -n '[{}]' | jq -r \
  --arg check_name "Validate" --arg app_slug "github-actions" \
  -f "$ci_filter" >/dev/null 2>&1; then
  echo "CI selector accepted an invalid API response" >&2
  exit 1
fi

workflow_pages='{"workflow_runs":[
  {"id":11,"path":".github/workflows/other.yml","display_title":"Deploy Agent Controller [agent-controller-qa-example]","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-01-05T00:00:00Z"},
  {"id":12,"path":".github/workflows/deploy-agent-controller.yml","display_title":"Deploy Agent Controller [agent-controller-qa-example-extra]","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-01-04T00:00:00Z"},
  {"id":13,"path":".github/workflows/deploy-agent-controller.yml","display_title":"Deploy Agent Controller [agent-controller-qa-example]","head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":"2026-01-03T00:00:00Z"},
  {"id":14,"path":".github/workflows/deploy-agent-controller.yml","display_title":"Deploy Agent Controller [agent-controller-qa-example]","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-01-01T00:00:00Z"}
]}
{"workflow_runs":[
  {"id":15,"path":".github/workflows/deploy-agent-controller.yml","display_title":"Deploy Agent Controller [agent-controller-qa-example]","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-01-02T00:00:00Z"}
]}'
run_id=$(printf '%s\n' "$workflow_pages" | jq -sr \
  --arg tag agent-controller-qa-example \
  --arg source_sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -f "$workflow_filter")
assert_equal 15 "$run_id" "workflow selector path, tag, SHA, pagination, and newest-run selection"

run_id=$(printf '%s\n' '{"workflow_runs":[]}' | jq -sr \
  --arg tag agent-controller-qa-example \
  --arg source_sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -f "$workflow_filter")
assert_equal "" "$run_id" "workflow selector missing state"

if printf '%s\n' '{}' | jq -sr \
  --arg tag agent-controller-qa-example \
  --arg source_sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -f "$workflow_filter" >/dev/null 2>&1; then
  echo "workflow selector accepted an invalid API response" >&2
  exit 1
fi
echo "release selectors: all tests passed"
