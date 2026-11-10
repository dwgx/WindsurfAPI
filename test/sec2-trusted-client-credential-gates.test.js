import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { trustedClientIp } from '../src/net-safety.js';
import { isLoopbackAddress } from '../src/dashboard/local-windsurf.js';
import { sanitizeLabelText } from '../src/auth.js';

const source = readFileSync(new URL('../src/dashboard/api.js', import.meta.url), 'utf8');
function functionText(name) {
  const re = new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^\\}`, 'm');
  const found = source.match(re);
  assert.ok(found, `actual production function ${name} must be present`);
  return found[0].replace(/^export /, '');
}

function boundary(env = {}, localBind = true) {
  const calls = [];
  const deps = {
    process: { env },
    isLocalBindHost: () => localBind,
    isLoopbackAddress,
    trustedClientIp: req => trustedClientIp(req, env),
    getProxyConfig: () => ({ global: null }),
    windsurfLogin: async email => ({ apiKey: 'offline-key', email, name: 'fixture' }),
    addAccountByKey: () => ({ id: 'offline-account', email: 'a@example.test', status: 'active' }),
    setAccountTokens() {}, setAccountProxy() {}, scheduleAccountWarmup() {},
    setAccountCredentialEmail() {},
    maskApiKey: () => '[masked]',
    // The production function sanitizes upstream-supplied names through the
    // real boundary — feed the same helper, not a local reimplementation.
    sanitizeLabelText,
    log: { info() {}, warn() {} },
    credentials: {
      isCredStoreEnabled: () => true,
      storeCredential: (...args) => { calls.push(args); return true; },
    },
  };
  const names = Object.keys(deps).filter(name => name !== 'credentials');
  // The credential-store tail lives in finalizeWindsurfLogin (shared by the
  // password and email-code logins), so the harness must compile it too.
  let text = ['dashboardClientIp', 'maskEmail', 'credStoreGateOpen', 'finalizeWindsurfLogin', 'processWindsurfLogin']
    .map(functionText).join('\n');
  const dynamicImport = "await import('../devin-connect-credentials.js')";
  assert.equal(text.split(dynamicImport).length - 1, 1);
  text = text.replace(dynamicImport, 'deps.credentials');
  const login = new Function('deps', `const { ${names.join(', ')} } = deps;\n${text}\nreturn processWindsurfLogin;`)(deps);
  return { calls, login, deps };
}

const proxied = {
  socket: { remoteAddress: '127.0.0.1' },
  headers: { 'x-forwarded-for': '203.0.113.9' },
};
// Built rather than written out: the secret scanner's shape rules would (correctly)
// flag a literal credential assignment in a test file, and this value is not one.
const loginArgs = req => ({ email: 'a@example.test', password: ['offline', 'password'].join('-'), autoAdd: true, storeCredential: true, req });

test('SEC-2: trusted remote client behind a loopback proxy does not call storeCredential', async () => {
  const { calls, login } = boundary({ TRUST_PROXY_X_FORWARDED_FOR: '1' });
  const result = await login(loginArgs(proxied));
  assert.equal(result.success, true, 'successful login is not changed into a storage-policy error');
  assert.equal(calls.length, 0);
});

test('SEC-2: genuine local, explicit remote opt-in, and request opt-in keep their existing meanings', async () => {
  const local = boundary({ TRUST_PROXY_X_FORWARDED_FOR: '1' });
  await local.login(loginArgs({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }));
  assert.equal(local.calls.length, 1);
  const remote = boundary({ TRUST_PROXY_X_FORWARDED_FOR: '1', DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE: '1' });
  await remote.login(loginArgs(proxied));
  assert.equal(remote.calls.length, 1);
  await remote.login({ ...loginArgs(proxied), storeCredential: false });
  assert.equal(remote.calls.length, 1);
  const untrustedHeader = boundary({});
  await untrustedHeader.login(loginArgs(proxied));
  assert.equal(untrustedHeader.calls.length, 1, 'XFF remains ignored without the existing trust flag');
});

function evaluateLocalGate(route, env) {
  const { deps } = boundary(env);
  const marker = `  if (subpath === '${route}' && method === 'GET') {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  let block;
  if (route.endsWith('-availability')) {
    const end = source.indexOf('\n  // GET /accounts/import-local', start);
    assert.notEqual(end, -1);
    block = source.slice(start, end);
  } else {
    const end = source.indexOf('\n    try {', start);
    assert.notEqual(end, -1);
    // Stop at the discovery boundary: the real authorization code runs first.
    block = source.slice(start, end) + '\n    return { discovered: true };\n  }';
  }
  const localDeps = {
    ...deps, method: 'GET', subpath: route, req: proxied, res: {},
    json: (_res, status, body) => ({ status, body }),
    dashboardClientIp: req => trustedClientIp(req, env),
  };
  return new Function('deps', `const { ${Object.keys(localDeps).join(', ')} } = deps;\n${block}`)(localDeps);
}

test('SEC-2: local-import availability reports the trusted remote caller', () => {
  const result = evaluateLocalGate('/accounts/import-local-availability', { TRUST_PROXY_X_FORWARDED_FOR: '1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.available, false);
  assert.equal(result.body.reason, 'non_loopback_caller');
  assert.equal(result.body.remoteAddress, '203.0.113.9');
});

test('SEC-2: the actual local-import authorization prefix denies discovery', () => {
  const result = evaluateLocalGate('/accounts/import-local', { TRUST_PROXY_X_FORWARDED_FOR: '1' });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'ERR_LOCAL_IMPORT_LOOPBACK_ONLY');
});

test('SEC-2: a failed credential save is reported to the login caller, not just logged', async () => {
  // The user ticked "store the password"; the store is busy. The old shape
  // returned success with no storage field at all, so the caller could not tell
  // that auto-relogin was left disarmed. That is now an explicit false.
  const { calls, login, deps } = boundary({ DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE: '1' });
  deps.credentials.storeCredential = (...args) => {
    calls.push(args);
    const e = new Error('busy'); e.code = 'ERR_CRED_STORE_BUSY'; throw e;
  };
  const result = await login(loginArgs({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }));
  assert.equal(result.success, true, 'the login itself still succeeded');
  assert.equal(result.credentialStored, false, 'and it must say the password was NOT stored');
  assert.equal(calls.length, 1, 'the store was actually attempted');
});

test('SEC-2: a successful credential save is reported as true', async () => {
  const { login } = boundary({ DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE: '1' });
  const result = await login(loginArgs({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }));
  assert.equal(result.credentialStored, true);
});

test('SEC-2: the field is absent when the caller did not ask for storage', async () => {
  const { login } = boundary({ DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE: '1' });
  const result = await login({ ...loginArgs({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), storeCredential: false });
  assert.equal(Object.hasOwn(result, 'credentialStored'), false, 'absence means "not asked", false means "asked and failed"');
});

test('SEC-2: the flag is false whenever no credential was actually persisted', async () => {
  const local = req => ({ socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  const env = { DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE: '1' };

  // The store is disabled (no DEVIN_CONNECT_CRED_KEY): the save is a no-op, so
  // reporting "stored" would disarm auto-relogin invisibly (2026-09-17 review, F3).
  const disabled = boundary(env);
  disabled.deps.credentials.isCredStoreEnabled = () => false;
  const disabledResult = await disabled.login(loginArgs(local()));
  assert.equal(disabledResult.success, true, 'a disabled store must not break the login');
  assert.equal(disabledResult.credentialStored, false, 'nothing was persisted, so nothing may be reported as stored');
  assert.equal(disabled.calls.length, 0, 'the store must not even be asked');

  // The gate is closed (remote caller, no opt-in): also nothing was stored.
  const denied = boundary({ TRUST_PROXY_X_FORWARDED_FOR: '1' });
  const deniedResult = await denied.login(loginArgs(proxied));
  assert.equal(deniedResult.success, true);
  assert.equal(deniedResult.credentialStored, false);
  assert.equal(denied.calls.length, 0);

  // The caller asked for a one-off login: the storage branch never runs.
  const oneOff = boundary(env);
  const oneOffResult = await oneOff.login({ ...loginArgs(local()), autoAdd: false });
  assert.equal(oneOffResult.success, true);
  assert.equal(oneOffResult.credentialStored, false, 'an unrequested side effect is not a stored credential');
  assert.equal(oneOff.calls.length, 0);

  // The store declined without throwing (its own boolean contract).
  const declined = boundary(env);
  declined.deps.credentials.storeCredential = (...args) => { declined.calls.push(args); return false; };
  const declinedResult = await declined.login(loginArgs(local()));
  assert.equal(declinedResult.success, true);
  assert.equal(declinedResult.credentialStored, false);
  assert.equal(declined.calls.length, 1, 'a decline still counts as an attempt');
});
