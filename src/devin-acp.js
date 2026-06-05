import { spawn } from 'child_process';
import { VERSION } from './version.js';

function intEnv(name, fallback, min = 0) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function runTimeoutMs() {
  return intEnv('DEVIN_TIMEOUT_MS', 10 * 60_000, 1000);
}

function outputLimitBytes() {
  return intEnv('DEVIN_OUTPUT_LIMIT_BYTES', 4 * 1024 * 1024, 1024);
}

function parseAcpArgs() {
  const raw = process.env.DEVIN_CLI_ACP_ARGS_JSON || '';
  if (!raw.trim()) return ['acp'];
  try {
    const args = JSON.parse(raw);
    if (!Array.isArray(args) || !args.every(x => typeof x === 'string')) {
      throw new Error('must be a JSON string array');
    }
    return args;
  } catch (err) {
    throw Object.assign(new Error(`Invalid DEVIN_CLI_ACP_ARGS_JSON: ${err.message}`), {
      status: 500,
      type: 'backend_misconfigured',
    });
  }
}

function writeJsonLine(child, payload) {
  if (!child.stdin?.writable) return;
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function errorFromRpcResponse(resp, fallback = 'ACP request failed') {
  const msg = resp?.error?.message || fallback;
  const err = new Error(msg);
  err.status = 502;
  err.type = 'backend_error';
  return err;
}

function extractAcpUpdate(params) {
  const update = params?.update || params?.sessionUpdate || params;
  const kind = update?.sessionUpdate || update?.type || update?.kind || update?.name || '';
  let text = '';
  const content = update?.content || update?.delta || update?.message || null;
  if (typeof update?.text === 'string') text = update.text;
  else if (typeof content === 'string') text = content;
  else if (typeof content?.text === 'string') text = content.text;
  else if (Array.isArray(content)) {
    text = content
      .map(part => typeof part === 'string' ? part : (part?.text || ''))
      .filter(Boolean)
      .join('');
  }
  return { kind: String(kind || ''), text };
}

function collectAcpTextFromNotification(obj, chunks) {
  if (obj?.method !== 'session/update') return;
  const { kind, text } = extractAcpUpdate(obj.params || {});
  if (!text) return;
  if (kind === 'agent_message_chunk' || kind === 'agent_message_delta' || kind === 'assistant_message_chunk') {
    chunks.push(text);
  }
}

function makeAcpClient({ command, args, env, signal, timeoutMs, outputLimit }) {
  const child = spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let stderr = '';
  let outputBytes = 0;
  let closed = false;
  let closeCode = null;
  let fatalError = null;
  let stdoutBuffer = '';
  const pending = new Map();
  const messageChunks = [];

  const cleanup = () => {
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
  };

  const failAll = (err) => {
    fatalError = fatalError || err;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  };

  const onData = (name, chunk) => {
    const s = chunk.toString('utf8');
    outputBytes += Buffer.byteLength(s);
    if (outputBytes > outputLimit) {
      const err = Object.assign(new Error(`Devin ACP output exceeded ${outputLimit} bytes`), {
        status: 502,
        type: 'backend_output_too_large',
      });
      failAll(err);
      child.kill('SIGTERM');
      return;
    }
    if (name === 'stderr') {
      stderr += s;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
      return;
    }
    stdoutBuffer += s;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = parseJsonLine(line);
      if (!obj) continue;
      collectAcpTextFromNotification(obj, messageChunks);
      if (obj.method === 'session/request_permission' && obj.id != null) {
        writeJsonLine(child, {
          jsonrpc: '2.0',
          id: obj.id,
          result: { outcome: 'cancelled' },
        });
        continue;
      }
      if (obj.id == null) continue;
      const waiter = pending.get(obj.id);
      if (!waiter) continue;
      pending.delete(obj.id);
      clearTimeout(waiter.timer);
      waiter.resolve(obj);
    }
  };

  child.stdout.on('data', c => onData('stdout', c));
  child.stderr.on('data', c => onData('stderr', c));
  child.on('error', err => {
    if (err.code === 'ENOENT') {
      failAll(Object.assign(new Error(`Devin CLI not found: ${command}`), {
        status: 503,
        type: 'backend_unavailable',
      }));
    } else {
      failAll(Object.assign(err, { status: 502, type: 'backend_error' }));
    }
  });
  child.on('close', code => {
    closed = true;
    closeCode = code;
    const err = fatalError || Object.assign(new Error(`Devin ACP exited with code ${code}`), {
      status: 502,
      type: 'backend_error',
    });
    if (code !== 0) failAll(err);
    else cleanup();
  });

  const onAbort = () => {
    const err = Object.assign(new Error('Request aborted'), { status: 499, type: 'request_aborted' });
    failAll(err);
    child.kill('SIGTERM');
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const request = (method, params = {}, timeout = timeoutMs) => {
    if (closed) {
      return Promise.reject(Object.assign(new Error(`Devin ACP is closed (code ${closeCode})`), {
        status: 502,
        type: 'backend_error',
      }));
    }
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`Devin ACP ${method} timed out after ${timeout}ms`), {
          status: 504,
          type: 'backend_timeout',
        }));
      }, timeout);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      writeJsonLine(child, payload);
    });
  };

  const close = () => {
    if (signal) signal.removeEventListener('abort', onAbort);
    cleanup();
    if (!closed) child.kill('SIGTERM');
  };

  return {
    request,
    close,
    getText: () => messageChunks.join('').trim(),
    getStderr: () => stderr.trim(),
  };
}

export async function runDevinAcpProcess(prompt, { modelKey = '', apiKey = '', apiServerUrl = '', signal = null } = {}) {
  if (!apiKey) {
    throw Object.assign(new Error('Devin ACP mode requires an upstream Windsurf account apiKey.'), {
      status: 503,
      type: 'backend_unavailable',
    });
  }
  const command = process.env.DEVIN_CLI_PATH || 'devin';
  const env = { ...process.env };
  const args = parseAcpArgs();
  const client = makeAcpClient({
    command,
    args,
    env,
    signal,
    timeoutMs: runTimeoutMs(),
    outputLimit: outputLimitBytes(),
  });

  try {
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'WindsurfAPI', version: VERSION },
    }, 30_000);
    if (init.error) throw errorFromRpcResponse(init, 'Devin ACP initialize failed');

    const authMeta = {
      api_key: apiKey,
      ...(apiServerUrl ? { api_server_url: apiServerUrl } : {}),
    };
    const auth = await client.request('authenticate', {
      methodId: 'windsurf-api-key',
      _meta: authMeta,
    }, 45_000);
    if (auth.error) throw errorFromRpcResponse(auth, 'Devin ACP authenticate failed');

    const session = await client.request('session/new', {
      cwd: process.env.DEVIN_CLI_WORKDIR || process.cwd(),
      mcpServers: [],
    }, 60_000);
    if (session.error) throw errorFromRpcResponse(session, 'Devin ACP session/new failed');
    const sessionId = session?.result?.sessionId || session?.result?.session_id;
    if (!sessionId) {
      throw Object.assign(new Error('Devin ACP session/new did not return sessionId'), {
        status: 502,
        type: 'backend_error',
      });
    }

    const modelHint = modelKey ? `Model requested by caller: ${modelKey}\n\n` : '';
    const result = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${modelHint}${prompt}` }],
    }, runTimeoutMs());
    if (result.error) throw errorFromRpcResponse(result, 'Devin ACP session/prompt failed');

    return {
      text: client.getText(),
      stderr: client.getStderr(),
      usage: result?.result?.usage || null,
    };
  } finally {
    client.close();
  }
}
