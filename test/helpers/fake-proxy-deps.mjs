// Capture-only stand-ins for the three imports https-proxy.js takes (http2,
// http, fs), substituted at the import boundary by test/https-proxy-policy.test.js.
// Nothing listens, no certificate is read from disk, and no request leaves the
// process: the registered request handler is handed to the test instead.
import { FakeEmitter } from './fake-emitter.mjs';

export const captured = {
  handler: null,
  serverOptions: null,
  listen: null,
  certPaths: [],
  backendRequests: [],
};

class FakeServer extends FakeEmitter {
  listen(port, host, callback) {
    captured.listen = { port, host };
    if (callback) callback();
  }
}

export function createSecureServer(options, handler) {
  captured.serverOptions = options;
  captured.handler = handler;
  return new FakeServer();
}

class FakeClientRequest extends FakeEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.destroyCalls = 0;
    this.written = [];
  }

  destroy() {
    this.destroyCalls++;
    this.destroyed = true;
    return this;
  }

  write(chunk) {
    this.written.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk) this.written.push(Buffer.from(chunk));
    return this;
  }
}

export function request(options, callback) {
  const record = { options, callback, req: new FakeClientRequest(), res: null };
  captured.backendRequests.push(record);
  return record.req;
}

export const get = request;

export function readFileSync(path) {
  captured.certPaths.push(path);
  return Buffer.from('FAKE-PEM');
}

// Test-facing: answer backend request `index` with `status`/`headers`/`body`.
export function deliverBackend(index, { status = 200, headers = {}, body = '' } = {}) {
  const record = captured.backendRequests[index];
  if (!record) throw new Error(`no backend request at index ${index}`);
  const res = new FakeEmitter();
  res.statusCode = status;
  res.headers = headers;
  res.body = body;
  res.pipe = (dest) => {
    res.on('data', (chunk) => dest.write(chunk));
    res.on('end', () => dest.end());
    return dest;
  };
  record.res = res;
  record.callback(res);
  if (body) res.emit('data', Buffer.from(body));
  res.emit('end');
  return res;
}

export function reset() {
  // Only per-request state: serverOptions/listen/certPaths/captured.handler are
  // set once at import time and are asserted by the startup control.
  captured.backendRequests.length = 0;
}

export default { createSecureServer, request, get, readFileSync };
