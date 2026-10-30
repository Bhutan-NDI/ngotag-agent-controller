if length == 0 then
  error("check-runs API returned no pages")
elif any(.[]; (.check_runs | type) != "array") then
  error("check-runs API returned an unexpected response shape")
else
  [.[].check_runs[] | select(.name == $check_name and .app.slug == $app_slug)]
  | sort_by(.started_at)
  | last
  | if . == null then
      "missing"
    elif .status != "completed" then
      "pending"
    elif .conclusion == "success" then
      "success"
    else
      "failed:" + (.conclusion // "unknown")
    end
end
