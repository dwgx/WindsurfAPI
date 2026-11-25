/**
 * Smoke-matrix families: login · accounts.
 *
 * Login covers all three ways a user can get an account into the pool (email
 * code, password, token) plus the email-OTP registration surface, and each has
 * a failure edge: unknown account, degraded probe, resend cooldown, wrong code,
 * replayed flow, wrong password, batch partial failure.
 */

import { readFileSync } from 'node:fs';

export function registerLoginFlows(ctx) {
  const { http, requireThat, addFlow, state, SMOKE, MATRIX, deps } = ctx;

  // ─── login ───────────────────────────────────────────────────────────
  addFlow('login', 'login.probe-email-code', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/probe', {
      body: { email: SMOKE.emailNoPassword },
    });
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.hasPassword === false, `hasPassword=${r.json.hasPassword}`);
    requireThat(r.json.emailCode === true, `emailCode=${r.json.emailCode}`);
    requireThat(r.json.userExists === true, `userExists=${r.json.userExists}`);
    requireThat(r.json.method === 'auth1', `method=${r.json.method}`);
    requireThat(r.json.source === 'connections', `source=${r.json.source}`);
    requireThat(!r.text.includes(SMOKE.verifyToken), 'verification token echoed by probe');
    return 'no password → email_code offer';
  });

  addFlow('login', 'login.probe-password', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/probe', {
      body: { email: SMOKE.emailHasPassword },
    });
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.hasPassword === true, `hasPassword=${r.json.hasPassword}`);
    requireThat(r.json.emailCode === false, `emailCode=${r.json.emailCode}`);
    requireThat(r.json.method === 'auth1', `method=${r.json.method}`);
    return 'password account → password form';
  });

  addFlow('login', 'login.probe-unknown-account', async () => {
    // 3.9.48 contract: upstream's literal method:"not_found" is a sentinel, not
    // a login method. It must never become "email code offered" for a typo.
    const r = await http('POST', '/dashboard/api/windsurf-login/probe', {
      body: { email: MATRIX.emailUnknown },
    });
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.userExists === false, `userExists=${r.json.userExists}`);
    requireThat(r.json.emailCode === false, `emailCode=${r.json.emailCode}`);
    requireThat(r.json.method === null, `method=${r.json.method}`);
    return 'not_found → userExists:false, no code offered';
  });

  addFlow('login', 'login.probe-degraded-upstream', async () => {
    // Both probe endpoints fail: the answer is "unknown", never a fabricated
    // method (the UI must not promise a login path it could not verify).
    const r = await http('POST', '/dashboard/api/windsurf-login/probe', {
      body: { email: MATRIX.emailBrokenProbe },
    });
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.source === 'unknown', `source=${r.json.source}`);
    requireThat(r.json.hasPassword === null, `hasPassword=${r.json.hasPassword}`);
    requireThat(r.json.userExists === null, `userExists=${r.json.userExists}`);
    requireThat(r.json.emailCode === false, `emailCode=${r.json.emailCode}`);
    return 'degraded probe reports unknown, not a guess';
  });

  addFlow('login', 'login.probe-requires-email', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/probe', { body: {} });
    requireThat(r.status === 400, `status ${r.status}`);
    requireThat(r.json?.error === 'ERR_EMAIL_REQUIRED', `error ${r.json?.error}`);
    return '400 ERR_EMAIL_REQUIRED';
  });

  addFlow('login', 'login.email-start', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/email/start', {
      body: { email: SMOKE.emailNoPassword },
    });
    requireThat(r.status === 200 && r.json?.sent === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(/^[0-9a-f]{32}$/.test(String(r.json.flowId)), `flowId ${r.json.flowId}`);
    requireThat(typeof r.json.expiresInMs === 'number' && r.json.expiresInMs > 0, 'expiresInMs missing');
    requireThat(!r.text.includes(SMOKE.verifyToken), 'verification token echoed by start');
    state.flowId = r.json.flowId;
    return 'opaque flowId issued, verification token kept server-side';
  });

  addFlow('login', 'login.email-start-cooldown', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/email/start', {
      body: { email: SMOKE.emailNoPassword },
    });
    requireThat(r.status === 400, `status ${r.status}`);
    requireThat(r.json?.error === 'ERR_EMAIL_CODE_COOLDOWN', `error ${r.json?.error}`);
    requireThat(Number(r.json?.retryAfterMs) > 0, `retryAfterMs ${r.json?.retryAfterMs}`);
    return '30s resend cooldown enforced';
  });

  addFlow('login', 'login.email-complete-wrong-code', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/email/complete', {
      body: { flowId: state.flowId, code: '000000' },
    });
    requireThat(r.status === 400, `status ${r.status}`);
    requireThat(r.json?.error === 'ERR_EMAIL_CODE_REJECTED', `error ${r.json?.error}`);
    requireThat(r.json?.isAuthFail === true, 'wrong code not flagged as an auth failure');
    requireThat(r.json?.attemptsRemaining === 4, `attemptsRemaining ${r.json?.attemptsRemaining}`);
    requireThat(!r.text.includes(SMOKE.verifyToken), 'verification token echoed by a rejected code');
    return 'wrong code 400, 4 attempts left, flow survives';
  });

  addFlow('login', 'login.email-complete-unknown-flow', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/email/complete', {
      body: { flowId: 'f'.repeat(32), code: SMOKE.emailCode },
    });
    requireThat(r.status === 404, `status ${r.status}`);
    requireThat(r.json?.error === 'ERR_EMAIL_FLOW_NOT_FOUND', `error ${r.json?.error}`);
    const missing = await http('POST', '/dashboard/api/windsurf-login/email/complete', { body: {} });
    requireThat(missing.status === 400 && missing.json?.error === 'ERR_EMAIL_FLOW_CODE_REQUIRED', `missing-field status ${missing.status}`);
    return 'unknown flow 404, missing fields 400';
  });

  addFlow('login', 'login.email-complete', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/email/complete', {
      body: { flowId: state.flowId, code: SMOKE.emailCode },
    });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.method === 'email_code', `method=${r.json.method}`);
    requireThat(r.json.email === SMOKE.emailNoPassword, `email=${r.json.email}`);
    requireThat(typeof r.json.account?.id === 'string' && r.json.account.id, 'account not auto-added');
    requireThat(!r.text.includes(SMOKE.sessionTokenEmail), 'raw session token echoed by complete');
    requireThat(!r.text.includes(SMOKE.auth1Token), 'Auth1 token echoed by complete');
    state.emailAccountId = r.json.account.id;
    return `logged in + auto-added ${state.emailAccountId}`;
  });

  addFlow('login', 'login.email-complete-replay', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/email/complete', {
      body: { flowId: state.flowId, code: SMOKE.emailCode },
    });
    requireThat(r.status === 409, `status ${r.status}`);
    requireThat(r.json?.error === 'ERR_EMAIL_FLOW_USED', `error ${r.json?.error}`);
    return 'single-use flow → 409 on replay';
  });

  addFlow('login', 'login.password', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login', {
      body: { email: MATRIX.emailPassword, password: MATRIX.password },
    });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(typeof r.json.account?.id === 'string' && r.json.account.id, 'account not auto-added');
    requireThat(!r.text.includes(MATRIX.sessionTokenPassword), 'session token echoed by password login');
    requireThat(!r.text.includes(MATRIX.password), 'upstream password echoed by login');
    state.passwordAccountId = r.json.account.id;
    return `password login added ${state.passwordAccountId}`;
  });

  addFlow('login', 'login.password-wrong', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login', {
      body: { email: MATRIX.emailPassword, password: 'definitely-not-' + 'the-password' },
    });
    // The route reports a rejected credential as 4xx (400 today; the dashboard
    // only needs isAuthFail to render the error). Asserting the exact code here
    // would pin a presentation detail the login lane is still settling.
    requireThat(r.status >= 400 && r.status < 500, `status ${r.status}`);
    requireThat(r.json?.isAuthFail === true, 'wrong password not flagged as an auth failure');
    requireThat(String(r.json?.error || '').length > 0, 'no error message');
    requireThat(!r.text.includes(MATRIX.password), 'submitted password echoed by the error');
    return `rejected (${r.status}) with isAuthFail, credential not echoed`;
  });

  addFlow('login', 'login.batch', async () => {
    const r = await http('POST', '/dashboard/api/windsurf-login/batch', {
      body: {
        accounts: [
          { email: MATRIX.emailPassword, password: MATRIX.password },
          { email: SMOKE.emailHasPassword, password: 'wrong-' + 'password-here' },
        ],
      },
    });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status}`);
    requireThat(r.json.total === 2, `total ${r.json.total}`);
    requireThat(r.json.successCount === 1, `successCount ${r.json.successCount}`);
    requireThat(r.json.failCount === 1, `failCount ${r.json.failCount}`);
    requireThat(r.json.results.length === 2, 'results length mismatch');
    requireThat(!r.text.includes(MATRIX.sessionTokenPassword), 'batch echoed a session token');
    return '1 ok / 1 failed, per-account results';
  });

  addFlow('login', 'login.email-otp', async () => {
    const send = await http('POST', '/dashboard/api/email-otp/send', {
      body: { email: 'otp-smoke@example.test', firstName: 'Smoke', turnstileToken: 'turnstile-smoke-token' },
    });
    requireThat(send.status === 200 && send.json?.success === true, `send status ${send.status} error ${send.json?.error || '?'}`);
    const complete = await http('POST', '/dashboard/api/email-otp/complete', {
      body: {
        email: 'otp-smoke@example.test',
        otpCode: '123456',
        turnstileToken: 'turnstile-smoke-token',
        firstName: 'Smoke',
        autoAdd: true,
      },
    });
    requireThat(complete.status === 200 && complete.json?.success === true, `complete status ${complete.status} error ${complete.json?.error || '?'}`);
    requireThat(typeof complete.json.apiKey_masked === 'string', 'apiKey_masked missing');
    requireThat(!complete.text.includes(MATRIX.otpKey), 'raw OTP api key echoed');
    requireThat(typeof complete.json.account?.id === 'string', 'OTP account not added');
    state.otpAccountId = complete.json.account.id;
    return `register-user flow added ${state.otpAccountId}`;
  });

  addFlow('login', 'login.email-otp-validation', async () => {
    const send = await http('POST', '/dashboard/api/email-otp/send', { body: { email: 'x@example.test' } });
    requireThat(send.status === 400, `send status ${send.status}`);
    requireThat(send.json?.error === 'ERR_EMAIL_FIRSTNAME_TURNSTILE_REQUIRED', `error ${send.json?.error}`);
    const complete = await http('POST', '/dashboard/api/email-otp/complete', { body: { email: 'x@example.test' } });
    requireThat(complete.status === 400, `complete status ${complete.status}`);
    requireThat(complete.json?.error === 'ERR_EMAIL_OTP_TURNSTILE_REQUIRED', `error ${complete.json?.error}`);
    return 'both OTP steps reject missing turnstile/fields';
  });

  // ─── login wave 3 (3.9.50 / 3.9.51) ──────────────────────────────────
  addFlow('login', 'login.probe-non-auth1', async () => {
    // Upstream can answer a known non-auth1 method (firebase/oauth) with NO
    // has_password field. Guessing Auth1 from that answer sent a passwordless
    // account to a guaranteed 401, so the probe must report the method.
    const r = await http('POST', '/dashboard/api/windsurf-login/probe', {
      body: { email: MATRIX.emailFirebase },
    });
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.method === 'firebase', `method ${r.json.method}`);
    requireThat(r.json.source === 'connections', `source ${r.json.source}`);
    requireThat(r.json.host === 'windsurf', `host ${r.json.host}`);
    requireThat(r.json.hasPassword === null, `hasPassword ${r.json.hasPassword}`);
    requireThat(r.json.userExists === true, `userExists ${r.json.userExists}`);
    requireThat(r.json.emailCode === true, `emailCode ${r.json.emailCode}`);
    requireThat(Array.isArray(r.json.oauth) && r.json.oauth.includes('google'), `oauth ${JSON.stringify(r.json.oauth)}`);
    requireThat(!r.text.includes(SMOKE.verifyToken), 'verification token echoed by the non-auth1 probe');
    return 'firebase method honored instead of guessing Auth1';
  });

  addFlow('login', 'login.probe-host-fallback', async () => {
    const before = await http('GET', '/dashboard/api/runtime-env-status');
    requireThat(before.status === 200, `runtime status ${before.status}`);
    requireThat(before.json?.switches?.loginHostFallback?.value === false, 'loginHostFallback is on by default');

    const on = await http('PUT', '/dashboard/api/runtime-env-status', { body: { loginHostFallback: true } });
    requireThat(on.status === 200 && on.json?.success === true, `switch-on status ${on.status}`);
    requireThat(on.json?.switches?.loginHostFallback?.value === true, 'loginHostFallback did not flip on');
    requireThat(on.json?.switches?.loginHostFallback?.source === 'config', 'override source not reported');

    const viaDevin = await http('POST', '/dashboard/api/windsurf-login/probe', {
      body: { email: MATRIX.emailDevinOnly },
    });
    requireThat(viaDevin.status === 200 && viaDevin.json?.ok === true, `devin probe status ${viaDevin.status}`);
    requireThat(viaDevin.json.method === 'auth1' && viaDevin.json.hasPassword === true, `devin probe payload ${JSON.stringify(viaDevin.json)}`);
    requireThat(viaDevin.json.source === 'connections', `devin probe source ${viaDevin.json.source}`);
    requireThat(viaDevin.json.host === 'devin', `devin probe host ${viaDevin.json.host}`);

    const off = await http('PUT', '/dashboard/api/runtime-env-status', { body: { loginHostFallback: null } });
    requireThat(off.status === 200, `switch-off status ${off.status}`);
    requireThat(off.json?.switches?.loginHostFallback?.value === false, 'loginHostFallback did not clear');

    // With the fallback off the same address is answered by the secondary
    // probe: a different source, and no host claim.
    const viaSecondary = await http('POST', '/dashboard/api/windsurf-login/probe', {
      body: { email: MATRIX.emailDevinOnly },
    });
    requireThat(viaSecondary.status === 200, `secondary probe status ${viaSecondary.status}`);
    requireThat(viaSecondary.json.source === 'check_user_login_method', `secondary source ${viaSecondary.json.source}`);
    requireThat(viaSecondary.json.host === null, `secondary host ${viaSecondary.json.host}`);
    requireThat(viaSecondary.json.method === 'auth1', `secondary method ${viaSecondary.json.method}`);
    return 'host fallback answers from app.devin.ai; off falls to the secondary probe';
  });

  addFlow('login', 'login.token-import', async () => {
    const bare = await http('POST', '/dashboard/api/windsurf-login/token', {
      body: { token: MATRIX.loginImportToken, label: 'login-import' },
    });
    requireThat(bare.status === 200 && bare.json?.success === true, `bare status ${bare.status} error ${bare.json?.error || '?'}`);
    requireThat(bare.json.method === 'token', `bare method ${bare.json.method}`);
    requireThat(typeof bare.json.account?.id === 'string' && bare.json.account.id, 'bare import did not add an account');
    requireThat(!bare.text.includes(MATRIX.loginImportToken), 'bare import echoed the token');
    state.loginImportAccountId = bare.json.account.id;

    // The desktop app's sign-in callback is a custom-scheme deep link; the
    // token is in the query string, not the path.
    const deep = await http('POST', '/dashboard/api/windsurf-login/token', {
      body: {
        token: `windsurf://codeium.windsurf?access_token=${MATRIX.loginImportTokenDeep}`,
        label: 'login-deep-link',
      },
    });
    requireThat(deep.status === 200 && deep.json?.success === true, `deep status ${deep.status} error ${deep.json?.error || '?'}`);
    requireThat(deep.json.method === 'token', `deep method ${deep.json.method}`);
    requireThat(deep.json.account?.id !== state.loginImportAccountId, 'deep link imported into the same row');
    requireThat(!deep.text.includes(MATRIX.loginImportTokenDeep), 'deep import echoed the token');
    state.loginImportDeepAccountId = deep.json.account.id;

    const empty = await http('POST', '/dashboard/api/windsurf-login/token', { body: {} });
    requireThat(empty.status === 400 && empty.json?.error === 'ERR_NO_TOKEN_IN_INPUT', `empty status ${empty.status} error ${empty.json?.error}`);

    const auth1 = await http('POST', '/dashboard/api/windsurf-login/token', { body: { token: SMOKE.auth1Token } });
    requireThat(auth1.status === 400 && auth1.json?.error === 'ERR_AUTH1_NOT_A_POOL_KEY', `auth1 status ${auth1.status} error ${auth1.json?.error}`);

    const unknownAccount = await http('POST', '/dashboard/api/windsurf-login/token', {
      body: { accountId: 'deadbeef', token: MATRIX.loginImportToken },
    });
    requireThat(unknownAccount.status === 404 && unknownAccount.json?.error === 'ERR_ACCOUNT_NOT_FOUND', `unknown status ${unknownAccount.status} error ${unknownAccount.json?.error}`);

    const listed = await http('GET', '/dashboard/api/accounts');
    const ids = (listed.json?.accounts || []).map((a) => a.id);
    requireThat(ids.includes(state.loginImportAccountId) && ids.includes(state.loginImportDeepAccountId), 'imported accounts missing from the pool');
    requireThat(!listed.text.includes(MATRIX.loginImportToken) && !listed.text.includes(MATRIX.loginImportTokenDeep), 'imported token in the account list');
    return 'bare + deep-link import; auth1/empty/unknown-account edges';
  });

  addFlow('login', 'login.code-form-devin-host', async () => {
    const start = await http('POST', '/dashboard/api/windsurf-login/email/start', {
      body: { email: MATRIX.emailCodeForm, host: 'devin' },
    });
    requireThat(start.status === 200 && start.json?.sent === true, `start status ${start.status} error ${start.json?.error || '?'}`);
    requireThat(start.json.host === 'devin', `start host ${start.json.host}`);
    requireThat(/^[0-9a-f]{32}$/.test(String(start.json.flowId)), `flowId ${start.json.flowId}`);
    requireThat(typeof start.json.expiresInMs === 'number' && start.json.expiresInMs > 0, `expiresInMs ${start.json.expiresInMs}`);
    requireThat(!start.text.includes(MATRIX.verifyTokenDevin), 'devin verification token echoed by start');
    const seenStart = deps.loginTransport.seen.some((url) => url.includes('app.devin.ai/api/auth1/email/start'));
    requireThat(seenStart, 'email/start did not reach app.devin.ai');

    const wrong = await http('POST', '/dashboard/api/windsurf-login/email/complete', {
      body: { flowId: start.json.flowId, code: '000000' },
    });
    requireThat(wrong.status === 400 && wrong.json?.error === 'ERR_EMAIL_CODE_REJECTED', `wrong status ${wrong.status} error ${wrong.json?.error}`);
    requireThat(wrong.json.isAuthFail === true && wrong.json.attemptsRemaining === 4, `wrong payload ${JSON.stringify(wrong.json)}`);

    const done = await http('POST', '/dashboard/api/windsurf-login/email/complete', {
      body: { flowId: start.json.flowId, code: SMOKE.emailCode },
    });
    requireThat(done.status === 200 && done.json?.success === true, `complete status ${done.status} error ${done.json?.error || '?'}`);
    requireThat(done.json.method === 'email_code', `method ${done.json.method}`);
    requireThat(done.json.viaHost === 'app.devin.ai', `viaHost ${done.json.viaHost}`);
    requireThat(typeof done.json.account?.id === 'string', 'code-form login did not add an account');
    requireThat(!done.text.includes(MATRIX.auth1TokenDevin), 'Auth1 token echoed by complete');
    requireThat(!done.text.includes(MATRIX.sessionTokenDevin), 'session token echoed by complete');
    const seenComplete = deps.loginTransport.seen.some((url) => url.includes('app.devin.ai/api/auth1/email/complete'));
    requireThat(seenComplete, 'email/complete did not reach app.devin.ai');
    state.codeFormAccountId = done.json.account.id;

    // An unknown host token is ignored (allowlist), not passed through.
    const invalidHost = await http('POST', '/dashboard/api/windsurf-login/email/start', {
      body: { email: MATRIX.emailUnknown, host: 'evil.example' },
    });
    requireThat(invalidHost.status === 200 && invalidHost.json?.host === 'windsurf', `invalid host status ${invalidHost.status} host ${invalidHost.json?.host}`);

    // The form the operator types the code into is wired in the dashboard.
    const html = await http('GET', '/dashboard', { auth: 'none' });
    requireThat(html.status === 200, `dashboard status ${html.status}`);
    requireThat(html.text.includes('id="wl-email-code-field"'), 'email-code form field marker missing');
    requireThat(html.text.includes('id="wl-email-code"'), 'email-code input marker missing');
    return 'code form runs on app.devin.ai and reports viaHost';
  });

  // ─── accounts ────────────────────────────────────────────────────────
  addFlow('accounts', 'accounts.add-token', async () => {
    const r = await http('POST', '/dashboard/api/accounts', {
      body: { token: SMOKE.sessionTokenAdded, label: 'smoke-token' },
    });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(typeof r.json.account?.id === 'string' && r.json.account.id, 'account id missing');
    requireThat(!r.text.includes(SMOKE.sessionTokenAdded), 'pasted token echoed by add');
    state.tokenAccountId = r.json.account.id;
    return `added ${state.tokenAccountId}`;
  });

  addFlow('accounts', 'accounts.add-token-idempotent', async () => {
    const r = await http('POST', '/dashboard/api/accounts', {
      body: { token: SMOKE.sessionTokenAdded, label: 'smoke-token-again' },
    });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status}`);
    requireThat(r.json.account.id === state.tokenAccountId, 'duplicate token created a second account');
    return 'same token → same account id';
  });

  addFlow('accounts', 'accounts.add-rejects-bad-input', async () => {
    const empty = await http('POST', '/dashboard/api/accounts', { body: {} });
    requireThat(empty.status === 400 && /Provide api_key or token/.test(String(empty.json?.error)), `empty status ${empty.status}`);
    const auth1 = await http('POST', '/dashboard/api/accounts', { body: { token: SMOKE.auth1Token } });
    requireThat(auth1.status === 400, `auth1 status ${auth1.status}`);
    requireThat(/ERR_AUTH1_NOT_A_POOL_KEY/.test(String(auth1.json?.error)), `auth1 error ${auth1.json?.error}`);
    const badProxy = await http('POST', '/dashboard/api/accounts', {
      body: { token: 'devin-session-token$smoke-bad-proxy-0001', proxy: 'not a proxy' },
    });
    requireThat(badProxy.status === 400 && badProxy.json?.error === 'ERR_PROXY_FORMAT_INVALID', `bad proxy status ${badProxy.status}`);
    return 'empty 400, auth1 400, bad proxy 400';
  });

  addFlow('accounts', 'accounts.import-text', async () => {
    const r = await http('POST', '/dashboard/api/accounts/import-text', {
      body: { text: `${MATRIX.importToken}\n${SMOKE.auth1Token}\nalice@example.test password123` },
    });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.added?.length === 1, `added ${r.json.added?.length}`);
    requireThat(r.json.skipped?.length === 2, `skipped ${r.json.skipped?.length}`);
    requireThat(r.json.skipped.some((s) => s.kind === 'auth1'), 'auth1 not skipped');
    requireThat(r.json.skipped.some((s) => s.kind === 'email_password'), 'email/password line not deferred to the login flow');
    requireThat(!r.text.includes(MATRIX.importToken), 'imported token echoed by import-text');
    state.importAccountId = r.json.added[0].id;
    const empty = await http('POST', '/dashboard/api/accounts/import-text', { body: { text: '   ' } });
    requireThat(empty.status === 400 && empty.json?.error === 'ERR_IMPORT_TEXT_EMPTY', `empty status ${empty.status}`);
    return '1 added, auth1 + email/password skipped, empty 400';
  });

  addFlow('accounts', 'accounts.batch', async () => {
    const r = await http('POST', '/dashboard/api/accounts/batch', {
      body: { op: 'refresh', ids: [state.tokenAccountId] },
    });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status}`);
    requireThat(r.json.results?.[0]?.ok === true, `refresh result ${JSON.stringify(r.json.results?.[0])}`);
    const invalid = await http('POST', '/dashboard/api/accounts/batch', { body: { op: 'nope', ids: ['x'] } });
    requireThat(invalid.status === 400 && invalid.json?.error === 'ERR_BATCH_OP_INVALID', `invalid op status ${invalid.status}`);
    const empty = await http('POST', '/dashboard/api/accounts/batch', { body: { op: 'probe', ids: [] } });
    requireThat(empty.status === 400 && empty.json?.error === 'ERR_BATCH_IDS_EMPTY', `empty ids status ${empty.status}`);
    return 'refresh ok; unknown op and empty ids rejected';
  });

  addFlow('accounts', 'accounts.probe', async () => {
    const r = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(state.tokenAccountId)}/probe`, { body: {} });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.skipped === true || typeof r.json.tier === 'string', 'probe returned neither a tier nor a skip reason');
    const missing = await http('POST', '/dashboard/api/accounts/deadbeef/probe', { body: {} });
    requireThat(missing.status === 404, `unknown account status ${missing.status}`);
    return r.json.skipped ? `skipped: ${r.json.reason}` : `tier ${r.json.tier}`;
  });

  addFlow('accounts', 'accounts.probe-all', async () => {
    const r = await http('POST', '/dashboard/api/accounts/probe-all', { body: {} });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status}`);
    requireThat(typeof r.json.total === 'number' && r.json.total >= 1, `total ${r.json.total}`);
    requireThat(Array.isArray(r.json.results) && r.json.results.length === r.json.total, 'results/total mismatch');
    requireThat(typeof r.json.okCount === 'number' && typeof r.json.skippedCount === 'number', 'probe summary missing');
    return `${r.json.total} probed (${r.json.okCount} ok, ${r.json.skippedCount} skipped)`;
  });

  addFlow('accounts', 'accounts.refresh-credits', async () => {
    const r = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(state.tokenAccountId)}/refresh-credits`, { body: {} });
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.credits?.planName === 'Pro', `planName ${r.json.credits?.planName}`);
    requireThat(r.json.credits?.dailyPercent === 42, `dailyPercent ${r.json.credits?.dailyPercent}`);
    requireThat(r.json.credits?.balance === 12.5, `balance ${r.json.credits?.balance}`);
    const all = await http('POST', '/dashboard/api/accounts/refresh-credits', { body: {} });
    requireThat(all.status === 200 && all.json?.success === true, `all status ${all.status}`);
    requireThat(Array.isArray(all.json?.results), 'refresh-all results missing');
    return 'REST + billing merged (Pro, $12.50, 42% daily); fleet refresh ran';
  });

  addFlow('accounts', 'accounts.rate-limit-and-preflight', async () => {
    const id = encodeURIComponent(state.tokenAccountId);
    const rate = await http('POST', `/dashboard/api/accounts/${id}/rate-limit`, { body: {} });
    requireThat(rate.status === 200 && rate.json?.success === true, `rate-limit status ${rate.status}`);
    requireThat(rate.json.hasCapacity === true && rate.json.messagesRemaining === 42, `rate-limit payload ${JSON.stringify(rate.json)}`);
    const pre = await http('POST', `/dashboard/api/accounts/${id}/capacity-preflight`, {
      body: { model: 'swe-1-6-slow' },
    });
    requireThat(pre.status === 200 && pre.json?.ok === true, `preflight status ${pre.status}`);
    // The upstream half is what this smoke controls (the scripted rate-limit
    // answer). The LOCAL verdict legitimately depends on this box's LS state
    // (`local.eligible` is false when no language server is resident), so pin
    // the contract — a verdict is always reported — not its value.
    requireThat(['ok', 'blocked', 'throttled', 'unknown'].includes(pre.json.verdict), `verdict ${pre.json.verdict}`);
    requireThat(pre.json.upstream?.state === 'ok', `upstream state ${pre.json.upstream?.state}`);
    requireThat(pre.json.upstream?.messagesRemaining === 42, `preflight upstream ${JSON.stringify(pre.json.upstream)}`);
    return `capacity check + preflight (${pre.json.verdict}, upstream 42 left)`;
  });

  addFlow('accounts', 'accounts.devin-cards', async () => {
    const r = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(state.tokenAccountId)}/devin-cards`);
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status}`);
    requireThat(typeof r.json.ledger === 'object', 'ledger card missing');
    requireThat(typeof r.json.modelStatus === 'object', 'modelStatus card missing');
    requireThat(typeof r.json.key === 'object', 'key card missing');
    requireThat(!r.text.includes(SMOKE.sessionTokenAdded), 'raw key leaked by the cards view');
    const missing = await http('GET', '/dashboard/api/accounts/deadbeef/devin-cards');
    requireThat(missing.status === 404, `unknown account status ${missing.status}`);
    return 'three cards, key masked, unknown account 404';
  });

  addFlow('accounts', 'accounts.get-patch-delete', async () => {
    const add = await http('POST', '/dashboard/api/accounts', { body: { token: MATRIX.revealToken, label: 'reveal-me' } });
    requireThat(add.status === 200, `add status ${add.status}`);
    const id = add.json.account.id;
    state.revealAccountId = id;

    const get = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    requireThat(get.status === 200 && get.json?.account?.id === id, `get status ${get.status}`);
    requireThat(!get.text.includes(MATRIX.revealToken), 'raw token in the account view');

    const patch = await http('PATCH', `/dashboard/api/accounts/${encodeURIComponent(id)}`, {
      body: { label: 'renamed@example.test', tier: 'pro' },
    });
    requireThat(patch.status === 200 && patch.json?.success === true, `patch status ${patch.status}`);
    const after = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    requireThat(after.json?.account?.email === 'renamed@example.test', `label ${after.json?.account?.email}`);
    requireThat(after.json?.account?.tier === 'pro', `tier ${after.json?.account?.tier}`);

    const del = await http('DELETE', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    requireThat(del.status === 200 && del.json?.success === true, `delete status ${del.status}`);
    const list = await http('GET', '/dashboard/api/accounts');
    requireThat(!list.json.accounts.some((a) => a.id === id), 'deleted account still listed');
    const again = await http('DELETE', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    requireThat(again.status === 404 && again.json?.success === false, `double delete status ${again.status}`);
    return 'get → patch → delete → 404 on repeat';
  });

  addFlow('accounts', 'accounts.refresh-token-edge', async () => {
    const id = encodeURIComponent(state.tokenAccountId);
    const r = await http('POST', `/dashboard/api/accounts/${id}/refresh-token`, { body: {} });
    requireThat(r.status === 400, `status ${r.status}`);
    requireThat(/no refresh token/i.test(String(r.json?.error)), `error ${r.json?.error}`);
    const missing = await http('POST', '/dashboard/api/accounts/deadbeef/refresh-token', { body: {} });
    requireThat(missing.status === 404, `unknown account status ${missing.status}`);
    return 'no stored refresh token → 400; unknown account → 404';
  });

  addFlow('accounts', 'accounts.reveal-key', async () => {
    const add = await http('POST', '/dashboard/api/accounts', { body: { token: MATRIX.revealToken } });
    requireThat(add.status === 200, `add status ${add.status}`);
    const id = encodeURIComponent(add.json.account.id);
    const refused = await http('POST', `/dashboard/api/account/${id}/reveal-key`, { body: {} });
    requireThat(refused.status === 401, `no re-auth status ${refused.status}`);
    requireThat(refused.json?.error === 'ERR_REVEAL_REAUTH_REQUIRED', `error ${refused.json?.error}`);
    const revealed = await http('POST', `/dashboard/api/account/${id}/reveal-key`, {
      body: { password: SMOKE.dashboardPassword },
    });
    requireThat(revealed.status === 200 && revealed.json?.success === true, `reauth status ${revealed.status}`);
    requireThat(revealed.json.apiKey === MATRIX.revealToken, 'revealed key mismatch');
    const missing = await http('POST', '/dashboard/api/account/deadbeef/reveal-key', {
      body: { password: SMOKE.dashboardPassword },
    });
    requireThat(missing.status === 404, `unknown account status ${missing.status}`);
    return 're-auth required; explicit confirmation reveals the key';
  });

  // ─── login modal structure + one action, one verb (3.9.54, 7b23aa0) ──
  // Two P0s from the UI review: the login tab stacked four competing sections
  // instead of asking for ONE method, and the entry buttons used a different
  // word than the tab they opened (添加 vs 粘贴凭证). Both are copy/structure
  // regressions a passing login flow cannot see, so they are asserted against
  // the HTML and the locale files the browser actually receives.
  addFlow('login', 'login.steps-and-verbs', async () => {
    const html = await http('GET', '/dashboard', { auth: 'none' });
    requireThat(html.status === 200, `dashboard status ${html.status}`);
    const doc = html.text;
    const slice = (from, to) => {
      const start = doc.indexOf(from);
      requireThat(start >= 0, `marker ${from} is missing from the served dashboard`);
      if (to === null) return doc.slice(start);
      const end = doc.indexOf(to, start);
      requireThat(end > start, `marker ${to} is missing after ${from}`);
      return doc.slice(start, end);
    };

    // The current chooser offers the provider website and email entry, plus
    // manual credential import and an explicitly enabled local browser flow.
    const panel = slice('<div class="add-panel active" id="add-panel-login"', '<div class="add-panel" id="add-panel-paste"');
    const chooser = slice('id="wl-method-step"', 'id="devin-browser-login"');
    const methods = chooser.match(/<(?:a|button)\b[^>]*class="login-method(?: [^"]+)?"[^>]*>/g) || [];
    requireThat(methods.length === 2, `the first screen offers ${methods.length} primary methods, not 2`);
    requireThat(methods.some(tag => tag.includes('href="https://app.devin.ai/"')), 'the Devin handoff is missing');
    requireThat(methods.some(tag => tag.includes("App.selectLoginMethod('email')")), 'the email action is missing');
    requireThat(!chooser.includes('id="wl-method-oauth-btn"'), 'the retired callback choice reappeared');
    requireThat(chooser.includes('App.openCredentialPaste()'), 'the independent manual paste action is missing');
    requireThat(!chooser.includes('oauth-google-btn'), 'provider buttons are on the first screen');
    requireThat(!chooser.includes('id="wl-email"'), 'the email field is on the first screen');

    // The proxy, saved password and login history live behind 高级选项, closed.
    const advancedAt = panel.indexOf('<details class="login-advanced"');
    requireThat(advancedAt > 0, 'the 高级选项 disclosure is missing');
    const advancedTag = panel.slice(advancedAt, panel.indexOf('>', advancedAt) + 1);
    requireThat(!/\bopen\b/.test(advancedTag), 'the advanced disclosure is open by default');
    const advanced = panel.slice(advancedAt);
    for (const id of ['wl-proxy-section', 'wl-store-cred', 'wl-history-table']) {
      requireThat(advanced.includes(id), `${id} escaped the advanced disclosure`);
    }

    // Browser authorization returns to this instance, and addition requires an
    // explicit confirmation after the callback. The panel is hidden until the
    // local availability check succeeds.
    const browser = slice('id="devin-browser-login"', 'id="wl-panel-email"');
    requireThat(browser.startsWith('id="devin-browser-login" class="login-alt-panel hidden"'), 'browser sign-in is visible before availability');
    for (const action of ['startDevinBrowserLogin', 'completeDevinBrowserLogin', 'cancelDevinBrowserLogin']) {
      requireThat(browser.includes('App.' + action + '()'), action + ' is missing');
    }
    requireThat(doc.includes('id="acc-key" type="password"'), 'the manual credential field is not masked');
    requireThat(!doc.includes('redirect_uri=show-auth-token'), 'the obsolete redirect is still offered');

    // One action, one verb: the entry button names the tab it opens.
    for (const [id, tab, key] of [
      ['accounts-login-btn', 'login', 'accounts.add.login'],
      ['accounts-import-btn', 'import', 'accounts.add.import'],
      ['accounts-add-btn', 'paste', 'accounts.add.paste'],
    ]) {
      const tag = (doc.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`)) || [])[0];
      requireThat(tag, `${id} is missing`);
      requireThat(tag.includes(`openAddAccountModal('${tab}')`), `${id} does not open the ${tab} tab`);
      requireThat(tag.includes(`data-i18n="${key}"`), `${id} is not labelled with ${key}`);
    }

    const en = await http('GET', '/dashboard/i18n/en.json', { auth: 'none' });
    const zh = await http('GET', '/dashboard/i18n/zh-CN.json', { auth: 'none' });
    requireThat(en.status === 200 && zh.status === 200, `locale status ${en.status}/${zh.status}`);
    const enValue = (key) => ctx.readPath(en.json, key);
    const zhValue = (key) => ctx.readPath(zh.json, key);
    for (const [locale, value] of [['en', enValue], ['zh-CN', zhValue]]) {
      requireThat(value('accounts.add.paste') === value('accounts.add.tab.paste'),
        `${locale}: the entry button (${value('accounts.add.paste')}) and its tab (${value('accounts.add.tab.paste')}) disagree`);
    }
    requireThat(zhValue('accounts.add.paste') !== '添加', 'the paste entry fell back to the generic 添加');

    // Canonical action strings: 检查 / 刷新余额, and 配额 vs 余额 stay distinct.
    const zhVerbs = {
      'batchOps.probe': '检查',
      'accounts.toolbar.probeAll': '全部检查',
      'accounts.row.probe': '检查层级与模型',
      'action.probe': '检查',
      'batchOps.refresh': '刷新余额',
      'accounts.row.refreshBalance': '刷新余额',
      'accounts.toolbar.refreshAll': '刷新全部余额',
      'table.header.quota': '配额',
      'table.header.credits': '余额',
    };
    for (const [key, want] of Object.entries(zhVerbs)) {
      requireThat(zhValue(key) === want, `zh-CN ${key} = ${JSON.stringify(zhValue(key))}, expected ${want}`);
    }
    const enVerbs = {
      'batchOps.probe': 'Check',
      'accounts.toolbar.probeAll': 'Check all',
      'accounts.row.probe': 'Check tier and models',
      'action.probe': 'Check',
      'batchOps.refresh': 'Refresh balances',
      'accounts.row.refreshBalance': 'Refresh balance',
      'accounts.toolbar.refreshAll': 'Refresh all balances',
    };
    for (const [key, want] of Object.entries(enVerbs)) {
      requireThat(enValue(key) === want, `en ${key} = ${JSON.stringify(enValue(key))}, expected ${want}`);
    }

    // The lint judges the account/usage scope of both locales and the shipped
    // template; the served bytes must be the linted bytes.
    const { lintDashboardCopy } = await import('../../scripts/check-dashboard-copy.mjs');
    const lint = lintDashboardCopy();
    requireThat(lint.ok === true && lint.problems.length === 0, `copy lint: ${lint.problems.slice(0, 3).join(' | ')}`);
    const disk = (file) => JSON.parse(readFileSync(new URL(`../../src/dashboard/i18n/${file}`, import.meta.url), 'utf8'));
    const stable = (value) => JSON.stringify(value, (_key, val) => (val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val));
    requireThat(stable(en.json) === stable(disk('en.json')), 'the served en.json is not the file the lint reads');
    requireThat(stable(zh.json) === stable(disk('zh-CN.json')), 'the served zh-CN.json is not the file the lint reads');
    return 'chooser + local browser flow + masked credential input; entry verbs match tabs; copy lint clean on served bytes';
  });
}
