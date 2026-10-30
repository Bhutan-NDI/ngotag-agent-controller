# Input: describe-task-definition's .taskDefinition. Output: the same definition
# as a register-task-definition request with only the controller container's
# image replaced and the task pinned to the release platform. Environment files,
# volumes, roles, CPU/memory and sidecar containers are kept unchanged.
if ([.containerDefinitions[]? | select(.name == $container)] | length) != 1 then
  error("task definition must contain exactly one container named " + $container)
elif ($cpu_architecture | IN("ARM64", "X86_64") | not) then
  error("unsupported CPU architecture " + $cpu_architecture)
else
  del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
      .registeredAt, .registeredBy, .deregisteredAt)
  | .containerDefinitions |= map(if .name == $container then .image = $image else . end)
  | .runtimePlatform = ((.runtimePlatform // {}) + {
      cpuArchitecture: $cpu_architecture,
      operatingSystemFamily: (.runtimePlatform.operatingSystemFamily // "LINUX")
    })
end
