if length == 0 then
  error("workflow-run API returned no pages")
elif any(.[]; (.workflow_runs | type) != "array") then
  error("workflow-run API returned an unexpected response shape")
else
  [
    .[].workflow_runs[]
    | select(
        .path == ".github/workflows/deploy-agent-controller.yml" and
          .display_title == ("Deploy Agent Controller [" + $tag + "]") and
          .head_sha == $source_sha
      )
  ]
  | sort_by(.created_at // "")
  | last
  | .id // empty
end
