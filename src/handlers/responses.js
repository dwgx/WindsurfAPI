/**
 * POST /v1/responses - OpenAI Responses API compatibility layer.
 *
 * Translates Responses requests to the internal Chat Completions handler and
 * adapts Chat SSE chunks back into Responses SSE events.
 */

import { randomUUID } from 'crypto';
import { handleChatCompletions } from './chat.js';
import { log } from '../config.js';

function genResponseId() {
  return 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function genMessageId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function genFunctionCallId() {
  return 'fc_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function stringifyMaybe(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyMaybe(content);

  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      out.push({ type: 'text', text: part.text || '' });
    } else if (part.type === 'input_image') {
      out.push(part.image_url ? { type: 'image_url', image_url: part.image_url } : part);
    } else {
      out.push(part);
    }
  }
  return out.length ? out : '';
}

function encodeToolName(name, namespace = '') {
  if (!namespace) return name || 'unknown';
  return `${namespace}${name || 'unknown'}`;
}

function flattenResponseTool(tool, inheritedNamespace = '') {
  if (!tool) return [];

  if (tool.type === 'namespace') {
    const namespace = tool.name || tool.namespace || inheritedNamespace || '';
    const children = tool.tools || tool.children || tool.functions || tool.items || [];
    if (!Array.isArray(children)) return [];
    return children.flatMap(child => flattenResponseTool(child, namespace));
  }

  if (tool.type === 'function') {
    const base = tool.function || tool;
    const originalName = base.name || tool.name || 'unknown';
    return [{
      type: 'function',
      function: {
        name: encodeToolName(originalName, inheritedNamespace),
        description: base.description || tool.description || '',
        parameters: base.parameters || tool.parameters || {},
      },
      __response_tool: {
        type: inheritedNamespace ? 'namespace' : 'function',
        namespace: inheritedNamespace || '',
        originalName,
      },
    }];
  }

  if (tool.type === 'custom') {
    const base = tool.function || tool;
    const originalName = base.name || tool.name;
    if (!originalName) return [];
    return [{
      type: 'function',
      function: {
        name: encodeToolName(originalName, inheritedNamespace),
        description: base.description || tool.description || '',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            input: {
              type: 'string',
              description: 'Raw custom tool input.',
            },
          },
          required: ['input'],
        },
      },
      __response_tool: {
        type: 'custom',
        namespace: inheritedNamespace || '',
        originalName,
      },
    }];
  }

  if (tool.type === 'web_search') {
    return [{
      type: 'function',
      function: {
        name: encodeToolName('web_search', inheritedNamespace),
        description: tool.description || 'Search the web.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: {
              type: 'string',
              description: 'Search query.',
            },
          },
          required: ['query'],
        },
      },
      __response_tool: {
        type: 'web_search',
        namespace: inheritedNamespace || '',
        originalName: 'web_search',
      },
    }];
  }

  if (tool.type === 'tool_search') {
    return [{
      type: 'function',
      function: {
        name: encodeToolName('tool_search', inheritedNamespace),
        description: tool.description || 'Search available tools.',
        parameters: {
          type: 'object',
          additionalProperties: true,
          properties: {
            query: {
              type: 'string',
              description: 'Tool search query.',
            },
          },
        },
      },
      __response_tool: {
        type: 'tool_search',
        namespace: inheritedNamespace || '',
        originalName: 'tool_search',
      },
    }];
  }

  throw new Error(`Unsupported Responses tool type: ${tool.type}`);
}

function flattenResponseTools(tools = []) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(tool => flattenResponseTool(tool));
}

function responseItemToolName(item) {
  return encodeToolName(item.name || item.function?.name || 'unknown', item.namespace || '');
}
function normalizeResponseToolChoice(toolChoice) {
  if (toolChoice == null) return toolChoice;
  if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') return toolChoice;
  if (typeof toolChoice !== 'object') return toolChoice;
  if (toolChoice.type === 'web_search' || toolChoice.type === 'tool_search') return 'auto';
  if (toolChoice.type === 'function' && toolChoice.function?.name) {
    return {
      type: 'function',
      function: {
        name: encodeToolName(toolChoice.function.name, toolChoice.function.namespace || toolChoice.namespace || ''),
      },
    };
  }
  if ((toolChoice.type === 'custom' || toolChoice.type === 'namespace') && (toolChoice.name || toolChoice.function?.name)) {
    return {
      type: 'function',
      function: {
        name: encodeToolName(toolChoice.name || toolChoice.function?.name, toolChoice.namespace || toolChoice.function?.namespace || ''),
      },
    };
  }
  return toolChoice;
}


export function responsesToChat(body) {
  const messages = [];
  const flushToolCalls = (() => {
    let pending = [];
    return {
      add(item) {
        pending.push({
          id: item.call_id || item.id || `call_${randomUUID().slice(0, 8)}`,
          type: 'function',
          function: {
            name: item.name || item.function?.name || 'unknown',
            arguments: stringifyMaybe(item.arguments || item.function?.arguments || ''),
          },
        });
      },
      flush() {
        if (!pending.length) return;
        messages.push({ role: 'assistant', content: null, tool_calls: pending });
        pending = [];
      },
    };
  })();

  if (body.instructions) {
    messages.push({ role: 'system', content: stringifyMaybe(body.instructions) });
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'message') {
        flushToolCalls.flush();
        messages.push({
          role: item.role || 'user',
          content: normalizeMessageContent(item.content),
        });
      } else if (item.type === 'function_call') {
        flushToolCalls.add(item);
      } else if (item.type === 'function_call_output') {
        flushToolCalls.flush();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id,
          content: stringifyMaybe(item.output),
        });
      } else if (item.type === 'custom_tool_call') {
        flushToolCalls.add({
          id: item.call_id || item.id,
          name: item.name,
          arguments: JSON.stringify({ input: stringifyMaybe(item.input) }),
        });
      } else if (item.type === 'custom_tool_call_output') {
        flushToolCalls.flush();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id,
          content: stringifyMaybe(item.output),
        });
      }
    }
    flushToolCalls.flush();
  }

  const tools = flattenResponseTools(body.tools || []);
  return {
    model: body.model || 'claude-sonnet-4.6',
    messages,
    stream: !!body.stream,
    ...(body.max_output_tokens != null ? { max_tokens: body.max_output_tokens } : {}),
    ...(body.reasoning?.effort != null ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(tools.length ? { tools } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.tool_choice != null ? { tool_choice: normalizeResponseToolChoice(body.tool_choice) } : {}),
  };
}

function mapUsage(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    total_tokens: usage.total_tokens || (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
  };
}

function textMessageItem(id, text, status = 'completed') {
  return {
    type: 'message',
    id,
    status,
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
  };
}

function reasoningItem(id, text, status = 'completed') {
  return {
    type: 'reasoning',
    id,
    status,
    summary: text ? [{ type: 'summary_text', text }] : [],
  };
}

function functionCallItem(toolCall, status = 'completed', requestedTools = []) {
  const name = toolCall.function?.name || 'unknown';
  const argsText = toolCall.function?.arguments || '';
  const requestedTool = Array.isArray(requestedTools)
    ? requestedTools.find(t => (t?.function?.name || t?.name || (t?.__response_tool?.type === 'web_search' ? 'web_search' : null)) === name)
    : null;
  const responseTool = requestedTool?.__response_tool || null;
  if (responseTool?.type === 'custom') {
    const parsed = safeJsonParse(argsText);
    const input = parsed && typeof parsed === 'object' && parsed.input != null
      ? stringifyMaybe(parsed.input)
      : argsText;
    return {
      type: 'custom_tool_call',
      call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
      name: responseTool.originalName || name,
      ...(responseTool.namespace ? { namespace: responseTool.namespace } : {}),
      input,
      status,
    };
  }
  if (responseTool?.type === 'web_search' || responseTool?.type === 'tool_search') {
    const parsed = safeJsonParse(argsText) || {};
    return {
      type: responseTool.type === 'web_search' ? 'web_search_call' : 'function_call',
      ...(responseTool.type === 'web_search'
        ? { id: toolCall.id || `ws_${randomUUID().replace(/-/g, '').slice(0, 24)}` }
        : {
            id: genFunctionCallId(),
            call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
            name: responseTool.originalName || name,
            ...(responseTool.namespace ? { namespace: responseTool.namespace } : {}),
          }),
      status,
      ...(responseTool.type === 'web_search'
        ? {
            action: {
              type: 'search',
              query: typeof parsed.query === 'string' ? parsed.query : argsText,
            },
          }
        : {
            arguments: argsText,
          }),
    };
  }
  return {
    type: 'function_call',
    id: genFunctionCallId(),
    call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
    name: responseTool?.originalName || name,
    ...(responseTool?.namespace ? { namespace: responseTool.namespace } : {}),
    arguments: argsText,
    status,
  };
}

export function chatToResponse(chatBody, requestedModel, responseId = genResponseId(), msgId = genMessageId(), requestedTools = []) {
  const choice = chatBody.choices?.[0] || {};
  const message = choice.message || {};
  const finishReason = choice.finish_reason || 'stop';
  const text = message.content || '';
  const output = [];
  if (message.reasoning_content) output.push(reasoningItem('rs_' + msgId.slice(4), message.reasoning_content));
  if (text) output.push(textMessageItem(msgId, text));
  for (const tc of (message.tool_calls || [])) output.push(functionCallItem(tc, 'completed', requestedTools));

  return {
    id: responseId,
    object: 'response',
    created_at: chatBody.created || Math.floor(Date.now() / 1000),
    status: finishReason === 'stop' ? 'completed' : 'incomplete',
    model: requestedModel || chatBody.model,
    output,
    usage: mapUsage(chatBody.usage || {}),
  };
}

class ResponsesStreamTranslator {
  constructor(res, responseId, model, requestedTools = []) {
    this.res = res;
    this.responseId = responseId;
    this.model = model;
    this.requestedTools = Array.isArray(requestedTools) ? requestedTools : [];
    this.createdAt = Math.floor(Date.now() / 1000);
    this.msgId = genMessageId();
    this.pendingSseBuf = '';
    this.createdSent = false;
    this.finished = false;
    this.text = '';
    this.messageOutputIndex = null;
    this.messageStarted = false;
    this.textPartStarted = false;
    this.messageDone = false;
    this.reasoningId = 'rs_' + randomUUID().replace(/-/g, '').slice(0, 24);
    this.reasoningOutputIndex = null;
    this.reasoningStarted = false;
    this.reasoningText = '';
    this.reasoningDone = false;
    this.nextOutputIndex = 0;
    this.outputItems = [];
    this.toolCalls = new Map();
    this.finalUsage = {};
    this.sequenceNumber = 0;
  }

  send(event, data) {
    if (!this.res.writableEnded) {
      const payload = { type: event, sequence_number: this.sequenceNumber++, ...data };
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  responseBase(status, output = []) {
    return {
      object: 'response',
      id: this.responseId,
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
    };
  }

  resolveRequestedTool(name) {
    return this.requestedTools.find(t => (t?.function?.name || t?.name || (t?.__response_tool?.type === 'web_search' ? 'web_search' : null)) === name) || null;
  }

  start() {
    if (this.createdSent) return;
    this.createdSent = true;
    this.send('response.created', { response: this.responseBase('in_progress') });
    this.send('response.in_progress', { response: this.responseBase('in_progress') });
  }

  processChunk(chunk) {
    if (chunk.created) this.createdAt = chunk.created;
    if (chunk.model) this.model = chunk.model;
    this.start();

    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.reasoning_content) this.emitReasoningDelta(delta.reasoning_content);
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) this.emitToolCallDelta(tc);
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
  }

  emitReasoningDelta(text) {
    if (!text) return;
    if (!this.reasoningStarted) {
      this.reasoningStarted = true;
      this.reasoningOutputIndex = this.nextOutputIndex++;
      this.send('response.output_item.added', {
        output_index: this.reasoningOutputIndex,
        item: reasoningItem(this.reasoningId, '', 'in_progress'),
      });
    }
    this.reasoningText += text;
    this.send('response.reasoning_summary_text.delta', {
      item_id: this.reasoningId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  finishReasoning() {
    if (!this.reasoningStarted || this.reasoningDone) return;
    this.reasoningDone = true;
    this.send('response.reasoning_summary_text.done', {
      item_id: this.reasoningId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      text: this.reasoningText,
    });
    const complete = reasoningItem(this.reasoningId, this.reasoningText);
    this.send('response.output_item.done', { output_index: this.reasoningOutputIndex, item: complete });
    this.outputItems[this.reasoningOutputIndex] = complete;
  }

  ensureMessage() {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.messageOutputIndex = this.nextOutputIndex++;
    const addedItem = textMessageItem(this.msgId, '', 'in_progress');
    this.send('response.output_item.added', { output_index: this.messageOutputIndex, item: addedItem });
  }

  ensureTextPart() {
    if (this.textPartStarted) return;
    this.ensureMessage();
    this.textPartStarted = true;
    this.send('response.content_part.added', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  emitTextDelta(text) {
    if (!text) return;
    this.ensureTextPart();
    this.text += text;
    this.send('response.output_text.delta', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      delta: text,
    });
  }

  emitToolCallDelta(toolCall) {
    const idx = toolCall.index ?? 0;
    let existing = this.toolCalls.get(idx);
    if (!existing) {
      const outputIndex = this.nextOutputIndex++;
      const name = toolCall.function?.name || 'unknown';
      const requestedTool = this.resolveRequestedTool(name);
      const responseTool = requestedTool?.__response_tool || null;
      const item = responseTool?.type === 'custom'
        ? {
            type: 'custom_tool_call',
            call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
            name: responseTool.originalName || name,
            ...(responseTool.namespace ? { namespace: responseTool.namespace } : {}),
            input: '',
            status: 'in_progress',
          }
        : responseTool?.type === 'web_search'
          ? {
              type: 'web_search_call',
              id: toolCall.id || `ws_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
              status: 'in_progress',
              action: { type: 'search', query: '' },
            }
          : {
            type: 'function_call',
            id: genFunctionCallId(),
            call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
            name: responseTool?.originalName || name,
            ...(responseTool?.namespace ? { namespace: responseTool.namespace } : {}),
            arguments: '',
            status: 'in_progress',
          };
      this.send('response.output_item.added', { output_index: outputIndex, item });
      existing = { item, outputIndex, argChunks: [], done: false, custom: responseTool?.type === 'custom', webSearch: responseTool?.type === 'web_search' || responseTool?.type === 'tool_search' };
      this.toolCalls.set(idx, existing);
    }

    if (toolCall.id) existing.item.call_id = toolCall.id;
    if (toolCall.function?.name) existing.item.name = toolCall.function.name;
    const argsChunk = toolCall.function?.arguments || '';
    if (argsChunk) {
      existing.argChunks.push(argsChunk);
      if (!existing.custom && !existing.webSearch) {
        this.send('response.function_call_arguments.delta', {
          item_id: existing.item.id,
          output_index: existing.outputIndex,
          delta: argsChunk,
        });
      }
    }
  }

  finishToolCalls() {
    const sorted = [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const tc of sorted) {
      if (tc.done) continue;
      tc.done = true;
      const args = tc.argChunks.join('');
      if (tc.custom) {
        const parsed = safeJsonParse(args);
        const input = parsed && typeof parsed === 'object' && parsed.input != null
          ? stringifyMaybe(parsed.input)
          : args;
        const complete = { ...tc.item, input, status: 'completed' };
        this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
        this.outputItems[tc.outputIndex] = complete;
        continue;
      }
      if (tc.item.type === 'web_search_call') {
        const parsed = safeJsonParse(args) || {};
        const complete = {
          ...tc.item,
          status: 'completed',
          action: {
            type: 'search',
            query: typeof parsed.query === 'string' ? parsed.query : args,
          },
        };
        this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
        this.outputItems[tc.outputIndex] = complete;
        continue;
      }
      if (tc.item.type === 'function_call' && tc.item.name === 'tool_search') {
        const complete = { ...tc.item, arguments: args, status: 'completed' };
        this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
        this.outputItems[tc.outputIndex] = complete;
        continue;
      }
      this.send('response.function_call_arguments.done', {
        item_id: tc.item.id,
        output_index: tc.outputIndex,
        arguments: args,
      });
      const complete = { ...tc.item, arguments: args, status: 'completed' };
      this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
      this.outputItems[tc.outputIndex] = complete;
    }
  }

  finishMessage() {
    if (this.messageDone) return;
    this.messageDone = true;
    this.ensureTextPart();
    const donePart = { type: 'output_text', text: this.text, annotations: [] };
    this.send('response.output_text.done', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      text: this.text,
    });
    this.send('response.content_part.done', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: donePart,
    });
    const complete = textMessageItem(this.msgId, this.text);
    this.send('response.output_item.done', { output_index: this.messageOutputIndex, item: complete });
    this.outputItems[this.messageOutputIndex] = complete;
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.start();
    this.finishReasoning();
    this.finishToolCalls();
    if (this.messageStarted || this.text) this.finishMessage();
    this.send('response.completed', {
      response: {
        ...this.responseBase('completed', this.outputItems.filter(Boolean)),
        usage: mapUsage(this.finalUsage),
      },
    });
  }

  error(err) {
    if (this.finished) return;
    this.finished = true;
    this.start();
    this.send('response.failed', {
      response: {
        ...this.responseBase('failed', this.outputItems.filter(Boolean)),
        error: {
          message: err?.message || 'Upstream stream error',
          type: err?.type || 'upstream_error',
          code: err?.code || null,
        },
      },
    });
  }

  feed(rawChunk) {
    this.pendingSseBuf += typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8');
    let idx;
    while ((idx = this.pendingSseBuf.indexOf('\n\n')) !== -1) {
      const frame = this.pendingSseBuf.slice(0, idx);
      this.pendingSseBuf = this.pendingSseBuf.slice(idx + 2);
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) {
            this.error(parsed.error);
          } else {
            this.processChunk(parsed);
          }
        } catch (e) {
          log.warn(`Responses SSE parse error: ${e.message}`);
        }
      }
    }
  }
}

function createCaptureRes(translator, realRes) {
  const listeners = new Map();
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) { try { cb(); } catch {} }
  };
  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (str.startsWith(':') && realRes && !realRes.writableEnded) {
        try { realRes.write(str); } catch {}
      }
      translator.feed(chunk);
      return true;
    },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) translator.feed(chunk);
      translator.finish();
      this.writableEnded = true;
      fire('close');
    },
    _clientDisconnected() { fire('close'); },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    once(event, cb) {
      const self = this;
      const wrapped = function onceWrapper() {
        self.off(event, wrapped);
        cb.apply(self, arguments);
      };
      return self.on(event, wrapped);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
      return this;
    },
    removeListener(event, cb) { return this.off(event, cb); },
    emit() { return true; },
  };
}

export async function handleResponses(body, deps = {}) {
  const chatHandler = deps.handleChatCompletions || handleChatCompletions;
  const context = deps.context || {};
  const responseId = genResponseId();
  const requestedModel = body.model || 'claude-sonnet-4.6';
  let chatBody;
  try {
    chatBody = responsesToChat(body);
  } catch (err) {
    return {
      status: 400,
      body: {
        error: {
          message: err?.message || 'Invalid Responses request',
          type: 'invalid_request_error',
        },
      },
    };
  }

  if (!body.stream) {
    const result = await chatHandler({ ...chatBody, stream: false }, context);
    if (result.status !== 200) return result;
    return { status: 200, body: chatToResponse(result.body, requestedModel, responseId, genMessageId(), body.tools || []) };
  }

  const streamResult = await chatHandler({ ...chatBody, stream: true }, context);
  if (!streamResult.stream) return streamResult;

  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(realRes) {
      const translator = new ResponsesStreamTranslator(realRes, responseId, requestedModel, body.tools || []);
      const captureRes = createCaptureRes(translator, realRes);

      realRes.on('close', () => {
        if (!captureRes.writableEnded) captureRes._clientDisconnected();
      });

      try {
        await streamResult.handler(captureRes);
      } catch (e) {
        log.error(`Responses stream error: ${e.message}`);
        translator.error(e);
      }

      if (!realRes.writableEnded) realRes.end();
    },
  };
}
