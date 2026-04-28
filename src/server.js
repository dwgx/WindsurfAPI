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
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  validateApiKey, isAuthenticated, getAccountList, getAccountCount,
  addAccountByEmail, addAccountByToken, addAccountByKey, removeAccount,
  configureBindHost, emitNoAuthWarnings,
} from './auth.js';
import { handleChatCompletions } from './handlers/chat.js';
import { handleMessages } from './handlers/messages.js';
import { handleResponses } from './handlers/responses.js';
import { handleModels } from './handlers/models.js';
import { handleDashboardApi } from './dashboard/api.js';
import { config, log } from './config.js';
import { VERSION } from './version.js';
import { callerKeyFromRequest } from './caller-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const VERSION_INFO = (() => {
  let commit = '', commitMessage = '', commitDate = '', branch = 'unknown';
  if (existsSync(join(REPO_ROOT, '.git'))) {
    try { commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { commitMessage = execSync('git log -1 --pretty=format:%s', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { commitDate = execSync('git log -1 --pretty=format:%cI', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
  }
  return { version: VERSION, commit, commitMessage, commitDate, branch };
})();

// 10 MB is way above any realistic chat-completions payload while still
// bounding worst-case memory from a malicious/broken client.
const MAX_BODY_SIZE = 10 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
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

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(data);
}

async function route(req, res) {
  const { method } = req;
  const path = req.url.split('?')[0];

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
      uptime: Math.round(process.uptime()),
      accounts: counts,
    };
    const qs = new URL(req.url, 'http://localhost').searchParams;
    if (qs.get('verbose') === '1' && validateApiKey(extractToken(req))) {
      try {
        const { poolStats } = await import('./conversation-pool.js');
        const { cacheStats } = await import('./cache.js');
        const { getLsStatus } = await import('./langserver.js');
        body.conversationPool = poolStats();
        body.cache = cacheStats();
        body.lsPool = getLsStatus();
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
      try { body = JSON.parse(await readBody(req)); } catch {}
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
    return json(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
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
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }

    try {
      // Support batch: { accounts: [{email,password}, ...] }
      if (Array.isArray(body.accounts)) {
        const results = [];
        for (const acct of body.accounts) {
          try {
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
            results.push({ id: result.id, email: result.email, status: result.status });
          } catch (err) {
            results.push({ email: acct.email, error: err.message });
          }
        }
        return json(res, 200, { results, ...getAccountCount() });
      }

      // Single account
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

      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      log.error('Login failed:', err.message);
      return json(res, 401, { error: err.message });
    }
  }

  if (path === '/v1/models' && method === 'GET') {
    return json(res, 200, handleModels());
  }

  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }
    if (!Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request' } });
    }
    if (body.messages.length === 0) {
      return json(res, 400, { error: { message: 'messages must contain at least 1 item', type: 'invalid_request' } });
    }

    const reqStartedAt = Date.now();
    const result = await handleChatCompletions(body, { callerKey: callerKeyFromRequest(req, extractToken(req)) });
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

  if (path === '/v1/responses' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }
    if (body.input == null) {
      return json(res, 400, { error: { message: 'input is required', type: 'invalid_request' } });
    }

    const reqStartedAt = Date.now();
    const result = await handleResponses(body, { context: { callerKey: callerKeyFromRequest(req, extractToken(req)) } });
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
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' } });
    }
    const result = await handleMessages(body, { callerKey: callerKeyFromRequest(req, extractToken(req)) });
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
