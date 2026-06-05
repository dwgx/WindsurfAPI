## v2.0.110 - native allowlist alias config fix

This release fixes the v2.0.109 native bridge allowlist matrix switch so alias experiments do not produce false negatives:

- `WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES=Read:read_file,Grep:grep_v2,Glob:list_dir` now keeps the raw allowlist names in Cascade field 32 while still enabling the matching per-tool sub-configs.
- `read_file` enables `ViewFileToolConfig`, `grep_v2` enables `GrepV2ToolConfig`, and `list_dir` enables `ListDirToolConfig`.
- Empty per-tool config messages are now encoded as present zero-length protobuf fields in native bridge mode instead of being accidentally omitted by the generic message helper.
- Default production behavior is unchanged and native bridge remains opt-in behind the existing gates.
