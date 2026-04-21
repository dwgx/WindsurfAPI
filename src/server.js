/**
 * OpenAI-compatible HTTP server with multi-account management.
 *
 *   POST /v1/chat/completions       — chat completions
 *   GET  /v1/models                 — list models
 *   POST /auth/login                — add account (email+password / token / api_key)
 *   GET  /auth/accounts             — list all accounts
 *   DELETE /auth/accounts/:id       — remove account
 *   GET  /auth/status               — pool status summary
 *   GET  /health                    — health check
 */

import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  validateApiKey, isAuthenticated, getAccountList, getAccountCount,
  addAccountByEmail, addAccountByToken, addAccountByKey, removeAccount,
} from './auth.js';
import { handleChatCompletions } from './handlers/chat.js';
import { handleMessages } from './handlers/messages.js';
import { handleModels } from './handlers/models.js';
import { handleDashboardApi } from './dashboard/api.js';
import { config, log } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Cache version info at boot — git queries are slow and this never changes
// until a restart (and self-update restarts us, so always fresh).
const VERSION_INFO = (() => {
  let pkgVersion = '1.2.0';
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    if (pkg.version) pkgVersion = pkg.version;
  } catch {}
  let commit = '', commitMessage = '', commitDate = '', branch = 'unknown';
  if (existsSync(join(REPO_ROOT, '.git'))) {
    try { commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { commitMessage = execSync('git log -1 --pretty=format:%s', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { commitDate = execSync('git log -1 --pretty=format:%cI', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
    try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, timeout: 2000 }).toString().trim(); } catch {}
  }
  return { version: pkgVersion, commit, commitMessage, commitDate, branch };
})();

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function extractToken(req) {
  // Anthropic SDK + OAI SDK compatibility: accept either header.
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  if (authHeader) return authHeader;
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

  if (method === 'OPTIONS') return json(res, 204, '');
  if (path === '/health') {
    const counts = getAccountCount();
    return json(res, 200, {
      status: 'ok',
      provider: 'WindsurfAPI bydwgx1337',
      version: VERSION_INFO.version,
      commit: VERSION_INFO.commit,
      commitMessage: VERSION_INFO.commitMessage,
      commitDate: VERSION_INFO.commitDate,
      branch: VERSION_INFO.branch,
      uptime: Math.round(process.uptime()),
      accounts: counts,
    });
  }

  // ─── Dashboard ─────────────────────────────────────────
  // Silent 204 for favicon — browsers request it from every page; otherwise
  // the later Bearer-token check produces noise in the dashboard console.
  if (path === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  if (path === '/dashboard' || path === '/dashboard/') {
    try {
      const html = readFileSync(join(__dirname, 'dashboard', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

  // ─── Auth status (public, no sensitive data) ───────────

  if (path === '/auth/status') {
    return json(res, 200, { authenticated: isAuthenticated(), ...getAccountCount() });
  }

  // ─── API endpoints (require API key) ────────────────────

  if (!validateApiKey(extractToken(req))) {
    return json(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
  }

  // ─── Auth management (requires API key) ────────────────

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

    const result = await handleChatCompletions(body);
    if (result.stream) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      await result.handler(res);
    } else {
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
    const result = await handleMessages(body);
    if (result.stream) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  json(res, 404, { error: { message: `${method} ${path} not found`, type: 'not_found' } });
}

export function startServer() {
  const activeRequests = new Set();

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
      setTimeout(() => server.listen(config.port, '0.0.0.0'), 3000);
    } else {
      log.error('Server error:', err);
    }
  });

  server.getActiveRequests = () => activeRequests.size;

  server.listen({ port: config.port, host: '0.0.0.0' }, () => {
    log.info(`Server on http://0.0.0.0:${config.port}`);
    log.info('  POST /v1/chat/completions');
    log.info('  GET  /v1/models');
    log.info('  POST /auth/login          (add account)');
    log.info('  GET  /auth/accounts       (list accounts)');
    log.info('  DELETE /auth/accounts/:id (remove account)');
  });
  return server;
}
