/**
 * Connect-RPC envelope framing and compression.
 *
 * Connect-RPC frame format:
 *   [1 byte flags] [4 bytes big-endian length] [N bytes payload]
 *
 * Flags:
 *   0x01 = gzip compressed
 *   0x02 = end-of-stream (trailer frame, JSON payload)
 *   0x03 = compressed + end-of-stream
 *
 * IMPORTANT: Connect-RPC uses HTTP/1.1 POST, NOT HTTP/2 gRPC.
 * Content-Type: application/connect+proto
 */

import { gzipSync, gunzipSync } from 'zlib';

// ─── Compression helpers ───────────────────────────────────

export function gzip(buf) { return gzipSync(buf); }

export function gunzip(buf) { return gunzipSync(buf); }

export function tryGunzip(buf) {
  try { return gunzipSync(buf); }
  catch { return null; }
}

// ─── Envelope wrapping ─────────────────────────────────────

/**
 * Wrap protobuf bytes in a Connect-RPC envelope frame.
 */
export function wrapEnvelope(protoBuf, { compress = true } = {}) {
  let payload = protoBuf;
  let flags = 0;
  if (compress && payload.length > 0) {
    payload = gzipSync(payload);
    flags |= 0x01;
  }
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

/**
 * Wrap a request for sending (single envelope, gzipped).
 */
export function wrapRequest(protoBuf) {
  return wrapEnvelope(protoBuf, { compress: true });
}

/**
 * Build the end-of-stream trailer frame (JSON {}).
 */
export function endOfStreamEnvelope() {
  const trailer = Buffer.from('{}');
  const frame = Buffer.alloc(5 + trailer.length);
  frame[0] = 0x02; // end-of-stream, not compressed
  frame.writeUInt32BE(trailer.length, 1);
  trailer.copy(frame, 5);
  return frame;
}

// ─── Request unwrapping ────────────────────────────────────

/**
 * Unwrap a Connect-RPC request body → raw protobuf bytes.
 * Handles both envelope-wrapped and HTTP-level gzip.
 */
export function unwrapRequest(body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);

  // HTTP-level content-encoding gzip
  const encoding = headers['content-encoding'] || headers['connect-content-encoding'] || '';
  if (encoding === 'gzip') {
    buf = gunzipSync(buf);
  }

  // Check if it's envelope-wrapped (flags byte + 4-byte length)
  if (buf.length >= 5) {
    const flags = buf[0];
    const len = buf.readUInt32BE(1);
    if (len === buf.length - 5 && (flags === 0 || flags === 1)) {
      let payload = buf.subarray(5);
      if (flags & 0x01) payload = gunzipSync(payload);
      return payload;
    }
  }

  return buf;
}

// ─── Streaming frame parser ───────────────────────────────

/**
 * Stateful parser that buffers incoming data and yields complete frames.
 */
export class StreamingFrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  /** Drain all complete frames. Returns [{ flags, isEndStream, payload }]. */
  drain() {
    // Guard against malformed upstream frames that advertise absurd lengths —
    // without this, Buffer.concat() will happily try to allocate gigabytes.
    const MAX_FRAME_SIZE = 16 * 1024 * 1024;
    const frames = [];
    while (this.buffer.length >= 5) {
      const len = this.buffer.readUInt32BE(1);
      if (len > MAX_FRAME_SIZE) {
        throw new Error(`HTTP/2 frame size ${len} exceeds ${MAX_FRAME_SIZE}`);
      }
      if (this.buffer.length < 5 + len) break;

      const flags = this.buffer[0];
      let payload = this.buffer.subarray(5, 5 + len);
      if (flags & 0x01) {
        try { payload = gunzipSync(payload); }
        catch (err) {
          // Don't silently drop a frame whose body we couldn't decompress —
          // upstream is sending something we don't understand and the caller
          // needs to know so the stream can be cancelled rather than continued
          // with missing data.
          throw new Error(`Connect frame decompression failed: ${err.message}`);
        }
      }

      frames.push({
        flags,
        isEndStream: !!(flags & 0x02),
        payload,
      });
      this.buffer = this.buffer.subarray(5 + len);
    }
    return frames;
  }
}

// ─── Connect-RPC headers ──────────────────────────────────

export function connectHeaders(extra = {}) {
  return {
    'Content-Type': 'application/connect+proto',
    'Connect-Protocol-Version': '1',
    'Connect-Accept-Encoding': 'gzip',
    'User-Agent': 'connect-es/2.0.0',
    ...extra,
  };
}
