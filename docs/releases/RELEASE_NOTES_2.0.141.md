## v2.0.141 - tool routing diagnostics

This release does not widen native bridge production defaults.

### Tool routing diagnostics

- Added `ToolRoute[...]` request logs for tool-bearing chat requests. The log
  records requested tools, `tool_choice`-filtered tools, native mapped/unmapped
  partitions, native bridge decision reason, tool preamble tier, and compact
  routing reasons.
- `/v1/responses` now drops a forced `tool_choice` when that choice points at
  an unbridged server-side tool such as `file_search`, `computer_use_preview`,
  or `mcp`. This prevents a translated request from carrying a forced tool that
  no longer exists after flattening.
- README now has a short FAQ explaining how to interpret "no tool calls" and
  why native bridge is not a general local IDE tool fix.

### WebFetch trace canaries

- `scripts/native-bridge-smoke.mjs` now summarizes redacted
  `webFetchTrace.state` values from proto trace JSONL files. Gated WebFetch
  canaries can now report whether the LS reached `pending_permission`,
  `completed_web_document`, `error`, or another known branch without manually
  inspecting trace records.
- The trace summary is diagnostic only and does not change smoke pass/fail
  criteria.

### Validation

- Added regression coverage for Responses server-side `tool_choice` pruning,
  tool routing diagnostics, and smoke WebFetch trace summaries.
