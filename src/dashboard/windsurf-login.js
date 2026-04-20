/**
 * Windsurf direct login — Firebase auth + Codeium registration.
 * Supports proxy tunneling and fingerprint randomization.
 */

import http from 'http';
import https from 'https';
import { log } from '../config.js';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const FIREBASE_AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const CODEIUM_REGISTER_URL = 'https://api.codeium.com/register_user/';

// ─── Fingerprint randomization ────────────────────────────

const OS_VERSIONS = [
  'Windows NT 10.0; Win64; x64',
  'Windows NT 10.0; WOW64',
  'Macintosh; Intel Mac OS X 10_15_7',
  'Macintosh; Intel Mac OS X 11_6_0',
  'Macintosh; Intel Mac OS X 12_3_1',
  'Macintosh; Intel Mac OS X 13_4_1',
  'Macintosh; Intel Mac OS X 14_2_1',
  'X11; Linux x86_64',
  'X11; Ubuntu; Linux x86_64',
];

const CHROME_VERSIONS = [
  '120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0',
  '125.0.0.0', '126.0.0.0', '127.0.0.0', '128.0.0.0', '129.0.0.0',
  '130.0.0.0', '131.0.0.0', '132.0.0.0', '133.0.0.0', '134.0.0.0',
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9', 'en-GB,en;q=0.9', 'zh-TW,zh;q=0.9,en;q=0.8',
  'zh-CN,zh;q=0.9,en;q=0.8', 'ja,en-US;q=0.9,en;q=0.8',
  'ko,en-US;q=0.9,en;q=0.8', 'de,en-US;q=0.9,en;q=0.8',
  'fr,en-US;q=0.9,en;q=0.8', 'es,en-US;q=0.9,en;q=0.8',
  'pt-BR,pt;q=0.9,en;q=0.8',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateFingerprint() {
  const os = pick(OS_VERSIONS);
  const chromeVer = pick(CHROME_VERSIONS);
  const major = chromeVer.split('.')[0];
  const ua = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;

  return {
    'User-Agent': ua,
    'Accept-Language': pick(ACCEPT_LANGUAGES),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity',
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': os.includes('Windows') ? '"Windows"' : os.includes('Mac') ? '"macOS"' : '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Origin': 'https://windsurf.com',
    'Referer': 'https://windsurf.com/',
  };
}

// ─── Proxy tunnel (HTTP CONNECT) ──────────────────────────

function createProxyTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxyHost = proxy.host.replace(/:\d+$/, '');
    const proxyPort = proxy.port || 8080;

    const authHeader = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
      : '';

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}` } : {}),
      },
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }
    });

    connectReq.on('error', (err) => reject(new Error(`Proxy connection error: ${err.message}`)));
    connectReq.setTimeout(15000, () => { connectReq.destroy(); reject(new Error('Proxy connection timeout')); });
    connectReq.end();
  });
}

// ─── HTTPS request with optional proxy ────────────────────

function httpsRequest(url, opts, postData, proxy) {
  return new Promise(async (resolve, reject) => {
    const parsed = new URL(url);
    const requestOpts = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'POST',
      headers: opts.headers || {},
    };

    const handleResponse = (res) => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(bufs).toString('utf8');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          reject(new Error(`Parse error (status ${res.statusCode}, encoding ${res.headers['content-encoding'] || 'identity'}): ${raw.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    };

    try {
      let req;
      if (proxy && proxy.host) {
        const socket = await createProxyTunnel(proxy, parsed.hostname, 443);
        requestOpts.socket = socket;
        requestOpts.agent = false;
        req = https.request(requestOpts, handleResponse);
      } else {
        req = https.request(requestOpts, handleResponse);
      }

      req.on('error', (err) => reject(new Error(`Request error: ${err.message}`)));
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
      if (postData) req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Login flow ───────────────────────────────────────────

/**
 * Full Windsurf login: Firebase auth → Codeium register → API key.
 * @param {string} email
 * @param {string} password
 * @param {object} [proxy] - { host, port, username, password }
 * @returns {{ apiKey, name, email, idToken }}
 */
export async function windsurfLogin(email, password, proxy = null) {
  const fingerprint = generateFingerprint();
  log.info(`Windsurf login: ${email} fp=${fingerprint['User-Agent'].slice(0, 40)}... proxy=${proxy?.host || 'none'}`);

  // Step 1: Firebase sign in
  const firebaseBody = JSON.stringify({
    email,
    password,
    returnSecureToken: true,
  });

  const fbHeaders = {
    ...fingerprint,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(firebaseBody),
  };

  const fbRes = await httpsRequest(FIREBASE_AUTH_URL, { method: 'POST', headers: fbHeaders }, firebaseBody, proxy);

  if (fbRes.data.error) {
    const msg = fbRes.data.error.message || 'Unknown Firebase error';
    const oauthHint = '若你用 Google/GitHub 注册的 Windsurf 账号 此处密码登录不适用 请用页面顶部的 Google / GitHub 登录按钮 或访问 https://windsurf.com/show-auth-token 复制 Auth Token 后在「账号管理」页手动添加';
    const friendly = {
      'EMAIL_NOT_FOUND': `该邮箱未注册邮箱密码登录方式（${oauthHint}）`,
      'INVALID_PASSWORD': `密码错误（${oauthHint}）`,
      'INVALID_LOGIN_CREDENTIALS': `邮箱或密码错误（${oauthHint}）`,
      'USER_DISABLED': '账号已被停用',
      'TOO_MANY_ATTEMPTS_TRY_LATER': '尝试太多次 请稍后再试',
      'INVALID_EMAIL': '邮箱格式错误',
    }[msg] || msg;
    const err = new Error(`Firebase 登入失败: ${friendly}`);
    err.firebaseCode = msg;
    err.isAuthFail = ['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS'].includes(msg);
    throw err;
  }

  const idToken = fbRes.data.idToken;
  if (!idToken) throw new Error('Firebase 回應缺少 idToken');

  log.info(`Firebase login OK: ${email}, UID=${fbRes.data.localId}`);

  // Step 2: Register with Codeium to get API key
  const regBody = JSON.stringify({ firebase_id_token: idToken });
  const regHeaders = {
    ...fingerprint,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(regBody),
  };

  const regRes = await httpsRequest(CODEIUM_REGISTER_URL, { method: 'POST', headers: regHeaders }, regBody, proxy);

  if (regRes.status >= 400 || !regRes.data.api_key) {
    throw new Error(`Codeium 註冊失敗: ${JSON.stringify(regRes.data).slice(0, 200)}`);
  }

  log.info(`Codeium register OK: ${email} → key=${regRes.data.api_key.slice(0, 12)}...`);

  return {
    apiKey: regRes.data.api_key,
    name: regRes.data.name || email,
    email,
    idToken,
    refreshToken: fbRes.data.refreshToken || '',
    apiServerUrl: regRes.data.api_server_url || '',
  };
}

/**
 * Refresh a Firebase ID token using a stored refresh token.
 * Returns a new { idToken, refreshToken, expiresIn } or throws.
 *
 * @param {string} refreshToken
 * @param {object} [proxy]
 * @returns {Promise<{idToken: string, refreshToken: string, expiresIn: number}>}
 */
export async function refreshFirebaseToken(refreshToken, proxy = null) {
  if (!refreshToken) throw new Error('No refresh token available');

  const postBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postBody),
    'Referer': 'https://windsurf.com/',
    'Origin': 'https://windsurf.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  };

  const res = await httpsRequest(FIREBASE_REFRESH_URL, { method: 'POST', headers }, postBody, proxy);

  if (res.data?.error) {
    const msg = res.data.error.message || res.data.error.code || 'Unknown error';
    throw new Error(`Firebase token refresh failed: ${msg}`);
  }

  const newIdToken = res.data?.id_token || res.data?.idToken;
  const newRefreshToken = res.data?.refresh_token || res.data?.refreshToken || refreshToken;
  const expiresIn = parseInt(res.data?.expires_in || res.data?.expiresIn || '3600', 10);

  if (!newIdToken) {
    throw new Error(`Firebase token refresh: no idToken in response: ${JSON.stringify(res.data).slice(0, 200)}`);
  }

  log.info(`Firebase token refreshed, expires in ${expiresIn}s`);
  return { idToken: newIdToken, refreshToken: newRefreshToken, expiresIn };
}

/**
 * Re-register with Codeium using a refreshed Firebase token.
 * Returns a fresh API key (may be the same key if unchanged).
 *
 * @param {string} idToken - fresh Firebase ID token
 * @param {object} [proxy]
 * @returns {Promise<{apiKey: string, name: string}>}
 */
export async function reRegisterWithCodeium(idToken, proxy = null) {
  const fingerprint = generateFingerprint();
  const regBody = JSON.stringify({ firebase_id_token: idToken });
  const regHeaders = {
    ...fingerprint,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(regBody),
  };

  const regRes = await httpsRequest(CODEIUM_REGISTER_URL, { method: 'POST', headers: regHeaders }, regBody, proxy);

  if (regRes.status >= 400 || !regRes.data.api_key) {
    throw new Error(`Codeium re-registration failed: ${JSON.stringify(regRes.data).slice(0, 200)}`);
  }

  return {
    apiKey: regRes.data.api_key,
    name: regRes.data.name || '',
  };
}
