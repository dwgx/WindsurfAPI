/**
 * HTTP/2 gRPC client for the local Windsurf language server binary.
 *
 * Uses Node.js built-in http2 module. No external dependencies.
 */

import http2 from 'http2';
import { log } from './config.js';

// Session pool: reuse HTTP/2 connections per port
const _sessionPool = new Map();

function getSession(port) {
  const key = `localhost:${port}`;
  let session = _sessionPool.get(key);
  if (!session || session.destroyed || session.closed) {
    session = http2.connect(`http://localhost:${port}`);
    session.on('error', (err) => {
      log.debug(`HTTP/2 session error for port ${port}: ${err.message}`);
      _sessionPool.delete(key);
    });
    session.on('close', () => {
      _sessionPool.delete(key);
    });
    _sessionPool.set(key, session);
  }
  return session;
}

/**
 * Wrap a protobuf payload in a gRPC frame.
 * Format: 1 byte compression (0) + 4 bytes BE length + payload
 */
export function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0; // no compression
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
    let settled = false;
    const settle = (fn, ...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };

    const client = getSession(port);
    const chunks = [];
    let timer;

    timer = setTimeout(() => {
      settle(reject, new Error('gRPC unary timeout'));
    }, timeout);

    const req = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      'te': 'trailers',
      'x-codeium-csrf-token': csrfToken,
    });

    req.on('data', (chunk) => chunks.push(chunk));

    let grpcStatus = '0', grpcMessage = '';

    req.on('trailers', (trailers) => {
      grpcStatus = String(trailers['grpc-status'] ?? '0');
      grpcMessage = String(trailers['grpc-message'] ?? '');
    });

    req.on('end', () => {
      clearTimeout(timer);
      if (grpcStatus !== '0') {
        const msg = grpcMessage ? decodeURIComponent(grpcMessage) : `gRPC status ${grpcStatus}`;
        settle(reject, new Error(msg));
        return;
      }
      const full = Buffer.concat(chunks);
      settle(resolve, stripGrpcFrame(full));
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      settle(reject, err);
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

  let done = false;
  const client = getSession(port);
  let timer;
  let pendingBuf = Buffer.alloc(0);

  timer = setTimeout(() => {
    if (done) return;
    done = true;
    onError?.(new Error('gRPC stream timeout'));
  }, timeout);

  const req = client.request({
    ':method': 'POST',
    ':path': path,
    'content-type': 'application/grpc',
    'te': 'trailers',
    'x-codeium-csrf-token': csrfToken,
  });

  req.on('data', (chunk) => {
    // Accumulate and parse gRPC frames
    pendingBuf = Buffer.concat([pendingBuf, chunk]);

    while (pendingBuf.length >= 5) {
      const compressed = pendingBuf[0];
      const msgLen = pendingBuf.readUInt32BE(1);
      if (pendingBuf.length < 5 + msgLen) break; // wait for more data

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
    if (done) return;
    done = true;
    if (grpcStatus !== '0') {
      const msg = grpcMessage ? decodeURIComponent(grpcMessage) : `gRPC status ${grpcStatus}`;
      onError?.(new Error(msg));
    } else {
      onEnd?.();
    }
  });

  req.on('error', (err) => {
    clearTimeout(timer);
    if (done) return;
    done = true;
    onError?.(err);
  });

  req.write(body);
  req.end();
}
