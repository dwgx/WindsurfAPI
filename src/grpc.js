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
import { wrapRequest, StreamingFrameParser } from './connect.js';
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
      'user-agent': 'grpc-node/1.108.2',
      'x-codeium-csrf-token': csrfToken,
    };

    const req = client.request(headers);
    traceGrpcPayload({
      port,
      path,
      direction: 'request',
      body,
      transport: USE_CONNECT ? 'connect' : 'grpc',
      framed: true,
    });
    req.on('data', (chunk) => chunks.push(chunk));

    let grpcStatus = '0', grpcMessage = '', httpStatus = 0;

    // H-3 (ultracode audit 2026-07-13): a gRPC Trailers-Only response folds
    // grpc-status into the FIRST HEADERS frame (END_STREAM, no DATA) — it arrives
    // via the 'response' event, NOT 'trailers'. Without reading it, an immediate
    // upstream error (grpc-status 14/8/12) or an HTTP :status 4xx/5xx left
    // grpcStatus at '0' and was treated as an empty SUCCESS, blinding the account
    // pool's error classification/failover. Capture status from the response
    // headers too, then honour it in the end handler below.
    req.on('response', (headers) => {
      httpStatus = Number(headers[':status'] || 0);
      if (headers['grpc-status'] != null) grpcStatus = String(headers['grpc-status']);
      if (headers['grpc-message'] != null) grpcMessage = String(headers['grpc-message']);
    });

    req.on('trailers', (trailers) => {
      // Trailers override/confirm; only take grpc-status when actually present so
      // a Trailers-Only status captured from headers isn't reset to '0'.
      if (trailers['grpc-status'] != null) grpcStatus = String(trailers['grpc-status']);
      if (trailers['grpc-message'] != null) grpcMessage = String(trailers['grpc-message']);
    });

    req.on('end', () => {
      clearTimeout(timer);
      if (!USE_CONNECT && httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
        done(reject, new Error(`upstream HTTP ${httpStatus}`));
        return;
      }
      if (!USE_CONNECT && grpcStatus !== '0') {
        const msg = grpcMessage ? decodeGrpcMessage(grpcMessage) : `gRPC status ${grpcStatus}`;
        done(reject, new Error(msg));
        return;
      }
      const full = Buffer.concat(chunks);

      if (USE_CONNECT) {
        let parsed;
        try {
          const parser = new StreamingFrameParser();
          parser.push(full);
          parsed = parser.drain();
        } catch (err) {
          try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
          done(reject, err);
          return;
        }
        const dataFrames = parsed.filter(f => !f.isEndStream);
        const trailer = parsed.find(f => f.isEndStream);
        if (trailer) {
          try {
            const t = JSON.parse(trailer.payload.toString());
            if (t.error) { done(reject, new Error(t.error.message || 'connect error')); return; }
          } catch {}
        }
        const payload = dataFrames.length > 0
          ? Buffer.concat(dataFrames.map(f => f.payload))
          : full;
        traceGrpcPayload({
          port,
          path,
          direction: 'response',
          body: payload,
          transport: 'connect',
          framed: false,
        });
        done(resolve, payload);
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

    req.write(body);
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
 * @param {object} opts - { onData, onEnd, onError, timeout }
 */
export function grpcStream(port, csrfToken, path, body, opts = {}) {
  const { onData, onEnd, onError, timeout = 300000 } = opts;

  // req may emit both 'end' and 'error' (or error twice) when the server
  // trailers report non-OK — flip this to only fire one callback.
  let settled = false;
  const client = getSession(port);
  let timer;
  let pendingBuf = Buffer.alloc(0);

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
  const connectParser = USE_CONNECT ? new StreamingFrameParser() : null;

  req.on('data', (chunk) => {
    if (settled) return;

    if (USE_CONNECT) {
      try {
        connectParser.push(chunk);
        for (const frame of connectParser.drain()) {
          if (frame.isEndStream) {
            try {
              const t = JSON.parse(frame.payload.toString());
              if (t.error) {
                settled = true;
                clearTimeout(timer);
                try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
                onError?.(new Error(t.error.message || 'connect stream error'));
                return;
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
        settled = true;
        clearTimeout(timer);
        try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
        onError?.(err);
      }
      return;
    }

    pendingBuf = Buffer.concat([pendingBuf, chunk]);
    if (pendingBuf.length > 100 * 1024 * 1024) {
      settled = true;
      clearTimeout(timer);
      try { req.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
      onError?.(new Error('gRPC frame too large (>100MB)'));
      return;
    }

    while (pendingBuf.length >= 5) {
      const compressed = pendingBuf[0];
      const msgLen = pendingBuf.readUInt32BE(1);
      if (pendingBuf.length < 5 + msgLen) break;

      if (compressed === 0) {
        const payload = pendingBuf.subarray(5, 5 + msgLen);
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
      pendingBuf = pendingBuf.subarray(5 + msgLen);
    }
  });

  let grpcStatus = '0', grpcMessage = '', httpStatus = 0;

  // H-3 (ultracode audit 2026-07-13): capture Trailers-Only status from the
  // HEADERS frame ('response' event) — same fix as grpcUnary. Without it a
  // stream that errors immediately (Trailers-Only grpc-status, or HTTP :status
  // 4xx/5xx, END_STREAM no DATA) produced zero chunks → onEnd → a silent empty
  // assistant reply instead of an error the pool can classify.
  req.on('response', (headers) => {
    httpStatus = Number(headers[':status'] || 0);
    if (headers['grpc-status'] != null) grpcStatus = String(headers['grpc-status']);
    if (headers['grpc-message'] != null) grpcMessage = String(headers['grpc-message']);
  });

  req.on('trailers', (trailers) => {
    if (trailers['grpc-status'] != null) grpcStatus = String(trailers['grpc-status']);
    if (trailers['grpc-message'] != null) grpcMessage = String(trailers['grpc-message']);
  });

  req.on('end', () => {
    clearTimeout(timer);
    if (settled) return;
    settled = true;
    if (!USE_CONNECT && httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
      onError?.(new Error(`upstream HTTP ${httpStatus}`));
    } else if (!USE_CONNECT && grpcStatus !== '0') {
      const msg = grpcMessage ? decodeGrpcMessage(grpcMessage) : `gRPC status ${grpcStatus}`;
      onError?.(new Error(msg));
    } else {
      onEnd?.();
    }
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
