#!/bin/sh

# Runs every release-automation check. Needs bash, jq, and mikefarah yq v4
# (preinstalled on GitHub-hosted Ubuntu runners).

set -eu

scripts=.github/scripts

for script in "$scripts"/*.sh; do
  case "$(head -n 1 "$script")" in
    *bash*) bash -n "$script" ;;
    *) sh -n "$script" ;;
  esac
done

sh "$scripts/validate-release-contract.sh" .github/agent-controller-release-contract.json
sh "$scripts/validate-workflow-contract.sh" .github/agent-controller-release-contract.json \
  .github/workflows/deploy-agent-controller.yml .github/workflows
sh "$scripts/test-resolve-release-version.sh"
sh "$scripts/test-render-task-definition.sh"
sh "$scripts/test-check-release-notes.sh"
sh "$scripts/test-deployment-manifest.sh"
sh "$scripts/test-selectors.sh"
bash "$scripts/test-deploy-controllers.sh"

echo "release automation: all checks passed"
