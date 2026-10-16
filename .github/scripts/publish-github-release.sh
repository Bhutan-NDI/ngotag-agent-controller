#!/usr/bin/env bash

# Builds and publishes the GitHub Release for a deployment. This repository is
# public, so the notes carry only the standard format: a heading with the
# component, version and release type, the source commit, GitHub's generated
# change list since the previous release of the same series, and the changelog
# link.
#
#   publish-github-release.sh prepare   writes NOTES_FILE and checks it; runs
#                                       before any infrastructure change
#   publish-github-release.sh publish   creates a draft with exactly NOTES_FILE,
#                                       publishes it, and checks the live body
#
# Environment:
#   GH_TOKEN, REPOSITORY, RELEASE_TAG, PREVIOUS_TAG (may be empty), SOURCE_SHA,
#   VERSION, CHANNEL (qa|rc|stable), TITLE, REUSE (true|false), NOTES_FILE,
#   PROMOTED_FROM (Prod only), PRIVATE_NAMES_FILE (one private name per line)

set -euo pipefail

mode=${1:?usage: $0 prepare|publish}
: "${GH_TOKEN:?}" "${REPOSITORY:?}" "${RELEASE_TAG:?}" "${SOURCE_SHA:?}" "${VERSION:?}" \
  "${CHANNEL:?}" "${TITLE:?}" "${REUSE:?}" "${NOTES_FILE:?}" "${PRIVATE_NAMES_FILE:?}"
script_dir=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export PUBLIC_TEXT="$TITLE $REPOSITORY"
mapfile -t private_names < "$PRIVATE_NAMES_FILE"
check() { sh "$script_dir/check-release-notes.sh" "$1" "$2" "${private_names[@]}"; }

case "$CHANNEL" in
  qa) label="pre-release"; prerelease=true; make_latest=false ;;
  rc) label="release candidate"; prerelease=true; make_latest=false ;;
  stable) label="release"; prerelease=false; make_latest=true ;;
  *) echo "unknown release channel $CHANNEL" >&2; exit 1 ;;
esac

verify_live() {
  gh api "repos/$REPOSITORY/releases/tags/$RELEASE_TAG" > "$work/live.json"
  jq -e --arg sha "$SOURCE_SHA" --argjson prerelease "$prerelease" \
    '.draft == false and .prerelease == $prerelease and .target_commitish == $sha' \
    "$work/live.json" >/dev/null || {
    echo "published release $RELEASE_TAG does not match this deployment" >&2
    exit 1
  }
  jq -r '.body' "$work/live.json" > "$work/live.md"
  check generated "$work/live.md" || {
    echo "the live notes of $RELEASE_TAG contain an infrastructure identifier; edit them now" >&2
    exit 1
  }
  echo "Published $(jq -r '.html_url' "$work/live.json")"
}

if [ "$REUSE" = "true" ]; then
  if [ "$mode" = "prepare" ]; then
    echo "Reusing $RELEASE_TAG from an earlier attempt of this deployment"
  else
    verify_live
  fi
  exit 0
fi

case "$mode" in
  prepare)
    {
      printf '## %s v%s (%s)\n\n' "$TITLE" "$VERSION" "$label"
      if [ "$CHANNEL" = "stable" ]; then
        printf 'Promoted unchanged from the release candidate `%s`.\n\n' "${PROMOTED_FROM:?}"
      fi
      printf '**Source commit:** `%s`\n\n' "$SOURCE_SHA"
    } > "$work/authored.md"
    check authored "$work/authored.md"

    generate_args=(-f tag_name="$RELEASE_TAG" -f target_commitish="$SOURCE_SHA")
    if [ -n "${PREVIOUS_TAG:-}" ]; then
      generate_args+=(-f previous_tag_name="$PREVIOUS_TAG")
    fi
    gh api --method POST "repos/$REPOSITORY/releases/generate-notes" "${generate_args[@]}" \
      --jq '.body' > "$work/generated.md"
    check generated "$work/generated.md"
    cat "$work/authored.md" "$work/generated.md" > "$NOTES_FILE"
    echo "Release notes for $RELEASE_TAG prepared and checked"
    ;;

  publish)
    test -s "$NOTES_FILE" || { echo "the prepared release notes are missing" >&2; exit 1; }
    # A draft left by an earlier failed attempt is reused only if it is for the same commit.
    draft_id=$(gh api --paginate "repos/$REPOSITORY/releases?per_page=100" \
      | jq -sr --arg tag "$RELEASE_TAG" --arg sha "$SOURCE_SHA" '
          [.[][] | select(.tag_name == $tag)] as $matches
          | if any($matches[]; .draft | not) then error("release already published")
            elif any($matches[]; .target_commitish != $sha) then error("a draft for another commit uses this tag")
            else ($matches | first | .id // empty) end')
    release_fields=(-f tag_name="$RELEASE_TAG" -f target_commitish="$SOURCE_SHA"
      -f name="$TITLE v$VERSION" -F body=@"$NOTES_FILE" -F draft=true -F prerelease="$prerelease")
    if [ -n "$draft_id" ]; then
      gh api --method PATCH "repos/$REPOSITORY/releases/$draft_id" "${release_fields[@]}" >/dev/null
    else
      draft_id=$(gh api --method POST "repos/$REPOSITORY/releases" "${release_fields[@]}" --jq '.id')
    fi
    gh api "repos/$REPOSITORY/releases/$draft_id" --jq '.body' > "$work/draft.md"
    check generated "$work/draft.md"
    gh api --method PATCH "repos/$REPOSITORY/releases/$draft_id" \
      -F draft=false -f make_latest="$make_latest" >/dev/null
    verify_live
    ;;

  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
