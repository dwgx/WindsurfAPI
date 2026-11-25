/**
 * Smoke-matrix families: core · auth · dashboard.
 *
 * Registered into scripts/smoke-matrix.mjs. Each flow names the family it
 * protects; the runner fails the run if a declared family registers nothing.
 */

export function registerCoreFlows(ctx) {
  const { http, requireThat, addFlow, SMOKE, MATRIX } = ctx;

  // ─── core ────────────────────────────────────────────────────────────
  addFlow('core', 'core.health', async () => {
    const r = await http('GET', '/health', { auth: 'none' });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(r.json?.status === 'ok', `status field ${r.json?.status}`);
    requireThat(/^\d+\.\d+\.\d+/.test(String(r.json?.version)), `version ${r.json?.version}`);
    requireThat(typeof r.json?.accounts?.total === 'number', 'accounts.total missing');
    requireThat(typeof r.header('x-request-id') === 'string', 'x-request-id header missing');
    return `v${r.json.version}, ${r.json.accounts.total} accounts`;
  });

  addFlow('core', 'core.health-verbose-gate', async () => {
    const anon = await http('GET', '/health?verbose=1', { auth: 'none' });
    requireThat(anon.status === 200, `status ${anon.status}`);
    requireThat(anon.json?.conversationPool === undefined, 'verbose diagnostics leaked without an API key');
    const authed = await http('GET', '/health?verbose=1', { auth: 'api' });
    requireThat(authed.status === 200, `authed status ${authed.status}`);
    requireThat(typeof authed.json?.conversationPool === 'object', 'verbose diagnostics missing for an authed caller');
    requireThat(typeof authed.json?.cache === 'object', 'cache stats missing for an authed caller');
    return 'diagnostics gated by API key';
  });

  addFlow('core', 'core.favicon', async () => {
    const r = await http('GET', '/favicon.ico', { auth: 'none' });
    requireThat(r.status === 204, `status ${r.status}`);
    requireThat(r.text === '', 'favicon returned a body');
    return '204, empty';
  });

  addFlow('core', 'core.404-openai', async () => {
    const r = await http('GET', '/v1/definitely-not-a-route', { auth: 'api' });
    requireThat(r.status === 404, `status ${r.status}`);
    requireThat(r.json?.error?.type === 'not_found_error', `type ${r.json?.error?.type}`);
    requireThat(typeof r.header('x-request-id') === 'string', 'x-request-id header missing');
    return '404 OpenAI envelope + request id';
  });

  addFlow('core', 'core.404-anthropic', async () => {
    const r = await http('GET', '/v1/messages/definitely-not-a-route', { auth: 'api' });
    requireThat(r.status === 404, `status ${r.status}`);
    requireThat(r.json?.type === 'error', `envelope ${r.json?.type}`);
    requireThat(r.json?.error?.type === 'not_found_error', `type ${r.json?.error?.type}`);
    return '404 Anthropic envelope';
  });

  // ─── auth ────────────────────────────────────────────────────────────
  addFlow('auth', 'auth.dashboard-401', async () => {
    const r = await http('GET', '/dashboard/api/overview', { auth: 'none' });
    requireThat(r.status === 401, `status ${r.status}`);
    requireThat(/Unauthorized/i.test(String(r.json?.error)), `error ${r.json?.error}`);
    return '401 without the dashboard password';
  });

  addFlow('auth', 'auth.dashboard-wrong-password', async () => {
    // Exactly one wrong guess: the shared IP bucket bans after the configured
    // strike count, and the next flow authenticates successfully to clear it.
    const r = await http('GET', '/dashboard/api/overview', {
      auth: 'none',
      headers: { 'x-dashboard-password': 'smoke-definitely-wrong-password' },
    });
    requireThat(r.status === 401, `status ${r.status}`);
    return '401 on a wrong password';
  });

  addFlow('auth', 'auth.dashboard-ok', async () => {
    const r = await http('GET', '/dashboard/api/overview');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(typeof r.json?.uptime === 'number', 'uptime missing');
    const probe = await http('GET', '/dashboard/api/auth', { auth: 'none' });
    requireThat(probe.status === 200, `auth probe status ${probe.status}`);
    requireThat(probe.json?.required === true && probe.json?.valid === false, 'unauthenticated /auth probe shape');
    const authed = await http('GET', '/dashboard/api/auth');
    requireThat(authed.json?.required === true && authed.json?.valid === true, 'authenticated /auth probe shape');
    return '200 with password; /auth reports required+valid';
  });

  addFlow('auth', 'auth.api-missing-key', async () => {
    const r = await http('POST', '/v1/chat/completions', {
      auth: 'none',
      body: { model: MATRIX.models.chat, messages: [{ role: 'user', content: 'hi' }] },
    });
    requireThat(r.status === 401, `status ${r.status}`);
    requireThat(r.json?.error?.type === 'auth_error', `type ${r.json?.error?.type}`);
    requireThat(typeof r.json?.request_id === 'string', 'error body request_id missing');
    return '401 auth_error + request_id';
  });

  addFlow('auth', 'auth.api-wrong-key', async () => {
    const r = await http('POST', '/v1/chat/completions', {
      auth: 'none',
      headers: { authorization: 'Bearer ' + 'sk-smoke-wrong-' + 'key-000000' },
      body: { model: MATRIX.models.chat, messages: [{ role: 'user', content: 'hi' }] },
    });
    requireThat(r.status === 401, `status ${r.status}`);
    requireThat(/Invalid API key/i.test(String(r.json?.error?.message)), 'wrong-key message missing');
    return '401 on a wrong API key';
  });

  addFlow('auth', 'auth.account-mgmt-403', async () => {
    const r = await http('GET', '/auth/accounts', { auth: 'api' });
    requireThat(r.status === 403, `status ${r.status}`);
    requireThat(r.json?.error?.code === 'admin_required', `code ${r.json?.error?.code}`);
    return 'chat key alone cannot list the account pool';
  });

  addFlow('auth', 'auth.account-mgmt-200', async () => {
    const r = await http('GET', '/auth/accounts', { auth: 'both' });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(Array.isArray(r.json?.accounts), 'accounts array missing');
    return `operator auth accepted (${r.json.accounts.length} accounts)`;
  });

  // ─── dashboard ───────────────────────────────────────────────────────
  addFlow('dashboard', 'dashboard.accounts-empty', async () => {
    const r = await http('GET', '/dashboard/api/accounts');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(Array.isArray(r.json?.accounts), 'accounts array missing');
    requireThat(r.json.accounts.length === 0, `fresh DATA_DIR already has ${r.json.accounts.length} accounts`);
    const ids = await http('GET', '/dashboard/api/accounts/ids');
    requireThat(ids.status === 200 && Array.isArray(ids.json?.ids), 'ids array missing');
    requireThat(ids.json.ids.length === 0, 'ids not empty on a fresh DATA_DIR');
    return 'fresh install lists zero accounts';
  });

  addFlow('dashboard', 'dashboard.html', async () => {
    const r = await http('GET', '/dashboard', { auth: 'none' });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(/text\/html/i.test(r.contentType), `content-type ${r.contentType}`);
    requireThat(r.text.includes('id="lang-toggle-btn"'), 'language toggle marker missing');
    requireThat(r.text.includes('data-i18n="nav.overview"'), 'i18n marker missing');
    requireThat(r.text.includes('data-i18n="nav.accounts"'), 'accounts nav marker missing');
    return '200 text/html, i18n markers present';
  });

  addFlow('dashboard', 'dashboard.html-sketch-skin', async () => {
    const r = await http('GET', '/dashboard', {
      auth: 'none',
      headers: { cookie: 'dashboard_skin=sketch' },
    });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(r.text.includes('id="hdr-stamp"'), 'sketch-only marker missing');
    requireThat(r.header('vary')?.toLowerCase().includes('cookie'), 'Vary: Cookie missing on the skin fork');
    return 'cookie selects the sketch console';
  });

  addFlow('dashboard', 'dashboard.i18n-en', async () => {
    const r = await http('GET', '/dashboard/i18n/en.json', { auth: 'none' });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(ctx.readPath(r.json, 'nav.overview') === 'Dashboard', 'nav.overview mismatch');
    requireThat(typeof ctx.readPath(r.json, 'emailLogin.methodEmailCode') === 'string', 'emailLogin.methodEmailCode missing');
    return 'en.json 200';
  });

  addFlow('dashboard', 'dashboard.i18n-zh-CN', async () => {
    const en = await http('GET', '/dashboard/i18n/en.json', { auth: 'none' });
    const r = await http('GET', '/dashboard/i18n/zh-CN.json', { auth: 'none' });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(ctx.readPath(r.json, 'nav.overview') === '仪表盘', 'nav.overview mismatch');
    requireThat(ctx.readPath(r.json, 'nav.overview') !== ctx.readPath(en.json, 'nav.overview'), 'zh-CN and en identical');
    return 'zh-CN.json 200, distinct translation';
  });

  addFlow('dashboard', 'dashboard.i18n-rejects-path-traversal', async () => {
    const r = await http('GET', '/dashboard/i18n/..%2F..%2Fpackage.json', { auth: 'none' });
    requireThat(r.status === 400, `status ${r.status}`);
    requireThat(/Invalid locale file/i.test(String(r.json?.error)), `error ${r.json?.error}`);
    const missing = await http('GET', '/dashboard/i18n/xx-YY.json', { auth: 'none' });
    requireThat(missing.status === 404, `missing locale status ${missing.status}`);
    return 'traversal 400, unknown locale 404';
  });

  addFlow('dashboard', 'dashboard.data-file', async () => {
    const r = await http('GET', '/dashboard/data/contributors.json', { auth: 'none' });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(/json/i.test(r.contentType), `content-type ${r.contentType}`);
    requireThat(r.json != null && typeof r.json === 'object', 'contributors payload not JSON');
    const bad = await http('GET', '/dashboard/data/..%2Fpackage.json', { auth: 'none' });
    requireThat(bad.status === 400, `traversal status ${bad.status}`);
    return 'roster served, traversal rejected';
  });

  addFlow('dashboard', 'dashboard.requires-operator-auth', async () => {
    // The dashboard's whole API surface is operator-only. Assert it from the
    // dashboard family too (the auth family covers the gate itself): a mutant
    // that opens the gate must turn a DASHBOARD flow red, not only an auth one.
    for (const path of ['/dashboard/api/accounts', '/dashboard/api/config', '/dashboard/api/logs']) {
      const anon = await http('GET', path, { auth: 'none' });
      requireThat(anon.status === 401, `${path} answered ${anon.status} without the dashboard password`);
    }
    const authed = await http('GET', '/dashboard/api/accounts');
    requireThat(authed.status === 200, `authed status ${authed.status}`);
    return '401 without the password on every dashboard read';
  });

  addFlow('dashboard', 'dashboard.oauth-status', async () => {
    const r = await http('GET', '/dashboard/api/oauth/status');
    requireThat(r.status === 410, 'the retired browser transaction still reports a usable status');
    requireThat(r.json?.success === false && r.json?.error === 'ERR_BROWSER_ENROLLMENT_UNAVAILABLE',
      'the retired flow must return its explicit terminal failure');
    const current = await http('GET', '/dashboard/api/devin-browser-login/status');
    requireThat(current.status === 200 && current.json?.available === false,
      'local browser enrollment must remain unavailable until explicitly enabled');
    return 'retired flow is terminal; current local browser enrollment is opt-in';
  });

  addFlow('dashboard', 'dashboard.import-local-availability', async () => {
    const r = await http('GET', '/dashboard/api/accounts/import-local-availability');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(typeof r.json?.available === 'boolean', 'available flag missing');
    requireThat(typeof r.json?.bindHost === 'string', 'bindHost missing');
    requireThat(typeof r.json?.hint === 'string', 'hint missing');
    return `available=${r.json.available} (bind ${r.json.bindHost})`;
  });

  addFlow('dashboard', 'dashboard.stats-export-import', async () => {
    const exported = await http('GET', '/dashboard/api/stats/export');
    requireThat(exported.status === 200, `export status ${exported.status}`);
    requireThat(exported.json?._schema === 'windsurfapi-stats-v2', `schema ${exported.json?._schema}`);
    const imported = await http('POST', '/dashboard/api/stats/import', {
      body: { mode: 'merge', snapshot: exported.json },
    });
    requireThat(imported.status === 200 && imported.json?.ok === true, `import status ${imported.status} error ${imported.json?.error || '?'}`);
    const invalid = await http('POST', '/dashboard/api/stats/import', { body: { mode: 'merge', snapshot: {} } });
    requireThat(invalid.status === 400, `empty snapshot status ${invalid.status}`);
    return 'export → merge import round-trip; empty snapshot rejected';
  });

  addFlow('dashboard', 'dashboard.conversation-pool-clear', async () => {
    const r = await http('DELETE', '/dashboard/api/experimental/conversation-pool');
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status}`);
    requireThat(typeof r.json?.cleared === 'number', 'cleared count missing');
    return `cleared ${r.json.cleared} pooled conversations`;
  });

  addFlow('dashboard', 'dashboard.overview', async () => {
    const r = await http('GET', '/dashboard/api/overview');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(typeof r.json?.uptime === 'number', 'uptime missing');
    requireThat(typeof r.json?.accounts?.total === 'number', 'accounts.total missing');
    requireThat(typeof r.json?.cache === 'object', 'cache stats missing');
    requireThat(typeof r.json?.poolBalance === 'object', 'poolBalance missing');
    return 'overview shape';
  });

  addFlow('dashboard', 'dashboard.stats', async () => {
    const r = await http('GET', '/dashboard/api/stats');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(typeof r.json?.totalRequests === 'number', 'totalRequests missing');
    requireThat(typeof r.json?.successCount === 'number', 'successCount missing');
    return `stats (${r.json.totalRequests} requests)`;
  });

  addFlow('dashboard', 'dashboard.config', async () => {
    const r = await http('GET', '/dashboard/api/config');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(typeof r.json?.port === 'number', 'port missing');
    requireThat(typeof r.json?.defaultModel === 'string', 'defaultModel missing');
    requireThat(r.json?.hasApiKey === true, 'hasApiKey false');
    requireThat(r.json?.hasDashboardPassword === true, 'hasDashboardPassword false');
    requireThat(!r.text.includes(SMOKE.dashboardPassword), 'dashboard password echoed by /config');
    return 'config shape, secret not echoed';
  });

  addFlow('dashboard', 'dashboard.models', async () => {
    const r = await http('GET', '/dashboard/api/models');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(Array.isArray(r.json?.models) && r.json.models.length > 5, `models ${r.json?.models?.length}`);
    requireThat(r.json.models.every((m) => typeof m.reachable === 'boolean'), 'a model row lacks reachable');
    requireThat(r.json.models.some((m) => m.id === 'swe-1-6-slow'), 'free selector row missing');
    requireThat(r.json.models.every((m) => typeof m.freeNow === 'boolean' || m.freeNow === null), 'freeNow tri-state broken');
    return `${r.json.models.length} rows incl. swe-1-6-slow`;
  });

  addFlow('dashboard', 'dashboard.tier-access', async () => {
    const r = await http('GET', '/dashboard/api/tier-access');
    requireThat(r.status === 200, `status ${r.status}`);
    for (const tier of ['free', 'pro', 'unknown', 'expired']) {
      requireThat(Array.isArray(r.json?.[tier]), `${tier} table missing`);
    }
    requireThat(Array.isArray(r.json?.allModels) && r.json.allModels.length > 0, 'allModels empty');
    return `${r.json.allModels.length} catalog models`;
  });

  addFlow('dashboard', 'dashboard.experimental', async () => {
    const before = await http('GET', '/dashboard/api/experimental');
    requireThat(before.status === 200, `status ${before.status}`);
    requireThat(typeof before.json?.flags === 'object', 'flags missing');
    requireThat(typeof before.json?.tunables === 'object', 'tunables missing');
    const put = await http('PUT', '/dashboard/api/experimental', { body: { clineCompat: false } });
    requireThat(put.status === 200 && put.json?.success === true, `put status ${put.status}`);
    requireThat(put.json?.flags?.clineCompat === false, 'clineCompat not pinned false');
    return 'flags + tunables readable, whitelisted write applied';
  });

  addFlow('dashboard', 'dashboard.breaker-and-quota-config', async () => {
    const breaker = await http('GET', '/dashboard/api/breaker-config');
    requireThat(breaker.status === 200, `breaker status ${breaker.status}`);
    requireThat(typeof breaker.json?.knobs === 'object', 'breaker knobs missing');
    const quota = await http('GET', '/dashboard/api/quota-config');
    requireThat(quota.status === 200, `quota status ${quota.status}`);
    requireThat(typeof quota.json?.knobs === 'object', 'quota knobs missing');
    const put = await http('PUT', '/dashboard/api/quota-config', { body: {} });
    requireThat(put.status === 200 && put.json?.success === true, `quota put status ${put.status}`);
    return `${Object.keys(breaker.json.knobs).length} breaker knobs`;
  });

  addFlow('dashboard', 'dashboard.system-prompts', async () => {
    const r = await http('GET', '/dashboard/api/system-prompts');
    requireThat(r.status === 200, `status ${r.status}`);
    const prompts = r.json?.prompts || {};
    requireThat(typeof prompts.toolReinforcement === 'string', 'toolReinforcement missing');
    // Write the SAME value back: proves the PUT path without changing behaviour.
    const put = await http('PUT', '/dashboard/api/system-prompts', { body: { toolReinforcement: prompts.toolReinforcement } });
    requireThat(put.status === 200 && put.json?.success === true, `put status ${put.status}`);
    requireThat(put.json?.prompts?.toolReinforcement === prompts.toolReinforcement, 'prompt changed by an identity write');
    const del = await http('DELETE', '/dashboard/api/system-prompts/toolReinforcement');
    requireThat(del.status === 200 && del.json?.success === true, `delete status ${del.status}`);
    requireThat(String(del.json?.prompts?.toolReinforcement).includes('<tool_call>'), 'reset prompt lost the tool-call example');
    return 'read, identity write, reset to default';
  });

  addFlow('dashboard', 'dashboard.model-access', async () => {
    const before = await http('GET', '/dashboard/api/model-access');
    requireThat(before.status === 200, `status ${before.status}`);
    requireThat(before.json?.mode === 'all', `mode ${before.json?.mode}`);
    const add = await http('POST', '/dashboard/api/model-access/add', { body: { model: 'smoke-model' } });
    requireThat(add.status === 200 && add.json?.config?.list?.includes('smoke-model'), 'add did not persist');
    const remove = await http('POST', '/dashboard/api/model-access/remove', { body: { model: 'smoke-model' } });
    requireThat(remove.status === 200 && !remove.json?.config?.list?.includes('smoke-model'), 'remove did not persist');
    const invalid = await http('POST', '/dashboard/api/model-access/add', { body: {} });
    requireThat(invalid.status === 400, `invalid add status ${invalid.status}`);
    requireThat(before.json?.mode === 'all', 'mode changed as a side effect');
    return 'add/remove round-trip, mode untouched, missing model 400';
  });

  addFlow('dashboard', 'dashboard.prefs', async () => {
    const before = await http('GET', '/dashboard/api/settings/prefs');
    requireThat(before.status === 200, `status ${before.status}`);
    requireThat(typeof before.json?.prefs?.oauthSkipChooser === 'boolean', 'oauthSkipChooser missing');
    const on = await http('PUT', '/dashboard/api/settings/prefs', { body: { oauthSkipChooser: true } });
    requireThat(on.status === 200 && on.json?.prefs?.oauthSkipChooser === true, 'pref not set');
    const off = await http('PUT', '/dashboard/api/settings/prefs', { body: { oauthSkipChooser: false } });
    requireThat(off.status === 200 && off.json?.prefs?.oauthSkipChooser === false, 'pref not cleared');
    return 'toggle persists both directions';
  });

  addFlow('dashboard', 'dashboard.settings-credentials', async () => {
    const r = await http('GET', '/dashboard/api/settings/credentials');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(typeof r.json?.apiKey_masked === 'string', 'apiKey_masked missing');
    requireThat(r.json.apiKey_masked !== SMOKE.apiKey, 'api key not masked');
    requireThat(r.json?.apiKeySource === 'env', `apiKeySource ${r.json?.apiKeySource}`);
    requireThat(r.json?.dashboardPasswordSet === true, 'dashboardPasswordSet false');
    requireThat(!r.text.includes(SMOKE.apiKey), 'raw API key echoed by credentials view');
    const bad = await http('PUT', '/dashboard/api/settings/credentials', { body: { apiKey: 'short' } });
    requireThat(bad.status === 400, `short api key status ${bad.status}`);
    const badPw = await http('PUT', '/dashboard/api/settings/credentials', { body: { dashboardPassword: 'short' } });
    requireThat(badPw.status === 400, `short dashboard password status ${badPw.status}`);
    return 'masked view, both validation edges 400';
  });

  addFlow('dashboard', 'dashboard.proxy-rejects-private-host', async () => {
    const r = await http('GET', '/dashboard/api/proxy');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(typeof r.json === 'object' && r.json !== null, 'proxy config missing');
    const put = await http('PUT', '/dashboard/api/proxy/global', { body: { host: '127.0.0.1', port: 8080 } });
    requireThat(put.status === 400, `private host status ${put.status}`);
    requireThat(/ERR_PROXY_PRIVATE_HOST|private|not allowed|blocked/i.test(String(put.json?.error)), `error ${put.json?.error}`);
    return 'masked config; private proxy host refused';
  });

  addFlow('dashboard', 'dashboard.cache-and-metrics', async () => {
    const cache = await http('GET', '/dashboard/api/cache');
    requireThat(cache.status === 200, `cache status ${cache.status}`);
    const metrics = await http('GET', '/dashboard/api/connect-metrics');
    requireThat(metrics.status === 200, `metrics status ${metrics.status}`);
    const rate = await http('GET', '/dashboard/api/rate-limit-history');
    requireThat(rate.status === 200, `rate-limit status ${rate.status}`);
    const cleared = await http('DELETE', '/dashboard/api/cache');
    requireThat(cleared.status === 200 && cleared.json?.success === true, `cache clear status ${cleared.status}`);
    const metricsCleared = await http('DELETE', '/dashboard/api/connect-metrics');
    requireThat(metricsCleared.status === 200, `metrics clear status ${metricsCleared.status}`);
    return 'cache + connect metrics read and clear';
  });

  addFlow('dashboard', 'dashboard.logs', async () => {
    const r = await http('GET', '/dashboard/api/logs?limit=5');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(Array.isArray(r.json?.logs), 'logs array missing');
    const exp = await http('GET', '/dashboard/api/logs/export?format=jsonl&type=all');
    requireThat(exp.status === 200, `export status ${exp.status}`);
    requireThat(/ndjson/i.test(exp.contentType), `export content-type ${exp.contentType}`);
    requireThat(/attachment; filename="/.test(String(exp.header('content-disposition'))), 'export filename header missing');
    requireThat(!exp.text.includes(SMOKE.apiKey), 'API key leaked into the log export');
    return `${r.json.logs.length} ring entries, JSONL export`;
  });

  addFlow('dashboard', 'dashboard.logs-stream', async () => {
    const r = await ctx.streamHead('/dashboard/api/logs/stream');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(/text\/event-stream/i.test(r.contentType), `content-type ${r.contentType}`);
    requireThat(/retry:/.test(r.text) || /data:/.test(r.text), `stream head ${JSON.stringify(r.text.slice(0, 120))}`);
    return 'SSE log stream opens with a retry hint';
  });

  addFlow('dashboard', 'dashboard.drought-and-upstream-endpoints', async () => {
    const drought = await http('GET', '/dashboard/api/drought');
    requireThat(drought.status === 200, `drought status ${drought.status}`);
    requireThat(typeof drought.json?.threshold === 'number', 'drought threshold missing');
    const endpoints = await http('GET', '/dashboard/api/upstream-endpoints');
    requireThat(endpoints.status === 200, `endpoints status ${endpoints.status}`);
    requireThat(String(endpoints.json?.registerUser?.primary).includes('register.windsurf.com'), 'registerUser.primary missing');
    requireThat(String(endpoints.json?.getUserStatus?.primary).includes('GetUserStatus'), 'getUserStatus.primary missing');
    return 'drought summary + upstream endpoint map';
  });

  addFlow('dashboard', 'dashboard.pool-events-and-ring-empty', async () => {
    const pool = await http('GET', '/dashboard/api/pool-events');
    requireThat(pool.status === 200, `pool status ${pool.status}`);
    requireThat(Array.isArray(pool.json?.accounts), 'pool accounts missing');
    requireThat(pool.json.accounts.length === 0, 'pool not empty before any account is added');
    const ring = await http('GET', '/dashboard/api/requests?limit=5');
    requireThat(ring.status === 200, `ring status ${ring.status}`);
    requireThat(Array.isArray(ring.json?.items) && ring.json.items.length === 0, 'ring not empty before any API traffic');
    requireThat(ring.json?.ring?.total === 0, `ring total ${ring.json?.ring?.total}`);
    return 'empty pool + empty ring on a fresh install';
  });
}
