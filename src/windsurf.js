/**
 * Protobuf message builders and parsers for the local Windsurf language server.
 *
 * Service: exa.language_server_pb.LanguageServerService
 *
 * Two flows:
 *   Legacy  → RawGetChatMessage (streaming, simpler)
 *   Cascade → StartCascade → SendUserCascadeMessage → poll GetCascadeTrajectorySteps
 *
 * ═══════════════════════════════════════════════════════════
 * Metadata {
 *   string ide_name          = 1;
 *   string extension_version = 2;
 *   string api_key           = 3;
 *   string locale            = 4;
 *   string os                = 5;
 *   string ide_version       = 7;
 *   string hardware          = 8;
 *   uint64 request_id        = 9;
 *   string session_id        = 10;
 *   string extension_name    = 12;
 * }
 *
 * RawGetChatMessageRequest {
 *   Metadata metadata                = 1;
 *   repeated ChatMessage messages    = 2;
 *   string system_prompt_override    = 3;
 *   Model chat_model                 = 4;   // enum
 *   string chat_model_name           = 5;
 * }
 *
 * ChatMessage {
 *   string message_id                = 1;
 *   ChatMessageSource source         = 2;   // enum
 *   Timestamp timestamp              = 3;
 *   string conversation_id           = 4;
 *   ChatMessageIntent intent         = 5;   // for user/system/tool
 *   // For assistant: field 5 is plain string text
 * }
 *
 * ChatMessageIntent { IntentGeneric generic = 1; }
 * IntentGeneric { string text = 1; }
 *
 * RawGetChatMessageResponse {
 *   RawChatMessage delta_message = 1;
 * }
 *
 * RawChatMessage {
 *   string message_id       = 1;
 *   ChatMessageSource source = 2;
 *   Timestamp timestamp     = 3;
 *   string conversation_id  = 4;
 *   string text             = 5;
 *   bool in_progress        = 6;
 *   bool is_error           = 7;
 * }
 * ═══════════════════════════════════════════════════════════
 */

import { randomUUID } from 'crypto';
import {
  writeVarintField, writeStringField, writeMessageField,
  writeBoolField, parseFields, getField, getAllFields,
} from './proto.js';

// ─── Enums ─────────────────────────────────────────────────

export const SOURCE = {
  USER: 1,
  SYSTEM: 2,
  ASSISTANT: 3,
  TOOL: 4,
};

// ─── Timestamp ─────────────────────────────────────────────

function encodeTimestamp() {
  const now = Date.now();
  const secs = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  const parts = [writeVarintField(1, secs)];
  if (nanos > 0) parts.push(writeVarintField(2, nanos));
  return Buffer.concat(parts);
}

// ─── Metadata ──────────────────────────────────────────────

export function buildMetadata(apiKey, version = '1.9600.41', sessionId = null) {
  return Buffer.concat([
    writeStringField(1, 'windsurf'),          // ide_name
    writeStringField(2, version),             // extension_version
    writeStringField(3, apiKey),              // api_key
    writeStringField(4, 'en'),                // locale
    writeStringField(5, 'linux'),             // os
    writeStringField(7, version),             // ide_version
    writeStringField(8, 'x86_64'),            // hardware
    writeVarintField(9, Date.now()),           // request_id
    writeStringField(10, sessionId || randomUUID()), // session_id
    writeStringField(12, 'windsurf'),          // extension_name
  ]);
}

// ─── ChatMessage (for RawGetChatMessage) ───────────────────

function buildChatMessage(content, source, conversationId) {
  const parts = [
    writeStringField(1, randomUUID()),                     // message_id
    writeVarintField(2, source),                           // source enum
    writeMessageField(3, encodeTimestamp()),                // timestamp
    writeStringField(4, conversationId),                   // conversation_id
  ];

  if (source === SOURCE.ASSISTANT) {
    // Assistant uses plain string for field 5
    parts.push(writeStringField(5, content));
  } else {
    // User/System/Tool use ChatMessageIntent { IntentGeneric { text } }
    const intentGeneric = writeStringField(1, content);    // IntentGeneric.text
    const intent = writeMessageField(1, intentGeneric);    // ChatMessageIntent.generic
    parts.push(writeMessageField(5, intent));
  }

  return Buffer.concat(parts);
}

// ─── RawGetChatMessageRequest ──────────────────────────────

/**
 * Build RawGetChatMessageRequest protobuf.
 *
 * @param {string} apiKey
 * @param {Array} messages - OpenAI-format [{role, content}, ...]
 * @param {number} modelEnum - Windsurf model enum value
 * @param {string} [modelName] - Model name string (optional)
 */
export function buildRawGetChatMessageRequest(apiKey, messages, modelEnum, modelName) {
  const parts = [];
  const conversationId = randomUUID();

  // Field 1: Metadata
  parts.push(writeMessageField(1, buildMetadata(apiKey)));

  // Field 2: repeated ChatMessage (skip system, handled separately)
  let systemPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') +
        (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      continue;
    }

    let source;
    switch (msg.role) {
      case 'user': source = SOURCE.USER; break;
      case 'assistant': source = SOURCE.ASSISTANT; break;
      case 'tool': source = SOURCE.TOOL; break;
      default: source = SOURCE.USER;
    }

    const text = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : JSON.stringify(msg.content);

    parts.push(writeMessageField(2, buildChatMessage(text, source, conversationId)));
  }

  // Field 3: system_prompt_override
  if (systemPrompt) {
    parts.push(writeStringField(3, systemPrompt));
  }

  // Field 4: model enum
  parts.push(writeVarintField(4, modelEnum));

  // Field 5: chat_model_name
  if (modelName) {
    parts.push(writeStringField(5, modelName));
  }

  return Buffer.concat(parts);
}

// ─── RawGetChatMessageResponse parser ──────────────────────

/**
 * Parse a RawGetChatMessageResponse → extract text from RawChatMessage.
 *
 * RawGetChatMessageResponse { RawChatMessage delta_message = 1; }
 * RawChatMessage { ..., string text = 5, bool in_progress = 6, bool is_error = 7 }
 */
export function parseRawResponse(buf) {
  const fields = parseFields(buf);
  const f1 = getField(fields, 1, 2); // delta_message
  if (!f1) return { text: '' };

  const inner = parseFields(f1.value);
  const text = getField(inner, 5, 2);
  const inProgress = getField(inner, 6, 0);
  const isError = getField(inner, 7, 0);

  return {
    text: text ? text.value.toString('utf8') : '',
    inProgress: inProgress ? !!inProgress.value : false,
    isError: isError ? !!isError.value : false,
  };
}

// ─── Panel initialization ─────────────────────────────────

/**
 * Build InitializeCascadePanelStateRequest.
 * Required before Cascade flow — initializes the panel state in the language server.
 *
 * Field 1: metadata
 * Field 2: ExtensionPanelTab enum (4 = CORTEX)
 */
// Field numbers verified by extracting the FileDescriptorProto from
// language_server_linux_x64. Historical layouts are NOT the same — field 2 of
// InitializeCascadePanelState is reserved; workspace_trusted moved to field 3.
export function buildInitializePanelStateRequest(apiKey, sessionId, trusted = true) {
  return Buffer.concat([
    writeMessageField(1, buildMetadata(apiKey, undefined, sessionId)),
    writeBoolField(3, trusted), // workspace_trusted
  ]);
}

// AddTrackedWorkspaceRequest has a single field: workspace (string, filesystem path).
export function buildAddTrackedWorkspaceRequest(apiKey, workspacePath, sessionId) {
  return writeStringField(1, workspacePath);
}

// UpdateWorkspaceTrustRequest { metadata=1, workspace_trusted=2 }. No path — trust is global.
export function buildUpdateWorkspaceTrustRequest(apiKey, _ignored, trusted = true, sessionId) {
  return Buffer.concat([
    writeMessageField(1, buildMetadata(apiKey, undefined, sessionId)),
    writeBoolField(2, trusted),
  ]);
}

// ─── Cascade flow builders ─────────────────────────────────

/**
 * Build StartCascadeRequest.
 * Field 1: metadata
 */
export function buildStartCascadeRequest(apiKey, sessionId) {
  return writeMessageField(1, buildMetadata(apiKey, undefined, sessionId));
}

/**
 * Build SendUserCascadeMessageRequest.
 *
 * Field 1: cascade_id
 * Field 2: items (TextOrScopeItem { text = 1 })
 * Field 3: metadata
 * Field 5: cascade_config
 */
export function buildSendCascadeMessageRequest(apiKey, cascadeId, text, modelEnum, modelUid, sessionId) {
  const parts = [];

  // Field 1: cascade_id
  parts.push(writeStringField(1, cascadeId));

  // Field 2: TextOrScopeItem { text = 1 }
  parts.push(writeMessageField(2, writeStringField(1, text)));

  // Field 3: metadata
  parts.push(writeMessageField(3, buildMetadata(apiKey, undefined, sessionId)));

  // Field 5: cascade_config
  const cascadeConfig = buildCascadeConfig(modelEnum, modelUid);
  parts.push(writeMessageField(5, cascadeConfig));

  return Buffer.concat(parts);
}

function buildCascadeConfig(modelEnum, modelUid) {
  // CascadeConversationalPlannerConfig.planner_mode (field 4) uses
  // codeium_common.ConversationalPlannerMode:
  //   0 UNSPECIFIED  1 DEFAULT  2 READ_ONLY  3 NO_TOOL
  //   4 EXPLORE      5 PLANNING 6 AUTO
  //
  // We pick NO_TOOL (3). DEFAULT keeps the IDE agent loop alive, so even
  // without setting CascadeToolConfig the planner reflexively fires
  // edit_file/view_file, which produces:
  //   - stall_warm bursts (15–25s silent tool-execution trajectory steps)
  //   - "Cascade cannot create /tmp/windsurf-workspace/foo because it already
  //     exists" on request bursts that reuse the same filename
  //   - /tmp/windsurf-workspace path leaks inside the chat body
  // NO_TOOL tells the planner to generate a pure conversational response
  // with no tool_call proposals at all. Client-defined OpenAI tools are
  // still supported via the prompt-level emulation layer in
  // handlers/tool-emulation.js — that doesn't go through this planner mode.
  const conversationalConfig = writeVarintField(4, 3);
  const plannerParts = [
    writeMessageField(2, conversationalConfig),   // conversational = 2
  ];

  if (modelUid) {
    // field 35: requested_model_uid (string)
    plannerParts.push(writeStringField(35, modelUid));
  } else {
    // field 15: requested_model_deprecated (ModelOrAlias { model = 1 })
    plannerParts.push(writeMessageField(15, writeVarintField(1, modelEnum)));
  }

  const plannerConfig = Buffer.concat(plannerParts);

  // BrainConfig: field 1=enabled(true), field 6=update_strategy { dynamic_update(6)={} }
  const brainConfig = Buffer.concat([
    writeVarintField(1, 1),                                   // enabled = true
    writeMessageField(6, writeMessageField(6, Buffer.alloc(0))), // update_strategy.dynamic_update = {}
  ]);

  // CascadeConfig: field 1=planner_config, field 7=brain_config
  return Buffer.concat([
    writeMessageField(1, plannerConfig),
    writeMessageField(7, brainConfig),
  ]);
}

/**
 * Build GetCascadeTrajectoryStepsRequest.
 * Field 1: cascade_id, Field 2: step_offset
 */
export function buildGetTrajectoryStepsRequest(cascadeId, stepOffset = 0) {
  const parts = [writeStringField(1, cascadeId)];
  if (stepOffset > 0) parts.push(writeVarintField(2, stepOffset));
  return Buffer.concat(parts);
}

/**
 * Build GetCascadeTrajectoryRequest.
 * Field 1: cascade_id
 */
export function buildGetTrajectoryRequest(cascadeId) {
  return writeStringField(1, cascadeId);
}

/**
 * Build GetCascadeTrajectoryGeneratorMetadataRequest.
 *
 * Field 1: cascade_id
 * Field 2: generator_metadata_offset (uint32)
 *
 * The response carries real token counts from the generator models
 * (CortexStepGeneratorMetadata.chat_model.usage → ModelUsageStats).
 * CortexStepMetadata.model_usage on the trajectory steps themselves is
 * usually empty — the LS only fills it on this separate RPC.
 */
export function buildGetGeneratorMetadataRequest(cascadeId, offset = 0) {
  const parts = [writeStringField(1, cascadeId)];
  if (offset > 0) parts.push(writeVarintField(2, offset));
  return Buffer.concat(parts);
}

/**
 * Parse GetCascadeTrajectoryGeneratorMetadataResponse → aggregated usage.
 *
 * Response {
 *   repeated CortexStepGeneratorMetadata generator_metadata = 1;
 * }
 * CortexStepGeneratorMetadata {
 *   ChatModelMetadata chat_model = 1;
 *   ...
 * }
 * ChatModelMetadata {
 *   ...
 *   ModelUsageStats usage = 4;
 *   ...
 * }
 * ModelUsageStats {
 *   uint64 input_tokens = 2;
 *   uint64 output_tokens = 3;
 *   uint64 cache_write_tokens = 4;
 *   uint64 cache_read_tokens = 5;
 * }
 *
 * Returns null if nothing reported; otherwise an aggregated
 * {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens} summed
 * across every generator invocation (multi-model trajectories sum).
 */
export function parseGeneratorMetadata(buf) {
  const fields = parseFields(buf);
  const metaEntries = getAllFields(fields, 1).filter(f => f.wireType === 2);
  if (metaEntries.length === 0) return null;

  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  let found = false;

  for (const entry of metaEntries) {
    const gm = parseFields(entry.value);
    const chatModelField = getField(gm, 1, 2); // chat_model
    if (!chatModelField) continue;
    const cm = parseFields(chatModelField.value);
    const usageField = getField(cm, 4, 2); // usage
    if (!usageField) continue;
    const us = parseFields(usageField.value);
    const readUint = (fn) => {
      const f = getField(us, fn, 0);
      return f ? Number(f.value) : 0;
    };
    const inT = readUint(2);
    const outT = readUint(3);
    const cacheW = readUint(4);
    const cacheR = readUint(5);
    if (inT || outT || cacheW || cacheR) {
      inputTokens += inT;
      outputTokens += outT;
      cacheWriteTokens += cacheW;
      cacheReadTokens += cacheR;
      found = true;
    }
  }
  if (!found) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

// ─── Cascade response parsers ──────────────────────────────

/** Parse StartCascadeResponse → cascade_id (field 1). */
export function parseStartCascadeResponse(buf) {
  const fields = parseFields(buf);
  const f1 = getField(fields, 1, 2);
  return f1 ? f1.value.toString('utf8') : '';
}

/** Parse GetCascadeTrajectoryResponse → status (field 2). */
export function parseTrajectoryStatus(buf) {
  const fields = parseFields(buf);
  const f2 = getField(fields, 2, 0);
  return f2 ? f2.value : 0;
}

/**
 * Parse GetCascadeTrajectoryStepsResponse → extract planner response text.
 *
 * Field 1: repeated CortexTrajectoryStep
 *   Step.field 1: type (enum, 15=PLANNER_RESPONSE)
 *   Step.field 4: status (enum, 3=DONE, 8=GENERATING)
 *   Step.field 20: planner_response { field 1: response, field 3: thinking }
 */
export function parseTrajectorySteps(buf) {
  const fields = parseFields(buf);
  const steps = getAllFields(fields, 1).filter(f => f.wireType === 2);
  const results = [];

  for (const step of steps) {
    const sf = parseFields(step.value);
    const typeField = getField(sf, 1, 0);
    const statusField = getField(sf, 4, 0);
    // CortexTrajectoryStep.planner_response = field 20
    // CortexStepPlannerResponse.response = 1, thinking = 3, modified_response = 8
    const plannerField = getField(sf, 20, 2);

    const entry = {
      type: typeField ? typeField.value : 0,
      status: statusField ? statusField.value : 0,
      text: '',
      thinking: '',
      errorText: '',
      toolCalls: [], // [{id, name, argumentsJson, result?}]
      usage: null,  // {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
    };

    // CortexTrajectoryStep.metadata (field 5) → CortexStepMetadata.
    // CortexStepMetadata.model_usage (field 9) → ModelUsageStats.
    // ModelUsageStats:
    //   input_tokens       = 2 (uint64)
    //   output_tokens      = 3 (uint64)
    //   cache_write_tokens = 4 (uint64)
    //   cache_read_tokens  = 5 (uint64)
    // These are server-reported token counts for this step's generator model
    // and map cleanly onto OpenAI `usage.prompt_tokens` / `completion_tokens`
    // / `prompt_tokens_details.cached_tokens` when aggregated across steps.
    const stepMetaField = getField(sf, 5, 2);
    if (stepMetaField) {
      const meta = parseFields(stepMetaField.value);
      const usageField = getField(meta, 9, 2);
      if (usageField) {
        const us = parseFields(usageField.value);
        const readUint = (fn) => {
          const f = getField(us, fn, 0);
          return f ? Number(f.value) : 0;
        };
        const inputTokens = readUint(2);
        const outputTokens = readUint(3);
        const cacheWriteTokens = readUint(4);
        const cacheReadTokens = readUint(5);
        if (inputTokens || outputTokens || cacheReadTokens || cacheWriteTokens) {
          entry.usage = { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens };
        }
      }
    }

    // Tool-call / tool-result sub-messages on CortexTrajectoryStep.
    // Sources: exa.cortex_pb.proto (AlexStrNik/windsurf-api).
    //   45 custom_tool         → CortexStepCustomTool{1=recipe_id,2=args,3=output,4=name}
    //   47 mcp_tool            → CortexStepMcpTool{1=server,2=ChatToolCall,3=result}
    //   49 tool_call_proposal  → {1=ChatToolCall}
    //   50 tool_call_choice    → {1=repeated ChatToolCall, 2=choice, 3=reason}
    // ChatToolCall (codeium_common_pb): 1=id, 2=name, 3=arguments_json
    const parseChatToolCall = (buf) => {
      const f = parseFields(buf);
      const id = getField(f, 1, 2);
      const name = getField(f, 2, 2);
      const args = getField(f, 3, 2);
      return {
        id: id ? id.value.toString('utf8') : '',
        name: name ? name.value.toString('utf8') : '',
        argumentsJson: args ? args.value.toString('utf8') : '',
      };
    };
    const customField = getField(sf, 45, 2);
    if (customField) {
      const cf = parseFields(customField.value);
      const recipeId = getField(cf, 1, 2);
      const argsF = getField(cf, 2, 2);
      const outF = getField(cf, 3, 2);
      const nameF = getField(cf, 4, 2);
      entry.toolCalls.push({
        id: recipeId ? recipeId.value.toString('utf8') : '',
        name: nameF ? nameF.value.toString('utf8') : (recipeId ? recipeId.value.toString('utf8') : 'custom_tool'),
        argumentsJson: argsF ? argsF.value.toString('utf8') : '',
        result: outF ? outF.value.toString('utf8') : '',
      });
    }
    const mcpField = getField(sf, 47, 2);
    if (mcpField) {
      const mf = parseFields(mcpField.value);
      const serverF = getField(mf, 1, 2);
      const callF = getField(mf, 2, 2);
      const resultF = getField(mf, 3, 2);
      if (callF) {
        const tc = parseChatToolCall(callF.value);
        tc.serverName = serverF ? serverF.value.toString('utf8') : '';
        tc.result = resultF ? resultF.value.toString('utf8') : '';
        entry.toolCalls.push(tc);
      }
    }
    const proposalField = getField(sf, 49, 2);
    if (proposalField) {
      const pf = parseFields(proposalField.value);
      const callF = getField(pf, 1, 2);
      if (callF) entry.toolCalls.push(parseChatToolCall(callF.value));
    }
    const choiceField = getField(sf, 50, 2);
    if (choiceField) {
      const cf = parseFields(choiceField.value);
      const chosenIdx = getField(cf, 2, 0);
      const calls = getAllFields(cf, 1).filter(x => x.wireType === 2).map(x => parseChatToolCall(x.value));
      if (calls.length) {
        const idx = chosenIdx ? Number(chosenIdx.value) : 0;
        entry.toolCalls.push(calls[idx] || calls[0]);
      }
    }

    if (plannerField) {
      const pf = parseFields(plannerField.value);
      const textField = getField(pf, 1, 2);
      const modifiedField = getField(pf, 8, 2);
      const thinkField = getField(pf, 3, 2);
      const responseText = textField ? textField.value.toString('utf8') : '';
      const modifiedText = modifiedField ? modifiedField.value.toString('utf8') : '';
      // modified_response is the LS post-pass edited final text (markdown
      // fixups, citations, tool-result folding). On long opus-4 replies the
      // LS writes a short `response` first, then overwrites with a much
      // longer `modified_response` at turn end. Prefer it whenever present
      // so we don't truncate to the early draft.
      entry.text = modifiedText || responseText;
      entry.responseText = responseText;
      entry.modifiedText = modifiedText;
      if (thinkField) entry.thinking = thinkField.value.toString('utf8');
    }

    // Walk CortexErrorDetails. user_error_message, short_error and full_error
    // usually contain the same text at increasing verbosity — pick one.
    const readErrorDetails = (buf) => {
      const ed = parseFields(buf);
      for (const fnum of [1, 2, 3]) {
        const f = getField(ed, fnum, 2);
        if (f) {
          const s = f.value.toString('utf8').trim();
          if (s) return s.split('\n')[0].slice(0, 300);
        }
      }
      return '';
    };

    // Error info lives at either CortexTrajectoryStep.error_message (field 24
    // for ERROR_MESSAGE steps) or CortexTrajectoryStep.error (field 31 for any
    // step). They both wrap CortexErrorDetails. Prefer the step-specific one.
    const errMsgField = getField(sf, 24, 2);
    if (errMsgField) {
      const inner = getField(parseFields(errMsgField.value), 3, 2);
      if (inner) entry.errorText = readErrorDetails(inner.value);
    }
    if (!entry.errorText) {
      const errField = getField(sf, 31, 2);
      if (errField) entry.errorText = readErrorDetails(errField.value);
    }


    results.push(entry);
  }

  return results;
}
