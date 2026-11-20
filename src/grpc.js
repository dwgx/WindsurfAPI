/**
 * HTTP/2 client for the local Windsurf language server binary.
 * Supports both gRPC and Connect-RPC protocols.
 *
 * Default: legacy gRPC framing (verified working with LS 2.12.5 against
 * production cascade flow). Set GRPC_PROTOCOL=connect to opt in to Connect
 * framing — note: as of v2.0.20, Connect default returned empty cascade_id
 * from StartCascade against the production LS, so we keep legacy as default
 * until the Connect response parser is debugged. Tracked for v2.0.22+.
 */

import http2 from 'http2';
import { log } from './config.js';
import { wrapRequest, unwrapRequest, gunzip, StreamingFrameParser } from './connect.js';
import { traceGrpcPayload } from './proto-trace.js';

const USE_CONNECT = process.env.GRPC_PROTOCOL === 'connect';
export const _USE_CONNECT_FOR_TEST = USE_CONNECT;

/**
 * Decode a raw upstream grpc-message trailer. Per the gRPC spec the value is
 * percent-encoded, but a misbehaving upstream can emit a malformed escape
 * (e.g. a bare '%'), and decodeURIComponent throws URIError on those. Since
 * this runs inside the stream 'end' listener, an unguarded throw escapes as
 * an uncaughtException and takes the whole proxy down. Fall back to the raw
 * value on decode failure so the status is still surfaced as an error.
 */
export function decodeGrpcMessage(grpcMessage) {
  try {
    return decodeURIComponent(grpcMessage);
  } catch {
    return grpcMessage;
  }
}

// ─── HTTP/2 session pool ───────────────────────────────────
//
// Previously every grpcUnary / grpcStream call did its own http2.connect()
// and client.close() — that's one TCP + HTTP/2 handshake per request, which
// under chat bursts (poll trajectory every 50 ms + per-chunk Send calls)
// was (a) wasting a SYN + SETTINGS round-trip per call and (b) burning
// ephemeral ports, eventually tripping EADDRNOTAVAIL. HTTP/2 is
// multiplexed — one session happily carries many concurrent streams, so we
// keep one session per LS port and let it handle all requests.
//
// The session is torn down (and a fresh one will be opened on demand) if
// it emits 'error' or 'close' — callers still see the error on their own
// `req` object because the stream error is delivered independently.

const _sessionPool = new Map();

function getSession(port) {
  const key = `127.0.0.1:${port}`;
  let session = _sessionPool.get(key);
  if (session && !session.destroyed && !session.closed) return session;

  // Use 127.0.0.1 (not "localhost") so the HTTP/2 client always connects via
  // IPv4 — the LS listens on 127.0.0.1, and on macOS "localhost" resolves to
  // ::1 first. With autoSelectFamily=false (set in config.js to fix ETIMEDOUT
  // on remote server.codeium.com connections), Node only tries the first DNS
  // result (::1) and gets ECONNREFUSED instead of falling back to 127.0.0.1.
  session = http2.connect(`http://127.0.0.1:${port}`);
  session.on('error', (err) => {
    log.debug(`HTTP/2 session error on port ${port}: ${err.message}`);
    if (_sessionPool.get(key) === session) _sessionPool.delete(key);
  });
  session.on('close', () => {
    if (_sessionPool.get(key) === session) _sessionPool.delete(key);
  });
  // The LS can hang up between requests; unref so an idle session doesn't
  // keep the Node event loop alive on its own.
  try { session.unref(); } catch {}
  _sessionPool.set(key, session);
  return session;
}

/**
 * Close the pooled session for a port (used when the underlying LS is
 * stopped so the next call opens a fresh session against whatever took
 * the port).
 */
export function closeSessionForPort(port) {
  const key = `127.0.0.1:${port}`;
  const session = _sessionPool.get(key);
  if (session) {
    try { session.close(); } catch {}
    _sessionPool.delete(key);
  }
}

/**
 * Wrap a protobuf payload for transport.
 * Connect mode: gzip-compressed connect envelope.
 * gRPC mode: uncompressed gRPC frame.
 *
 * Connect *unary* calls unwrap this again inside grpcUnary (the protocol wants a
 * bare message there); streaming calls send it as-is.
 */
export function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (USE_CONNECT) return wrapRequest(buf);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

/**
 * Strip gRPC frame header (5 bytes) from a response buffer.
 * Returns the protobuf payload.
 */
export function stripGrpcFrame(buf) {
  if (buf.length >= 5 && buf[0] === 0) {
    const msgLen = buf.readUInt32BE(1);
    if (buf.length >= 5 + msgLen) {
      return buf.subarray(5, 5 + msgLen);
    }
  }
  return buf;
}

/**
 * Extract all gRPC frames from a buffer (may contain multiple concatenated frames).
 */
export function extractGrpcFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const compressed = buf[offset];
    const msgLen = buf.readUInt32BE(offset + 1);
    if (compressed !== 0 || offset + 5 + msgLen > buf.length) break;
    frames.push(buf.subarray(offset + 5, offset + 5 + msgLen));
    offset += 5 + msgLen;
  }
  return frames;
}

// ─── Terminal truth ───────────────────────────────────────
//
// grpcStatus defaults to '0', so a response that ends without any grpc-status
// used to fall through to the success branch: a truncated or crashed LS reply
// surfaced as an empty assistant turn and the account pool never failed over
// (audit G4, probe G1). Presence is tracked separately from the value.
//
// Connect does not use grpc-status. Its HTTP status is checked on response
// headers, before feeding the body to a frame reader (audit G2, probe C2).
// grpcStream also requires the in-band Connect EndStreamResponse.

/**
 * @returns {Error|null} the failure to surface, or null when the response is a
 *   success and its body may be parsed.
 */
function terminalFailure({ connect, grpcStatus, sawGrpcStatus, grpcMessage }) {
  if (connect) return null;
  if (!sawGrpcStatus) return new Error('gRPC response ended without grpc-status');
  if (grpcStatus !== '0') {
    return new Error(grpcMessage ? decodeGrpcMessage(grpcMessage) : `gRPC status ${grpcStatus}`);
  }
  return null;
}

/**
 * Split a Connect envelope stream, or return null when the buffer is not one.
 *
 * A spec-compliant Connect *unary* response body is a bare protobuf message;
 * the 5-byte envelope only applies to `application/connect+proto` streaming.
 * The LS has historically answered unary calls with envelopes, so both shapes
 * are accepted — but the discriminator is structural, never try/catch: a valid
 * protobuf message cannot begin with 0x00-0x03 (field number 0 is illegal, and
 * tags 0x01-0x03 are field 0 with wire types 1-3), which is exactly the first
 * byte of every envelope. That makes the two shapes unambiguous, so a corrupt
 * envelope is reported as such instead of being parsed as a message (G12).
 */
function scanConnectEnvelope(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 5 > buf.length) return null;
    const flags = buf[offset];
    if (flags & ~0x03) return null;
    const len = buf.readUInt32BE(offset + 1);
    if (offset + 5 + len > buf.length) return null;
    frames.push({ flags, isEndStream: !!(flags & 0x02), payload: buf.subarray(offset + 5, offset + 5 + len) });
    offset += 5 + len;
  }
  return frames;
}

/**
 * Decode a Connect unary response body.
 *
 * Returns the bare message plus any error the end-stream frame carried. A
 * trailer-only body decodes to an EMPTY message — never to the envelope bytes,
 * which callers then ran through parseFields as if they were protobuf (G1).
 */
function decodeConnectUnaryResponse(body) {
  if (body.length === 0 || body[0] > 0x03) return { payload: body, error: null };
  const frames = scanConnectEnvelope(body);
  if (!frames) throw new Error('Connect unary response is not a valid frame stream');
  const data = [];
  let error = null;
  for (const frame of frames) {
    if (frame.isEndStream) {
      if (!error) {
        try {
          const trailer = JSON.parse(frame.payload.toString());
          if (trailer.error) error = new Error(trailer.error.message || 'connect error');
        } catch {}
      }
      continue;
    }
    data.push(frame.flags & 0x01 ? gunzip(frame.payload) : frame.payload);
  }
  return { payload: Buffer.concat(data), error };
}

/**
 * Make a unary gRPC call to the language server.
 *
 * @param {number} port - Language server port
 * @param {string} csrfToken - CSRF token
 * @param {string} path - gRPC path (e.g. /exa.language_server_pb.LanguageServerService/StartCascade)
 * @param {Buffer} body - gRPC-framed request
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<Buffer>} Protobuf response (stripped of gRPC frame)
 */
export function grpcUnary(port, csrfToken, path, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    // Guard against double-settling: req 'error' followed by session
    // 'error' (or a late 'end' after an abort) would otherwise call
    // resolve and reject both.
    let settled = false;
    const done = (fn, ...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };

    // Connect unary RPCs use `application/proto` with a BARE message; the
    // envelope plus `application/connect+proto` belongs to streaming RPCs only
    // (connectrpc.com/docs/protocol). Callers hand every request through
    // grpcFrame(), which envelopes under GRPC_PROTOCOL=connect, so unwrap here
    // instead of teaching every call site which transport is active.
    //
    // Done before the timer is armed: unwrapRequest can throw on a corrupt
    // envelope, and a throw after setTimeout() would leave a timer whose
    // callback dereferences `req` before it exists.
    const requestBody = USE_CONNECT ? unwrapRequest(body, {}) : body;

    const client = getSession(port);
    const chunks = [];
    let timer;

    timer = setTimeout(() => {
      try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
      done(reject, new Error('gRPC unary timeout'));
    }, timeout);

    const headers = USE_CONNECT ? {
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
      'user-agent': 'connect-es/2.0.0',
      'x-codeium-csrf-token': csrfToken,
    } : {
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      'te': 'trailers',
      'user-agent': 'grpc-node/1.108.2',
      'x-codeium-csrf-token': csrfToken,
    };

    const req = client.request(headers);
    traceGrpcPayload({
      port,
      path,
      direction: 'request',
      body: requestBody,
      transport: USE_CONNECT ? 'connect' : 'grpc',
      framed: !USE_CONNECT,
    });
    req.on('data', (chunk) => chunks.push(chunk));

    let grpcStatus = '0', grpcMessage = '', sawGrpcStatus = false;

    // H-3 (ultracode audit 2026-07-13): a gRPC Trailers-Only response folds
    // grpc-status into the FIRST HEADERS frame (END_STREAM, no DATA) — it arrives
    // via the 'response' event, NOT 'trailers'. Without reading it, an immediate
    // upstream error (grpc-status 14/8/12) or an HTTP :status 4xx/5xx left
    // grpcStatus at '0' and was treated as an empty SUCCESS, blinding the account
    // pool's error classification/failover. Capture status from the response
    // headers too, then honour it in the end handler below.
    req.on('response', (headers) => {
      const status = Number(headers[':status'] || 0);
      if (headers['grpc-status'] != null) { grpcStatus = String(headers['grpc-status']); sawGrpcStatus = true; }
      if (headers['grpc-message'] != null) grpcMessage = String(headers['grpc-message']);
      // A non-2xx body is an error page (proxy/HTML), never a message. Decide at
      // the headers and stop reading so the real cause is reported instead of a
      // frame-size error produced by parsing HTML as frames (G2).
      if (status && (status < 200 || status >= 300)) {
        clearTimeout(timer);
        try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
        done(reject, new Error(`upstream HTTP ${status}`));
      }
    });

    req.on('trailers', (trailers) => {
      // Trailers override/confirm; only take grpc-status when actually present so
      // a Trailers-Only status captured from headers isn't reset to '0'.
      if (trailers['grpc-status'] != null) { grpcStatus = String(trailers['grpc-status']); sawGrpcStatus = true; }
      if (trailers['grpc-message'] != null) grpcMessage = String(trailers['grpc-message']);
    });

    req.on('end', () => {
      clearTimeout(timer);
      if (settled) return;
      const failure = terminalFailure({ connect: USE_CONNECT, grpcStatus, sawGrpcStatus, grpcMessage });
      if (failure) { done(reject, failure); return; }
      const full = Buffer.concat(chunks);

      if (USE_CONNECT) {
        let decoded;
        try {
          decoded = decodeConnectUnaryResponse(full);
        } catch (err) {
          try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
          done(reject, err);
          return;
        }
        if (decoded.error) { done(reject, decoded.error); return; }
        traceGrpcPayload({
          port,
          path,
          direction: 'response',
          body: decoded.payload,
          transport: 'connect',
          framed: false,
        });
        done(resolve, decoded.payload);
      } else {
        const frames = extractGrpcFrames(full);
        const payload = frames.length > 0 ? Buffer.concat(frames) : stripGrpcFrame(full);
        traceGrpcPayload({
          port,
          path,
          direction: 'response',
          body: payload,
          transport: 'grpc',
          framed: false,
        });
        done(resolve, payload);
      }
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      done(reject, err);
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * Make a streaming gRPC call to the language server.
 * Yields parsed gRPC frame payloads as they arrive.
 *
 * @param {number} port
 * @param {string} csrfToken
 * @param {string} path
 * @param {Buffer} body
 * @param {object} opts - { onData, onEnd, onError, timeout, signal }
 */
export function grpcStream(port, csrfToken, path, body, opts = {}) {
  const { onData, onEnd, onError, timeout = 300000, signal } = opts;

  // GAP-2: caller-supplied cancellation. A client disconnect (or a server
  // shutdown drain) aborts `signal`; close the HTTP/2 stream with
  // NGHTTP2_CANCEL and surface an AbortError so callers stop burning
  // LS + account quota. No-op when no signal is supplied.
  const abortError = () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    return err;
  };
  if (signal?.aborted) {
    // Already aborted before any stream was opened — settle without a request.
    onError?.(abortError());
    return;
  }

  // req may emit both 'end' and 'error' (or error twice) when the server
  // trailers report non-OK — flip this to only fire one callback.
  let settled = false;
  const client = getSession(port);
  let timer;
  let pendingChunks = [];
  let pendingHead = 0;
  let pendingOffset = 0;
  let pendingLength = 0;

  const pendingByteAt = (relative) => {
    let index = pendingHead;
    let offset = pendingOffset + relative;
    while (offset >= pendingChunks[index].length) {
      offset -= pendingChunks[index++].length;
    }
    return pendingChunks[index][offset];
  };

  const copyPendingPayload = (length) => {
    const payload = Buffer.alloc(length);
    if (length === 0) return payload;
    let index = pendingHead;
    let offset = pendingOffset + 5;
    while (offset >= pendingChunks[index].length) {
      offset -= pendingChunks[index++].length;
    }
    let written = 0;
    while (written < length) {
      const chunk = pendingChunks[index++];
      const take = Math.min(length - written, chunk.length - offset);
      payload.set(chunk.subarray(offset, offset + take), written);
      written += take;
      offset = 0;
    }
    return payload;
  };

  const consumePending = (length) => {
    pendingLength -= length;
    while (length > 0) {
      const available = pendingChunks[pendingHead].length - pendingOffset;
      if (length < available) {
        pendingOffset += length;
        break;
      }
      length -= available;
      pendingChunks[pendingHead++] = null;
      pendingOffset = 0;
    }
    if (pendingHead === pendingChunks.length) {
      pendingChunks = [];
      pendingHead = 0;
    } else if (pendingHead * 2 >= pendingChunks.length) {
      // Retired entries pay for this reference-only compaction; never shift().
      pendingChunks = pendingChunks.slice(pendingHead);
      pendingHead = 0;
    }
  };

  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
    onError?.(new Error('gRPC stream timeout'));
  }, timeout);

  const streamHeaders = USE_CONNECT ? {
    ':method': 'POST',
    ':path': path,
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    'connect-accept-encoding': 'gzip',
    'user-agent': 'connect-es/2.0.0',
    'x-codeium-csrf-token': csrfToken,
  } : {
    ':method': 'POST',
    ':path': path,
    'content-type': 'application/grpc',
    'te': 'trailers',
    // T3 (Grok audit): the frame reader only handles uncompressed frames
    // (compressed===0) — a gzip/deflate frame is silently skipped, truncating
    // the stream. Advertise ONLY what we can actually decode so the LS never
    // sends a compressed frame we'd drop. (The LS is local loopback and rarely
    // compresses, but advertising a codec we can't read is a latent bug.)
    'grpc-accept-encoding': 'identity',
    'user-agent': 'grpc-node/1.108.2',
    'x-codeium-csrf-token': csrfToken,
  };

  const req = client.request(streamHeaders);
  traceGrpcPayload({
    port,
    path,
    direction: 'request',
    body,
    transport: USE_CONNECT ? 'connect' : 'grpc',
    framed: true,
  });

  if (signal) {
    signal.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
      onError?.(abortError());
    }, { once: true });
  }

  const connectParser = USE_CONNECT ? new StreamingFrameParser() : null;
  let sawConnectEndStream = false;

  req.on('data', (chunk) => {
    if (settled) return;

    if (USE_CONNECT) {
      try {
        connectParser.push(chunk);
        for (const frame of connectParser.drain()) {
          // A data callback can synchronously abort the call.
          if (settled) return;
          if (frame.isEndStream) {
            try {
              const endStream = JSON.parse(frame.payload.toString());
              if (endStream?.error) {
                settled = true;
                clearTimeout(timer);
                try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
                onError?.(new Error(endStream.error.message || 'connect stream error'));
                return;
              }
              if (endStream && typeof endStream === 'object'
                  && !Array.isArray(endStream) && !Object.hasOwn(endStream, 'error')) {
                sawConnectEndStream = true;
              }
            } catch {}
          } else {
            traceGrpcPayload({
              port,
              path,
              direction: 'response',
              body: frame.payload,
              transport: 'connect',
              framed: false,
            });
            onData?.(frame.payload);
          }
        }
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
        onError?.(err);
      }
      return;
    }

    // Incoming HTTP/2 Buffer chunks are borrowed until consumed. Keep the guard
    // on aggregate pending bytes BEFORE draining, not on advertised frame size.
    if (chunk.length) {
      pendingChunks.push(chunk);
      pendingLength += chunk.length;
    }
    if (pendingLength > 100 * 1024 * 1024) {
      settled = true;
      clearTimeout(timer);
      try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
      onError?.(new Error('gRPC frame too large (>100MB)'));
      return;
    }

    while (pendingLength >= 5) {
      const compressed = pendingByteAt(0);
      let msgLen = 0;
      for (let i = 1; i < 5; i++) msgLen = msgLen * 256 + pendingByteAt(i);
      if (pendingLength < 5 + msgLen) break;

      if (compressed === 0) {
        const payload = copyPendingPayload(msgLen);
        traceGrpcPayload({
          port,
          path,
          direction: 'response',
          body: payload,
          transport: 'grpc',
          framed: false,
        });
        onData?.(payload);
      }
      consumePending(5 + msgLen);
    }
  });

  let grpcStatus = '0', grpcMessage = '', sawGrpcStatus = false;

  // H-3 (ultracode audit 2026-07-13): capture Trailers-Only status from the
  // HEADERS frame ('response' event) — same fix as grpcUnary. Without it a
  // stream that errors immediately (Trailers-Only grpc-status, or HTTP :status
  // 4xx/5xx, END_STREAM no DATA) produced zero chunks → onEnd → a silent empty
  // assistant reply instead of an error the pool can classify.
  req.on('response', (headers) => {
    const status = Number(headers[':status'] || 0);
    if (headers['grpc-status'] != null) { grpcStatus = String(headers['grpc-status']); sawGrpcStatus = true; }
    if (headers['grpc-message'] != null) grpcMessage = String(headers['grpc-message']);
    // Fail at the headers for a non-2xx response: its body is an error page, and
    // the frame reader would report a bogus frame size for it instead of the
    // status (G2). Settle here so the data handler never parses that body.
    if (!settled && status && (status < 200 || status >= 300)) {
      settled = true;
      clearTimeout(timer);
      try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
      onError?.(new Error(`upstream HTTP ${status}`));
    }
  });

  req.on('trailers', (trailers) => {
    if (trailers['grpc-status'] != null) { grpcStatus = String(trailers['grpc-status']); sawGrpcStatus = true; }
    if (trailers['grpc-message'] != null) grpcMessage = String(trailers['grpc-message']);
  });

  req.on('end', () => {
    clearTimeout(timer);
    if (settled) return;
    settled = true;
    const failure = USE_CONNECT && !sawConnectEndStream
      ? new Error('Connect stream ended without EndStreamResponse')
      : terminalFailure({ connect: USE_CONNECT, grpcStatus, sawGrpcStatus, grpcMessage });
    if (failure) onError?.(failure);
    else onEnd?.();
  });

  req.on('error', (err) => {
    clearTimeout(timer);
    if (settled) return;
    settled = true;
    onError?.(err);
  });

  req.write(body);
  req.end();
}
