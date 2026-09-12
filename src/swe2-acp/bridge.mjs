import { spawn } from 'node:child_process';
import readline from 'node:readline';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { isModelAllowed } from '../dashboard/model-access.js';
import {
  sweModel,
  hash,
  conversationKey,
  isPrefix,
  toolDefinitions,
  buildPrompt,
  contentText,
  errorInfo,
  newToolCallId,
  isPendingAction,
  clientPermissionDenial,
} from './protocol.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Set(),
  pendingCalls = new Map();
const TTL = 30 * 60_000,
  MAX_SESSIONS = 12;
function diagnostic(s, event, extra = {}) {
  console.log(
    '[INFO] SWE2_ACP ' +
      JSON.stringify({
        session: s?.id?.slice(0, 12),
        model: s?.model,
        event,
        ...extra,
      }),
  );
}
class Session {
  constructor(body, context) {
    this.model = sweModel(body.model, body.reasoning_effort);
    this.owner = context.callerKey || '';
    this.defs = toolDefinitions(body);
    this.schemaHash = hash(this.defs);
    this.instructionHash = hash(
      body.messages.filter((m) => ['system', 'developer'].includes(m.role)),
    );
    this.calls = new Map();
    this.events = [];
    this.waiter = null;
    this.rpc = new Map();
    this.nextId = 0;
    this.closed = false;
    this.busy = false;
    this.lastUsed = Date.now();
    this.active = false;
    this.lastConversation = [];
    this.pendingInput = null;
  }
  push(event) {
    if (this.closed) return;
    this.events.push(event);
    this.waiter?.();
    this.waiter = null;
  }
  request(method, params, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId,
        timer =
          timeout > 0
            ? setTimeout(() => {
                this.rpc.delete(id);
                reject(
                  Object.assign(new Error(`Devin ACP ${method} timed out`), {
                    code: 'ACP_TIMEOUT',
                  }),
                );
              }, timeout)
            : null;
      this.rpc.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        (e) => {
          if (e) {
            this.rpc.get(id)?.reject(e);
            this.rpc.delete(id);
          }
        },
      );
    });
  }
  async start() {
    const ensureOpen = () => {
      if (this.closed) throw new Error('ACP session closed during startup');
    };
    ensureOpen();
    const data =
      process.env.DEVIN_SWE2_ACP_DATA ||
      path.join(homedir(), '.local/share/windsurfapi/swe2-acp');
    await mkdir(data, { recursive: true, mode: 0o700 });
    ensureOpen();
    this.dir = await mkdtemp(path.join(data, 'session-'));
    ensureOpen();
    await mkdir(path.join(this.dir, '.devin'), { mode: 0o700 });
    ensureOpen();
    let userConfig = {};
    try {
      userConfig = JSON.parse(
        await readFile(
          path.join(homedir(), '.config/devin/config.json'),
          'utf8',
        ),
      );
    } catch {}
    ensureOpen();
    const cfg = {
      version: userConfig.version || 1,
      devin: userConfig.devin || {},
      agent: { model: this.model },
      auto_update: false,
      subagents_enabled: false,
      read_config_from: { cursor: false, windsurf: false, claude: false },
      permissions: {
        deny: [
          'read',
          'edit',
          'grep',
          'glob',
          'exec',
          'Read(**)',
          'Write(**)',
          'Bash(*)',
          'WebFetch(*)',
        ],
        allow: ['mcp__client__*'],
      },
    };
    const cfgPath = path.join(this.dir, 'adapter-config.json');
    await writeFile(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
    ensureOpen();
    this.token = randomBytes(32).toString('hex');
    this.server = http.createServer((req, res) =>
      this.mcp(req, res).catch((e) => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end('MCP relay error');
        }
      }),
    );
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    ensureOpen();
    const mcp = {
      mcpServers: {
        client: {
          command: process.execPath,
          args: [path.join(here, 'mcp-relay.mjs')],
          env: {
            SWE2_RELAY_PORT: String(this.server.address().port),
            SWE2_RELAY_TOKEN: this.token,
          },
        },
      },
    };
    await writeFile(
      path.join(this.dir, '.devin/mcp_config.local.json'),
      JSON.stringify(mcp),
      { mode: 0o600 },
    );
    ensureOpen();
    // The CLI owns its account credentials. Do not inherit the proxy's API keys.
    const env = {};
    for (const key of [
      'HOME',
      'USERPROFILE',
      'PATH',
      'TMPDIR',
      'TMP',
      'TEMP',
      'LANG',
      'LC_ALL',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'APPDATA',
      'LOCALAPPDATA',
      'SystemRoot',
      'COMSPEC',
      'PATHEXT',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      if (process.env[key] != null) env[key] = process.env[key];
    }
    env.NO_COLOR = '1';
    this.child = spawn(
      process.env.DEVIN_CLI_PATH || path.join(homedir(), '.local/bin/devin'),
      ['--config', cfgPath, 'acp', '--model', this.model],
      {
        cwd: this.dir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    this.child.stdin.on('error', (e) => this.fail(e));
    this.child.on('error', (e) => this.fail(e));
    this.child.stderr.on('data', () => {});
    this.child.once('close', (code) => {
      if (!this.closed) this.fail(new Error(`Devin ACP exited (${code})`));
    });
    readline
      .createInterface({ input: this.child.stdout })
      .on('line', (line) => this.receive(line));
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'windsurfapi-client-tool-bridge', version: '1.0.0' },
    });
    ensureOpen();
    if (init.protocolVersion !== 1)
      throw new Error('Unsupported Devin ACP protocol version');
    const session = await this.request('session/new', {
      cwd: this.dir,
      mcpServers: [],
    });
    ensureOpen();
    this.id = session.sessionId;
    const actual =
      session.configOptions?.find((o) => o.id === 'model')?.currentValue ||
      session.models?.currentModelId;
    if (!this.id || actual !== this.model)
      throw new Error(
        `Devin ACP model mismatch: expected ${this.model}, received ${actual || 'unknown'}`,
      );
    diagnostic(this, 'ready', {
      tools: this.defs.length,
      instructionsPreserved: true,
    });
  }
  receive(line) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (d.id != null && !d.method) {
      const p = this.rpc.get(d.id);
      this.rpc.delete(d.id);
      if (d.error)
        p?.reject(
          Object.assign(new Error(d.error.message || 'ACP error'), {
            code: d.error.code,
          }),
        );
      else p?.resolve(d.result);
      return;
    }
    if (d.method && d.id != null) {
      let result = null;
      if (d.method === 'session/request_permission') {
        // MCP execution remains pending until the caller actually executes and
        // returns its tool result. All native permission requests are denied.
        // The dedicated config allows the relay only. Never approve an unexpected
        // native or third-party tool by inspecting free-form request prose.
        const option = d.params?.options?.find((o) => o.kind === 'reject_once');
        result = {
          outcome: option
            ? { outcome: 'selected', optionId: option.optionId }
            : { outcome: 'cancelled' },
        };
        diagnostic(this, 'unexpected_permission_denied');
      }
      this.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: d.id,
          ...(result
            ? { result }
            : {
                error: {
                  code: -32601,
                  message:
                    'Native execution is unavailable in this client tool adapter.',
                },
              }),
        }) + '\n',
      );
      return;
    }
    if (d.method === 'session/update') {
      const u = d.params?.update;
      if (
        u?.sessionUpdate === 'agent_message_chunk' &&
        u.content?.type === 'text'
      )
        this.push({ type: 'text', text: u.content.text });
      // Thought chunks are not mixed into the answer or required to continue.
    }
  }
  async mcp(req, res) {
    if (
      req.method !== 'POST' ||
      req.url !== '/mcp' ||
      req.headers.authorization !== `Bearer ${this.token}`
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    let raw = '',
      size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > 16 * 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
      raw += part;
    }
    let rpc;
    try {
      rpc = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const send = (result) => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      }
    };
    if (rpc.method === 'initialize') {
      send({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'client', version: '1.0.0' },
      });
      return;
    }
    if (rpc.method === 'tools/list') {
      send({
        tools: [
          {
            name: 'list_client_tools',
            description:
              'List names and short summaries of all functions available in the calling client. Use get_client_tools to retrieve complete descriptions and parameter schemas before calling a function.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description:
                    'Optional case-insensitive substring to filter names and descriptions.',
                },
                offset: { type: 'integer', minimum: 0 },
              },
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'get_client_tools',
            description:
              'Retrieve the complete original descriptions and JSON parameter schemas for selected client functions. No fields or instructions are removed.',
            inputSchema: {
              type: 'object',
              properties: {
                names: {
                  type: 'array',
                  items: { type: 'string' },
                  maxItems: 5,
                },
                offset: {
                  type: 'integer',
                  minimum: 0,
                  description:
                    'For a large schema, continue the JSON fragment at the returned nextOffset.',
                },
              },
              required: ['names'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'call_client_tool',
            description:
              'Call an existing client function with arguments matching its original schema. Execution and approval happen in the client. Returns its actual result.',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                arguments: { type: 'object', additionalProperties: true },
              },
              required: ['name', 'arguments'],
              additionalProperties: false,
            },
          },
        ],
      });
      return;
    }
    if (rpc.method === 'ping') {
      send({});
      return;
    }
    if (rpc.method === 'tools/call') {
      const input = rpc.params?.arguments || {};
      if (rpc.params?.name === 'list_client_tools') {
        const q = String(input.query || '').toLowerCase();
        const matches = this.defs.filter(
          (x) =>
            !q ||
            (x.originalName + ' ' + x.description).toLowerCase().includes(q),
        );
        const offset = Math.max(0, Math.trunc(Number(input.offset) || 0));
        send({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                count: matches.length,
                nextOffset: offset + 40 < matches.length ? offset + 40 : null,
                tools: matches.slice(offset, offset + 40).map((x) => ({
                  name: x.originalName,
                  summary: x.description.slice(0, 160),
                  fullSchemaAvailable: true,
                })),
              }),
            },
          ],
        });
        return;
      }
      if (rpc.params?.name === 'get_client_tools') {
        const names = Array.isArray(input.names) ? input.names.slice(0, 5) : [];
        const schemaText = JSON.stringify(
          names.map((name) => {
            const d = this.defs.find((x) => x.originalName === name);
            return d
              ? { name, description: d.description, inputSchema: d.inputSchema }
              : { name, error: 'Unknown client function' };
          }),
        );
        const offset = Math.max(0, Math.trunc(Number(input.offset) || 0));
        const text =
          Buffer.byteLength(schemaText) <= 16000 && !offset
            ? schemaText
            : JSON.stringify({
                format: 'json_fragment',
                offset,
                totalChars: schemaText.length,
                nextOffset:
                  offset + 4000 < schemaText.length ? offset + 4000 : null,
                fragment: schemaText.slice(offset, offset + 4000),
                instruction:
                  'Concatenate fragments in offset order to recover the complete original schema. Request the same names with nextOffset until null.',
              });
        send({ content: [{ type: 'text', text }] });
        return;
      }
      const def =
        rpc.params?.name === 'call_client_tool'
          ? this.defs.find((x) => x.originalName === input.name)
          : null;
      if (!def) {
        send({
          isError: true,
          content: [{ type: 'text', text: 'Unknown client function.' }],
        });
        return;
      }
      // Keep IDs below client normalization limits (OmO rewrites long IDs).
      const id = newToolCallId();
      const call = {
        id,
        type: 'function',
        function: {
          name: def.originalName,
          arguments: JSON.stringify(input.arguments || {}),
        },
      };
      const pending = { session: this, call, send };
      this.calls.set(id, pending);
      pendingCalls.set(id, pending);
      this.push({ type: 'tool', call });
      diagnostic(this, 'client_tool', { name: def.originalName, id });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32601, message: 'Unsupported MCP method' },
      }),
    );
  }
  begin(messages, body, initial) {
    if (this.active) throw new Error('A Devin prompt is already active');
    this.active = true;
    // One ACP prompt spans many client tool turns. Bound each response wait in
    // take() and idle sessions in the reaper, not the total useful work duration.
    this.request(
      'session/prompt',
      {
        sessionId: this.id,
        prompt: [
          { type: 'text', text: buildPrompt(messages, body, { initial }) },
        ],
      },
      0,
    ).then(
      (result) => {
        this.active = false;
        this.push({ type: 'done', result });
      },
      (e) => {
        this.active = false;
        this.push({ type: 'error', error: e });
      },
    );
  }
  fail(e) {
    for (const p of this.rpc.values()) p.reject(e);
    this.rpc.clear();
    this.push({ type: 'error', error: e });
  }
  async take(signal) {
    if (signal?.aborted) throw new Error('Client disconnected');
    while (!this.events.length) {
      if (this.closed || signal?.aborted)
        throw new Error('Client disconnected');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new Error('Devin response timed out'));
        }, 10 * 60_000);
        const abort = () => {
          clearTimeout(timer);
          this.waiter = null;
          reject(new Error('Client disconnected'));
        };
        this.waiter = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return this.events.shift();
  }
  async close() {
    // Cleanup may run again after an interrupted startup finishes an awaited
    // allocation. No resource created after the first close may be orphaned.
    this.closed = true;
    sessions.delete(this);
    this.waiter?.();
    for (const [id, p] of this.calls) {
      pendingCalls.delete(id);
      p.send({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Client session ended before a tool result was returned.',
          },
        ],
      });
    }
    this.calls.clear();
    for (const p of this.rpc.values())
      p.reject(new Error('ACP session closed'));
    this.rpc.clear();
    const child = this.child;
    const signalTree = (signal) => {
      try {
        if (child?.pid && process.platform !== 'win32') {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {}
      try {
        child?.kill(signal);
      } catch {}
    };
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => signalTree('SIGKILL'), 2000);
        const endTimer = setTimeout(resolve, 5000);
        child.once('close', () => {
          clearTimeout(killTimer);
          clearTimeout(endTimer);
          resolve();
        });
        signalTree('SIGTERM');
      });
    }
    this.server?.closeAllConnections();
    this.server?.close();
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
async function acquire(body, context) {
  if (!Array.isArray(body.messages) || !body.messages.length)
    throw Object.assign(new Error('messages must be a nonempty array'), {
      status: 400,
    });
  const owner = context.callerKey || '',
    model = sweModel(body.model, body.reasoning_effort),
    defs = toolDefinitions(body),
    schemaHash = hash(defs);
  const toolMessages = body.messages.filter(
    (m) => m.role === 'tool' && pendingCalls.has(m.tool_call_id),
  );
  if (
    new Set(toolMessages.map((m) => m.tool_call_id)).size !==
    toolMessages.length
  )
    throw Object.assign(new Error('Duplicate pending tool result'), {
      status: 400,
    });
  if (!toolMessages.length && pendingCalls.size) {
    const pending = [...pendingCalls.values()].filter(
      (p) => p.session.owner === owner && p.session.model === model,
    );
    if (pending.length)
      diagnostic(null, 'pending_result_mismatch', {
        roles: body.messages.slice(-4).map((m) => m.role),
        incomingIds: body.messages
          .filter((m) => m.role === 'tool')
          .slice(-3)
          .map((m) => m.tool_call_id),
        pendingIds: pending.map((p) => p.call.id),
      });
  }
  const denied = clientPermissionDenial(body.messages);
  const denialError = () =>
    Object.assign(
      new Error(
        'Client tool permission was rejected. This SWE-2 turn has stopped; no alternative tool will execute. ' +
          denied,
      ),
      {
        status: 403,
        type: 'permission_error',
        code: 'CLIENT_TOOL_PERMISSION_DENIED',
      },
    );
  let s;
  if (toolMessages.length) {
    const found = new Set(
      toolMessages.map((m) => pendingCalls.get(m.tool_call_id).session),
    );
    if (found.size !== 1)
      throw Object.assign(
        new Error('Tool results span different client sessions'),
        { status: 400 },
      );
    s = [...found][0];
    if (s.owner !== owner || s.model !== model) {
      diagnostic(s, 'tool_context_changed', {
        sameOwner: s.owner === owner,
        nextModel: model,
        sameSchema: s.schemaHash === schemaHash,
        oldToolCount: s.defs?.length,
        newToolCount: defs.length,
      });
      throw Object.assign(
        new Error('Tool result does not match its client session/model/schema'),
        { status: 409 },
      );
    }
    if (s.busy)
      throw Object.assign(
        new Error('This conversation already has an active request'),
        { status: 409 },
      );
    if (denied) {
      diagnostic(s, 'client_permission_denied');
      await s.close();
      throw denialError();
    }
    const instructions = hash(
      body.messages.filter((m) => ['system', 'developer'].includes(m.role)),
    );
    const sequence = conversationKey(body.messages);
    const hasNewMessages = sequence
      .slice(s.lastConversation.length)
      .some((m) => m.role !== 'tool');
    if (
      instructions !== s.instructionHash ||
      !isPrefix(s.lastConversation, sequence) ||
      hasNewMessages
    ) {
      // An active ACP prompt cannot accept new system/user instructions while
      // waiting on MCP. End that prompt before releasing its tool result, then
      // replay the complete updated transcript into a fresh session. The real
      // client result stays in that transcript; no tool is re-executed here.
      await s.close();
      return acquire(body, context);
    }
    // OmO discovers MCP/LSP tools lazily, so its catalog can change after a
    // successful read. The unguessable pending ID and caller/model identify the
    // result; refresh subsequent tool discovery from the client's newest schema.
    if (s.schemaHash !== schemaHash) {
      s.defs = defs;
      s.schemaHash = schemaHash;
      diagnostic(s, 'client_tools_refreshed', { tools: defs.length });
    }
  } else {
    if (denied) throw denialError();
    const seq = conversationKey(body.messages),
      ih = hash(
        body.messages.filter((m) => ['system', 'developer'].includes(m.role)),
      );
    const matches = [...sessions].filter(
      (x) =>
        !x.active &&
        !x.busy &&
        !x.closed &&
        x.owner === owner &&
        x.model === model &&
        x.schemaHash === schemaHash &&
        x.instructionHash === ih &&
        x.lastConversation.length &&
        isPrefix(x.lastConversation, seq) &&
        seq.length > x.lastConversation.length,
    );
    if (matches.length === 1) {
      s = matches[0];
      s.begin(seq.slice(s.lastConversation.length), body, false);
    } else {
      if (sessions.size >= MAX_SESSIONS) {
        const idle = [...sessions]
          .filter((x) => !x.active && !x.busy)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (idle) await idle.close();
        else
          throw Object.assign(
            new Error(
              'SWE-2 session capacity reached; finish an active client turn first.',
            ),
            { status: 429 },
          );
      }
      s = new Session(body, context);
      s.busy = true;
      sessions.add(s);
      try {
        await s.start();
        if (s.closed) throw new Error('ACP session closed during startup');
        s.begin(body.messages, body, true);
      } catch (e) {
        await s.close();
        throw e;
      }
    }
  }
  s.busy = true;
  s.lastUsed = Date.now();
  for (const m of toolMessages) {
    const p = pendingCalls.get(m.tool_call_id);
    pendingCalls.delete(m.tool_call_id);
    s.calls.delete(m.tool_call_id);
    p.send({ content: [{ type: 'text', text: contentText(m.content) }] });
  }
  return s;
}
async function run(body, context, onText) {
  if (context.signal?.aborted) throw new Error('Client disconnected');
  const s = await acquire(body, context);
  let text = '',
    continuations = 0,
    iterationStart = 0;
  try {
    while (true) {
      const event = await s.take(context.signal);
      if (event.type === 'error') throw event.error;
      if (event.type === 'text') {
        text += event.text;
        onText?.(event.text);
        continue;
      }
      if (event.type === 'tool') {
        const message = {
          role: 'assistant',
          content: text || null,
          tool_calls: [event.call],
        };
        s.lastConversation = conversationKey([...body.messages, message]);
        return { message, finish: 'tool_calls', usage: null };
      }
      if (event.type === 'done') {
        if (event.result.stopReason !== 'end_turn')
          throw new Error(`Devin stopped with ${event.result.stopReason}`);
        if (s.defs.length && isPendingAction(text.slice(iterationStart))) {
          if (continuations++ < 1) {
            diagnostic(s, 'continue_announced_action');
            iterationStart = text.length;
            s.begin(
              [
                {
                  role: 'user',
                  content:
                    'Your last reply announced a pending action but returned no client function call. Continue the requested work now using client MCP functions and their complete schemas. Preserve all original instructions and permission checks. If the action cannot be performed, state the concrete blocker instead of announcing another future action.',
                },
              ],
              body,
              false,
            );
            continue;
          }
          throw Object.assign(
            new Error(
              'SWE-2 ended after announcing an action without returning a client tool call.',
            ),
            { status: 422, code: 'SWE2_TOOL_CALL_REQUIRED' },
          );
        }
        if (!text.trim())
          throw new Error(
            'Devin finished without an answer or client tool call',
          );
        const message = { role: 'assistant', content: text };
        s.lastConversation = conversationKey([...body.messages, message]);
        diagnostic(s, 'completed', { answerChars: text.length });
        return { message, finish: 'stop', usage: event.result.usage };
      }
    }
  } catch (e) {
    await s.close();
    throw e;
  } finally {
    s.busy = false;
    s.lastUsed = Date.now();
  }
}
export async function handleSwe2AcpChat(body, context = {}) {
  if (process.pkg)
    return {
      status: 503,
      body: {
        error: {
          type: 'server_error',
          code: 'ACP_SOURCE_INSTALL_REQUIRED',
          message:
            'SWE-2 ACP requires a source or npm installation; standalone executables cannot launch the MCP relay as Node.',
        },
      },
    };
  if (!sweModel(body.model))
    return {
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          message: 'The ACP transport only accepts SWE-2 models.',
        },
      },
    };
  if (!context.callerKey)
    return {
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          message: 'The ACP transport requires a server-derived caller key.',
        },
      },
    };
  if (!Array.isArray(body.messages) || !body.messages.length)
    return {
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          message: 'messages must be a nonempty array',
        },
      },
    };
  if (
    body.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((c) => c.type !== 'text' && c.type !== 'input_text'),
    )
  )
    return {
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          message: 'SWE-2 ACP currently accepts text content only.',
        },
      },
    };
  if (!body.reasoning_effort) {
    const pending = body.messages
      .map((m) =>
        m.role === 'tool' ? pendingCalls.get(m.tool_call_id)?.session : null,
      )
      .find((s) => s?.owner === context.callerKey);
    if (pending)
      body = {
        ...body,
        reasoning_effort: pending.model.match(/-(medium|high|max)$/)?.[1],
      };
  }
  const access = isModelAllowed(sweModel(body.model, body.reasoning_effort));
  if (!access.allowed)
    return {
      status: 403,
      body: { error: { message: access.reason, type: 'model_blocked' } },
    };
  const id = 'chatcmpl-' + randomUUID(),
    created = Math.floor(Date.now() / 1000),
    model = body.model;
  const usage = (u) => ({
    prompt_tokens: u?.inputTokens || 0,
    completion_tokens: u?.outputTokens || 0,
    total_tokens: u?.totalTokens || 0,
  });
  if (!body.stream) {
    try {
      const r = await run(body, context);
      return {
        status: 200,
        body: {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: r.message, finish_reason: r.finish }],
          usage: usage(r.usage),
        },
      };
    } catch (e) {
      const { status, ...error } = errorInfo(e);
      return { status, body: { error } };
    }
  }
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
    handler: async (res) => {
      const controller = new AbortController(),
        abort = () => controller.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      if (context.signal?.aborted) abort();
      const close = () => {
        if (!res.writableEnded) abort();
      };
      res.on?.('close', close);
      const send = (data) => {
        if (!res.writableEnded && !controller.signal.aborted)
          res.write('data: ' + JSON.stringify(data) + '\n\n');
      };
      const frame = (delta, finish = null, u) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(u ? { usage: usage(u) } : {}),
      });
      const ping = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, 10000);
      try {
        send(frame({ role: 'assistant' }));
        const r = await run(
          body,
          { ...context, signal: controller.signal },
          (text) => send(frame({ content: text })),
        );
        if (r.message.tool_calls)
          send(
            frame({
              tool_calls: r.message.tool_calls.map((c, i) => ({
                index: i,
                ...c,
              })),
            }),
          );
        send(frame({}, r.finish, r.usage));
      } catch (e) {
        const { status, ...error } = errorInfo(e);
        send({ error });
      } finally {
        clearInterval(ping);
        context.signal?.removeEventListener('abort', abort);
        res.off?.('close', close);
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    },
  };
}
const reap = setInterval(() => {
  for (const s of sessions)
    if (!s.busy && Date.now() - s.lastUsed > TTL) s.close().catch(() => {});
}, 60000);
reap.unref();
export async function closeAllSessions() {
  await Promise.allSettled([...sessions].map((s) => s.close()));
}
export const __test = { Session, acquire, sessions, pendingCalls };

process.once('exit', () => {
  for (const s of sessions) {
    try {
      if (s.child?.pid && process.platform !== 'win32')
        process.kill(-s.child.pid, 'SIGTERM');
      else s.child?.kill('SIGTERM');
    } catch {}
  }
});
