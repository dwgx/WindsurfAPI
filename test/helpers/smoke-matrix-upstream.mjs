/**
 * Fixtures + scripted upstream for scripts/smoke-matrix.mjs.
 *
 * The matrix EXTENDS the dashboard smoke suite: it imports the same four
 * scripted transports (`scriptedLoginTransport`, `scriptedPostJson`,
 * `scriptedCatalogTransport`, `scriptedFetch`) and the same synthetic
 * credentials from `dashboard-smoke-upstream.mjs` instead of re-inventing a
 * fake upstream. What it adds here is the piece the dashboard suite never
 * needed — a scripted DEVIN_CONNECT event stream, so the four public protocol
 * fronts (OpenAI chat, Anthropic Messages, OpenAI Responses, Gemini) can run
 * the REAL adapters against deterministic bytes — plus the fake `devin acp`
 * stdio server that lets the ACP backend be smoked without the real CLI.
 *
 * Everything fails closed: an unrouted call throws, and the runner installs
 * scripts/mutation-network-deny.mjs as an independent egress barrier.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { MAX_FRAME_SIZE, tryGunzip, wrapEnvelope } from '../../src/connect.js';
import { getAllFields, getField, parseFields, writeStringField, writeVarintField } from '../../src/proto.js';

import { SMOKE_SECRETS } from './dashboard-smoke-upstream.mjs';

export {
  SMOKE,
  SMOKE_SECRETS,
  scriptedLoginTransport,
  scriptedPostJson,
  scriptedCatalogTransport,
  scriptedFetch,
} from './dashboard-smoke-upstream.mjs';


// A loopback HTTP peer for tests that need the real Connect encoder/decoder
// and socket delivery order. Only fixture credentials are recognized; the
// transport replaces their authorization header with a local slot number.
export async function startOfflineConnectStub({ tokens, scenario, model, parallelProbe = false, latencyMs = 0 }) {
  const attempts = [];
  const samples = [];
  const pair = Promise.withResolvers();
  const responses = scriptedConnectEvents();
  let inflight = 0;
  let peak = 0;
  function trailer(error) {
    const frame = wrapEnvelope(Buffer.from(JSON.stringify(error ? { error } : {})), { compress: false });
    frame[0] = 2;
    return frame;
  }
  const server = createServer(async (req, res) => {
    const slot = Number(req.headers['x-offline-slot']);
    if (req.method !== 'POST' || req.url !== '/exa.api_server_pb.ApiServerService/GetChatMessage' ||
        !Number.isInteger(slot) || slot < 0 || slot >= tokens.length) {
      res.writeHead(400).end(); return;
    }
    const chunks = [];
    let received = 0;
    for await (const part of req) {
      received += part.length;
      if (received > MAX_FRAME_SIZE + 5) { res.writeHead(413).end(); return; }
      chunks.push(part);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length < 6 || (bytes[0] & ~1) !== 0 || bytes.readUInt32BE(1) !== bytes.length - 5) {
      res.writeHead(400).end(); return;
    }
    // Read the same selector and user-content fields covered by the encoder
    // tests. Persist only the fixture's numeric turn number.
    let prompt, sample;
    try {
      const payload = bytes[0] === 1 ? tryGunzip(bytes.subarray(5)) : bytes.subarray(5);
      if (!payload) throw new Error('invalid compression');
      const fields = parseFields(payload);
      const selected = getField(fields, 21, 2)?.value.toString('utf8');
      const last = getAllFields(fields, 3).at(-1);
      prompt = getField(parseFields(last.value), 3, 2)?.value.toString('utf8');
      const marker = /^offline sample (\d+)$/.exec(prompt);
      if (selected !== model || !marker) throw new Error('unexpected fixture request');
      sample = Number(marker[1]);
    } catch { res.writeHead(400).end(); return; }
    const turn = attempts.length;
    attempts.push(slot);
    samples.push(sample);
    peak = Math.max(peak, ++inflight);
    try {
      if (parallelProbe && turn === 1) pair.resolve();
      if (parallelProbe && turn === 0) await Promise.race([pair.promise, delay(2000, undefined, { ref: false })]);
      if (latencyMs) await delay(latencyMs);
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      if (!turn && scenario !== 'ok') {
        if (scenario === 'postcommit') res.write(wrapEnvelope(writeStringField(3, 'partial fixture'), { compress: false }));
        res.end(trailer({ code: 'resource_exhausted', message: 'Message rate limit. Resets in: 30s.' }));
        return;
      }
      for await (const event of responses({ model, messages: [{ role: 'user', content: prompt }] })) {
        if (event.type === 'content') res.write(wrapEnvelope(writeStringField(3, event.text + ' #' + sample)));
        if (event.type === 'finish') res.write(wrapEnvelope(writeVarintField(5, 2)));
      }
      res.end(trailer());
    } catch { res.destroy(); }
    finally { inflight--; }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    attempts,
    samples,
    get peak() { return peak; },
    request(options, callback) {
      const slot = tokens.findIndex(token => options.headers.authorization === 'Basic ' + token + '-' + token);
      if (slot < 0) throw new Error('Unexpected upstream identity in offline Connect fixture');
      return request({ hostname: '127.0.0.1', port, path: options.path, method: options.method, signal: options.signal,
        headers: { 'content-type': 'application/connect+proto', 'x-offline-slot': String(slot) } }, callback);
    },
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

/** Extra synthetic credentials this suite mints (never printed). */
export const MATRIX = Object.freeze({
  // Second login identity that needs a password (the SMOKE fixture covers the
  // email-code identity). Distinct addresses keep the per-email resend cooldown
  // and lockout counters from bleeding between flows.
  emailPassword: 'smoke-password@example.test',
  emailUnknown: 'smoke-unknown@example.test',
  emailBrokenProbe: 'smoke-broken-probe@example.test',
  // Login wave 3 (3.9.50/3.9.51): a known NON-auth1 method, an address that
  // only app.devin.ai can answer, and the email-code-form identity.
  emailFirebase: 'smoke-firebase@example.test',
  emailDevinOnly: 'smoke-devin-only@example.test',
  emailCodeForm: 'smoke-code-form@example.test',
  password: 'smoke-upstream-' + 'password-8c1f4a',
  auth1Password: 'auth1_smoke_password_9d2f6b4a1c8e',
  sessionTokenPassword: 'devin-session-token$smoke-password-2f7c4a9e1d6b',

  // app.devin.ai login host (wave 3 host choice) mints its own Auth1 + session
  // pair so a response that crossed hosts cannot be mistaken for windsurf.com.
  verifyTokenDevin: 'smoke-devin-verify-4c8b1e6d9a3f',
  auth1TokenDevin: 'auth1_smoke_devin_7b2e4c9d1a5f',
  sessionTokenDevin: 'devin-session-token$smoke-devin-3a7c9e1d5b2f',

  // POST /windsurf-login/token imports: a bare paste and a desktop deep link.
  loginImportToken: 'devin-session-token$smoke-login-import-8e2f4a6c1d9b',
  loginImportTokenDeep: 'devin-session-token$smoke-login-deep-5a9c3e7b2d4f',

  // SessionReauth (3.9.52): the token that dies, its replacement, and the
  // throwaway accounts the state machine's 409/404 edges need.
  reauthToken: 'devin-session-token$smoke-reauth-2b6d8f4a1c7e',
  reauthTokenNext: 'devin-session-token$smoke-reauth-next-9d3f5b7c2e8a',
  reauthTokenAlive: 'devin-session-token$smoke-reauth-alive-4e8a2c6b9d1f',
  reauthTokenForce: 'devin-session-token$smoke-reauth-force-7c1e5a3f8b2d',
  reauthTokenDisabled: 'devin-session-token$smoke-reauth-disabled-6f2a8c4e1b9d',

  // DEVIN_CONNECT_TOKEN. A deployment token makes /v1/models and the chat
  // entitlement gate fail open, which is the documented single-token deploy
  // shape; the suite asserts that shape rather than hiding it.
  connectToken: 'smoke-connect-token-6b8d3f0a9c2e',

  // Tokens minted by the import/OTP/reveal flows.
  importToken: 'devin-session-token$smoke-import-9a4f2c7e5b1d',
  otpKey: 'sk-smoke-otp-' + '3e7b1d9c4a6f',
  // Deliberately NOT in MATRIX_SECRETS: POST /account/:id/reveal-key is
  // SUPPOSED to return this in cleartext to a re-authenticated operator, so the
  // leak scan must not flag the one endpoint whose contract is disclosure.
  revealToken: 'devin-session-token$smoke-reveal-5c2e8a1f7b4d',

  // Fake ACP session output. Distinctive so a stray upstream cannot match it.
  acpReply: 'ACP_SMOKE_REPLY_7f3c1a9d',
  acpFailureReply: 'ACP_SMOKE_SHOULD_NOT_APPEAR',

  // Selectors used per front. All resolve through the committed catalog
  // snapshot (verified: resolveConnectSelector -> mapped:true).
  //
  // The chat front deliberately runs on the FREE-REACHABLE selector: the
  // protocol family executes before any account is pooled, so the connect
  // client uses the env token and every front stays independent of per-account
  // entitlement. A paid alias is still exercised on the Messages front.
  models: Object.freeze({
    chat: 'swe-1-6-slow',
    tools: 'swe-1-6-slow',
    messages: 'claude-sonnet-4.6',
    responses: 'swe-1-6-slow',
    gemini: 'swe-1-6-slow',
    acp: 'swe-1.6',
  }),

  // Prompt markers routed by the scripted connect stream.
  marker: Object.freeze({
    tool: 'SMOKE_MARKER_TOOL',
    reasoning: 'SMOKE_MARKER_REASONING',
    fail: 'SMOKE_MARKER_FAIL',
    echo: 'SMOKE_MARKER_ECHO',
    // Two content chunks separated by a real pause, so a client can hang up
    // AFTER content is on the wire (the detach admission scenario).
    slow: 'SMOKE_MARKER_SLOW',
  }),

  // The two halves of the paused answer, distinct so a replay can be counted.
  slow: Object.freeze({
    prefix: 'DETACH_SLOW_PREFIX_5c1a',
    growth: 'DETACH_SLOW_GROWTH_8f2b',
  }),

  text: 'Hello from the smoke upstream.',
});

/**
 * Secrets that must never reach stdout/stderr or an HTTP body. Superset of the
 * dashboard suite's list; the runner scans both.
 */
export const MATRIX_SECRETS = Object.freeze([
  ...SMOKE_SECRETS,
  { label: 'password-login session token', value: MATRIX.sessionTokenPassword },
  { label: 'password-login Auth1 token', value: MATRIX.auth1Password },
  { label: 'DEVIN_CONNECT deployment token', value: MATRIX.connectToken },
  { label: 'password-login upstream password', value: MATRIX.password },
  { label: 'import-text session token', value: MATRIX.importToken },
  { label: 'email-OTP api key', value: MATRIX.otpKey },
  { label: 'app.devin.ai email verification token', value: MATRIX.verifyTokenDevin },
  { label: 'app.devin.ai Auth1 token', value: MATRIX.auth1TokenDevin },
  { label: 'app.devin.ai session token', value: MATRIX.sessionTokenDevin },
  { label: 'login-token import (bare)', value: MATRIX.loginImportToken },
  { label: 'login-token import (deep link)', value: MATRIX.loginImportTokenDeep },
  { label: 'reauth dead session token', value: MATRIX.reauthToken },
  { label: 'reauth replacement session token', value: MATRIX.reauthTokenNext },
  { label: 'reauth alive-probe session token', value: MATRIX.reauthTokenAlive },
  { label: 'reauth force-override session token', value: MATRIX.reauthTokenForce },
  { label: 'reauth disabled-account session token', value: MATRIX.reauthTokenDisabled },
]);

/** Flatten a connect message's content into searchable text. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n');
  }
  return '';
}

function promptText(params) {
  return (params?.messages || []).map(messageText).join('\n');
}

/**
 * Scripted `streamChat` (the __setStreamChatForTest seam in
 * src/devin-connect-openai.js). Routes on markers in the conversation so one
 * fake serves every protocol front: the front's translation layer has already
 * turned its request into chat messages by the time this runs.
 *
 * Yields the event vocabulary devin-connect.js defines:
 *   { type:'content'|'reasoning', text } and one terminal { type:'finish' }.
 */
export function scriptedConnectEvents() {
  const seen = [];

  async function* stream(params = {}) {
    const text = promptText(params);
    seen.push({ model: params.model, text });

    if (text.includes(MATRIX.marker.fail)) {
      throw Object.assign(new Error('smoke upstream internal failure'), { code: 'UPSTREAM_INTERNAL' });
    }
    if (text.includes(MATRIX.marker.tool)) {
      yield {
        type: 'content',
        text: '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>',
      };
      yield { type: 'finish', reason: 'tool_calls', usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } };
      return;
    }
    if (text.includes(MATRIX.marker.reasoning)) {
      yield { type: 'reasoning', text: 'weighing the options' };
      yield { type: 'content', text: 'Reasoned answer.' };
      yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 } };
      return;
    }
    if (text.includes(MATRIX.marker.echo)) {
      // Echo the last user turn so a caller can prove which front reached the
      // backend (the four fronts rewrite prompts differently).
      const last = [...(params.messages || [])].reverse().find((m) => m?.role === 'user');
      yield { type: 'content', text: `echo:${messageText(last)}` };
      yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
      return;
    }
    if (text.includes(MATRIX.marker.slow)) {
      // Two chunks with a real pause between them: the client can read the
      // prefix, hang up, and still have a turn that was genuinely mid-flight.
      yield { type: 'content', text: MATRIX.slow.prefix };
      await delay(250);
      yield { type: 'content', text: MATRIX.slow.growth };
      yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } };
      return;
    }
    yield { type: 'content', text: MATRIX.text };
    yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } };
  }

  stream.seen = seen;
  return stream;
}

/**
 * Source of the fake `devin acp` stdio server. Written to a temp .mjs and run
 * as `node <script>` through the product's documented DEVIN_CLI_PATH +
 * DEVIN_CLI_ACP_ARGS_JSON knobs, so the REAL runner (handshake, credential
 * injection, SSE re-framing, error mapping) is exercised.
 *
 * A prompt containing the fail marker makes session/prompt answer with the
 * "model overloaded" RPC error, which the runner classifies as transient →
 * 429 capacity_error (same contract as test/devin-acp-integration.test.js).
 */
export const FAKE_ACP_SOURCE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'smoke-session', update: u } }); }
let seenKey = '';
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } });
    return;
  }
  if (msg.method === 'authenticate') {
    seenKey = msg.params?._meta?.api_key || '';
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'smoke-session' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    const prompt = (msg.params?.prompt || []).map((p) => p.text || '').join('');
    if (prompt.includes('${MATRIX.marker.fail}')) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'model overloaded' } });
      return;
    }
    update({ sessionUpdate: 'agent_thought_chunk', content: { text: 'internal reasoning that must not leak' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { text: '${MATRIX.acpReply}|auth=' + (seenKey ? 'present' : 'absent') } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { totalTokens: 12 } } });
    return;
  }
});
`;

/** Flow manifest, grouped by the user-visible family each flow protects. */
export const MATRIX_FAMILIES = Object.freeze([
  'core',
  'auth',
  'dashboard',
  'login',
  'accounts',
  'models',
  'openai',
  'messages',
  'responses',
  'gemini',
  'dashboard-live',
  'acp',
  'i18n',
  'hygiene',
  // Wave 6 additions: each of these is a user-visible surface that had no
  // smoke family before 3.9.52.
  'reauth',
  'acu',
  'request-history',
  'devin-cards',
  'engines',
  'docker',
  // 3.9.54–3.9.60 additions: each shipped a user-visible behaviour that had no
  // smoke family before it.
  'fleet',
  'kpi',
  'detach',
  'docs',
]);
