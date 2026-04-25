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

function responseToolToChatTool(tool) {
  if (!tool || tool.type !== 'function') return null; // TODO: map web_search and other Responses-native tools.
  if (tool.function) return tool;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || {},
    },
  };
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
      }
    }
    flushToolCalls.flush();
  }

  const tools = (body.tools || []).map(responseToolToChatTool).filter(Boolean);
  return {
    model: body.model || 'claude-sonnet-4.6',
    messages,
    stream: !!body.stream,
    ...(body.max_output_tokens != null ? { max_tokens: body.max_output_tokens } : {}),
    ...(body.reasoning?.effort != null ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(tools.length ? { tools } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.tool_choice != null ? { tool_choice: body.tool_choice } : {}),
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

function functionCallItem(toolCall, status = 'completed') {
  return {
    type: 'function_call',
    id: genFunctionCallId(),
    call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
    name: toolCall.function?.name || 'unknown',
    arguments: toolCall.function?.arguments || '',
    status,
  };
}

export function chatToResponse(chatBody, requestedModel, responseId = genResponseId(), msgId = genMessageId()) {
  const choice = chatBody.choices?.[0] || {};
  const message = choice.message || {};
  const finishReason = choice.finish_reason || 'stop';
  const text = message.content || '';
  const output = [textMessageItem(msgId, text)];
  for (const tc of (message.tool_calls || [])) output.push(functionCallItem(tc));

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
  constructor(res, responseId, model) {
    this.res = res;
    this.responseId = responseId;
    this.model = model;
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
    this.nextOutputIndex = 0;
    this.outputItems = [];
    this.toolCalls = new Map();
    this.finalUsage = {};
  }

  send(event, data) {
    if (!this.res.writableEnded) {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
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

  start() {
    if (this.createdSent) return;
    this.createdSent = true;
    this.send('response.created', this.responseBase('in_progress'));
  }

  processChunk(chunk) {
    if (chunk.created) this.createdAt = chunk.created;
    if (chunk.model) this.model = chunk.model;
    this.start();

    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) this.emitToolCallDelta(tc);
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
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
      const item = {
        type: 'function_call',
        id: genFunctionCallId(),
        call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
        name: toolCall.function?.name || 'unknown',
        arguments: '',
        status: 'in_progress',
      };
      this.send('response.output_item.added', { output_index: outputIndex, item });
      existing = { item, outputIndex, argChunks: [], done: false };
      this.toolCalls.set(idx, existing);
    }

    if (toolCall.id) existing.item.call_id = toolCall.id;
    if (toolCall.function?.name) existing.item.name = toolCall.function.name;
    const argsChunk = toolCall.function?.arguments || '';
    if (argsChunk) {
      existing.argChunks.push(argsChunk);
      this.send('response.function_call_arguments.delta', {
        item_id: existing.item.id,
        output_index: existing.outputIndex,
        delta: argsChunk,
      });
    }
  }

  finishToolCalls() {
    const sorted = [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const tc of sorted) {
      if (tc.done) continue;
      tc.done = true;
      const args = tc.argChunks.join('');
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
    this.finishToolCalls();
    this.finishMessage();
    this.send('response.completed', {
      ...this.responseBase('completed', this.outputItems.filter(Boolean)),
      usage: mapUsage(this.finalUsage),
    });
  }

  error(err) {
    if (this.finished) return;
    this.finished = true;
    this.start();
    this.send('error', {
      error: {
        message: err?.message || 'Upstream stream error',
        type: err?.type || 'upstream_error',
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
          this.processChunk(JSON.parse(payload));
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
  const responseId = genResponseId();
  const requestedModel = body.model || 'claude-sonnet-4.6';
  const chatBody = responsesToChat(body);

  if (!body.stream) {
    const result = await chatHandler({ ...chatBody, stream: false });
    if (result.status !== 200) return result;
    return { status: 200, body: chatToResponse(result.body, requestedModel, responseId) };
  }

  const streamResult = await chatHandler({ ...chatBody, stream: true });
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
      const translator = new ResponsesStreamTranslator(realRes, responseId, requestedModel);
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
