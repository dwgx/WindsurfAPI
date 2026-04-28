/**
 * HTTP/2 client for the local Windsurf language server binary.
 * Supports both gRPC and Connect-RPC protocols.
 *
 * GRPC_PROTOCOL=connect (default) — matches real Windsurf client fingerprint.
 * GRPC_PROTOCOL=grpc — legacy mode, original gRPC framing.
 */

import http2 from 'http2';
import { log } from './config.js';
import { wrapRequest, StreamingFrameParser } from './connect.js';

const USE_CONNECT = process.env.GRPC_PROTOCOL === 'connect';

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
  const key = `localhost:${port}`;
  let session = _sessionPool.get(key);
  if (session && !session.destroyed && !session.closed) return session;

  session = http2.connect(`http://localhost:${port}`);
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
  const key = `localhost:${port}`;
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
    req.on('data', (chunk) => chunks.push(chunk));

    let grpcStatus = '0', grpcMessage = '';

    req.on('trailers', (trailers) => {
      grpcStatus = String(trailers['grpc-status'] ?? '0');
      grpcMessage = String(trailers['grpc-message'] ?? '');
    });

    req.on('end', () => {
      clearTimeout(timer);
      if (!USE_CONNECT && grpcStatus !== '0') {
        const msg = grpcMessage ? decodeURIComponent(grpcMessage) : `gRPC status ${grpcStatus}`;
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
        done(resolve, payload);
      } else {
        const frames = extractGrpcFrames(full);
        const payload = frames.length > 0 ? Buffer.concat(frames) : stripGrpcFrame(full);
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
    'grpc-accept-encoding': 'identity,gzip,deflate',
    'user-agent': 'grpc-node/1.108.2',
    'x-codeium-csrf-token': csrfToken,
  };

  const req = client.request(streamHeaders);
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
        onData?.(payload);
      }
      pendingBuf = pendingBuf.subarray(5 + msgLen);
    }
  });

  let grpcStatus = '0', grpcMessage = '';

  req.on('trailers', (trailers) => {
    grpcStatus = String(trailers['grpc-status'] ?? '0');
    grpcMessage = String(trailers['grpc-message'] ?? '');
  });

  req.on('end', () => {
    clearTimeout(timer);
    if (settled) return;
    settled = true;
    if (!USE_CONNECT && grpcStatus !== '0') {
      const msg = grpcMessage ? decodeURIComponent(grpcMessage) : `gRPC status ${grpcStatus}`;
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
