/**
 * EMAIL-OTP login for Windsurf/Devin upstream (2026-07-07).
 *
 * Architecture (verified 2026-07-06):
 *   1. POST SendEmailVerification {first_name, email, turnstile_token} → {}
 *   2. Poll Gmail IMAP for 6-digit OTP code (pluggable reader interface)
 *   3. POST RegisterUser {email, turnstile_token, otp_code, ...} → {api_key, name, api_server_url}
 *
 * Wire facts:
 *   - Base: https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService
 *   - Protocol: Connect-RPC (Content-Type: application/json, 'Connect-Protocol-Version: 1')
 *   - Turnstile sitekey: 0x4AAAAAAA447Bur1xJStKg5 (public, browser-generated, ~300s TTL, single-use)
 *   - MANDATORY real turnstile_token (empty/fake → rejected; dev keys rejected)
 *
 * Zero npm deps (Node built-ins only). Reuses windsurf-login.js transport/proxy/fingerprint patterns.
 */

import tls from 'node:tls';
import { config, log } from '../config.js';
import { resolveProxyConnectHost } from '../net-safety.js';
import { safeEmailRef, safeKeyRef } from '../log-safety.js';

// Test-only transport seam (same pattern as windsurf-login.js __setLoginTransportForTests)
let _transportOverride = null;
export function __setOtpTransportForTests(fn) { _transportOverride = fn; }

// Import reusable helpers from windsurf-login.js
// (these are NOT exported currently, so we'll replicate minimally below)

const SEAT_SERVICE_BASE = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService';
const SEND_EMAIL_VERIFICATION_URL = `${SEAT_SERVICE_BASE}/SendEmailVerification`;
const REGISTER_USER_URL = `${SEAT_SERVICE_BASE}/RegisterUser`;

// ─── Fingerprint randomization (minimal replica from windsurf-login.js) ───

const OS_VERSIONS = [
  'Windows NT 10.0; Win64; x64',
  'Macintosh; Intel Mac OS X 10_15_7',
  'Macintosh; Intel Mac OS X 13_4_1',
  'X11; Ubuntu; Linux x86_64',
];

const CHROME_VERSIONS = [
  '128.0.0.0', '129.0.0.0', '130.0.0.0', '131.0.0.0', '132.0.0.0',
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8', 'ja,en-US;q=0.9,en;q=0.8',
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
    'Sec-Fetch-Site': 'same-origin',
    'Origin': 'https://windsurf.com',
    'Referer': 'https://windsurf.com/',
  };
}

function buildJsonHeaders(fingerprint, body, extra = {}) {
  return {
    ...fingerprint,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  };
}

// ─── HTTPS request with proxy support (minimal replica) ───

import https from 'node:https';
import http from 'node:http';
import { isSocks, createSocksTunnel } from '../socks.js';

async function createProxyTunnel(proxy, targetHost, targetPort) {
  if (isSocks(proxy)) return createSocksTunnel(proxy, targetHost, targetPort);
  // #11: pin the proxy host to a vetted IP literal (no second rebindable lookup).
  const rawHost = proxy.host.replace(/:\d+$/, '');
  const proxyHost = await resolveProxyConnectHost(rawHost, { allowPrivate: config.allowPrivateProxyHosts });
  return new Promise((resolve, reject) => {
    const proxyPort = proxy.port || 8080;

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

function httpsRequest(url, opts, postData, proxy) {
  if (_transportOverride) return _transportOverride(url, opts, postData, proxy);
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
          resolve({ status: res.statusCode, data: raw });
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

// ─── Connect-RPC calls ───

/**
 * Send email verification code via windsurf.com Connect-RPC.
 * @param {string} email - target email address
 * @param {string} firstName - display name for the email
 * @param {string} turnstileToken - real Cloudflare Turnstile response token (~300s TTL, single-use)
 * @param {object} [proxy] - { host, port, username?, password?, type }
 * @returns {Promise<{success: boolean}>}
 * @throws {Error} ERR_TURNSTILE_INVALID | ERR_EMAIL_VERIFICATION_FAILED
 */
export async function sendEmailVerification(email, firstName, turnstileToken, proxy = null) {
  const fingerprint = generateFingerprint();
  const body = JSON.stringify({
    first_name: firstName || '',
    email,
    turnstile_token: turnstileToken,
  });
  const headers = buildJsonHeaders(fingerprint, body, { 'Connect-Protocol-Version': '1' });

  log.info(`SendEmailVerification: ${safeEmailRef(email)}, firstName="${firstName}"`);

  const res = await httpsRequest(SEND_EMAIL_VERIFICATION_URL, { method: 'POST', headers }, body, proxy);

  if (res.status >= 400) {
    const errMsg = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (/turnstile/i.test(errMsg)) {
      throw new Error('ERR_TURNSTILE_INVALID');
    }
    throw new Error(`ERR_EMAIL_VERIFICATION_FAILED: HTTP ${res.status}: ${errMsg.slice(0, 200)}`);
  }

  log.info(`SendEmailVerification OK: ${safeEmailRef(email)}`);
  return { success: true };
}

/**
 * Complete registration with OTP code via RegisterUser Connect-RPC.
 * @param {string} email
 * @param {string} otpCode - 6-digit code from pollGmailForOTP
 * @param {string} turnstileToken - SAME token used in sendEmailVerification (must be fresh)
 * @param {string} [firstName] - optional
 * @param {string} [lastName] - optional
 * @param {object} [proxy] - proxy config
 * @returns {Promise<{apiKey: string, name: string, apiServerUrl: string}>}
 * @throws {Error} ERR_OTP_INVALID | ERR_REGISTRATION_FAILED
 */
export async function registerUserWithOtp(email, otpCode, turnstileToken, firstName = '', lastName = '', proxy = null) {
  const fingerprint = generateFingerprint();
  const body = JSON.stringify({
    email,
    turnstile_token: turnstileToken,
    otp_code: otpCode,
    first_name: firstName || '',
    last_name: lastName || '',
  });
  const headers = buildJsonHeaders(fingerprint, body, { 'Connect-Protocol-Version': '1' });

  log.info(`RegisterUser (OTP): ${safeEmailRef(email)}, otpCode=***${otpCode.slice(-2)}`);

  const res = await httpsRequest(REGISTER_USER_URL, { method: 'POST', headers }, body, proxy);

  if (res.status >= 400) {
    const errMsg = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (/otp|code|verification/i.test(errMsg)) {
      throw new Error('ERR_OTP_INVALID');
    }
    throw new Error(`ERR_REGISTRATION_FAILED: HTTP ${res.status}: ${errMsg.slice(0, 200)}`);
  }

  const apiKey = res.data?.api_key || res.data?.apiKey;
  const name = res.data?.name || email;
  const apiServerUrl = res.data?.api_server_url || res.data?.apiServerUrl || '';

  if (!apiKey) {
    throw new Error(`ERR_REGISTRATION_FAILED: no api_key in response: ${JSON.stringify(res.data).slice(0, 200)}`);
  }

  log.info(`RegisterUser OK: ${safeEmailRef(email)} → ${safeKeyRef(apiKey, 'apiKey')}`);

  return { apiKey, name, apiServerUrl };
}

// ─── Gmail IMAP OTP reader (hand-rolled, zero npm deps) ───

/**
 * Minimal IMAP-over-TLS client for Gmail OTP reading.
 * Connects to imap.gmail.com:993, logs in, searches recent messages for 6-digit code.
 * @param {string} imapUser - GMAIL_IMAP_USER (full email)
 * @param {string} imapPassword - GMAIL_IMAP_PASSWORD (app password)
 * @param {number} [timeoutMs=120000] - max wait time (polling loop)
 * @returns {Promise<string>} - 6-digit code
 * @throws {Error} ERR_OTP_TIMEOUT | ERR_IMAP_* | ERR_GMAIL_CREDS_MISSING
 */
export async function pollGmailForOtp(imapUser, imapPassword, timeoutMs = 120000) {
  if (!imapUser || !imapPassword) {
    throw new Error('ERR_GMAIL_CREDS_MISSING: GMAIL_IMAP_USER and GMAIL_IMAP_PASSWORD env vars required');
  }

  log.info(`Polling Gmail IMAP for OTP: ${safeEmailRef(imapUser)}, timeout=${timeoutMs}ms`);

  const startTime = Date.now();
  const pollIntervalMs = 5000; // 5s between IMAP queries

  while (Date.now() - startTime < timeoutMs) {
    try {
      const code = await readOtpFromImapOnce(imapUser, imapPassword);
      if (code) {
        log.info(`OTP code found: ***${code.slice(-2)}`);
        return code;
      }
    } catch (err) {
      log.warn(`IMAP poll attempt failed: ${err.message}`);
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw new Error('ERR_OTP_TIMEOUT');
}

/**
 * Single IMAP query: connect, login, search recent messages from Windsurf/Devin, extract 6-digit code.
 * Returns null if no code found (caller polls).
 */
async function readOtpFromImapOnce(imapUser, imapPassword) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: 'imap.gmail.com', port: 993 }, () => {
      // Connected
    });

    let tagCounter = 1;
    const nextTag = () => `A${tagCounter++}`;
    let buffer = '';
    let currentPhase = 'greeting';
    let settled = false;
    let messageIds = [];
    let fetchingBodyContent = false;
    let bodyBuffer = '';

    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const sendCmd = (cmd) => {
      socket.write(cmd + '\r\n');
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      const lines = buffer.split('\r\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        // Handle multi-line FETCH responses (body content may span lines)
        if (fetchingBodyContent) {
          bodyBuffer += line + '\n';
          // End of body: look for closing parenthesis or next tag
          if (line.includes(')') || /^A\d+/.test(line)) {
            fetchingBodyContent = false;
            // Extract 6-digit code from accumulated body
            const codeMatch = bodyBuffer.match(/\b(\d{6})\b/);
            if (codeMatch) {
              done(codeMatch[1]);
              return;
            }
            bodyBuffer = '';
            if (/^A\d+ OK/i.test(line)) {
              done(null); // No code found
            }
          }
          continue;
        }

        if (currentPhase === 'greeting') {
          // Wait for server greeting: "* OK ..."
          if (line.startsWith('* OK')) {
            currentPhase = 'login';
            sendCmd(`${nextTag()} LOGIN "${imapUser}" "${imapPassword}"`);
          }
        } else if (currentPhase === 'login') {
          // Wait for login success: "A1 OK ..."
          if (/^A\d+ OK/i.test(line)) {
            currentPhase = 'select';
            sendCmd(`${nextTag()} SELECT INBOX`);
          } else if (/^A\d+ NO|BAD/i.test(line)) {
            done(new Error(`ERR_IMAP_LOGIN_FAILED: ${line}`));
          }
        } else if (currentPhase === 'select') {
          // Wait for SELECT success: "A2 OK ..."
          if (/^A\d+ OK/i.test(line)) {
            currentPhase = 'search';
            // Search for recent messages from Windsurf/Devin sender
            // Windsurf uses "noreply@windsurf.com" or similar — adjust if needed
            sendCmd(`${nextTag()} SEARCH FROM "windsurf" UNSEEN`);
          } else if (/^A\d+ NO|BAD/i.test(line)) {
            done(new Error(`ERR_IMAP_SELECT_FAILED: ${line}`));
          }
        } else if (currentPhase === 'search') {
          // Parse SEARCH response: "* SEARCH 1234 5678"
          if (line.startsWith('* SEARCH')) {
            const msgIds = line.match(/\d+/g)?.slice(1) || []; // skip "SEARCH" token
            if (msgIds.length === 0) {
              // No new messages found, return null (caller will poll again)
              done(null);
              return;
            }
            messageIds = msgIds;
            // Fetch the most recent message body
            currentPhase = 'fetch';
            const lastId = msgIds[msgIds.length - 1];
            sendCmd(`${nextTag()} FETCH ${lastId} BODY[TEXT]`);
          } else if (/^A\d+ OK/i.test(line)) {
            // SEARCH completed with no results
            done(null);
          }
        } else if (currentPhase === 'fetch') {
          // Start of BODY[TEXT] response: "* 1234 FETCH (BODY[TEXT] {123}"
          if (/BODY\[TEXT\]/i.test(line) && line.includes('{')) {
            fetchingBodyContent = true;
            bodyBuffer = '';
            continue;
          }
          // Single-line BODY match (rare, but handle it)
          const codeMatch = line.match(/\b(\d{6})\b/);
          if (codeMatch) {
            done(codeMatch[1]);
            return;
          }
          // FETCH complete: "A4 OK ..."
          if (/^A\d+ OK/i.test(line)) {
            done(null); // No code found in this message
          }
        }
      }
    });

    socket.on('error', (err) => done(new Error(`ERR_IMAP_CONNECTION: ${err.message}`)));
    socket.on('end', () => { if (!settled) done(new Error('ERR_IMAP_DISCONNECT')); });
    socket.setTimeout(30000, () => done(new Error('ERR_IMAP_TIMEOUT')));
  });
}

// ─── Full OTP login orchestrator ───

/**
 * Full OTP login flow: sendEmailVerification → pollGmailForOtp → registerUserWithOtp.
 * Returns pool-compatible account shape.
 * @param {string} email
 * @param {string} firstName
 * @param {string} turnstileToken - real browser-generated Cloudflare Turnstile token
 * @param {string} [lastName]
 * @param {object} [proxy]
 * @param {object} [deps] - injectable dependencies (readOtp, env) for testing
 * @returns {Promise<{apiKey: string, name: string, email: string, apiServerUrl: string}>}
 */
export async function windsurfLoginViaEmailOtp(email, firstName, turnstileToken, lastName = '', proxy = null, deps = {}) {
  const env = deps.env || process.env;
  const readOtp = deps.readOtp || pollGmailForOtp;

  log.info(`Email-OTP login START: ${safeEmailRef(email)}`);

  // Step 1: Send verification email
  await sendEmailVerification(email, firstName, turnstileToken, proxy);

  // Step 2: Poll Gmail for OTP code
  const imapUser = env.GMAIL_IMAP_USER;
  const imapPassword = env.GMAIL_IMAP_PASSWORD;
  if (!imapUser || !imapPassword) {
    throw new Error('ERR_GMAIL_CREDS_MISSING: Set GMAIL_IMAP_USER and GMAIL_IMAP_PASSWORD env vars');
  }
  const otpCode = await readOtp(imapUser, imapPassword, 120000);

  // Step 3: Register user with OTP
  const result = await registerUserWithOtp(email, otpCode, turnstileToken, firstName, lastName, proxy);

  log.info(`Email-OTP login OK: ${safeEmailRef(email)}`);

  return {
    apiKey: result.apiKey,
    name: result.name,
    email,
    apiServerUrl: result.apiServerUrl,
  };
}
