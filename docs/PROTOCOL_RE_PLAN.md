# Protocol RE Completion Plan

Status: planning artifact (2026-06-10). Goal: make WindsurfAPI's reverse-engineered
Cascade protocol layer complete/correct ("protocol perfect"), at cliproxyapi-class
quality. Execute heavy inventory, trace analysis, and test work in the lab workflow
when backend access is available; one backend was returning `503` from
`v-api.hk.yesfuture.ai` at planning time. Keep credentials out of prompts, logs, and
repo files.

## Lab box runbook (the RE asset)

- Host `154.40.36.22` (Debian 12, 7.8G RAM). Password SSH via `scripts/vps-exec.py`
  (`WINDSURFAPI_VPS_HOST/USER/PASS` env). Credentials are held by the user, session-only —
  NEVER write them to disk/git/logs. (SSH key auth is rejected by this image's sshd.)
- Service: systemd unit `windsurfapi`, repo `/root/WindsurfAPI`, running v2.0.144,
  10 active accounts (HAIKU-ONLY — all sonnet variants return `model_not_available`).
- Canary env drop-in: `/etc/systemd/system/windsurfapi.service.d/canary.conf`
  (native-bridge gate, auto-approve, proto trace). Edit + `systemctl daemon-reload &&
  systemctl restart windsurfapi`.
- Proto trace dir: `/root/WindsurfAPI/data/proto-trace/` (files
  `ls-proto-<pid>-<RPC>.jsonl`). `WINDSURFAPI_PROTO_TRACE_STRINGS=1` captures string
  bodies (incl. prompts) — **lab-only; turn it OFF as the first resume step.**
- Remote native-tool workspace (where view_file/grep/find/run_command execute):
  `/home/user/projects/workspace-<hash>` (discovered via Bash native `pwd`). To test the
  file tools, drop known files there first.

## Findings locked in so far (real haiku traces, 2026-06-10)

- Native WebFetch works end-to-end and is FIXED in v2.0.144 (the LS fetches and returns a
  real `web_document`; the proxy used to drop it). See [docs/native-bridge-protocol-notes.md].
- Trajectory step `type` ↔ native oneof, OBSERVED co-occurrences (not a full confirmed
  schema; docs warn `type` is not a reliable body-field number):
  - `type=21` carries the `run_command` (Bash) native oneof. **NEW.**
  - `type=31` carries the `read_url_content` (WebFetch) oneof, alongside a
    `requested_interaction` echo and the `web_document`.
  - `type=14` carries `readWrapperField19` (the Read/view_file environment+prompt wrapper).
  - `type=34`, `type=15` appear at the head of every trajectory (preamble / planner-status).
  - `type=8`, `type=23` appear in the Read trajectory (post-tool / status) — unmapped.
  - Per docs, oneof FIELD numbers: `read_url_content`=40, `search_web`=42 (distinct from step `type`).
- Read/Grep/Glob native execution targets the REMOTE stub workspace, useless for clients
  that want their LOCAL files. So returning a tool-call PROPOSAL (client executes locally)
  is the correct default for these — unlike WebFetch (URLs are location-independent).

## Work items (priority order; the user picked "deep protocol RE completion")

### 1. Confirmed trajectory step-type map (highest RE value)
Currently the parser treats `type` as unreliable. Build a confirmed map by tracing each
native tool on the lab box and tabulating `{type, nativeOneofs, messageFields}` per step.
- Tools to trace: Read(view_file), Grep(grep_search_v2), Glob(find), list_dir(list_directory),
  Bash(run_command, done=21), WebFetch(read_url_content, done=31), WebSearch(search_web).
- Deliverable: a table in native-bridge-protocol-notes.md mapping step type → meaning →
  oneof field, with the haiku-trace evidence. Update the parser to key off confirmed fields.

### 2. Per-tool round-trip confirmation (place test files in the remote workspace first)
For each file tool, confirm the LS executes and returns a result oneof, and that the parser
extracts it. Watch for the same class of bug as the WebFetch one (result present but dropped
because a requested_interaction/pending echo is checked first).
- view_file result step type + field; grep_search_v2 result shape; find result shape;
  list_directory result shape.

### 3. Confirm the still-unconfirmed subconfig fields
- `GrepV2ToolConfig` exact field number for `allow_access_gitignore` (docs: needs descriptor
  dump or CONFIG_RAW matrix).
- `ListDirToolConfig` non-empty fields.
- Use `WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW` matrix on the lab box to bisect field numbers.

### 4. Resolve the Read wrapper `type=14 field=19` schema
Use `semantic.steps[].readWrapperField19.candidateSummary` across traces to decide path-vs-prompt
field handling; replace the current stop-loss guard with a confirmed rule.

### 5. Endpoint breadth (secondary — protocol surface parity with cliproxyapi)
Server currently exposes: `/v1/chat/completions`, `/v1/responses` (+`/v1/response`),
`/v1/messages` (Anthropic), `/v1/models`, `/auth/*`, `/dashboard/*`, `/health`.
Missing vs cliproxyapi-class:
- Anthropic `/v1/messages/count_tokens` (Claude Code calls it; missing = 404). HIGH client-compat.
- Gemini format `/v1beta/models/{model}:generateContent` + `:streamGenerateContent`.
- OpenAI `/v1/embeddings` (only if Cascade exposes embeddings — verify first).
- OpenAI legacy `/v1/completions` (minor).

## Implementation work queue (run when backend access is healthy)
- A: external benchmark — cliproxyapi (router-for-me/CLIProxyAPI) + kiro.rs feature/protocol
  matrix (retry the task that 503'd).
- B: internal protocol-RE inventory (retry the task that 503'd) — confirmed vs stub map.
- C: implement endpoint(s) from item 5 (start with count_tokens) with tests.
- D: given lab-box traces, update windsurf.js/proto-trace.js parsers + tests
  per items 1–4.
Pattern: use bulk automation for reads, writes, and tests; use lab-box trace evidence
for parser changes and verification. Keep credentials out of prompts and logs.

## Verification + release rules (unchanged)
Per [docs/MAINTAINER_NOTES.md]: focused tests + `npm run test:release` + `npm run secret-scan`,
full shards on non-trivial blast radius, then commit/tag/push, verify CI/Release, deploy +
smoke. Production VPS (43.153.139.136) still runs v2.0.142; deploying needs prod creds.
Never widen native-bridge production defaults from a single lab success.
