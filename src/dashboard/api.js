/**
 * Dashboard API route handlers.
 * All routes are under /dashboard/api/*.
 */

import { config, log } from '../config.js';
import {
  getAccountList, getAccountCount, addAccountByKey, addAccountByToken,
  removeAccount, setAccountStatus, resetAccountErrors, updateAccountLabel,
  isAuthenticated, probeAccount, ensureLsForAccount,
  refreshCredits, refreshAllCredits,
  setAccountBlockedModels, setAccountTokens, setAccountTier,
} from '../auth.js';
import { restartLsForProxy } from '../langserver.js';
import { getLsStatus, stopLanguageServer, startLanguageServer, isLanguageServerRunning } from '../langserver.js';
import { getStats, resetStats, recordRequest } from './stats.js';
import { cacheStats, cacheClear } from '../cache.js';
import { getExperimental, setExperimental, getIdentityPrompts, setIdentityPrompts, resetIdentityPrompt, DEFAULT_IDENTITY_PROMPTS } from '../runtime-config.js';
import { poolStats as convPoolStats, poolClear as convPoolClear } from '../conversation-pool.js';
import { getLogs, subscribeToLogs, unsubscribeFromLogs } from './logger.js';
import { getProxyConfig, getProxyConfigMasked, setGlobalProxy, setAccountProxy, removeProxy, getEffectiveProxy } from './proxy-config.js';
import { MODELS, MODEL_TIER_ACCESS as _TIER_TABLE, getTierModels as _getTierModels } from '../models.js';
import { windsurfLogin, refreshFirebaseToken, reRegisterWithCodeium } from './windsurf-login.js';
import { getModelAccessConfig, setModelAccessMode, setModelAccessList, addModelToList, removeModelFromList } from './model-access.js';
import { checkMessageRateLimit } from '../windsurf-api.js';

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Password',
  });
  res.end(data);
}

function checkAuth(req) {
  // Header is preferred (set by fetch). EventSource can't set custom headers,
  // so /logs/stream etc. also accept ?pwd=... as fallback.
  let pw = req.headers['x-dashboard-password'] || '';
  if (!pw) {
    try {
      const qs = new URL(req.url, 'http://x').searchParams;
      pw = qs.get('pwd') || '';
    } catch {}
  }
  if (config.dashboardPassword) return pw === config.dashboardPassword;
  if (config.apiKey) return pw === config.apiKey;
  return true;  // No password and no API key = open access
}

async function processWindsurfLogin({ email, password, loginProxy, autoAdd }) {
  if (!email || !password) {
    const err = new Error('email 和 password 为必填');
    err.statusCode = 400;
    throw err;
  }

  // Use provided proxy, or global proxy
  const proxy = loginProxy?.host ? loginProxy : getProxyConfig().global;
  const result = await windsurfLogin(email, password, proxy);

  // Auto-add to account pool if requested
  let account = null;
  if (autoAdd !== false) {
    account = addAccountByKey(result.apiKey, result.name || email);
    // Persist refresh token via the setter so it survives restart and
    // the background Firebase-renewal loop can find it.
    if (result.refreshToken) {
      setAccountTokens(account.id, { refreshToken: result.refreshToken, idToken: result.idToken });
    }
    // Persist the per-account proxy we used for login so chat requests
    // also egress through the same IP, then warm up a matching LS.
    if (loginProxy?.host) setAccountProxy(account.id, loginProxy);
    ensureLsForAccount(account.id)
      .then(() => probeAccount(account.id))
      .catch(e => log.warn(`Auto-probe failed: ${e.message}`));
  }

  return {
    success: true,
    apiKey: result.apiKey,
    name: result.name,
    email: result.email,
    apiServerUrl: result.apiServerUrl,
    account: account ? { id: account.id, email: account.email, status: account.status } : null,
  };
}

/**
 * Handle all /dashboard/api/* requests.
 */
export async function handleDashboardApi(method, subpath, body, req, res) {
  if (method === 'OPTIONS') return json(res, 204, '');

  // Auth check (except for auth verification endpoint)
  if (subpath !== '/auth' && !checkAuth(req)) {
    return json(res, 401, { error: 'Unauthorized. Set X-Dashboard-Password header.' });
  }

  // ─── Auth ─────────────────────────────────────────────
  if (subpath === '/auth') {
    const needsAuth = !!(config.dashboardPassword || config.apiKey);
    if (!needsAuth) return json(res, 200, { required: false });
    return json(res, 200, { required: true, valid: checkAuth(req) });
  }

  // ─── Overview ─────────────────────────────────────────
  if (subpath === '/overview' && method === 'GET') {
    const stats = getStats();
    return json(res, 200, {
      uptime: process.uptime(),
      startedAt: stats.startedAt,
      accounts: getAccountCount(),
      authenticated: isAuthenticated(),
      langServer: getLsStatus(),
      totalRequests: stats.totalRequests,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      successRate: stats.totalRequests > 0
        ? ((stats.successCount / stats.totalRequests) * 100).toFixed(1)
        : '0.0',
      cache: cacheStats(),
    });
  }

  // ─── Experimental features ────────────────────────────
  if (subpath === '/experimental' && method === 'GET') {
    return json(res, 200, { flags: getExperimental(), conversationPool: convPoolStats() });
  }
  if (subpath === '/experimental' && method === 'PUT') {
    const flags = setExperimental(body || {});
    // Dropping the toggle should also drop any live entries so nothing
    // resumes against a disabled feature on the next request.
    if (!flags.cascadeConversationReuse) convPoolClear();
    return json(res, 200, { success: true, flags });
  }
  if (subpath === '/experimental/conversation-pool' && method === 'DELETE') {
    const n = convPoolClear();
    return json(res, 200, { success: true, cleared: n });
  }

  // ─── Identity prompts (per-provider editable templates) ─
  if (subpath === '/identity-prompts' && method === 'GET') {
    return json(res, 200, {
      prompts: getIdentityPrompts(),
      defaults: DEFAULT_IDENTITY_PROMPTS,
    });
  }
  if (subpath === '/identity-prompts' && method === 'PUT') {
    const prompts = setIdentityPrompts(body || {});
    return json(res, 200, { success: true, prompts });
  }
  if (subpath.match(/^\/identity-prompts\/[^/]+$/) && method === 'DELETE') {
    const provider = subpath.split('/').pop();
    const prompts = resetIdentityPrompt(provider);
    return json(res, 200, { success: true, prompts });
  }

  // ─── Proxy test — try an HTTP CONNECT through the given proxy ──
  if (subpath === '/test-proxy' && method === 'POST') {
    const { host, port, username, password, type = 'http' } = body || {};
    if (!host || !port) return json(res, 400, { ok: false, error: '缺少 host 或 port' });
    const startTime = Date.now();
    try {
      const result = await testProxy({ host, port: Number(port), username, password, type });
      return json(res, 200, { ok: true, ...result, latencyMs: Date.now() - startTime });
    } catch (err) {
      return json(res, 200, { ok: false, error: err.message, latencyMs: Date.now() - startTime });
    }
  }

  // ─── Self-update: pull latest code + restart PM2 ──────
  if (subpath === '/self-update/check' && method === 'GET') {
    try {
      const info = await gitStatus();
      return json(res, 200, { ok: true, ...info });
    } catch (err) {
      return json(res, 200, { ok: false, error: err.message });
    }
  }
  if (subpath === '/self-update' && method === 'POST') {
    try {
      const before = await gitStatus();
      // Guard: working tree must be clean (ignoring untracked files like
      // accounts.json, stats.json, runtime-config.json which live in the
      // repo root but aren't checked in). If the tracked files were edited
      // manually (or pushed via SFTP without a corresponding commit),
      // `git pull --ff-only` would refuse — surface a friendly error
      // instead of a raw git message.
      const dirty = (await runGit(['status', '--porcelain', '-uno'])).trim();
      if (dirty) {
        const allowForce = !!(body && body.forceReset);
        if (!allowForce) {
          return json(res, 200, {
            ok: false,
            dirty: true,
            error: '工作区有未提交的修改（SFTP 部署或手动改过代码）。确定要覆盖本地修改用远程最新版本吗？',
            dirtyFiles: dirty.split('\n').slice(0, 20),
          });
        }
        // branch comes from `git rev-parse --abbrev-ref HEAD`; execFile
        // doesn't spawn a shell so metacharacters can't break out — the
        // regex is kept as defence-in-depth so a malformed ref can't feed
        // a bogus `origin/xxx` spec to `git fetch`.
        const safeBranch = /^[\w.\-\/]+$/.test(before.branch || '') ? before.branch : 'master';
        await runGit(['fetch', 'origin', safeBranch]);
        await runGit(['reset', '--hard', `origin/${safeBranch}`]);
      }
      const safeBranch = /^[\w.\-\/]+$/.test(before.branch || '') ? before.branch : 'master';
      // execFile can't do `2>&1`; use child_process stderr merge via
      // combining stdout+stderr explicitly. runGit already pipes stderr
      // into the Error message on failure, so for success we get just
      // stdout, which is what the UI displays.
      const pull = dirty ? 'hard-reset applied' : await runGit(['pull', 'origin', safeBranch, '--ff-only']);
      const after = await gitStatus();
      const changed = before.commit !== after.commit;
      // Schedule process exit so PM2 auto-restarts us. This is far simpler
      // and port/env-agnostic compared to spawning update.sh (which hardcodes
      // PORT=3003 default). Requires PM2 autorestart: true (the default).
      if (changed) {
        setTimeout(() => {
          log.info('self-update: exiting for PM2 auto-restart');
          process.exit(0);
        }, 800);
      }
      return json(res, 200, {
        ok: true,
        changed,
        before: before.commit,
        after: after.commit,
        pullOutput: pull.trim(),
        restarting: changed,
      });
    } catch (err) {
      return json(res, 200, { ok: false, error: err.message });
    }
  }

  // ─── Cache ────────────────────────────────────────────
  if (subpath === '/cache' && method === 'GET') {
    return json(res, 200, cacheStats());
  }
  if (subpath === '/cache' && method === 'DELETE') {
    cacheClear();
    return json(res, 200, { success: true });
  }

  // ─── Accounts ─────────────────────────────────────────
  if (subpath === '/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  if (subpath === '/accounts' && method === 'POST') {
    try {
      let account;
      if (body.api_key) {
        account = addAccountByKey(body.api_key, body.label);
      } else if (body.token) {
        account = await addAccountByToken(body.token, body.label);
      } else {
        return json(res, 400, { error: 'Provide api_key or token' });
      }
      // Fire-and-forget probe so the UI gets tier info shortly after add
      probeAccount(account.id).catch(e => log.warn(`Auto-probe failed: ${e.message}`));
      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /accounts/probe-all — probe every active account
  if (subpath === '/accounts/probe-all' && method === 'POST') {
    const list = getAccountList().filter(a => a.status === 'active');
    const results = [];
    for (const a of list) {
      try {
        const r = await probeAccount(a.id);
        results.push({ id: a.id, email: a.email, tier: r?.tier || 'unknown' });
      } catch (err) {
        results.push({ id: a.id, email: a.email, error: err.message });
      }
    }
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/probe — manually trigger capability probe
  const accountProbe = subpath.match(/^\/accounts\/([^/]+)\/probe$/);
  if (accountProbe && method === 'POST') {
    try {
      const result = await probeAccount(accountProbe[1]);
      if (!result) return json(res, 404, { error: 'Account not found' });
      return json(res, 200, { success: true, ...result });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /accounts/refresh-credits — refresh every active account's balance
  if (subpath === '/accounts/refresh-credits' && method === 'POST') {
    const results = await refreshAllCredits();
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/refresh-credits — single-account refresh
  const creditRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-credits$/);
  if (creditRefresh && method === 'POST') {
    const r = await refreshCredits(creditRefresh[1]);
    return json(res, r.ok ? 200 : 400, r);
  }

  // PATCH /accounts/:id
  const accountPatch = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountPatch && method === 'PATCH') {
    const id = accountPatch[1];
    if (body.status) setAccountStatus(id, body.status);
    if (body.label) updateAccountLabel(id, body.label);
    if (body.resetErrors) resetAccountErrors(id);
    if (Array.isArray(body.blockedModels)) setAccountBlockedModels(id, body.blockedModels);
    if (body.tier) setAccountTier(id, body.tier);
    return json(res, 200, { success: true });
  }

  // GET /tier-access — hardcoded FREE/PRO model entitlement tables.
  // The dashboard uses this to render the full per-account model grid
  // (every row in the tier's list is shown, blocked models are dimmed).
  if (subpath === '/tier-access' && method === 'GET') {
    return json(res, 200, {
      free: _TIER_TABLE.free,
      pro: _TIER_TABLE.pro,
      unknown: _TIER_TABLE.unknown,
      expired: _TIER_TABLE.expired,
      allModels: Object.keys(MODELS),
    });
  }

  // DELETE /accounts/:id
  const accountDel = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountDel && method === 'DELETE') {
    const ok = removeAccount(accountDel[1]);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  // ─── Stats ────────────────────────────────────────────
  if (subpath === '/stats' && method === 'GET') {
    return json(res, 200, getStats());
  }

  if (subpath === '/stats' && method === 'DELETE') {
    resetStats();
    return json(res, 200, { success: true });
  }

  // ─── Logs ─────────────────────────────────────────────
  if (subpath === '/logs' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const level = url.searchParams.get('level') || null;
    return json(res, 200, { logs: getLogs(since, level) });
  }

  if (subpath === '/logs/stream' && method === 'GET') {
    req.socket.setKeepAlive(true);
    req.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Send existing logs first
    const existing = getLogs();
    for (const entry of existing.slice(-50)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15000);

    const cb = (entry) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    subscribeToLogs(cb);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeFromLogs(cb);
    });
    return;
  }

  // ─── Proxy ────────────────────────────────────────────
  // Always return the masked view over the API — plaintext passwords
  // would otherwise end up in dashboard network logs, HAR files, proxy
  // access logs, etc. The UI posts the sentinel back to preserve the
  // stored password when editing other fields (see mergePassword).
  if (subpath === '/proxy' && method === 'GET') {
    return json(res, 200, getProxyConfigMasked());
  }

  if (subpath === '/proxy/global' && method === 'PUT') {
    setGlobalProxy(body);
    return json(res, 200, { success: true, config: getProxyConfigMasked() });
  }

  if (subpath === '/proxy/global' && method === 'DELETE') {
    removeProxy('global');
    return json(res, 200, { success: true });
  }

  const proxyAccount = subpath.match(/^\/proxy\/accounts\/([^/]+)$/);
  if (proxyAccount && method === 'PUT') {
    setAccountProxy(proxyAccount[1], body);
    // Spawn (or adopt) the LS instance for this proxy so chat routes immediately
    ensureLsForAccount(proxyAccount[1]).catch(e => log.warn(`LS ensure failed: ${e.message}`));
    return json(res, 200, { success: true });
  }
  if (proxyAccount && method === 'DELETE') {
    removeProxy('account', proxyAccount[1]);
    return json(res, 200, { success: true });
  }

  // ─── Config ───────────────────────────────────────────
  if (subpath === '/config' && method === 'GET') {
    return json(res, 200, {
      port: config.port,
      defaultModel: config.defaultModel,
      maxTokens: config.maxTokens,
      logLevel: config.logLevel,
      lsBinaryPath: config.lsBinaryPath,
      lsPort: config.lsPort,
      codeiumApiUrl: config.codeiumApiUrl,
      hasApiKey: !!config.apiKey,
      hasDashboardPassword: !!config.dashboardPassword,
    });
  }

  // ─── Language Server ──────────────────────────────────
  if (subpath === '/langserver/restart' && method === 'POST') {
    if (!body.confirm) {
      return json(res, 400, { error: 'Send { confirm: true } to restart language server' });
    }
    stopLanguageServer();
    setTimeout(async () => {
      try {
        await startLanguageServer({
          binaryPath: config.lsBinaryPath,
          port: config.lsPort,
          apiServerUrl: config.codeiumApiUrl,
        });
      } catch (e) {
        log.error(`Language server restart failed: ${e.message}`);
      }
    }, 2000);
    return json(res, 200, { success: true, message: 'Restarting language server...' });
  }

  // ─── Models list ──────────────────────────────────────
  if (subpath === '/models' && method === 'GET') {
    const models = Object.entries(MODELS).map(([id, info]) => ({
      id, name: info.name, provider: info.provider,
    }));
    return json(res, 200, { models });
  }

  // ─── Model Access Control ──────────────────────────────
  if (subpath === '/model-access' && method === 'GET') {
    return json(res, 200, getModelAccessConfig());
  }

  if (subpath === '/model-access' && method === 'PUT') {
    if (body.mode) setModelAccessMode(body.mode);
    if (body.list) setModelAccessList(body.list);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  if (subpath === '/model-access/add' && method === 'POST') {
    if (!body.model) return json(res, 400, { error: 'model is required' });
    addModelToList(body.model);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  if (subpath === '/model-access/remove' && method === 'POST') {
    if (!body.model) return json(res, 400, { error: 'model is required' });
    removeModelFromList(body.model);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  // ─── Windsurf Login ────────────────────────────────────
  if (subpath === '/windsurf-login' && method === 'POST') {
    try {
      const { email, password, proxy: loginProxy, autoAdd } = body || {};
      return json(res, 200, await processWindsurfLogin({ email, password, loginProxy, autoAdd }));
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.message, isAuthFail: !!err.isAuthFail, firebaseCode: err.firebaseCode });
    }
  }

  if (subpath === '/windsurf-login/batch' && method === 'POST') {
    try {
      const { accounts, proxy: loginProxy, autoAdd } = body || {};
      if (!Array.isArray(accounts) || !accounts.length) {
        return json(res, 400, { error: 'accounts 为必填数组' });
      }

      const results = [];
      for (const acct of accounts) {
        const email = String(acct?.email || '').trim();
        const password = String(acct?.password || '').trim();
        try {
          const result = await processWindsurfLogin({ email, password, loginProxy, autoAdd });
          results.push(result);
        } catch (err) {
          results.push({
            success: false,
            email,
            error: err.message,
            isAuthFail: !!err.isAuthFail,
            firebaseCode: err.firebaseCode,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;
      return json(res, 200, {
        success: true,
        total: results.length,
        successCount,
        failCount,
        results,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // ─── OAuth login (Google / GitHub via Firebase) ────────
  // POST /oauth-login — accepts Firebase idToken from client-side OAuth
  if (subpath === '/oauth-login' && method === 'POST') {
    try {
      const { idToken, refreshToken, email, provider, autoAdd } = body;
      if (!idToken) return json(res, 400, { error: '缺少 idToken' });

      const proxy = getProxyConfig().global;
      const { apiKey, name } = await reRegisterWithCodeium(idToken, proxy);

      let account = null;
      if (autoAdd !== false) {
        account = addAccountByKey(apiKey, name || email || provider || 'OAuth');
        if (refreshToken) {
          setAccountTokens(account.id, { refreshToken, idToken });
        }
        ensureLsForAccount(account.id)
          .then(() => probeAccount(account.id))
          .catch(e => log.warn(`OAuth auto-probe failed: ${e.message}`));
      }

      return json(res, 200, {
        success: true,
        apiKey,
        name,
        email: email || '',
        account: account ? { id: account.id, email: account.email, status: account.status } : null,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // ─── Rate Limit Check ──────────────────────────────────
  // POST /accounts/:id/rate-limit — check capacity for a single account
  const rateLimitCheck = subpath.match(/^\/accounts\/([^/]+)\/rate-limit$/);
  if (rateLimitCheck && method === 'POST') {
    const list = getAccountList();
    const acct = list.find(a => a.id === rateLimitCheck[1]);
    if (!acct) return json(res, 404, { error: 'Account not found' });
    try {
      const proxy = getEffectiveProxy(acct.id) || null;
      const result = await checkMessageRateLimit(acct.apiKey, proxy);
      return json(res, 200, { success: true, account: acct.email, ...result });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ─── Firebase Token Refresh ───────────────────────────────
  // POST /accounts/:id/refresh-token — manually refresh Firebase token
  const tokenRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-token$/);
  if (tokenRefresh && method === 'POST') {
    const list = getAccountList();
    const acct = list.find(a => a.id === tokenRefresh[1]);
    if (!acct) return json(res, 404, { error: 'Account not found' });
    if (!acct.refreshToken) return json(res, 400, { error: 'Account has no refresh token' });
    try {
      const proxy = getEffectiveProxy(acct.id) || null;
      const { idToken, refreshToken: newRefresh } = await refreshFirebaseToken(acct.refreshToken, proxy);
      const { apiKey } = await reRegisterWithCodeium(idToken, proxy);
      const keyChanged = apiKey && apiKey !== acct.apiKey;
      // Persist the fresh credentials back onto the account. Without this, the
      // in-memory apiKey stays on the now-stale value until the next server
      // restart — every subsequent request from this account will fail auth.
      setAccountTokens(acct.id, { apiKey: apiKey || acct.apiKey, refreshToken: newRefresh || acct.refreshToken, idToken });
      return json(res, 200, { success: true, keyChanged, email: acct.email });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  json(res, 404, { error: `Dashboard API: ${method} ${subpath} not found` });
}

// ─── Proxy connectivity test ──────────────────────────────
// HTTP CONNECT tunnel to api.ipify.org:443 → GET / → the returned IP is the
// proxy's egress IP. Confirms the proxy works AND that auth is accepted.
// ─── Self-update helpers ───────────────────────────────
//
// execFile (not exec) for every invocation: no shell is spawned, so
// metacharacters in any future argument source are data, not commands.
// Belt-and-braces with the branch-name regex in /self-update — if a
// future refactor drops the regex, execFile still denies injection.
function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => {
      execFile('git', args, { timeout: 30_000, maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).toString().slice(0, 500)));
        resolve(stdout.toString());
      });
    }).catch(reject);
  });
}

async function gitStatus() {
  const commit = (await runGit(['rev-parse', 'HEAD'])).trim();
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  let remote = '';
  try {
    await runGit(['fetch', '--quiet', 'origin']);
    remote = (await runGit(['rev-parse', `origin/${branch}`])).trim();
  } catch {}
  const localMsg = (await runGit(['log', '-1', '--pretty=format:%s'])).trim();
  const behind = remote && remote !== commit;
  const remoteMsg = behind ? (await runGit(['log', '-1', '--pretty=format:%s', remote]).catch(() => '')).trim() : '';
  return {
    commit: commit.slice(0, 7),
    commitFull: commit,
    branch,
    localMessage: localMsg,
    remoteCommit: remote ? remote.slice(0, 7) : '',
    remoteMessage: remoteMsg,
    behind,
  };
}

const PRIVATE_PROXY_HOST = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|localhost$|0\.0\.0\.0$)/i;

async function testProxy({ host, port, username, password, type }) {
  if (PRIVATE_PROXY_HOST.test(host)) throw new Error('代理地址不能指向内网/本机');
  const http = await import('node:http');
  const tls = await import('node:tls');
  return new Promise((resolve, reject) => {
    const targetHost = 'api.ipify.org';
    const targetPort = 443;
    const authHeader = username
      ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64') }
      : {};
    const req = http.request({
      host,
      port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}`, ...authHeader },
      timeout: 10000,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理返回 HTTP ${res.statusCode}`));
      }
      // Do a quick TLS handshake + GET to verify the tunnel actually works
      const tlsSock = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false }, () => {
        tlsSock.write(`GET / HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\nUser-Agent: WindsurfAPI/ProxyTest\r\n\r\n`);
      });
      const chunks = [];
      tlsSock.on('data', c => chunks.push(c));
      tlsSock.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const match = body.match(/\r\n\r\n([^\r\n]+)/);
        const ip = match ? match[1].trim() : '';
        tlsSock.destroy();
        if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          return reject(new Error('TLS 隧道建立但返回内容异常'));
        }
        resolve({ egressIp: ip, type });
      });
      tlsSock.on('error', (err) => reject(new Error(`TLS 失败: ${err.message}`)));
    });
    req.on('error', (err) => reject(new Error(`连接失败: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('超时（10s）')); });
    req.end();
  });
}
