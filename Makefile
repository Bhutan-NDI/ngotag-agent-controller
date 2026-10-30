.PHONY: deploy-qa deploy-stage deploy-prod release-check

DEPLOY_WAIT ?= true
DEPLOYMENT_CONFIG_REPOSITORY ?=
CONFIRM ?=

# A DevOps operator starts every NGOTAG ECS release through one of these targets:
#   deploy-qa     releases the current develop head to QA
#   deploy-stage  releases the current main head to Stage as a release candidate
#   deploy-prod   promotes the exact image Stage runs to Prod (asks for confirmation)
# Each target pins the private manifest commit and the source commit in an
# immutable trigger tag; .github/workflows/deploy-agent-controller.yml repeats
# every check before it obtains AWS credentials. See docs/ecs-release-automation.md.
deploy-qa:
	@DEPLOY_ENV=qa DEPLOY_WAIT="$(DEPLOY_WAIT)" CONFIRM="$(CONFIRM)" \
		DEPLOYMENT_CONFIG_REPOSITORY="$(DEPLOYMENT_CONFIG_REPOSITORY)" \
		sh .github/scripts/trigger-release.sh

deploy-stage:
	@DEPLOY_ENV=stage DEPLOY_WAIT="$(DEPLOY_WAIT)" CONFIRM="$(CONFIRM)" \
		DEPLOYMENT_CONFIG_REPOSITORY="$(DEPLOYMENT_CONFIG_REPOSITORY)" \
		sh .github/scripts/trigger-release.sh

deploy-prod:
	@DEPLOY_ENV=prod DEPLOY_WAIT="$(DEPLOY_WAIT)" CONFIRM="$(CONFIRM)" \
		DEPLOYMENT_CONFIG_REPOSITORY="$(DEPLOYMENT_CONFIG_REPOSITORY)" \
		sh .github/scripts/trigger-release.sh

# Validates the release automation; CI runs the same checks.
release-check:
	@sh .github/scripts/test-release-automation.sh
