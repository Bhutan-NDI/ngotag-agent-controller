#!/bin/sh

# Prints the GitHub Release this deployment publishes, as key=value lines:
#   version, release_tag, previous_tag, reuse
#
# QA and Stage publish pre-releases of the next stable version
# (vX.Y.Z-qa.N, vX.Y.Z-rc.N). X.Y.Z is the larger of the manifest's
# next_version and the latest stable release plus one patch. Prod publishes
# vX.Y.Z for the release candidate Stage runs and never reuses a version.
#
# A release of the same series on the same commit that was published after the
# trigger tag was created belongs to an earlier attempt of this deployment and
# is reused, so a retried workflow never publishes a duplicate.

set -eu

if [ "$#" -ne 6 ]; then
  echo "usage: $0 <release-contract> <environment> <next-version|source-release-tag> <releases-json> <source-sha> <trigger-time>" >&2
  exit 2
fi

contract=$1
environment=$2
requested=$3
releases=$4
source_sha=$5
trigger_time=$6

test -f "$contract" || { echo "release contract does not exist: $contract" >&2; exit 1; }
test -f "$releases" || { echo "release list does not exist: $releases" >&2; exit 1; }
printf '%s' "$source_sha" | grep -Eq '^[0-9a-f]{40}$' || { echo "invalid source commit" >&2; exit 1; }
printf '%s' "$trigger_time" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || {
  echo "trigger time must be an ISO-8601 UTC timestamp" >&2
  exit 1
}

jq -r -n \
  --slurpfile contract "$contract" \
  --slurpfile pages "$releases" \
  --arg environment "$environment" \
  --arg requested "$requested" \
  --arg source_sha "$source_sha" \
  --arg trigger_time "$trigger_time" '
  def fail($message): error($message);
  def semver: capture("^(?<major>0|[1-9][0-9]*)\\.(?<minor>0|[1-9][0-9]*)\\.(?<patch>0|[1-9][0-9]*)$")
    | [.major, .minor, .patch] | map(tonumber);

  $contract[0] as $c
  | ($c.environments[$environment] // fail("unknown environment " + $environment)) as $env
  | $c.release.tag_prefix as $prefix
  | ($prefix | gsub("(?<c>[.\\\\/+*?()|\\[\\]{}^$])"; "\\\(.c)")) as $escaped
  | [$pages[] | if type == "array" then .[] else fail("release list must contain arrays of releases") end
      | select(.draft | not)] as $all
  | [$all[] | select(.tag_name | test("^" + $escaped + "[0-9]+\\.[0-9]+\\.[0-9]+$"))
      | . + {semver: (.tag_name | ltrimstr($prefix) | semver)}] as $stable
  | ($stable | map(.semver) | max) as $latest_stable
  # Prefer published_at: GitHub sets created_at to the date of the release commit.
  | def published: (.published_at // .created_at // "");
    def newest($list): $list | sort_by(published) | last;
    def reusable($tag): $all | map(select(.tag_name == $tag and .target_commitish == $source_sha
      and published >= $trigger_time)) | length > 0;
    def previous($pattern; $tag): (newest([$all[] | select((.tag_name | test($pattern)) and .tag_name != $tag)]) // null)
      // newest([$all[] | select(.tag_name | test($env.legacy_release_pattern))])
      | .tag_name // "";

  if $env.channel == "stable" then
    ($requested | capture("^" + $escaped + "(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)-rc\\.[1-9][0-9]*$")
      // fail("prod must promote a Stage release candidate, got: " + $requested)) as $source
    | ($prefix + $source.version) as $tag
    | if ($latest_stable != null and ($source.version | semver) < $latest_stable) then
        fail("release candidate " + $requested + " is older than the latest stable release")
      elif any($stable[]; .tag_name == $tag) then
        if reusable($tag) then {version: $source.version, release_tag: $tag, reuse: true}
        else fail($tag + " is already released; promote a newer release candidate") end
      else {version: $source.version, release_tag: $tag, reuse: false} end
    | . + {previous_tag: previous("^" + $escaped + "[0-9]+\\.[0-9]+\\.[0-9]+$"; .release_tag)}
  else
    ($requested | semver? // fail("next_version must be X.Y.Z, got: " + $requested)) as $floor
    | (if $latest_stable == null then $floor
       else [$floor, ($latest_stable | .[2] += 1)] | max end) as $base
    | ($base | map(tostring) | join(".")) as $version
    | ($prefix + $version + "-" + $env.channel + ".") as $series
    | ($series | gsub("(?<c>[.\\\\/+*?()|\\[\\]{}^$])"; "\\\(.c)")) as $series_escaped
    | [$all[] | select(.tag_name | test("^" + $series_escaped + "[1-9][0-9]*$"))] as $existing
    | ([$existing[] | select(.target_commitish == $source_sha and published >= $trigger_time)]
        | sort_by(published) | last) as $earlier_attempt
    | if $earlier_attempt != null then
        {version: ($earlier_attempt.tag_name | ltrimstr($prefix)), release_tag: $earlier_attempt.tag_name, reuse: true}
      else
        (([$existing[] | .tag_name | ltrimstr($series) | tonumber] | max // 0) + 1) as $number
        | {version: ($version + "-" + $env.channel + "." + ($number | tostring)),
           release_tag: ($series + ($number | tostring)), reuse: false}
      end
    | . + {previous_tag: previous("^" + $escaped + "[0-9]+\\.[0-9]+\\.[0-9]+-" + $env.channel + "\\.[0-9]+$"; .release_tag)}
  end
  | "version=\(.version)", "release_tag=\(.release_tag)", "previous_tag=\(.previous_tag)", "reuse=\(.reuse)"
'
