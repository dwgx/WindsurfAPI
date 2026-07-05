/**
 * OpenAI-compatible HTTP server with multi-account management.
 *
 *   POST /v1/chat/completions       — chat completions
 *   POST /v1/responses              - OpenAI Responses API
 *   GET  /v1/models                 — list models
 *   POST /auth/login                — add account (email+password / token / api_key)
 *   GET  /auth/accounts             — list all accounts
 *   DELETE /auth/accounts/:id       — remove account
 *   GET  /auth/status               — pool status summary
 *   GET  /health                    — health check
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  validateApiKey, isAuthenticated, getAccountList, getAccountCount,
  addAccountByEmail, addAccountByToken, addAccountByKey, removeAccount,
  configureBindHost, emitNoAuthWarnings, getDroughtSummary, ensureLsForAccount,
} from './auth.js';
import { handleChatCompletions } from './handlers/chat.js';
import { handleMessages } from './handlers/messages.js';
import { handleResponses } from './handlers/responses.js';
import { handleModels } from './handlers/models.js';
import { resolveModel, getModelInfo } from './models.js';
import { handleDashboardApi, parseProxyUrl, validateProxyHost } from './dashboard/api.js';
import { setAccountProxy } from './dashboard/proxy-config.js';
import { config, log } from './config.js';
import { getVersionInfo } from './version.js';
import { callerKeyFromRequest } from './caller-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const VERSION_INFO = getVersionInfo();

// 10 MB is way above any realistic chat-completions payload while still
// bounding worst-case memory from a malicious/broken client.
export const MAX_BODY_SIZE = 10 * 1024 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      try { req.resume?.(); } catch {}
      reject(err);
    };
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        fail(Object.assign(new Error('Request body too large'), {
          statusCode: 413,
          code: 'ERR_REQUEST_BODY_TOO_LARGE',
        }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', fail);
  });
}

export function bodyTooLargePayload(style = 'openai') {
  if (style === 'dashboard') {
    return { ok: false, error: 'ERR_REQUEST_BODY_TOO_LARGE', message: 'Request body too large' };
  }
  if (style === 'legacy') {
    return { error: 'Request body too large' };
  }
  if (style === 'anthropic') {
    return { type: 'error', error: { type: 'invalid_request_error', message: 'Request body too large' } };
  }
  return { error: { message: 'Request body too large', type: 'invalid_request' } };
}

function sendBodyTooLargeIfNeeded(res, err, style = 'openai') {
  if (err?.statusCode !== 413 && err?.code !== 'ERR_REQUEST_BODY_TOO_LARGE') return false;
  json(res, 413, bodyTooLargePayload(style));
  return true;
}

export function extractToken(req) {
  // Anthropic SDK + OAI SDK compatibility: accept either header.
  const authHeader = String(req.headers['authorization'] || '').trim();
  if (authHeader && authHeader.includes(',')) return '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const xApiKey = req.headers['x-api-key'] || '';
  return xApiKey;
}

function nativeBridgeCallerKeyForRequest(req, token, body, callerKey = '') {
  const key = callerKey || callerKeyFromRequest(req, token, body);
  const tokenAllowlist = String(process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!tokenAllowlist.length) return key;
  return tokenAllowlist.includes(String(token || '').trim()) ? `${key}:api_key_allowed` : key;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // Per-request dynamic responses must not be cached by intermediaries.
    // Some upstream aggregators (e.g. sub2api, #97) priority-cache responses
    // when they don't see an explicit Cache-Control directive and serve
    // stale content for fresh requests.
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function estimateAnthropicInputTokens(body = {}) {
  const chunks = [];
  const collect = (v) => {
    if (v == null) return;
    if (typeof v === 'string') chunks.push(v);
    else if (Array.isArray(v)) for (const item of v) collect(item);
    else if (typeof v === 'object') {
      if (typeof v.text === 'string') chunks.push(v.text);
      else if (typeof v.content === 'string') chunks.push(v.content);
      else if (Array.isArray(v.content)) collect(v.content);
      else if (typeof v.input === 'object') chunks.push(JSON.stringify(v.input));
    }
  };
  collect(body.system);
  collect(body.messages);
  collect(body.tools);
  const chars = chunks.join('\n').length;
  return Math.max(1, Math.ceil(chars / 4));
}

function anthropicModelPayload(id, info) {
  return {
    type: 'model',
    id: info?.name || id,
    display_name: info?.name || id,
    created_at: '2026-01-01T00:00:00Z',
  };
}

async function route(req, res) {
  const { method } = req;
  let path = req.url.split('?')[0];
  if (path.startsWith('/v1/v1/')) path = path.slice(3);
  if (path.startsWith('/v1/')) console.info('[CC-REQ]', JSON.stringify({ method, path }));

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    });
    return res.end();
  }
  if (path === '/health') {
    const counts = getAccountCount();
    const body = {
      status: 'ok',
      provider: 'WindsurfAPI bydwgx1337',
      version: VERSION_INFO.version,
      commit: VERSION_INFO.commit,
      commitMessage: VERSION_INFO.commitMessage,
      commitDate: VERSION_INFO.commitDate,
      branch: VERSION_INFO.branch,
      buildSource: VERSION_INFO.source,
      uptime: Math.round(process.uptime()),
      accounts: counts,
    };
    const qs = new URL(req.url, 'http://localhost').searchParams;
    if (qs.get('verbose') === '1' && validateApiKey(extractToken(req))) {
      try {
        const { poolStats } = await import('./conversation-pool.js');
        const { cacheStats } = await import('./cache.js');
        const { getLsStatus } = await import('./langserver.js');
        const { getSpecialAgentStatus } = await import('./special-agent.js');
        const { getNativeBridgeStats } = await import('./native-bridge-stats.js');
        const { getNativeBridgeConfigStatus } = await import('./cascade-native-bridge.js');
        body.conversationPool = poolStats();
        body.cache = cacheStats();
        body.lsPool = getLsStatus();
        body.specialAgent = getSpecialAgentStatus();
        body.nativeBridge = getNativeBridgeStats();
        body.nativeBridgeConfig = getNativeBridgeConfigStatus();
        // v2.0.57 Fix 5 — drought summary so monitoring can page on
        // "all accounts < 5% weekly" without screen-scraping per-account
        // credit dumps.
        body.drought = getDroughtSummary();
      } catch {}
    }
    return json(res, 200, body);
  }

  // ─── Dashboard ─────────────────────────────────────────
  if (path === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  if (path === '/dashboard' || path === '/dashboard/') {
    try {
      // Cookie-based skin selection. `dashboard_skin=sketch` serves the
      // experimental hand-drawn console; anything else (or no cookie)
      // serves the default UI. Each UI sets/unsets the cookie via its own
      // settings toggle, then reloads — server picks the right file based
      // on the next request's cookie. Vary: Cookie keeps intermediaries
      // from poisoning one user's skin onto another.
      const cookie = String(req.headers.cookie || '');
      const m = cookie.match(/(?:^|;\s*)dashboard_skin=([^;]+)/);
      const skin = m ? decodeURIComponent(m[1]) : '';
      const file = skin === 'sketch' ? 'index-sketch.html' : 'index.html';
      const html = readFileSync(join(__dirname, 'dashboard', file));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Vary': 'Cookie',
        'Cache-Control': 'no-cache',
      });
      return res.end(html);
    } catch {
      return json(res, 500, { error: 'Dashboard not found' });
    }
  }

  if (path.startsWith('/dashboard/api/')) {
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try { body = JSON.parse(await readBody(req)); } catch (err) {
        if (sendBodyTooLargeIfNeeded(res, err, 'dashboard')) return;
        return json(res, 400, { ok: false, error: 'Invalid JSON' });
      }
    }
    const subpath = path.slice('/dashboard/api'.length);
    return handleDashboardApi(method, subpath, body, req, res);
  }

  // ─── Dashboard i18n locale files ────────────────────────
  if (path.startsWith('/dashboard/i18n/')) {
    try {
      const localeFile = path.slice('/dashboard/i18n/'.length);
      // Security: only allow .json files with alphanumeric/hyphen names
      if (!localeFile.match(/^[a-zA-Z0-9\-]+\.json$/)) {
        return json(res, 400, { error: 'Invalid locale file' });
      }
      const filePath = join(__dirname, 'dashboard', 'i18n', localeFile);
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(content);
    } catch {
      return json(res, 404, { error: 'Locale file not found' });
    }
  }

  // ─── Dashboard data files (contributors, etc.) ──────────
  // Same shape as i18n: tight regex on the basename, served as JSON.
  // Used by both default and sketch UIs as the single source of truth
  // for hand-maintained roster data so the two skins stay in sync.
  if (path.startsWith('/dashboard/data/')) {
    try {
      const dataFile = path.slice('/dashboard/data/'.length);
      if (!dataFile.match(/^[a-zA-Z0-9\-]+\.json$/)) {
        return json(res, 400, { error: 'Invalid data file' });
      }
      const filePath = join(__dirname, 'dashboard', 'data', dataFile);
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(content);
    } catch {
      return json(res, 404, { error: 'Data file not found' });
    }
  }

  // ─── API endpoints (require API key) ────────────────────

  if (!validateApiKey(extractToken(req))) {
    // v2.0.61 (#110): clearer error so operators know the issue is
    // configuration (no API_KEY set on a public-bind instance) rather
    // than a bad client header. The chat client side rarely shows a
    // verbose error so we cram the diagnosis into the message itself.
    const tokenSent = !!extractToken(req);
    const message = tokenSent
      ? 'Invalid API key. Either the key is wrong, or the server has API_KEY configured to a different value than the one your client sent.'
      : 'Missing API key. This server runs in fail-closed mode: requests must include `Authorization: Bearer <key>` (or `x-api-key: <key>`) matching the configured API_KEY env var. If you intend to run open (no auth), bind the server to localhost (HOST=127.0.0.1).';
    return json(res, 401, { error: { message, type: 'auth_error' } });
  }

  // ─── Auth management (admin — gated by API key above) ──

  if (path === '/auth/status') {
    return json(res, 200, { authenticated: isAuthenticated(), ...getAccountCount() });
  }

  if (path === '/auth/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  // DELETE /auth/accounts/:id
  if (path.startsWith('/auth/accounts/') && method === 'DELETE') {
    const id = path.split('/')[3];
    const ok = removeAccount(id);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  if (path === '/auth/login' && method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'legacy')) return;
      return json(res, 400, { error: 'Invalid JSON' });
    }

    try {
      // ── bind proxy to account ──────────────────────
      async function parseAndValidateAccountProxy(proxyStr) {
        if (!proxyStr) return null;
        const parsed = parseProxyUrl(proxyStr);
        if (!parsed) {
          log.warn(`auth/login: ignoring invalid proxy format: ${String(proxyStr).slice(0, 80)}`);
          return null;
        }
        await validateProxyHost(parsed);
        return parsed;
      }

      function bindAccountProxy(accountId, parsedProxy) {
        if (parsedProxy) {
          setAccountProxy(accountId, parsedProxy);
          if (process.env.LS_PREWARM_ON_ACCOUNT_ADD === '1' || process.env.LS_PREWARM_PROXIES === '1') {
            ensureLsForAccount(accountId).then(r => {
              if (r && !r.ok) log.warn(`LS ensure skipped/failed: ${r.errorType || r.error}`);
            }).catch(e => log.warn(`LS ensure failed: ${e.message}`));
          }
        }
      }

      // Support batch: { accounts: [{token,proxy}, ...] }
      if (Array.isArray(body.accounts)) {
        const results = [];
        for (const acct of body.accounts) {
          try {
            const parsedProxy = await parseAndValidateAccountProxy(acct.proxy);
            let result;
            if (acct.api_key) {
              result = addAccountByKey(acct.api_key, acct.label);
            } else if (acct.token) {
              result = await addAccountByToken(acct.token, acct.label);
            } else if (acct.email && acct.password) {
              result = await addAccountByEmail(acct.email, acct.password);
            } else {
              results.push({ error: 'Missing credentials' });
              continue;
            }
            bindAccountProxy(result.id, parsedProxy);
            results.push({ id: result.id, email: result.email, status: result.status });
          } catch (err) {
            results.push({ email: acct.email, error: err.message });
          }
        }
        return json(res, 200, { results, ...getAccountCount() });
      }

      // Single account
      const parsedProxy = await parseAndValidateAccountProxy(body.proxy);
      let account;
      if (body.api_key) {
        account = addAccountByKey(body.api_key, body.label);
      } else if (body.token) {
        account = await addAccountByToken(body.token, body.label);
      } else if (body.email && body.password) {
        account = await addAccountByEmail(body.email, body.password);
      } else {
        return json(res, 400, { error: 'Provide api_key, token, or email+password' });
      }

      bindAccountProxy(account.id, parsedProxy);

      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      log.error('Login failed:', err.message);
      const status = /^ERR_PROXY_/i.test(err.message || '') ? 400 : 401;
      return json(res, status, { error: err.message });
    }
  }

  if (path === '/v1/models' && method === 'GET') {
    return json(res, 200, handleModels());
  }

  if (path.startsWith('/v1/models/') && method === 'GET') {
    const rawId = decodeURIComponent(path.slice('/v1/models/'.length));
    const modelKey = resolveModel(rawId);
    const info = getModelInfo(modelKey);
    if (!info) {
      return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `Model ${rawId} not found` } });
    }
    return json(res, 200, anthropicModelPayload(rawId, info));
  }

  if (path === '/v1/messages/count_tokens' && method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'anthropic')) return;
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    const modelKey = resolveModel(body.model || config.defaultModel);
    if (!getModelInfo(modelKey)) {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `Unsupported model: ${body.model || config.defaultModel}` } });
    }
    return json(res, 200, { input_tokens: estimateAnthropicInputTokens(body) });
  }

  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'openai')) return;
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }
    if (!Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request' } });
    }
    if (body.messages.length === 0) {
      return json(res, 400, { error: { message: 'messages must contain at least 1 item', type: 'invalid_request' } });
    }

    const reqStartedAt = Date.now();
    const token = extractToken(req);
    const callerKey = callerKeyFromRequest(req, token, body);
    const result = await handleChatCompletions(body, {
      callerKey,
      nativeBridgeCallerKey: nativeBridgeCallerKeyForRequest(req, token, body, callerKey),
    });
    const processingMs = Date.now() - reqStartedAt;
    const modelHeaders = {
      'x-request-id': 'req-' + randomUUID(),
      'openai-model': body.model || '',
      // Actual upstream processing time — hvoy.ai and similar verifiers
      // treat a flat "0" as a fingerprint of a faking proxy.
      'openai-processing-ms': String(processingMs),
      'openai-version': '2020-10-01',
      // OpenAI always returns an organization header. We don't have a real
      // org id, but a stable synthetic one keeps the shape consistent so
      // the signature check doesn't pick up on the missing field.
      'openai-organization': 'org-windsurf-proxy',
    };
    if (result.stream) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...modelHeaders, ...result.headers });
      await result.handler(res);
    } else {
      for (const [k, v] of Object.entries(modelHeaders)) res.setHeader(k, v);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      }
      json(res, result.status, result.body);
    }
    return;
  }

  // v2.0.71 (#121 keh4l): some clients send `/v1/response` (singular)
  // by mistake — this exact alias avoids a confusing 404 and routes to
  // the canonical handler. The plural `/v1/responses` is the spec form.
  if (path === '/v1/response' && method === 'POST') {
    path = '/v1/responses';
  }

  if (path === '/v1/responses' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'openai')) return;
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }
    if (body.input == null) {
      return json(res, 400, { error: { message: 'input is required', type: 'invalid_request' } });
    }

    const reqStartedAt = Date.now();
    const token = extractToken(req);
    const callerKey = callerKeyFromRequest(req, token, body);
    const result = await handleResponses(body, {
      context: {
        callerKey,
        nativeBridgeCallerKey: nativeBridgeCallerKeyForRequest(req, token, body, callerKey),
      },
    });
    const processingMs = Date.now() - reqStartedAt;
    const modelHeaders = {
      'x-request-id': 'req-' + randomUUID(),
      'openai-model': body.model || '',
      'openai-processing-ms': String(processingMs),
      'openai-version': '2020-10-01',
      'openai-organization': 'org-windsurf-proxy',
    };
    if (result.stream) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...modelHeaders, ...result.headers });
      await result.handler(res);
    } else {
      for (const [k, v] of Object.entries(modelHeaders)) res.setHeader(k, v);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      }
      json(res, result.status, result.body);
    }
    return;
  }

  // Anthropic Messages API — Claude Code compatibility
  if (path === '/v1/messages' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, { type: 'error', error: { type: 'api_error', message: 'No active accounts' } });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (sendBodyTooLargeIfNeeded(res, err, 'anthropic')) return;
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' } });
    }
    const token = extractToken(req);
    const callerKey = callerKeyFromRequest(req, token, body);
    const result = await handleMessages(body, {
      callerKey,
      nativeBridgeCallerKey: nativeBridgeCallerKeyForRequest(req, token, body, callerKey),
    });
    const anthropicHeaders = {
      'request-id': 'req-' + randomUUID(),
      'anthropic-model': body.model || '',
    };
    if (result.stream) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...anthropicHeaders, ...result.headers });
      await result.handler(res);
    } else {
      for (const [k, v] of Object.entries(anthropicHeaders)) res.setHeader(k, v);
      json(res, result.status, result.body);
    }
    return;
  }

  json(res, 404, { error: { message: `${method} ${path} not found`, type: 'not_found' } });
}

export function startServer() {
  const activeRequests = new Set();
  const bindHost = config.host || '0.0.0.0';
  configureBindHost(bindHost);
  emitNoAuthWarnings(bindHost);

  const server = http.createServer(async (req, res) => {
    activeRequests.add(res);
    res.on('close', () => activeRequests.delete(res));
    try {
      await route(req, res);
    } catch (err) {
      log.error('Handler error:', err);
      if (!res.headersSent) json(res, 500, { error: { message: 'Internal error', type: 'server_error' } });
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let retryCount = 0;
  const maxRetries = 10;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount > maxRetries) {
        log.error(`Port ${config.port} still in use after ${maxRetries} retries. Exiting.`);
        process.exit(1);
      }
      log.warn(`Port ${config.port} in use, retry ${retryCount}/${maxRetries} in 3s...`);
      setTimeout(() => server.listen(config.port, bindHost), 3000);
    } else {
      log.error('Server error:', err);
    }
  });

  server.getActiveRequests = () => activeRequests.size;

  server.listen({ port: config.port, host: bindHost }, () => {
    log.info(`Server on http://${bindHost}:${config.port}`);
    log.info('  POST /v1/chat/completions');
    log.info('  POST /v1/responses');
    log.info('  GET  /v1/models');
    log.info('  POST /auth/login          (add account)');
    log.info('  GET  /auth/accounts       (list accounts)');
    log.info('  DELETE /auth/accounts/:id (remove account)');
  });
  return server;
}
