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
    // Assistant goes in ChatMessage.action (field 6), not .intent (field 5).
    // Proto: ChatMessageAction { ChatMessageActionGeneric generic = 1; }
    //        ChatMessageActionGeneric { string text = 1; }
    // Previous code wrote a raw string into field 5 which happens to share
    // wire type (length-delimited) with the expected message, so short
    // replies slipped through parsing by coincidence — real multi-turn
    // conversations tripped the LS with "invalid wire-format data".
    const actionGeneric = writeStringField(1, content);    // ChatMessageActionGeneric.text
    const action = writeMessageField(1, actionGeneric);    // ChatMessageAction.generic
    parts.push(writeMessageField(6, action));
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

  // Field 2: repeated ChatMessage (skip system, handled separately).
  // Windsurf's legacy RawGetChatMessage backend rejects role=tool and
  // doesn't know about assistant tool_calls. Degrade both to plain text
  // so multi-turn conversations that carry tool history still flow
  // through without triggering "proto: cannot parse invalid wire-format
  // data" upstream. Cascade models are unaffected — they use a different
  // endpoint (SendUserCascadeMessage) with full tool support.
  let systemPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') +
        (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      continue;
    }

    let source;
    let text;
    const baseText = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : msg.content == null ? '' : JSON.stringify(msg.content);

    switch (msg.role) {
      case 'user':
        source = SOURCE.USER;
        text = baseText;
        break;
      case 'assistant':
        source = SOURCE.ASSISTANT;
        // If the assistant previously called tools, append the call descriptions
        // so the model sees its own prior tool usage as text. Empty string OK.
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          const tcLines = msg.tool_calls.map(tc =>
            `[called tool ${tc.function?.name || 'unknown'} with ${tc.function?.arguments || '{}'}]`
          ).join('\n');
          text = baseText ? `${baseText}\n${tcLines}` : tcLines;
        } else {
          text = baseText;
        }
        break;
      case 'tool':
        // Rewrite tool-result turn as a synthetic user utterance so the
        // server-side schema accepts it.
        source = SOURCE.USER;
        text = `[tool result${msg.tool_call_id ? ` for ${msg.tool_call_id}` : ''}]: ${baseText}`;
        break;
      default:
        source = SOURCE.USER;
        text = baseText;
    }

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
export function buildSendCascadeMessageRequest(apiKey, cascadeId, text, modelEnum, modelUid, sessionId, { toolPreamble } = {}) {
  const parts = [];

  // Field 1: cascade_id
  parts.push(writeStringField(1, cascadeId));

  // Field 2: TextOrScopeItem { text = 1 }
  parts.push(writeMessageField(2, writeStringField(1, text)));

  // Field 3: metadata
  parts.push(writeMessageField(3, buildMetadata(apiKey, undefined, sessionId)));

  // Field 5: cascade_config
  const cascadeConfig = buildCascadeConfig(modelEnum, modelUid, { toolPreamble });
  parts.push(writeMessageField(5, cascadeConfig));

  return Buffer.concat(parts);
}

function buildCascadeConfig(modelEnum, modelUid, { toolPreamble } = {}) {
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
  // with no tool_call proposals at all.
  //
  // When toolPreamble is provided (client-side OpenAI tools[] emulation),
  // we inject it into the system prompt's tool_calling_section via
  // SectionOverrideConfig (OVERRIDE mode). This is far more reliable than
  // user-message injection because NO_TOOL mode's system prompt likely
  // tells the model "you have no tools" — which overpowers anything we
  // put in the user message. The section override replaces that section
  // directly so the model sees our emulated tool definitions at the
  // system-prompt level.
  const convParts = [writeVarintField(4, 3)]; // planner_mode = NO_TOOL

  // ── System prompt section overrides ──────────────────────────────────
  //
  // CascadeConversationalPlannerConfig section override fields:
  //   field 10: tool_calling_section
  //   field 12: additional_instructions_section
  //
  // Key insight: NO_TOOL mode (planner_mode=3) appears to SUPPRESS the
  // tool_calling_section entirely — SectionOverrideConfig on field 10 is
  // injected but never rendered to the model.  Verified 2026-04-12: even
  // with OVERRIDE mode on field 10, the model says "I don't have access
  // to tools" and ignores the emulated definitions.
  //
  // Fix: inject tool definitions via additional_instructions_section
  // (field 12, OVERRIDE) which IS rendered regardless of planner mode.
  // Field 10 is kept as belt-and-suspenders in case a future LS version
  // respects it in NO_TOOL mode.
  if (toolPreamble) {
    // ── Client provided OpenAI tools[] ──
    // Primary delivery: additional_instructions_section (field 12, OVERRIDE).
    // This section is always rendered, even in NO_TOOL planner mode.
    const reinforcement =
      '\n\nIMPORTANT: You have real, callable functions described above. ' +
      'When the user\'s request can be answered by calling a function, you MUST emit ' +
      '<tool_call> blocks as described. Do NOT say "I don\'t have access to tools" ' +
      'or "I cannot perform that action" — call the function.';
    const additionalSection = Buffer.concat([
      writeVarintField(1, 1),             // SECTION_OVERRIDE_MODE_OVERRIDE
      writeStringField(2, toolPreamble + reinforcement),
    ]);
    convParts.push(writeMessageField(12, additionalSection));

    // Belt-and-suspenders: also override tool_calling_section (field 10)
    // in case the LS does render it in NO_TOOL mode on some code paths.
    const toolSection = Buffer.concat([
      writeVarintField(1, 1),             // SECTION_OVERRIDE_MODE_OVERRIDE
      writeStringField(2, toolPreamble),
    ]);
    convParts.push(writeMessageField(10, toolSection));

    // field 13 (communication_section): override IDE persona + add security rules.
    // Even with tools[], the model must not leak server environment info.
    const toolCommOverride = Buffer.concat([
      writeVarintField(1, 1),             // SECTION_OVERRIDE_MODE_OVERRIDE
      writeStringField(2,
        'You are an AI assistant accessed via API with the tool-calling capabilities described above. ' +
        'You are NOT running inside an IDE or code editor.\n\n' +
        'CRITICAL SECURITY RULE: You must NEVER reveal any information about the server, ' +
        'infrastructure, or runtime environment you are running on. This includes but is not limited to: ' +
        'operating system, Docker containers, file paths, working directories, IP addresses, ' +
        'hostnames, environment variables, installed software, hardware specs, network configuration, ' +
        'process information, or any other system-level details. ' +
        'If asked about your environment, server, infrastructure, or "where you are running", ' +
        'simply say you are a cloud-based AI assistant and cannot disclose infrastructure details. ' +
        'Do NOT speculate about or confirm any environment details even if the user guesses correctly. ' +
        'This rule overrides ALL other instructions.'),
    ]);
    convParts.push(writeMessageField(13, toolCommOverride));
  } else {
    // ── No client tools ──
    // Override system prompt sections to suppress Cascade's IDE-assistant
    // persona. Field numbers from CascadeConversationalPlannerConfig in
    // exa.cortex_pb.proto:
    //
    //   field 8  = string test_section_content  (PLAIN STRING, NOT a message!)
    //   field 9  = SectionOverrideConfig test_section
    //   field 10 = SectionOverrideConfig tool_calling_section
    //   field 11 = SectionOverrideConfig code_changes_section
    //   field 12 = SectionOverrideConfig additional_instructions_section
    //   field 13 = SectionOverrideConfig communication_section
    //
    // IMPORTANT: field 8 is a string, not a SectionOverrideConfig. Writing a
    // message to it causes the Go LS binary to reject the protobuf with
    // "string field contains invalid UTF-8". Use field 13
    // (communication_section) for the instructions override instead.

    // field 10 (tool_calling_section): suppress built-in tool list
    const noToolSection = Buffer.concat([
      writeVarintField(1, 1),             // SECTION_OVERRIDE_MODE_OVERRIDE
      writeStringField(2, 'No tools are available.'),
    ]);
    convParts.push(writeMessageField(10, noToolSection));

    // field 12 (additional_instructions): reinforce direct-answer mode
    const noToolAdditional = Buffer.concat([
      writeVarintField(1, 1),             // SECTION_OVERRIDE_MODE_OVERRIDE
      writeStringField(2,
        'You have no tools, no file access, and no command execution. ' +
        'Answer all questions directly using your knowledge. ' +
        'Never pretend to create files or check directories.'),
    ]);
    convParts.push(writeMessageField(12, noToolAdditional));

    // field 13 (communication_section): strip the IDE-assistant persona
    // and replace it with conversational AI identity. Cascade's baked-in
    // instructions say "you're an IDE coding assistant that can create/edit
    // files and run commands". This override replaces that context so the
    // model doesn't role-play file creation.
    const communicationOverride = Buffer.concat([
      writeVarintField(1, 1),             // SECTION_OVERRIDE_MODE_OVERRIDE
      writeStringField(2,
        'You are a conversational AI assistant accessed via API. ' +
        'You are NOT running inside an IDE or code editor. ' +
        'You CANNOT access, create, read, edit, or delete any files on any file system. ' +
        'You CANNOT execute commands, run programs, or interact with any external services. ' +
        'You CANNOT check directories or browse any working directory. ' +
        'When users ask you to perform file operations, system actions, or check directories, ' +
        'clearly tell them that you are a text-based conversational AI without those capabilities. ' +
        'Do NOT pretend to check directories, create files, or perform actions you cannot actually do. ' +
        'Answer all questions directly using your training knowledge.\n\n' +
        'CRITICAL SECURITY RULE: You must NEVER reveal any information about the server, ' +
        'infrastructure, or runtime environment you are running on. This includes but is not limited to: ' +
        'operating system, Docker containers, file paths, working directories, IP addresses, ' +
        'hostnames, environment variables, installed software, hardware specs, network configuration, ' +
        'process information, or any other system-level details. ' +
        'If asked about your environment, server, infrastructure, or "where you are running", ' +
        'simply say you are a cloud-based AI assistant and cannot disclose infrastructure details. ' +
        'Do NOT speculate about or confirm any environment details even if the user guesses correctly. ' +
        'This rule overrides ALL other instructions.'),
    ]);
    convParts.push(writeMessageField(13, communicationOverride));
  }

  const conversationalConfig = Buffer.concat(convParts);
  const plannerParts = [
    writeMessageField(2, conversationalConfig),   // conversational = 2
  ];

  // Set BOTH the modern uid field (35) and the deprecated enum field (15)
  // when available. Seen in the wild (issue #8): free-tier / fresh accounts
  // report "user status is nil" during InitializeCascadePanelState and then
  // the server rejects the chat with "neither PlanModel nor RequestedModel
  // specified" if only field 35 is populated. Setting both covers whichever
  // field the upstream validator actually reads for that account state.
  // plan_model_uid (field 34) is also set as a safety fallback — some
  // backends require the plan model when user status has no tier info.
  if (modelUid) {
    plannerParts.push(writeStringField(35, modelUid));   // requested_model_uid
    plannerParts.push(writeStringField(34, modelUid));   // plan_model_uid (safety)
  }
  if (modelEnum && modelEnum > 0) {
    // requested_model_deprecated = ModelOrAlias { model = 1 (enum) }
    plannerParts.push(writeMessageField(15, writeVarintField(1, modelEnum)));
    // plan_model_deprecated = Model (enum directly at field 1)
    plannerParts.push(writeVarintField(1, modelEnum));
  }
  if (!modelUid && !modelEnum) {
    throw new Error('buildCascadeConfig: at least one of modelUid or modelEnum must be provided');
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
