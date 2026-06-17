.PHONY: deploy-prod

PROD_TAG_PREFIX ?= prod-agent-controller
VERSION ?= $(shell date -u +%Y%m%d%H%M%S)-$(shell git rev-parse --short=8 HEAD)

deploy-prod:
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "main" || (echo "deploy-prod must be run from main" && exit 1)
	@test -z "$$(git status --porcelain)" || (echo "working tree must be clean before deploy-prod" && exit 1)
	git fetch origin main --tags
	git pull --ff-only origin main
	git tag -a "$(PROD_TAG_PREFIX)-$(VERSION)" -m "Deploy prod $(PROD_TAG_PREFIX)-$(VERSION)"
	git push origin "$(PROD_TAG_PREFIX)-$(VERSION)"
