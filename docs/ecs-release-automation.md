# ECS release automation (NGOTAG)

This describes how NGOTAG releases this controller to its ECS environments. It
covers only the NGOTAG controllers that run on ECS. This public repository holds the
workflow and its checks, but no infrastructure topology, account identifiers or
runtime settings; those live in restricted operations repositories and protected
GitHub Environments.

## Release flow

| Environment | Source                 | Image                                     | GitHub Release                             |
| ----------- | ---------------------- | ----------------------------------------- | ------------------------------------------ |
| QA          | current `develop` head | built for `linux/arm64`                   | pre-release `agent-controller/vX.Y.Z-qa.N` |
| Stage       | current `main` head    | built for `linux/arm64`                   | pre-release `agent-controller/vX.Y.Z-rc.N` |
| Prod        | the commit Stage runs  | Stage's image, copied unchanged by digest | release `agent-controller/vX.Y.Z`          |

A DevOps operator starts every release from a clean checkout of the environment's
branch:

```sh
make deploy-qa    DEPLOYMENT_CONFIG_REPOSITORY=<owner>/<manifest repository>   # on develop
make deploy-stage DEPLOYMENT_CONFIG_REPOSITORY=<owner>/<manifest repository>   # on main
make deploy-prod  DEPLOYMENT_CONFIG_REPOSITORY=<owner>/<manifest repository>   # on main, asks for confirmation
```

Make checks the branch, a clean tree, that the local head matches the remote, the
private deployment manifest, and that the `Validate` CI check passed for the exact
commit. It then pushes an immutable trigger tag
(`agent-controller-<environment>-<manifest commit>-<source commit>-<UTC time>`) and
watches the workflow (`DEPLOY_WAIT=false` skips watching). Pushing trigger tags by
hand or running the workflow any other way is not an approved release path: a tag
ruleset lets only repository administrators create `agent-controller-*` tags, and
each GitHub Environment accepts only its own trigger tags.

`deploy-prod` promotes the release candidate recorded in Stage's private ledger; it
never builds. It shows the release candidate and commit and asks the operator to
type `prod` (or pass `CONFIRM=prod`).

## What the workflow does

1. A job without secrets validates the trigger tag against
   `.github/agent-controller-release-contract.json`: the environment, that QA and
   Stage use the current branch head, and that Prod promotes a commit on `main`.
2. QA and Stage: a native arm64 runner builds one single-platform `linux/arm64`
   image and starts it to prove that the Askar, AnonCreds, Indy VDR and FFI native
   libraries load and that Askar can generate a key. Nothing is pushed otherwise.
   The image tag names the source commit, so a retry reuses the same image.
3. The deploy job resolves the release version, then builds the complete release
   notes and checks them for infrastructure identifiers. It changes nothing in ECS
   until this check passes.
4. Prod: the workflow proves that every Stage controller runs the release
   candidate's image digest on ARM64 and copies that image, byte for byte, into the
   Prod image repository.
5. Every controller of the environment is checked before any is changed: active
   service, expected task definition family, no deployment in progress, and every
   kept sidecar image available for arm64.
6. Controllers are then deployed one at a time. Each gets a copy of its current
   task definition with only the controller image replaced and the CPU architecture
   set to ARM64; environment files, volumes, roles, CPU, memory and sidecars stay
   as they are. The service is updated with the deployment circuit breaker and
   rollback enabled. The next controller starts only after ECS reports the rollout
   COMPLETED and every running task runs the released image digest. On the first
   failure ECS rolls that controller back and the run stops; controllers already
   updated keep the new image, and no release is published. A controller is not
   started unless its full rollout window fits in both the job's remaining time
   and the AWS session; the run then stops cleanly and can be repeated.
7. The GitHub Release is created as a draft with the notes checked in step 3,
   checked again, and published; the live notes are checked once more.
8. The private manifest records the version, release, image tag and digest, source
   and manifest commits, task definitions and time of the deployment.

AWS access uses short-lived GitHub OIDC credentials from a role per environment
that trusts only that environment's trigger tags and may update only that
environment's controllers. Private repository access and release publishing use
GitHub App tokens scoped to a single repository and revoked after the job.

## Versions and release notes

QA and Stage publish pre-releases of the next stable version: the larger of the
manifest's `next_version` and the latest stable release plus one patch. Raising
`next_version` in the private manifest selects a new minor or major version. Prod
publishes the stable version of the release candidate it promotes and never
re-releases a version. A retried deployment reuses the release it already published.

Release notes follow the standard format only: the heading with the component,
version and release type, the source commit, GitHub's generated change list since
the previous release of the same series, and the changelog link. Images, digests,
registries, accounts, clusters, services, task definitions, architectures and
storage or network identifiers are never published; they are kept only in the
private ledger. The release tags and trigger tags match no other workflow trigger
in this repository; CI enforces this.

## Changing the automation

`make release-check` runs every check that CI runs for the release automation. Keep
the workflow trigger globs, the resolver concurrency mapping and the Make targets
synchronized with the release contract; CI rejects drift.
