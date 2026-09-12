# SWE-2 through the official Devin CLI

This opt-in Chat Completions transport runs `devin acp` and relays tool calls back
to the calling client. It supports clients such as Aside, OMO, and OpenClaw without
editing their shared prompts or tool implementations. It is an experimental local
adapter, not an official Cognition API integration.

## Setup

Use a source or npm installation with Node.js. Standalone packaged executables
are not supported by this transport because the MCP relay runs as a Node child.

1. Install the official Devin CLI and sign in with `devin auth login`.
2. Check `devin models list --format json` for the models available to your account.
3. Set `DEVIN_SWE2_TRANSPORT=acp` in the proxy environment and restart the proxy.
   Set `DEVIN_CLI_PATH` if the executable is not at `~/.local/bin/devin`.
4. Send a text request to the proxy's `/v1/chat/completions` endpoint:

```json
{
  "model": "swe-2-high",
  "reasoning_effort": "medium",
  "messages": [{ "role": "user", "content": "Explain how a binary search works." }]
}
```

This starts `devin acp --model swe-2-medium`. An explicit `reasoning_effort`
overrides the suffix in the requested model. Without an effort, the suffix is
used; bare `swe-2` selects High. Medium, High, and Max are native CLI model
variants, not three unrelated model families. `low`, `minimal`, and `off` select
Medium; `xhigh` selects Max. Check your CLI catalog before depending on a variant.

The session acknowledgement must match the selected model before the adapter
sends the caller's prompt. The official CLI model guide is
<https://docs.devin.ai/cli/models>.

Keep this endpoint local to a trusted operator. It uses that operator's CLI
account, not the proxy's cloud account pool. Configure the proxy's existing
authentication before exposing it to other clients. HTTP authentication and model
access checks still run; cloud-account failover does not apply to this transport.

## Client configuration

Configure an OpenAI-compatible Chat Completions provider pointing at your proxy.
Use an existing custom-provider facility; avoid changing a client's global
system prompt, output-length limit, or tool schema to accommodate SWE-2.

| Client | SWE-2 configuration |
| --- | --- |
| OpenCodex | Use a custom-named `openai-chat` provider. Use explicit model variants or send `reasoning_effort`; a picker default alone does not prove a raw Chat request sent that value. |
| Aside | Add a custom model with text input and reasoning support. Select Medium for that model if desired; do not add image input just to make it appear in a vision picker. Restart a running conversation or reopen the app if it retains an older explicit choice. |
| OMO | Select the custom provider's `swe-2-high` model and High effort. Keep existing `read`, `eval`, and Python tool schemas; the model retrieves their full descriptions before calling them. |
| OpenClaw | For a custom `opencodex-chat` provider exposing `devin/swe-2-high`, set `agents.defaults.models["opencodex-chat/devin/swe-2-high"].params.thinking` to `"high"`. An agent or session thinking override can take precedence. |

The `opencodex-chat` name above is an example custom provider, not an official
OpenCodex provider. Match the name and model path in your own configuration.
Installing a newer OpenCodex version may also expose its separate built-in Devin
providers; those do not automatically select this proxy transport.

## Tool calls and session continuity

The CLI sees a small MCP catalog with three functions: list client tools,
retrieve their complete descriptions and schemas, and request a client tool call.
Large schemas are paged without removing content. The adapter returns a normal
OpenAI `tool_calls` response and waits for the client's actual tool result.
It never executes a caller tool itself or invents its output.

Tool call IDs are 28 alphanumeric characters, preserving identity across clients
that truncate long IDs or strip punctuation. Continue with the returned ID and
the same server-derived caller identity. A lazily expanded client tool catalog
can be refreshed while completing an existing tool batch.

If system/developer instructions change or a user adds steering while a tool is
pending, the old ACP prompt is closed before receiving the result. A fresh session
receives the full updated transcript, including the real client tool result.
This preserves the new instructions instead of resuming an outdated prompt.

The client continues to own its permissions. Native CLI tools are denied in a
dedicated session configuration; unexpected ACP permission requests are rejected.
An explicit OMO tool-permission rejection ends the turn. Provider content-policy
errors are returned as errors without stripping instructions or retrying through
another model. System/developer messages and memories are preserved in full.

An explicitly selected `[$Skill](.../SKILL.md)` is incomplete until the matching
client file-reading call returns. Required `tool_choice` values are enforced from
the request field rather than inferred from prose. If a turn ends empty after a
real client tool result, the adapter asks once for the final answer without
repeating completed side effects. A short announcement of unfinished work remains
a bounded fallback signal. None of these paths retries policy refusals.

## Limits and verification

- Text only. Image content is rejected explicitly.
- One CLI account and at most 12 in-memory sessions per proxy process.
- Sessions expire after 30 idle minutes and are lost on restart. Do not replay
  pending tool IDs after a restart as though their CLI session still existed.
- Each response wait is bounded at ten minutes. An active ACP prompt may span
  several client tool turns without a ten-minute total-work cutoff.
- `DEVIN_SWE2_ACP_DATA` selects the private session/config directory. Session
  cleanup stops the CLI process group and removes its generated configuration.
- The proxy does not manage CLI-account billing, quota, or failover.

For a useful smoke test, give the client a read-only tool and ask it to read a
new fixture containing a unique value, then verify that it returns that value.
A 200 health response or a model-picker entry alone does not verify tool execution
or effort selection. Tests in `test/swe2-acp.test.js` cover protocol handling and
`test/swe2-acp-route.test.js` exercise the Chat handler with a local fake ACP child.

Unset `DEVIN_SWE2_TRANSPORT` and restart to restore the previous transport. Other
model requests retain their existing routes while ACP is enabled.
