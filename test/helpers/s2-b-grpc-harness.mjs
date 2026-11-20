import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

let sequence = 0;
export async function loadGrpc({ before = false, connect = false } = {}) {
  const root = new URL('../../', import.meta.url);
  const file = new URL(before ? 'test/fixtures/s2-b-grpc-before.mjs' : 'src/grpc.js', root);
  let source = readFileSync(file, 'utf8');
  // Only transport-adjacent logging is stubbed. The entire grpcStream function,
  // event handlers, size guards, and timers are the production/frozen source.
  for (const [find, replacement] of [
    ["import { log } from './config.js';", 'const log = { debug() {} };'],
    ["import { traceGrpcPayload } from './proto-trace.js';", 'function traceGrpcPayload() {}'],
    ["from './connect.js';", `from '${new URL(before ? 'test/fixtures/s2-b-connect-before.mjs' : 'src/connect.js', root).href}';`],
  ]) {
    assert.equal(source.split(find).length - 1, 1, `Harness import anchor changed: ${find}`);
    source = source.replace(find, replacement);
  }
  const saved = process.env.GRPC_PROTOCOL;
  process.env.GRPC_PROTOCOL = connect ? 'connect' : 'grpc';
  try {
    // A unique URL keeps protocol selection and session pools isolated per load.
    return await import(`data:text/javascript;base64,${Buffer.from(source + `\n// harness ${++sequence}\n`).toString('base64')}`);
  } finally {
    if (saved === undefined) delete process.env.GRPC_PROTOCOL;
    else process.env.GRPC_PROTOCOL = saved;
  }
}

export function startStream(module, options = {}) {
  const req = new EventEmitter(), session = new EventEmitter();
  const events = [], payloads = [], closeCodes = [];
  let headers;
  req.write = () => true; req.end = () => {};
  req.close = code => closeCodes.push(code);
  session.request = value => { headers = value; return req; };
  session.unref = () => {};
  session.close = () => { session.closed = true; };
  const port = 12345;
  const savedConnect = http2.connect;
  http2.connect = () => session;
  try {
    module.grpcStream(port, 's2-test-csrf', '/s2/test', Buffer.alloc(0), {
      signal: options.signal,
      onData(payload) { payloads.push(payload); events.push(['data', payload.length]); options.onData?.(payload); },
      onError(error) { events.push(['error', error.constructor.name, error.message]); },
      onEnd() { events.push(['end']); },
    });
  } finally {
    http2.connect = savedConnect;
  }
  return {
    req, payloads, events, closeCodes, headers,
    cleanup() { req.emit('end'); module.closeSessionForPort(port); },
  };
}

// Unary sibling of startStream: same stubbed session, but the call settles a
// promise instead of invoking callbacks, and the request body the module
// actually writes is captured so a test can assert the wire framing.
let unaryPort = 24000;
export function startUnary(module, options = {}) {
  const req = new EventEmitter(), session = new EventEmitter();
  const closeCodes = [], written = [];
  let headers;
  req.write = (chunk) => { written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; };
  req.end = () => {};
  req.close = code => closeCodes.push(code);
  session.request = value => { headers = value; return req; };
  session.unref = () => {};
  session.close = () => { session.closed = true; };
  // A port per call: the module keeps a session pool keyed by port, and a
  // reused key would hand this call the previous fake session.
  const port = ++unaryPort;
  const savedConnect = http2.connect;
  http2.connect = () => session;
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  try {
    module.grpcUnary(port, 's2-test-csrf', '/s2/test', options.body ?? Buffer.alloc(0), options.timeout ?? 1000)
      .then(payload => settle({ ok: true, payload }), error => settle({ ok: false, error }));
  } finally {
    http2.connect = savedConnect;
  }
  return {
    req, closeCodes, settled,
    get headers() { return headers; },
    get body() { return Buffer.concat(written); },
    cleanup() { module.closeSessionForPort(port); },
  };
}

export function grpcFrame(payload, flags = 0) {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags; frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5);
  return frame;
}
