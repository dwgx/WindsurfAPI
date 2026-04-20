/**
 * POST /v1/messages — Anthropic Messages API compatibility layer.
 * Translates Anthropic request/response format to internal OpenAI format
 * so Claude Code and other Anthropic SDK clients can connect directly.
 */

import { randomUUID } from 'crypto';
import { handleChatCompletions } from './chat.js';

function genMsgId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(b => b.text || '').join('\n')
        : '';
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  for (const m of (body.messages || [])) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const parts = [];
      const toolResults = [];
      for (const block of m.content) {
        if (block.type === 'text') parts.push(block.text || '');
        else if (block.type === 'tool_use' && role === 'assistant') {
          if (!messages.length || messages[messages.length - 1].role !== 'assistant') {
            messages.push({ role: 'assistant', content: null, tool_calls: [] });
          }
          const last = messages[messages.length - 1];
          if (!last.tool_calls) last.tool_calls = [];
          last.tool_calls.push({
            id: block.id || `call_${randomUUID().slice(0, 8)}`,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        } else if (block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(b => b.text || '').join('\n')
              : JSON.stringify(block.content);
          toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
        }
      }
      if (parts.length && role === 'assistant' && messages.length && messages[messages.length - 1].tool_calls) {
        messages[messages.length - 1].content = parts.join('\n');
      } else if (parts.length) {
        messages.push({ role, content: parts.join('\n') });
      }
      for (const tr of toolResults) messages.push(tr);
    }
  }
  const tools = (body.tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || {},
    },
  }));
  return {
    model: body.model || 'claude-sonnet-4.6',
    messages,
    max_tokens: body.max_tokens || 8192,
    stream: !!body.stream,
    ...(tools.length ? { tools } : {}),
  };
}

function openAIToAnthropic(result, model, msgId) {
  const choice = result.choices?.[0];
  const usage = result.usage || {};
  const content = [];
  if (choice?.message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: choice.message.reasoning_content });
  }
  if (choice?.message?.tool_calls?.length) {
    if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name || 'unknown',
        input: JSON.parse(tc.function?.arguments || '{}'),
      });
    }
  } else {
    content.push({ type: 'text', text: choice?.message?.content || '' });
  }
  const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    content,
    model: model || result.model,
    stop_reason: stopMap[choice?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
    },
  };
}

export async function handleMessages(body) {
  const msgId = genMsgId();
  const requestedModel = body.model || 'claude-sonnet-4.6';
  const wantStream = !!body.stream;
  const openaiBody = anthropicToOpenAI(body);

  if (!wantStream) {
    const result = await handleChatCompletions({ ...openaiBody, stream: false });
    if (result.status !== 200) {
      return {
        status: result.status,
        body: {
          type: 'error',
          error: {
            type: result.body?.error?.type || 'api_error',
            message: result.body?.error?.message || 'Unknown error',
          },
        },
      };
    }
    return { status: 200, body: openAIToAnthropic(result.body, requestedModel, msgId) };
  }

  const nonStreamResult = await handleChatCompletions({ ...openaiBody, stream: false });

  if (nonStreamResult.status !== 200) {
    return {
      status: nonStreamResult.status,
      body: {
        type: 'error',
        error: {
          type: nonStreamResult.body?.error?.type || 'api_error',
          message: nonStreamResult.body?.error?.message || 'Unknown error',
        },
      },
    };
  }

  const full = openAIToAnthropic(nonStreamResult.body, requestedModel, msgId);

  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
    handler(res) {
      const send = (event, data) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('message_start', {
        type: 'message_start',
        message: { ...full, content: [], usage: { ...full.usage, output_tokens: 0 } },
      });

      let blockIdx = 0;
      for (const block of full.content) {
        if (block.type === 'thinking') {
          send('content_block_start', {
            type: 'content_block_start', index: blockIdx,
            content_block: { type: 'thinking', thinking: '' },
          });
          const chunks = chunkText(block.thinking, 80);
          for (const chunk of chunks) {
            send('content_block_delta', {
              type: 'content_block_delta', index: blockIdx,
              delta: { type: 'thinking_delta', thinking: chunk },
            });
          }
          send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
        } else if (block.type === 'text') {
          send('content_block_start', {
            type: 'content_block_start', index: blockIdx,
            content_block: { type: 'text', text: '' },
          });
          const chunks = chunkText(block.text, 80);
          for (const chunk of chunks) {
            send('content_block_delta', {
              type: 'content_block_delta', index: blockIdx,
              delta: { type: 'text_delta', text: chunk },
            });
          }
          send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
        } else if (block.type === 'tool_use') {
          send('content_block_start', {
            type: 'content_block_start', index: blockIdx,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          });
          const jsonStr = JSON.stringify(block.input);
          const chunks = chunkText(jsonStr, 80);
          for (const chunk of chunks) {
            send('content_block_delta', {
              type: 'content_block_delta', index: blockIdx,
              delta: { type: 'input_json_delta', partial_json: chunk },
            });
          }
          send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
        }
      }

      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: full.stop_reason, stop_sequence: null },
        usage: { output_tokens: full.usage.output_tokens },
      });
      send('message_stop', { type: 'message_stop' });
      if (!res.writableEnded) res.end();
    },
  };
}

function chunkText(text, size) {
  if (!text) return [''];
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length ? chunks : [''];
}
