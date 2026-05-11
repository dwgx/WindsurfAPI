/**
 * Minimal Codex/OpenAI Responses WebSocket facade.
 *
 * Upstream Windsurf is still served through the existing HTTP/SSE Responses
 * adapter. This layer speaks downstream WebSocket so Codex-style clients can
 * send `response.create` frames and receive Responses event JSON frames.
 */

import { createHash, randomUUID } from 'crypto';
import { handleResponses } from './handlers/responses.js';
import { validateApiKey, isAuthenticated } from './auth.js';
import { callerKeyFromRequest } from './caller-key.js';
import { getCodexSettings } from './runtime-config.js';
import { log } from './config.js';

let handleResponsesImpl = handleResponses;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PATHS = new Set([
  '/v1/responses',
  '/v1/ws/responses',
  '/backend-api/codex/responses',
]);
const MAX_WS_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_WS_BUFFER_BYTES = MAX_WS_FRAME_BYTES + 14;
const MAX_WS_FRAGMENTS = 4096;
const WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const WS_PARTIAL_TIMEOUT_MS = 30 * 1000;
const TURN_STATE_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const RESPONSE_OWNER_MAX = 5000;
const RESPONSE_OWNER_TTL_MS = 6 * 60 * 60 * 1000;
const _responseOwners = new Map();

class WebSocketProtocolError extends Error {
  constructor(message, closeCode = 1002) {
    super(message);
    this.closeCode = closeCode;
  }
}

function extractToken(req) {
  const authHeader = String(req.headers['authorization'] || '').trim();
  if (authHeader && authHeader.includes(',')) return '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const apiKey = req.headers['x-api-key'];
  return Array.isArray(apiKey) ? apiKey[0] : String(apiKey || '');
}

function safeHttpHeaderLines(headers) {
  return Object.entries(headers)
    .filter(([k, v]) => HEADER_NAME_RE.test(k) && !/[\r\n]/.test(String(v)))
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
}

function httpReject(socket, status, message, headers = {}) {
  const body = JSON.stringify({ error: { message } });
  const extraHeaders = safeHttpHeaderLines(headers);
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + extraHeaders
    + 'Connection: close\r\n\r\n'
    + body
  );
  socket.destroy();
}

function acceptKey(secKey) {
  return createHash('sha1').update(secKey + WS_GUID).digest('base64');
}

function headerHasToken(value, token) {
  return String(value || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .includes(token);
}

function isValidSecWebSocketKey(key) {
  if (typeof key !== 'string') return false;
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  try {
    const raw = Buffer.from(key, 'base64');
    return raw.length === 16;
  } catch {
    return false;
  }
}

function nextTurnState() {
  return `turn_${randomUUID().replace(/-/g, '')}`;
}

function normalizeTurnState(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const turnState = String(raw || '').trim();
  return TURN_STATE_RE.test(turnState) ? turnState : nextTurnState();
}

function canWrite(socket) {
  return !socket.destroyed && socket.writableEnded !== true && socket.writable !== false;
}

function sendFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (!canWrite(socket)) return false;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, body]));
  return true;
}

function sendText(socket, payload) {
  return sendFrame(socket, 0x1, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function sendClose(socket, code = 1000, reason = '') {
  const reasonBuf = Buffer.from(String(reason)).subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  try { sendFrame(socket, 0x8, payload); } catch {}
  socket.end();
}

function parseFrames(state, chunk, { requireMasked = false } = {}) {
  if (chunk && chunk.length) {
    state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : chunk;
    if (state.buffer.length > MAX_WS_BUFFER_BYTES) {
      throw new WebSocketProtocolError('WebSocket frame too large', 1009);
    }
  }
  const frames = [];
  while (state.buffer.length >= 2) {
    const b0 = state.buffer[0];
    const b1 = state.buffer[1];
    const fin = !!(b0 & 0x80);
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f;
    let offset = 2;
    if (rsv) throw new WebSocketProtocolError('Unsupported WebSocket extension bits');
    if (requireMasked && !masked) throw new WebSocketProtocolError('Client WebSocket frames must be masked');
    if ((opcode >= 0x3 && opcode <= 0x7) || opcode > 0xA) throw new WebSocketProtocolError('Reserved WebSocket opcode');
    if (len === 126) {
      if (state.buffer.length < offset + 2) break;
      len = state.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (state.buffer.length < offset + 8) break;
      const big = state.buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebSocketProtocolError('WebSocket frame too large', 1009);
      len = Number(big);
      offset += 8;
    }
    if (len > MAX_WS_FRAME_BYTES) throw new WebSocketProtocolError('WebSocket frame too large', 1009);
    if (opcode >= 0x8) {
      if (!fin) throw new WebSocketProtocolError('Fragmented control frame');
      if (len > 125) throw new WebSocketProtocolError('Control frame too large');
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (state.buffer.length < offset + len) break;
    let payload = state.buffer.subarray(offset, offset + len);
    if (masked) {
      const mask = state.buffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ fin, opcode, payload });
    state.buffer = state.buffer.subarray(offset + len);
  }
  return frames;
}

function normalizeSocketPayload(opcode, payload) {
  if (opcode !== 0x1 && opcode !== 0x2) return null;
  let text;
  try {
    text = opcode === 0x1 ? UTF8_DECODER.decode(payload) : payload.toString('utf8');
  } catch {
    throw new WebSocketProtocolError('Invalid UTF-8 in WebSocket text frame', 1007);
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorPayload(message, type = 'invalid_request_error', extra = {}) {
  return { message, type, ...extra };
}

function sendErrorEvent(socket, status, error) {
  sendText(socket, {
    type: 'error',
    status,
    error: error || errorPayload('Invalid request'),
  });
}

function normalizeResponseCreatePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type !== 'response.create') return null;
  const source = payload.response && typeof payload.response === 'object'
    ? payload.response
    : payload;
  const out = { ...source };
  delete out.type;
  delete out.event_id;
  out.stream = true;
  return out.input == null ? null : out;
}

function normalizeUsage(usage = {}) {
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? (input + output);
  if (!input && !output && !total) return null;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

function pruneResponseOwners(now = Date.now()) {
  for (const [id, entry] of _responseOwners) {
    if (!entry || now - (entry.updatedAt || 0) > RESPONSE_OWNER_TTL_MS) _responseOwners.delete(id);
  }
  while (_responseOwners.size > RESPONSE_OWNER_MAX) {
    const oldest = _responseOwners.keys().next().value;
    if (!oldest) break;
    _responseOwners.delete(oldest);
  }
}

function getResponseOwner(responseId, callerKey) {
  if (!responseId) return null;
  pruneResponseOwners();
  const owner = _responseOwners.get(responseId);
  if (!owner) return null;
  if (owner.callerKey && callerKey && owner.callerKey !== callerKey) return null;
  return owner;
}

function rememberResponseOwner(responseId, accountId, callerKey, model) {
  if (!responseId || !accountId) return;
  _responseOwners.set(responseId, {
    accountId,
    callerKey: callerKey || '',
    model: model || '',
    updatedAt: Date.now(),
  });
  pruneResponseOwners();
}

function logWebSocketRequest(summary) {
  const payload = {
    transport: 'websocket',
    request_id: summary.requestId || null,
    model: summary.model || null,
    status: summary.status || 'unknown',
    latency_ms: summary.latencyMs || 0,
    account_id: summary.accountId || null,
    usage: summary.usage || null,
    error: summary.error || null,
  };
  log.info(`ResponsesWS ${JSON.stringify(payload)}`);
}

function responseCallerKey(req, apiKey, body) {
  const scopedBody = body && typeof body === 'object' ? { ...body } : null;
  if (scopedBody) delete scopedBody.previous_response_id;
  return callerKeyFromRequest(req, apiKey, scopedBody);
}

function captureResponseEvent(payload, capture) {
  if (!payload || typeof payload !== 'object' || !capture) return;
  if (payload?.response?.id) capture.responseId = payload.response.id;
  if (payload?.response?.created_at) capture.createdAt = payload.response.created_at;
  if (payload?.response?.model) capture.model = payload.response.model;
  const usage = normalizeUsage(payload?.response?.usage);
  if (usage) capture.usage = usage;
  if (payload.type === 'response.completed') capture.completed = true;
  if (payload.type === 'error') {
    capture.failed = true;
    capture.error = payload?.error?.message || 'Response failed';
  }
  if (payload.type === 'response.failed') {
    capture.failed = true;
    capture.error = payload?.response?.error?.message || payload?.error?.message || 'Response failed';
  }
}

function streamFailureEvent(capture, model, message, code = 'stream_incomplete') {
  return {
    type: 'response.failed',
    response: {
      id: capture.responseId,
      object: 'response',
      created_at: capture.createdAt || Math.floor(Date.now() / 1000),
      status: 'failed',
      model: capture.model || model || '',
      error: {
        code,
        message,
        type: 'server_error',
      },
    },
  };
}

function createSseToWebSocketSink(socket, { onEvent } = {}) {
  const listeners = new Map();
  let pending = '';
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) { try { cb(); } catch {} }
  };
  const feed = (chunk) => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx;
    while ((idx = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, idx);
      pending = pending.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (!data || data === '[DONE]') continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          sendErrorEvent(socket, 502, errorPayload('Invalid upstream event', 'server_error'));
          continue;
        }
        if (payload?.type === 'error' && payload.status == null) payload.status = 502;
        try { onEvent?.(payload); } catch {}
        sendText(socket, payload);
      }
    }
  };
  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    setHeader() {},
    write(chunk) { if (!this.writableEnded) feed(chunk); return true; },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) feed(chunk);
      this.writableEnded = true;
      fire('close');
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    once(event, cb) {
      const wrapped = (...args) => { this.off(event, wrapped); cb(...args); };
      return this.on(event, wrapped);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (arr) {
        const i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      }
      return this;
    },
    removeListener(event, cb) { return this.off(event, cb); },
    _clientDisconnected() { fire('close'); },
  };
}

async function handleResponseCreate(socket, req, payload, context) {
  const startedAt = Date.now();
  const responsesPayload = normalizeResponseCreatePayload(payload);
  const requestId = payload?.event_id || payload?.id || null;
  if (!responsesPayload) {
    sendErrorEvent(socket, 400, errorPayload('Expected response.create payload with type "response.create" and input'));
    logWebSocketRequest({
      requestId,
      model: payload?.model || payload?.response?.model || null,
      status: 400,
      latencyMs: Date.now() - startedAt,
      error: 'invalid_response_create',
    });
    return;
  }

  const apiKey = context.apiKey || extractToken(req);
  const callerKey = responseCallerKey(req, apiKey, responsesPayload);
  const requestContext = { ...context, callerKey };
  const previousResponseId = responsesPayload.previous_response_id;
  if (previousResponseId) {
    const previousOwner = getResponseOwner(previousResponseId, callerKey);
    if (!previousOwner) {
      sendErrorEvent(socket, 409, errorPayload(
        'previous_response_id is not available for this caller',
        'invalid_request_error',
        { code: 'previous_response_not_found' }
      ));
      logWebSocketRequest({
        requestId,
        model: responsesPayload.model || null,
        status: 409,
        latencyMs: Date.now() - startedAt,
        error: 'previous_response_not_found',
      });
      return;
    }
    requestContext.preferredAccountId = previousOwner.accountId;
    requestContext.requirePreferredAccount = true;
  }

  let result;
  try {
    result = await handleResponsesImpl(responsesPayload, { context: requestContext });
  } catch (e) {
    const message = e?.message || 'Response failed';
    sendErrorEvent(socket, 500, errorPayload(message, 'server_error'));
    logWebSocketRequest({
      requestId,
      model: responsesPayload.model || null,
      status: 500,
      latencyMs: Date.now() - startedAt,
      accountId: requestContext.__selectedAccountId,
      error: message,
    });
    return;
  }

  const responseContext = result?.context || requestContext;
  if (!result.stream) {
    if (result.status >= 400) {
      const message = result.body?.error?.message || 'Request failed';
      sendErrorEvent(socket, result.status || 500, result.body?.error || errorPayload(message, 'upstream_error'));
      logWebSocketRequest({
        requestId,
        model: responsesPayload.model || null,
        status: result.status || 500,
        latencyMs: Date.now() - startedAt,
        accountId: responseContext.__selectedAccountId,
        error: message,
      });
    } else {
      const event = { type: 'response.completed', response: result.body };
      const capture = {};
      captureResponseEvent(event, capture);
      if (capture.responseId && responseContext.__selectedAccountId) {
        rememberResponseOwner(capture.responseId, responseContext.__selectedAccountId, callerKey, responsesPayload.model);
      }
      sendText(socket, event);
      logWebSocketRequest({
        requestId: requestId || capture.responseId,
        model: responsesPayload.model || result.body?.model || null,
        status: 200,
        latencyMs: Date.now() - startedAt,
        accountId: responseContext.__selectedAccountId,
        usage: capture.usage,
      });
    }
    return;
  }
  const capture = {};
  const sink = createSseToWebSocketSink(socket, { onEvent: event => captureResponseEvent(event, capture) });
  const onClose = () => sink._clientDisconnected();
  socket.once('close', onClose);
  try {
    await result.handler(sink);
    if (capture.responseId && !capture.completed && !capture.failed) {
      capture.failed = true;
      capture.error = 'Response stream ended before response.completed';
      sendText(socket, streamFailureEvent(capture, responsesPayload.model, capture.error));
    }
    if (capture.responseId && responseContext.__selectedAccountId && capture.completed && !capture.failed) {
      rememberResponseOwner(capture.responseId, responseContext.__selectedAccountId, callerKey, responsesPayload.model);
    }
    logWebSocketRequest({
      requestId: requestId || capture.responseId,
      model: responsesPayload.model || null,
      status: capture.failed ? 502 : 200,
      latencyMs: Date.now() - startedAt,
      accountId: responseContext.__selectedAccountId,
      usage: capture.usage,
      error: capture.error,
    });
  } catch (e) {
    const message = e?.message || 'Response stream failed';
    if (capture.responseId && !capture.failed) {
      capture.failed = true;
      capture.error = message;
      sendText(socket, streamFailureEvent(capture, responsesPayload.model, message, 'stream_error'));
    } else {
      sendErrorEvent(socket, 500, errorPayload(message, 'server_error'));
    }
    logWebSocketRequest({
      requestId: requestId || capture.responseId,
      model: responsesPayload.model || null,
      status: 500,
      latencyMs: Date.now() - startedAt,
      accountId: responseContext.__selectedAccountId,
      usage: capture.usage,
      error: message,
    });
  } finally {
    socket.removeListener('close', onClose);
  }
}

export function handleResponsesWebSocketUpgrade(req, socket, head) {
  const path = String(req.url || '').split('?')[0];
  if (!WS_PATHS.has(path)) return false;

  if (req.method && req.method !== 'GET') {
    httpReject(socket, 405, 'Method Not Allowed');
    return true;
  }
  if (!headerHasToken(req.headers.upgrade, 'websocket') || !headerHasToken(req.headers.connection, 'upgrade')) {
    httpReject(socket, 400, 'Invalid WebSocket upgrade');
    return true;
  }
  if (String(req.headers['sec-websocket-version'] || '') !== '13') {
    httpReject(socket, 426, 'Unsupported WebSocket Version', { 'Sec-WebSocket-Version': '13' });
    return true;
  }
  const key = req.headers['sec-websocket-key'];
  if (!isValidSecWebSocketKey(key)) {
    httpReject(socket, 400, 'Invalid Sec-WebSocket-Key');
    return true;
  }

  const settings = getCodexSettings();
  if (!settings.websocketEnabled) {
    httpReject(socket, 403, 'Responses WebSocket disabled');
    return true;
  }
  if (!validateApiKey(extractToken(req))) {
    httpReject(socket, 401, 'Unauthorized');
    return true;
  }
  if (!isAuthenticated()) {
    httpReject(socket, 503, 'No active accounts');
    return true;
  }

  const turnState = normalizeTurnState(req.headers['x-codex-turn-state']);
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    `x-codex-turn-state: ${turnState}`,
    '\r\n',
  ];
  socket.write(responseHeaders.join('\r\n'));

  const headers = { ...req.headers, 'x-codex-turn-state': turnState };
  const apiKey = extractToken(req);
  const context = {
    apiKey,
    callerKey: callerKeyFromRequest(req, apiKey, null),
    headers,
  };
  const state = {
    buffer: Buffer.alloc(0),
    busy: Promise.resolve(),
    fragmented: null,
    closing: false,
    partialTimer: null,
  };

  const handlePayload = (opcode, data) => {
    if (state.closing) return;
    const payload = normalizeSocketPayload(opcode, data);
    if (payload === null) return;
    if (payload === undefined) {
      sendErrorEvent(socket, 400, errorPayload('Invalid JSON'));
      return;
    }
    state.busy = state.busy
      .then(() => {
        if (state.closing) return undefined;
        return handleResponseCreate(socket, req, payload, context);
      })
      .catch((e) => {
        if (state.closing) return;
        log.error(`Responses WS error: ${e.message}`);
        sendErrorEvent(socket, 500, errorPayload(e.message, 'server_error'));
      });
  };

  let processChunk;
  const closeSocket = (code = 1000, reason = '') => {
    if (state.closing) return;
    stopReading();
    sendClose(socket, code, reason);
  };
  const refreshPartialTimeout = () => {
    if (state.partialTimer) {
      clearTimeout(state.partialTimer);
      state.partialTimer = null;
    }
    if (state.closing || (!state.buffer.length && !state.fragmented)) return;
    state.partialTimer = setTimeout(() => {
      log.warn('Responses WS partial frame timeout');
      closeSocket(1002, 'Protocol error');
    }, WS_PARTIAL_TIMEOUT_MS);
    try { state.partialTimer.unref?.(); } catch {}
  };
  const stopReading = () => {
    state.closing = true;
    if (state.partialTimer) {
      clearTimeout(state.partialTimer);
      state.partialTimer = null;
    }
    try { socket.setTimeout?.(0); } catch {}
    state.buffer = Buffer.alloc(0);
    state.fragmented = null;
    if (processChunk) socket.removeListener('data', processChunk);
  };

  const handleFrame = (frame) => {
    if (state.closing) return undefined;
    if (frame.opcode === 0x8) return closeSocket();
    if (frame.opcode === 0x9) { sendFrame(socket, 0xA, frame.payload); return undefined; }
    if (frame.opcode === 0xA) return undefined;

    if (frame.opcode === 0x0) {
      if (!state.fragmented) throw new WebSocketProtocolError('Unexpected continuation frame');
      state.fragmented.size += frame.payload.length;
      if (state.fragmented.size > MAX_WS_MESSAGE_BYTES) {
        throw new WebSocketProtocolError('WebSocket message too large', 1009);
      }
      state.fragmented.fragments += 1;
      if (state.fragmented.fragments > MAX_WS_FRAGMENTS) {
        throw new WebSocketProtocolError('WebSocket message has too many fragments', 1002);
      }
      state.fragmented.chunks.push(frame.payload);
      if (frame.fin) {
        const complete = Buffer.concat(state.fragmented.chunks);
        const opcode = state.fragmented.opcode;
        state.fragmented = null;
        handlePayload(opcode, complete);
      }
      return undefined;
    }

    if (frame.opcode !== 0x1 && frame.opcode !== 0x2) return undefined;
    if (state.fragmented) throw new WebSocketProtocolError('New data frame before fragmented message completed');
    if (!frame.fin) {
      state.fragmented = { opcode: frame.opcode, chunks: [frame.payload], size: frame.payload.length, fragments: 1 };
      return undefined;
    }
    handlePayload(frame.opcode, frame.payload);
    return undefined;
  };

  processChunk = (chunk) => {
    if (state.closing) return;
    try {
      for (const frame of parseFrames(state, chunk, { requireMasked: true })) {
        handleFrame(frame);
      }
      refreshPartialTimeout();
    } catch (e) {
      log.warn(`Responses WS parse error: ${e.message}`);
      const reason = e.closeCode === 1009
        ? 'Message too big'
        : e.closeCode === 1007
          ? 'Invalid payload data'
          : 'Protocol error';
      closeSocket(e.closeCode || 1002, reason);
    }
  };

  socket.on('data', processChunk);
  if (head && head.length) processChunk(Buffer.from(head));
  socket.setTimeout?.(WS_IDLE_TIMEOUT_MS, () => {
    log.warn('Responses WS idle timeout');
    closeSocket(1000, 'Idle timeout');
  });
  socket.on('close', stopReading);
  socket.on('error', () => {});
  return true;
}

export const _test = {
  normalizeResponseCreatePayload,
  parseFrames,
  sendFrame,
  setHandleResponsesForTest(fn) { handleResponsesImpl = fn || handleResponses; },
  resetHandleResponsesForTest() { handleResponsesImpl = handleResponses; },
  clearResponseOwnersForTest() { _responseOwners.clear(); },
  rememberResponseOwner,
  getResponseOwner,
};
