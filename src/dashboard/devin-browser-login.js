import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const AUTHORIZE = 'https://app.devin.ai/auth/cli/continue';
const TOKEN = 'https://api.devin.ai/auth/cli/token';
const VALID_FOR_MS = 5 * 60_000;
export const DEVIN_BROWSER_CALLBACK = '/callback';

export function browserLoginOrigin(req) {
  const socket = req?.socket;
  const port = socket?.localPort;
  if (process.env.DEVIN_BROWSER_LOGIN !== '1' || config.host !== '127.0.0.1'
      || socket?.localAddress !== '127.0.0.1' || socket?.remoteAddress !== '127.0.0.1'
      || !Number.isInteger(port) || port < 1 || req.headers?.host !== '127.0.0.1:' + port
      || req.headers?.forwarded || req.headers?.['x-forwarded-for'] || req.headers?.['x-forwarded-host']) {
    return null;
  }
  return 'http://127.0.0.1:' + port;
}

async function exchangeCode({ code, verifier, signal }) {
  const response = await fetch(TOKEN, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) return { error: 'exchange_rejected' };
  const body = await response.json();
  const token = typeof body?.token === 'string' ? body.token : '';
  const prefix = 'devin-session-token$';
  const jwt = token.startsWith(prefix) ? token.slice(prefix.length) : token;
  if (jwt.length > 16_384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt)) return { error: 'credential_unrecognized' };
  let claims;
  try { claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')); }
  catch { return { error: 'credential_unrecognized' }; }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { error: 'credential_unrecognized' };
  // A client-specific grant needs an independently established client identity.
  // The public trial does not assert any third-party client registration.
  const audiences = [claims.aud].flat();
  if (claims.azp || claims.client_id || audiences.some(a => /^(?:devin|windsurf)[-_ ](?:cli|desktop)$/i.test(String(a)))) {
    return { error: 'client_binding_unverified' };
  }
  return { candidateKey: prefix + jwt };
}

export function createBrowserLogin({ clock = Date.now, exchange = exchangeCode } = {}) {
  let flow;
  let expiry;
  const clear = (entry, status, error) => {
    entry.controller?.abort();
    delete entry.code;
    delete entry.verifier;
    delete entry.state;
    delete entry.controller;
    entry.status = status;
    if (error) entry.error = error;
  };
  const checkExpiry = () => {
    if (flow && ['pending', 'ready', 'exchanging'].includes(flow.status) && clock() >= flow.expiresAt) clear(flow, 'expired');
  };
  const describe = (entry) => ({ status: entry.status, expiresAt: entry.expiresAt, ...(entry.error ? { error: entry.error } : {}),
    ...(entry.accountId ? { accountId: entry.accountId } : {}) });
  const select = (origin, id) => {
    checkExpiry();
    return flow && flow.origin === origin && flow.id === id ? flow : null;
  };
  return {
    start(origin) {
      checkExpiry();
      if (flow && ['pending', 'ready', 'exchanging'].includes(flow.status)) return { status: 'busy' };
      clearTimeout(expiry);
      flow = {
        origin, id: randomBytes(24).toString('base64url'), state: randomBytes(32).toString('base64url'),
        verifier: randomBytes(32).toString('base64url'), status: 'pending', expiresAt: clock() + VALID_FOR_MS,
      };
      expiry = setTimeout(checkExpiry, VALID_FOR_MS);
      expiry.unref?.();
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        redirect_uri: origin + DEVIN_BROWSER_CALLBACK, state: flow.state, prompt: 'select_account',
        code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256',
      });
      return { ...describe(flow), id: flow.id, authorizeUrl: url.href };
    },
    callback(origin, input) {
      checkExpiry();
      if (!flow || flow.origin !== origin || flow.status !== 'pending'
          || input.getAll('state').length !== 1 || input.get('state') !== flow.state) return false;
      delete flow.state;
      const code = input.get('code');
      if (input.has('error')) {
        const errors = ['access_denied', 'invalid_request', 'unauthorized_client', 'invalid_scope', 'server_error'];
        clear(flow, 'failed', errors.includes(input.get('error')) ? input.get('error') : 'provider_rejected');
      } else if (input.getAll('code').length !== 1 || !code || code.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(code)) {
        clear(flow, 'failed', 'callback_invalid');
      } else {
        flow.code = code;
        flow.status = 'ready';
      }
      return true;
    },
    status(origin, id) {
      const entry = select(origin, id);
      return entry ? describe(entry) : { status: 'unknown' };
    },
    cancel(origin, id) {
      const entry = select(origin, id);
      if (!entry) return { status: 'unknown' };
      if (['pending', 'ready', 'exchanging'].includes(entry.status)) clear(entry, 'cancelled');
      return describe(entry);
    },
    async complete(origin, id, admit) {
      const entry = select(origin, id);
      if (!entry) return { status: 'unknown' };
      if (entry.status !== 'ready') return describe(entry);
      const { code, verifier } = entry;
      delete entry.code;
      delete entry.verifier;
      entry.status = 'exchanging';
      entry.controller = new AbortController();
      try {
        const result = await exchange({ code, verifier, signal: entry.controller.signal });
        checkExpiry();
        if (entry.status !== 'exchanging') return describe(entry);
        if (!result.candidateKey) {
          clear(entry, 'failed', result.error);
        } else {
          const id = admit(result.candidateKey);
          if (!id) clear(entry, 'failed', 'admission_unconfirmed');
          else {
            entry.accountId = id;
            clear(entry, 'added');
          }
        }
      } catch {
        checkExpiry();
        if (entry.status === 'exchanging') clear(entry, 'failed', 'exchange_unavailable');
      }
      return describe(entry);
    },
  };
}

export const browserLogin = createBrowserLogin();

export function handleBrowserLoginCallback(req, res) {
  const origin = browserLoginOrigin(req);
  let accepted = false;
  if (origin && req.url.length <= 8192) {
    accepted = browserLogin.callback(origin, new URL(req.url, origin).searchParams);
  }
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  res.writeHead(accepted ? 303 : 404, accepted ? { ...headers, Location: '/dashboard#accounts' } : headers);
  res.end();
}
