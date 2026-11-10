// Deferred SSE commit point.
//
// Why: the proxy currently writes HTTP 200 before the upstream attempt, so a
// pre-content 429/500 can only be delivered as an in-band SSE error frame after
// a 200. That loses the status and Retry-After. This wrapper holds the first
// frames until it can tell a real payload from an error, then either commits the
// SSE response or replaces it with a JSON error carrying the real status.
//
// It is deliberately protocol-agnostic at the byte level; the caller supplies
// the error-body shape. The first integration is the OpenAI chat route.

import { Buffer } from 'node:buffer';
import { findFrameEnd, parseSseLine, parseSseDataJson } from './sse-framer.js';
import { connectErrorToHttp, normalizeOpenAIErrorType, clientRetryAfterSeconds } from './handlers/chat.js';

const DEFAULT_MAX_FRAMES = 48;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_BOOTSTRAP_MS = 5_000;
const MAX_BOOTSTRAP_MS = 14_000;

// A heartbeat frame is comment-only. A leading comment on a frame that also
// carries data must not make that data a bootstrap.
function isCommentFrame(frame) {
  let sawComment = false;
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line === '') continue;
    if (!line.startsWith(':')) return false;
    sawComment = true;
  }
  return sawComment;
}

const KEEPALIVE_EVENT = /^(?:ping|keep-?alive)$/i;

// SSE event names that carry no payload. Holding one cannot delay content, and
// it keeps a pre-content error behind a ping from being flattened into a
// committed 200. The last `event` value in the frame wins, as in the framer.
function isKeepaliveFrame(frame) {
  let event = null;
  for (const line of frame.split(/\r\n|\n|\r/)) {
    const parsed = parseSseLine(line);
    if (parsed?.field === 'event') event = parsed.value;
  }
  return event !== null && KEEPALIVE_EVENT.test(event.trim());
}

// True when the text ends on a frame terminator, so no partial frame is left
// to carry. A lone trailing CRLF is not a terminator, so it takes the slow
// path; only a false "no" costs a scan, never a missed frame.
function endsAtFrameEnd(buf) {
  const n = buf.length;
  if (n < 2) return false;
  const last = buf[n - 1];
  const prev = buf[n - 2];
  if ((last !== 10 && last !== 13) || (prev !== 10 && prev !== 13)) return false;
  return !(prev === 13 && last === 10);
}

function dataPayload(frame) {
  const data = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    const parsed = parseSseLine(line);
    if (parsed?.field === 'data') data.push(parsed.value);
  }
  return data.join('\n');
}

// Every JSON document a frame carries. An upstream may concatenate documents
// on one `data:` line; `parseSseDataJson` repairs that per line. A payload that
// starts like a JSON object but cannot be parsed into complete documents is
// malformed — the gate must surface a typed error, never treat it as "no error
// frame" and let the stream finish cleanly with zero content.
function frameDocuments(frame) {
  return parseSseDataJson(dataPayload(frame));
}

function malformedDataError() {
  const err = new Error('Upstream sent an SSE data payload that is not valid JSON and could not be repaired');
  // No `type`: `api_error` maps to 500 in TYPE_STATUS, but this is a transport
  // failure (the payload could not be parsed at all), so the status must come
  // from the unclassified-code path — 502 — and the body type is normalized
  // from that status.
  err.code = 'SSE_MALFORMED_JSON';
  return err;
}

function isOpenAIBootstrapChunk(obj) {
  // Role-only prime chunk: no content, no tool call, no finish. Holding it is
  // safe because a client cannot observe anything from it alone.
  if (!Array.isArray(obj?.choices) || obj.choices.length === 0) return false;
  return obj.choices.every((c) => {
    const d = c?.delta;
    if (!d || c?.finish_reason) return false;
    return Object.keys(d).every((k) => k === 'role'
      || ((k === 'content' || k === 'reasoning' || k === 'reasoning_content') && !d[k]));
  });
}

function isBootstrapFrame(frame, protocol, isBootstrap = null) {
  if (isCommentFrame(frame)) return true;
  if (isKeepaliveFrame(frame)) return true;
  const { docs, malformed } = frameDocuments(frame);
  if (malformed || !docs || docs.length === 0) return false;
  // Every document must be bootstrap. One content document in the frame is a
  // real payload and must commit the gate.
  if (typeof isBootstrap === 'function') return docs.every((obj) => !!isBootstrap(obj));
  if (protocol === 'openai') return docs.every((obj) => isOpenAIBootstrapChunk(obj));
  return false;
}

function errorFromFrame(frame, parseError = null) {
  const { docs, malformed } = frameDocuments(frame);
  if (malformed) return malformedDataError();
  if (!docs) return null;
  for (const obj of docs) {
    if (typeof parseError === 'function') {
      const parsed = parseError(obj);
      if (parsed) return parsed;
      continue;
    }
    if (obj && typeof obj === 'object' && obj.error && typeof obj.error === 'object') return obj.error;
  }
  return null;
}

const GRPC_STATUS = {
  INVALID_ARGUMENT: 400,
  OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  ABORTED: 409,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNIMPLEMENTED: 501,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

const TYPE_STATUS = {
  invalid_request_error: 400,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  rate_limit_exceeded: 429,
  authentication_error: 401,
  permission_error: 403,
  insufficient_quota: 402,
  capacity_error: 503,
  api_error: 500,
  overloaded_error: 529,
  timeout_error: 504,
};

function mapStatus(error, mapError, protocol = '') {
  if (typeof mapError === 'function') return mapError(error).status;
  // Gemini's error envelope carries the HTTP-like status in numeric `code`
  // (e.g. 400/413/404), while `status` is the gRPC enum. Prefer the numeric
  // code so 413 is not flattened to INVALID_ARGUMENT/400.
  const numeric = Number.isInteger(error?.code)
    ? error.code
    : (Number.isInteger(error?.status) ? error.status : null);
  if (numeric >= 400 && numeric <= 599) return numeric;
  if (error?.status && GRPC_STATUS[error.status]) return GRPC_STATUS[error.status];
  const code = error?.__upstream_code
    || (typeof error?.code === 'string' ? error.code : null);
  // Messages is the one protocol whose Anthropic enum must win over the
  // internal Connect code (MODEL_BLOCKED → permission_error/403, while the
  // same code is 402 for OpenAI/Responses). Other protocols keep the code.
  if (protocol === 'messages' && error?.type && TYPE_STATUS[error.type]) return TYPE_STATUS[error.type];
  if (code) {
    const byCode = connectErrorToHttp(code);
    if (byCode.status !== 502) return byCode.status;
  }
  if (error?.type && TYPE_STATUS[error.type]) return TYPE_STATUS[error.type];
  return 502;
}

function retryAfterSeconds(error) {
  const ms = Number(error?.retry_after_ms ?? error?.retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return clientRetryAfterSeconds(ms);
  return null;
}

export function createDeferredSseResponse(realRes, {
  status = 200,
  headers = {},
  protocol = 'openai',
  requestId = null,
  errorBody = null,
  mapError = null,
  isBootstrap = null,
  parseError = null,
  maxFrames = DEFAULT_MAX_FRAMES,
  maxBytes = DEFAULT_MAX_BYTES,
  bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_MS,
} = {}) {
  const bootstrapMs = Math.max(0, Math.min(Number(bootstrapTimeoutMs) || 0, MAX_BOOTSTRAP_MS));
  let committed = false;
  let ended = false;
  let headerStatus = status;
  let headerObj = { ...headers };
  let pending = [];
  let pendingBytes = 0;
  let pendingFrames = 0;
  let inspectedChars = 0;
  let timer = null;
  let disposed = false;
  // O10: the first failure this stream surfaced, kept after it is delivered so
  // the caller can classify the request-ring row. The commit gate already
  // parses frames until it commits; from then on an error frame cannot change
  // the status any more, but it still has to reach the ring.
  let failure = null;
  // Post-commit failure scan: one write may carry several frames (content and
  // error), and one frame may span writes, so the scan walks frames and carries
  // the incomplete tail instead of parsing the whole write as a frame.
  let scanCarry = Buffer.alloc(0);

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const commit = () => {
    if (committed || ended) return;
    if (realRes.writableEnded || realRes.destroyed) { ended = true; clearTimer(); return; }
    committed = true;
    clearTimer();
    realRes.writeHead(headerStatus, headerObj);
    if (pending.length === 0) realRes.flushHeaders?.();
    for (const buf of pending) realRes.write(buf);
    pending = [];
    pendingBytes = 0;
    pendingFrames = 0;
    inspectedChars = 0;
  };

  const finishError = (error) => {
    if (ended) return;
    if (!failure) failure = error;
    ended = true;
    clearTimer();
    if (realRes.writableEnded || realRes.destroyed) return;
    const mapped = mapStatus(error, mapError, protocol);
    const retry = retryAfterSeconds(error);
    const fallbackType = (mapError ? mapError(error).type : connectErrorToHttp(error?.code).type);
    const type = normalizeOpenAIErrorType(
      error?.type && error.type !== 'api_error' ? error.type : fallbackType,
      mapped,
    );
    const body = errorBody
      ? errorBody(error, mapped)
      : {
        error: {
          message: error?.message || 'Upstream error',
          type,
          ...(error?.code ? { code: error.code } : {}),
        },
        ...(requestId ? { request_id: requestId } : {}),
      };
    const outHeaders = {};
    for (const [k, v] of Object.entries(headerObj)) {
      if (k.toLowerCase() !== 'content-type') outHeaders[k] = v;
    }
    outHeaders['content-type'] = 'application/json; charset=utf-8';
    if (retry) outHeaders['retry-after'] = String(retry);
    try {
      realRes.writeHead(mapped, outHeaders);
      headerStatus = mapped;
      committed = true;
      realRes.end(JSON.stringify(body));
    } catch {
      ended = true;
      // S3-F2: a throw here (e.g. an invalid header byte) used to leave the
      // socket half-open — `ended` flagged but nothing ever written — and the
      // caller held the upstream slot forever. Destroy so the connection
      // actually closes.
      try { realRes.destroy(); } catch { /* already gone */ }
    }
  };

  const scanFailure = (buf) => {
    if (failure) return;
    // A JSON error key cannot occur in a write without this byte sequence, so
    // skip the frame walk unless the write (or a carried frame) can hold one.
    // A write that stops mid-frame is always walked: its `"error"` may still be
    // in the next write, and the incomplete tail has to be carried.
    if (scanCarry.length === 0 && buf.indexOf('"error"') === -1 && endsAtFrameEnd(buf)) return;
    const text = scanCarry.length === 0
      ? buf.toString('utf8')
      : Buffer.concat([scanCarry, buf]).toString('utf8');
    let offset = 0;
    for (;;) {
      const found = findFrameEnd(text, offset);
      if (!found) break;
      const error = errorFromFrame(text.slice(offset, found.frameEnd), parseError);
      if (error) {
        failure = error;
        scanCarry = Buffer.alloc(0);
        return;
      }
      offset = found.next;
    }
    const rest = offset < text.length ? Buffer.from(text.slice(offset), 'utf8') : Buffer.alloc(0);
    scanCarry = rest.length <= maxBytes ? rest : Buffer.alloc(0);
  };

  const inspectPending = () => {
    let text = Buffer.concat(pending).toString('utf8');
    // The wire may start with a UTF-8 BOM. It stays in `pending`, so the client
    // still receives it, but it must not hide the first frame from the gate.
    // Before the gate commits, `pending` always starts at the stream start, so
    // the BOM is always at index 0; stripping it every pass keeps
    // `inspectedChars` in one coordinate space across writes.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let offset = inspectedChars;
    let framesSeen = 0;
    for (;;) {
      const found = findFrameEnd(text, offset);
      if (!found) break;
      framesSeen += 1;
      const frame = text.slice(offset, found.frameEnd);
      const error = errorFromFrame(frame, parseError);
      if (error) {
        finishError(error);
        return;
      }
      if (!isBootstrapFrame(frame, protocol, isBootstrap)) {
        commit();
        // Committing does not end the stream: an error frame after the
        // committing frame in this same write still has to reach the ring.
        if (!failure && !ended) scanFailure(Buffer.from(text.slice(found.next), 'utf8'));
        return;
      }
      offset = found.next;
      inspectedChars = offset;
    }
    pendingFrames += framesSeen;
    // Keep holding; a later content/error frame decides. The timer is the
    // escape hatch so a silent upstream still commits a live SSE response.
    if (pendingFrames > maxFrames || pendingBytes > maxBytes) commit();
  };

  // The bootstrap timer is armed by the FIRST write, not at construction.
  //
  // Measured P0 (2026-10-22): the gate used to start this timer when the
  // wrapper was created — before the handler acquired an account. The Cascade
  // stream handler can wait up to QUEUE_MAX_WAIT_MS (30 s) for admission and
  // only then discover the pool is exhausted; a construction-time 5 s timer
  // committed `200 text/event-stream` first, so the 429 and its Retry-After
  // could only arrive as an in-band error frame. Arming on the first write
  // keeps the response uncommitted for the whole admission window: a
  // pre-content error frame is then the first write and rewrites the status.
  // Once the handler is admitted it starts heartbeating, and this timer is the
  // escape hatch that still commits a live SSE response when upstream is silent.
  const armBootstrap = () => {
    if (bootstrapMs <= 0 || timer || committed || ended) return;
    timer = setTimeout(() => {
      if (!committed && !ended) commit();
    }, bootstrapMs);
    timer.unref?.();
  };

  return {
    get writableEnded() { return ended; },
    get headersSent() { return committed; },
    get statusCode() { return headerStatus; },
    set statusCode(v) { headerStatus = v; },
    // O10: first failure frame this stream carried (pre- or post-commit), or
    // null. Read by serveChatStream after the handler settles to classify the
    // request-ring row; it never changes what was sent to the client.
    get failure() { return failure; },
    setHeader(name, value) {
      if (committed) return realRes.setHeader(name, value);
      headerObj[name] = value;
      return this;
    },
    getHeader(name) {
      if (committed) return realRes.getHeader(name);
      return headerObj[name];
    },
    removeHeader(name) {
      if (committed) return realRes.removeHeader(name);
      delete headerObj[name];
    },
    writeHead(nextStatus, nextHeaders) {
      if (ended) return this;
      if (committed) return realRes.writeHead(nextStatus, nextHeaders);
      headerStatus = nextStatus;
      headerObj = { ...headerObj, ...(nextHeaders || {}) };
      return this;
    },
    flushHeaders() { commit(); },
    write(chunk, encoding, cb) {
      if (ended || disposed) return false;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
      if (committed) {
        // O10: a failure that lands after the commit gate is already on the
        // wire with HTTP 200, so it cannot rewrite the status — but the request
        // ring must still record its class. Walk the frames in this write (and
        // any frame carried over from the previous one) rather than parsing the
        // whole write as a single frame.
        scanFailure(buf);
        const ok = realRes.write(buf);
        if (typeof cb === 'function') process.nextTick(cb);
        return ok;
      }
      // First write of an uncommitted response: start the silence escape hatch
      // now. A write that commits immediately clears it in commit().
      armBootstrap();
      pending.push(buf);
      pendingBytes += buf.length;
      inspectPending();
      if (typeof cb === 'function') process.nextTick(cb);
      return true;
    },
    end(chunk, encoding, cb) {
      if (ended || disposed) return this;
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      if (!committed && !ended) commit();
      if (!ended) {
        ended = true;
        clearTimer();
        realRes.end(typeof cb === 'function' ? cb : undefined);
      }
      return this;
    },
    on(event, listener) { realRes.on(event, listener); return this; },
    once(event, listener) { realRes.once(event, listener); return this; },
    removeListener(event, listener) { realRes.removeListener?.(event, listener); return this; },
    emit(event, ...args) { return realRes.emit?.(event, ...args); },
    // Cancellation releases the queued bytes, not just the timer: a route that
    // aborts before commit must not keep a held burst reachable from the gate.
    dispose() { disposed = true; ended = true; clearTimer(); pending = []; pendingBytes = 0; pendingFrames = 0; scanCarry = Buffer.alloc(0); },
    destroy(error) { disposed = true; ended = true; clearTimer(); pending = []; pendingBytes = 0; pendingFrames = 0; scanCarry = Buffer.alloc(0); return realRes.destroy?.(error); },
    get socket() { return realRes.socket; },
  };
}
