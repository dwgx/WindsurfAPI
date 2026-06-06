# Native Bridge Protocol Notes

Status: reverse-engineering notes for the opt-in native bridge. Nothing here
is a default production enablement decision.

## Production Gate Status

Default production canary scope is intentionally limited to
`Bash` / `shell_command` / `run_command`.

`Read`, `Grep`, `Glob`, `WebSearch`, and `WebFetch` stay in `TOOL_MAP` for
protocol matrix testing, but they are not in the default native bridge tool
allowlist. To test them, set
`WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS=Read,Bash,Grep,Glob` or a narrower list
for a gated account/API key/model.

For Claude Code, Cline, Codex, Cursor-style local agents, the safe production
default is still prompt/tool emulation. Native bridge means Cascade may execute
the built-in tool in the remote Windsurf workspace, not on the caller's local
machine. Do not recommend `all_mapped` as a general fix for "tools not called";
use it only for narrow canaries with explicit model/account/API-key gates.

Do not add `WebSearch` / `WebFetch` to a production allowlist yet. v2.0.126
confirmed their tool-config fields and subconfig enums, but live LS canaries
still return a `permission_denied` Cascade error step before any web oneof is
emitted.

Do not treat successful protobuf encode/decode round-trips as production
readiness.

## Confirmed Tool Config Fields

`CascadeToolConfig`:

- `find` = field `5` (`FindToolConfig`)
- `run_command` = field `8` (`RunCommandToolConfig`)
- `view_file` = field `10` (`ViewFileToolConfig`)
- `search_web` = field `13` (`SearchWebToolConfig`)
- `list_dir` = field `19` (`ListDirToolConfig`)
- `tool_allowlist` = repeated field `32`
- `grep_v2` = field `33` (`GrepV2ToolConfig`)
- `read_url_content` = field `37` (`ReadUrlContentToolConfig`)

Confirmed from LS binary protobuf struct tags and runtime trace.

Not confirmed yet:

- Exact web result/document payload shape beyond the summary field currently
  surfaced in trajectory steps.
- Whether the local LS can expose web tools as proposal-only native bridge
  calls. A v2.0.125/v2.0.126 VPS canary confirmed normal trial/pro accounts had
  `cascadeWebSearchEnabled=true`, and direct `GetWebSearchResults` returned
  HTTP 200 with results for every loaded account. The failure is therefore in
  the LS native web executor path, not in account web entitlement or the public
  web-search API.

`FindToolConfig`:

- `max_find_results` = field `1`
- `fd_path` = field `2`
- `enterprise_config` = field `7`

`ViewFileToolConfig`:

- `max_tokens_per_outline` = field `1`
- `max_doc_lines_fraction` = field `2` (`fixed32`)
- `allow_doc_outline` = field `4` (`optional bool`)
- `use_line_numbers_for_raw` = field `5` (`optional bool`)
- `use_prompt_prefix` = field `6` (`optional bool`)
- `allow_view_gitignore` = field `7` (`optional bool`)
- `split_outline_tool` = field `8` (`optional bool`)
- `max_total_outline_bytes` = field `9`
- `show_full_file_bytes` = field `10` (`optional bool`)
- `max_bytes_per_outline_item` = field `11`
- `enterprise_config` = field `12`
- `show_triggered_memories` = field `13` (`optional bool`)
- `max_lines_per_view` = field `14` (`optional bool/int-style oneof in Go tag`)
- `use_view_file_v2` = field `15` (`optional bool`)

`GrepV2ToolConfig`:

- Methods confirm `enterprise_config` and `allow_access_gitignore`.
- Binary tags show several `allow_access_gitignore` fields across related
  grep/view-code configs. The exact GrepV2 field number still needs an
  isolated descriptor dump or raw-config matrix confirmation before hardcoding.

`ListDirToolConfig`:

- Method confirms `enterprise_config`.
- No safe non-empty field is hardcoded yet.

`SearchWebToolConfig`:

- `force_disable` = field `1` (`optional bool`)
- `third_party_config` = field `2`
  (`exa.codeium_common_pb.ThirdPartyWebSearchConfig`)

`ThirdPartyWebSearchConfig`:

- `provider` = field `1`
  - `0` = `THIRD_PARTY_WEB_SEARCH_PROVIDER_UNSPECIFIED`
  - `1` = `THIRD_PARTY_WEB_SEARCH_PROVIDER_OPENAI`
- `model` = field `2`
  - `0` = `THIRD_PARTY_WEB_SEARCH_MODEL_UNSPECIFIED`
  - `1` = `THIRD_PARTY_WEB_SEARCH_MODEL_O3`
  - `2` = `THIRD_PARTY_WEB_SEARCH_MODEL_GPT_4_1`
  - `3` = `THIRD_PARTY_WEB_SEARCH_MODEL_O4_MINI`

`ReadUrlContentToolConfig`:

- `force_disable` = field `1` (`optional bool`)
- `auto_web_request_config` = field `2`
  (`AutoWebRequestConfig`)

`AutoWebRequestConfig`:

- `allowlist` = repeated field `1` (`string`)
- `auto_execution_policy` = field `2`
  - `0` = `CASCADE_WEB_REQUESTS_AUTO_EXECUTION_UNSPECIFIED`
  - `1` = `CASCADE_WEB_REQUESTS_AUTO_EXECUTION_DISABLED`
  - `2` = `CASCADE_WEB_REQUESTS_AUTO_EXECUTION_ALLOWLIST`
  - `3` = `CASCADE_WEB_REQUESTS_AUTO_EXECUTION_TURBO`

`CortexStepSearchWeb`:

- `query` = field `1`
- `web_documents` = repeated field `2`
  (`exa.codeium_common_pb.KnowledgeBaseItem`)
- `domain` = field `3`
- `web_search_url` = field `4`
- `summary` = field `5`
- `third_party_config` = field `6`

## Runtime Step Caveat

`CortexTrajectoryStep.type` is not a reliable body-field number. Some traces
show `type=14` with payload on `field=19`, and `type=15` with `field=20`
planner response data. Keep parsing based on actual oneof/message fields and
trace unknown message-field children before promoting a new mapping.

For the observed Read wrapper (`type=14`, `field=19`), v2.0.131 only promotes
field `1` or `2` when the candidate is clearly path-like. Live traces showed
field `2` can also contain the full prompt/environment text, so this is a
stop-loss guard, not a confirmed schema. Enable proto trace to inspect
`semantic.steps[].readWrapperField19` before changing the parser again:

```text
WINDSURFAPI_PROTO_TRACE=1
# Optional, only for a gated lab run. Redaction still applies.
WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_STRINGS=1
```

The dedicated summary records child field numbers, wire types, byte lengths,
hashes, and safe classifications such as `looksPathLike` and
`looksPromptLike`. Do not use the global raw-string trace switch for production
traffic; it can capture prompts.

v2.0.137 adds a parser-aligned evidence block at
`semantic.steps[].readWrapperField19.candidateSummary`:

- `acceptedField` = the field current production parsing would accept
  (`1`/`2` only, and only when path-like), otherwise `null`
- `pathLikeFields` = fields whose string payload looks like a path/file URI
- `rejectedPromptFields` = prompt-like string fields not accepted by the parser
- `ambiguous` = more than one accepted field, which is a trace investigation
  signal rather than a license to widen production parsing

This lets a gated canary answer "which field would the current Read parser
use?" without printing the actual file path or prompt text.

Error trajectory steps also have a dedicated redacted summary. For `type=17`
or any step carrying `error_message` field `24` / `error` field `31`, traces
now expose `semantic.steps[].errorStep` with source field numbers, byte
lengths, hashes, nested string paths, and classification flags such as
`permissionDenied`, `failedPrecondition`, `modelNotAvailable`, and
`internalError`. Raw previews stay off by default; for a gated lab run only:

```text
WINDSURFAPI_PROTO_TRACE_ERROR_STRINGS=1
```

This switch is narrower than `WINDSURFAPI_PROTO_TRACE_STRINGS=1` and still
redacts emails and token-like values. It exists to diagnose LS executor
preconditions without dumping complete prompts or account material.

Trajectory parsing now recognizes the web step oneofs observed so far:

- `read_url_content` = field `40`, body
  `{ url=1, web_document=2, resolved_url=3, latency_ms=4,
  user_rejected=6, auto_run_decision=7 }`
- `search_web` = field `42`, body `{ query=1, domain=3, summary=5 }`

Official Windsurf 2.3.15 generated client fields for the WebFetch document:

- `KnowledgeBaseItem.text` = field `2`
- `KnowledgeBaseItem.url` = field `3`
- `KnowledgeBaseItem.title` = field `4`
- `KnowledgeBaseItem.chunks` = repeated field `6`
- `KnowledgeBaseItem.summary` = field `7`
- `KnowledgeBaseChunk.text` = field `1`
- `KnowledgeBaseChunk.markdown_chunk` = field `3`, whose text is field `2`

There is no confirmed top-level `CortexStepReadUrlContent.summary=5` in the
official 2.3.15 client. The parser keeps field `5` only as a legacy fallback
for older local traces; new injection writes `web_document` instead.

This is trace visibility, not a production enablement decision. The bridge can
decode these steps when Cascade emits them, but WebSearch/WebFetch still need
gated live smoke before they can join the default native bridge allowlist.

## WebSearch/WebFetch Canary Result

The v2.0.126 protocol pass tested a gated VPS canary with:

```text
WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS=WebSearch,WebFetch
WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS=claude-sonnet-4.6
WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS=<single account id>
WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL=1
WINDSURFAPI_PROTO_TRACE=1
```

Control checks:

- `GetCliTeamSettings` returned `cascadeWebSearchEnabled=true`.
- Direct `GetWebSearchResults` returned HTTP 200 and web results.

Raw subconfigs tested:

```text
# SearchWebToolConfig.third_party_config { provider=OPENAI, model=O4_MINI }
# ReadUrlContentToolConfig.auto_web_request_config { auto_execution_policy=TURBO }
search_web:120408011003;read_url_content:12021003
```

Result:

- `SendUserCascadeMessage` included `CascadeToolConfig.search_web=13` and
  `read_url_content=37` with those non-empty subconfigs.
- `GetCascadeTrajectorySteps` returned the same three-step error shape as the
  empty-config baseline: `find` placeholder, planner/status step, then
  `type=17` error with a `permission_denied` wrapper.
- No `field=42 search_web` or `field=40 read_url_content` oneof appeared.

Current conclusion: WebSearch/WebFetch must stay on prompt emulation or a
separate first-party API bridge until we find the LS-side web executor
precondition. The confirmed protobuf fields are useful for tracing and future
matrix work, but not sufficient for production native bridge rollout.

The v2.0.132 VPS pass rechecked the same area after the Read wrapper fixes:

- Direct `GetWebSearchResults` succeeded for all ten loaded active/pro
  accounts, returning two results per account for the control query.
- A gated LS-native smoke enabled only `WebSearch,WebFetch` for
  `claude-sonnet-4.6` with API-key gating and raw web subconfigs.
- `SendUserCascadeMessage` did send web native configs:
  `search_web` appeared as allowlist `["search_web"]` with subconfig field
  `13`; `read_url_content` appeared as allowlist `["read_url_content"]` with
  subconfig field `37`.
- `GetCascadeTrajectorySteps` still emitted no `field=42 search_web` and no
  `field=40 read_url_content` native oneof. The repeated shape was
  `type=14`, `type=34`, then `type=17` error with field `24`.
- The OpenAI-compatible smoke response surfaced HTTP `403` with
  `type="model_not_available"` for both web scenarios.

Updated conclusion: the proxy is not failing to send the WebFetch config; LS
receives the `read_url_content` config but still fails before emitting the web
oneof. The missing piece remains an LS-side web executor precondition or a
descriptor-backed direct WebFetch/read-url API.

The v2.0.134 VPS pass tested `read_url_content` alone with an explicit
allowlist subconfig for `https://example.com/`:

- `SendUserCascadeMessage` enabled the bridge decision for mapped WebFetch and
  sent `read_url_content` in the native allowlist.
- `GetCascadeTrajectorySteps` repeatedly returned a pending
  `requested_interaction.read_url_content` for the target URL/origin.
- The matching native step body had fields `[1, 7]`: URL plus
  `autoRunDecision=8`; there was no `web_document` yet and no executor error.
- Both streaming and non-streaming canaries timed out because the proxy did not
  answer the official permission prompt.

Updated direction: do not search for a guessed direct WebFetch endpoint first.
The observed blocker is now the official LS permission interaction. The next
valid canary must send `HandleCascadeUserInteraction` and then verify whether
the same trajectory advances to `read_url_content.web_document`, an error step,
or another requested interaction.

## Direct Web Search API

`GetWebSearchResults` is confirmed independently of the LS-native tool path:

```text
POST /exa.api_server_pb.ApiServerService/GetWebSearchResults
```

Request fields from the descriptor dump:

- `metadata` = field `1`
- `query` = field `2`
- `limit` = field `3`
- `domain` = field `4`
- `third_party_config` = field `5`
- `mode` = field `6`

Response fields:

- `results` = repeated field `1` (`KnowledgeBaseItem`)
- `web_search_url` = field `2`
- `summary` = field `3`

`src/windsurf-api.js` exposes `getWebSearchResults()` and
`npm run probe:web-search` exercises it against real accounts. This is the
preferred WebSearch investigation path for now because it avoids the LS native
web executor that currently returns `permission_denied`.

There is not yet an equivalent confirmed direct WebFetch/read-url endpoint.
Do not implement WebFetch direct bridging from guesswork; keep it on emulation
or native lab traces until a descriptor-backed endpoint is found.

## Official WebFetch Permission Flow

Static inspection of the official Windsurf 2.3.15 client found no direct
API-server method that returns URL contents. `RecordReadUrlContent` only
records `{ metadata=1, url=2, web_document=3, latency_ms=4, is_cached=5 }`
and returns an empty response.

The official client handles WebFetch through the language server:

- `CortexTrajectoryStep.requested_interaction` = field `56`
- `RequestedInteraction.read_url_content` = field `14`
- `CascadeReadUrlContentInteractionSpec.url` = field `1`
- `CascadeReadUrlContentInteractionSpec.origin` = field `2`
- RPC:
  `/exa.language_server_pb.LanguageServerService/HandleCascadeUserInteraction`
- `HandleCascadeUserInteractionRequest.cascade_id` = field `1`
- `HandleCascadeUserInteractionRequest.interaction` = field `2`
- `CascadeUserInteraction.trajectory_id` = field `1`
- `CascadeUserInteraction.step_index` = field `2`
- `CascadeUserInteraction.read_url_content` = field `15`
- `CascadeReadUrlContentInteraction.action` = field `1`
- `CascadeReadUrlContentInteraction.url` = field `2`
- `CascadeReadUrlContentInteraction.origin` = field `3`

`ReadUrlContentAction` enum values:

- `1` = allow once
- `2` = reject
- `3` = always allow origin

User settings that influence auto-approval:

- `cascade_user_allowed_web_origins` = field `88`
- `cascade_removed_default_web_origins` = field `89`
- `cascade_web_requests_auto_execution_policy` = field `90`
  (`1` disabled, `2` allowlist, `3` turbo)

`WINDSURFAPI_PROTO_TRACE` now summarizes `requested_interaction=56` and its
read-url body with byte lengths and hashes only. It also summarizes
`HandleCascadeUserInteraction` requests, including cascade/trajectory ID
hashes, step index, action enum, and URL/origin hashes.

v2.0.137 adds
`semantic.steps[].webFetchTrace` so a canary can classify the post-approval
trajectory without raw URL text:

- `pending_permission`
- `completed_web_document`
- `auto_run_decision_only`
- `legacy_summary_only`
- `native_oneof_no_document`
- `error` with redacted `permissionDenied` / `failedPrecondition` style flags

Use this field after `HandleCascadeUserInteraction` to decide whether the LS
advanced to a real `read_url_content.web_document`, repeated the permission
prompt, or failed a precondition.

The next valid WebFetch canary decision point is: after approval, did the LS
emit a completed `field=40` step with `web_document`, an error step, or another
requested interaction?

v2.0.135 adds a lab-only auto-approval hook for this canary:

```text
WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE=1
WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE_ORIGINS=https://example.com
```

The hook is still behind normal native bridge gating and only runs when
`read_url_content` is in the native allowlist. It is not a production default.
Pending `read_url_content` steps that only contain the permission request are
not surfaced as completed native tool calls; the proxy waits for an actual
`web_document` or legacy result before returning WebFetch content to the
client. The origin list must explicitly match the requested origin or URL.

## Experiment Hooks

`WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW` can inject exact protobuf bytes
for native tool subconfigs or unknown top-level `CascadeToolConfig` fields:

```text
read_file:<hex>;grep_v2:base64:<base64>;find:<hex>;list_dir:<hex>;search_web:<hex>;read_url_content:<hex>;field42:<hex>;field40:
```

Useful confirmed web examples:

```text
# provider=OPENAI, model=O4_MINI
search_web:120408011003

# auto_execution_policy=TURBO
read_url_content:12021003

# allowlist=["https://example.com/"], auto_execution_policy=ALLOWLIST
read_url_content:12180a1468747470733a2f2f6578616d706c652e636f6d2f1002
```

The hook is default-off and exists only for matrix testing. Smoke must still
require native source plus argument validation; a raw subconfig that merely
causes natural-language or degraded `pattern:"*"` output is not a success.
Use `fieldNN:<hex>`, `field_NN:<hex>`, or `fNN:<hex>` only for unconfirmed
top-level matrix fields in a gated lab account.

`WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL=1` is also lab-only. It keeps
polling Cascade after the first `cascade_native` tool call so protobuf traces
can capture post-tool result/document payloads. Production bridge traffic should
leave it unset; the default behavior stops at the tool proposal so OpenAI
clients execute the tool locally instead of the remote LS workspace doing it.

## Next Matrix

- `Read/read_file`: test `ViewFileToolConfig` with `use_view_file_v2=true`
  (`field 15 = true`) plus, separately, `use_line_numbers_for_raw=true`
  (`field 5 = true`) and `use_prompt_prefix=true` (`field 6 = true`).
- `Grep/grep_v2`: test likely `allow_access_gitignore=true` candidates only
  after isolating the field number. Do not promote from method names alone.
- `Glob/find`: test `FindToolConfig.max_find_results` and `fd_path` only as
  diagnostics; full Glob requires returned arguments to preserve caller
  `pattern`, not just a `list_directory` fallback with `pattern:"*"`.
