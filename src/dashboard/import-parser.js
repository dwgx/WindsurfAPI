import { isIPv6 } from 'node:net';
import { domainToASCII } from 'node:url';
import { unwrapPastedSecret } from './account-text-parser.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// A whole credential can be one opaque string: a show-auth-token /
// OneTimeAuthToken value is 47 chars of [A-Za-z0-9_-] (measured live), and the
// desktop callback is a `windsurf://…?access_token=…` deep link. Without this
// a token-only line was ERR_FORMAT_INVALID, so a pasted token could not be
// batch-imported at all (F3/F9).
const BARE_TOKEN_RE = /^[A-Za-z0-9_\-\.\$\/+=]{40,}$/;
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;

function tokenFromLine(line) {
  if (BARE_TOKEN_RE.test(line)) return line;
  if (!ABSOLUTE_URL_RE.test(line)) return '';
  try {
    return unwrapPastedSecret(line);
  } catch {
    // A URL with no token (or a proxy URL) is not a credential; the caller
    // reports the line as ERR_FORMAT_INVALID exactly as before.
    return '';
  }
}

export class BatchImportParseError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function toTrimmedString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function readCaseInsensitive(obj, key) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const match = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
  return match ? obj[match] : undefined;
}

function getFirstString(obj, keys) {
  for (const key of keys) {
    const direct = toTrimmedString(readCaseInsensitive(obj, key));
    if (direct) return direct;
  }
  return '';
}

const PROXY_TYPES = new Set(['http', 'https', 'socks', 'socks5', 'socks5h']);
const DNS_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;
const NON_HOST_ASCII = /[^A-Za-z0-9._\u0080-\u{10FFFF}-]/u;
// IDNA checks the two contextual joiners. Other invisible formatting and
// controls do not belong in the public display label.
const UNSAFE_DISPLAY = /[\s\p{Cc}\p{Cs}]|(?![\u200C\u200D])\p{Cf}/u;

// Only bare hostnames and IP literals belong in a public proxy label.
// DNS resolution and the private-address policy still run before use.
export function redactedProxyLabel(proxy) {
  if (!proxy || typeof proxy.host !== 'string') return null;
  const { host, port } = proxy;
  const type = typeof proxy.type === 'string' ? proxy.type.toLowerCase() : '';
  if (!PROXY_TYPES.has(type) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const address = host.replace(/^\[([^\]]+)\]$/, '$1');
  if (isIPv6(address)) {
    // A link-local scope belongs to the connection, not to its public label.
    const [ip] = address.split('%');
    return `${type}://[${ip}]:${port}`;
  }
  if (UNSAFE_DISPLAY.test(host) || NON_HOST_ASCII.test(host) || NON_HOST_ASCII.test(host.normalize('NFKC'))) return null;
  const ascii = domainToASCII(host);
  const name = ascii.replace(/\.$/, '');
  if (name.length > 253 || !name.split('.').every(label => DNS_LABEL.test(label))) return null;
  // Node's host parser must consume the entire input. An appended label must
  // survive and change the result, even if the input already ends in .invalid.
  const suffixed = domainToASCII(`${host}.invalid`);
  if (suffixed === ascii || !suffixed.endsWith('.invalid')) return null;
  return `${type}://${host}:${port}`;
}

function normalizeProxy(rawProxy, parseProxyUrl) {
  if (rawProxy == null) return { proxyRaw: null, proxy: null };
  if (typeof rawProxy === 'object' && !Array.isArray(rawProxy)) {
    const port = toTrimmedString(rawProxy.port);
    const proxy = {
      type: toTrimmedString(rawProxy.type || 'http').toLowerCase(),
      host: typeof rawProxy.host === 'string' ? rawProxy.host.trim() : '',
      port: /^\d+$/.test(port) ? Number(port) : NaN,
      username: toTrimmedString(rawProxy.username),
      password: toTrimmedString(rawProxy.password),
    };
    const proxyRaw = redactedProxyLabel(proxy);
    return proxyRaw ? { proxyRaw, proxy } : { error: 'ERR_PROXY_FORMAT_INVALID' };
  }
  if (typeof rawProxy !== 'string') return { error: 'ERR_PROXY_FORMAT_INVALID' };
  const proxyRaw = rawProxy.trim();
  if (!proxyRaw) return { proxyRaw: null, proxy: null };
  const proxy = parseProxyUrl(proxyRaw);
  if (!redactedProxyLabel(proxy)) return { error: 'ERR_PROXY_FORMAT_INVALID' };
  return { proxyRaw, proxy };
}

function buildIssue({ lineNumber, raw, code, label }) {
  return {
    kind: 'issue',
    success: false,
    skipped: true,
    lineNumber,
    raw,
    label: label || (lineNumber ? `Line ${lineNumber}` : 'Skipped'),
    error: code,
  };
}

function buildEntry(base) {
  return {
    success: false,
    skipped: false,
    lineNumber: base.lineNumber || 0,
    raw: base.raw || '',
    proxyRaw: base.proxyRaw || null,
    proxy: base.proxy || null,
    label: base.label || '',
    ...base,
  };
}

function parsePasswordRemainder(remainder) {
  if (!remainder) return '';
  const trimmed = remainder.trimStart();
  const label = trimmed.match(/^(?:(?:密码|密碼|口令)\s*[:：=]?\s*|(?:password|pass|pwd)\b\s*(?:[:：=]\s*|\s+))/i);
  if (label) return trimmed.slice(label[0].length).trim();
  if (/^\s+/.test(remainder)) return remainder.trim();
  for (const separator of ['----', '|', ',', ':', '：', '=']) {
    if (trimmed.startsWith(separator)) return trimmed.slice(separator.length).trim();
  }
  return '';
}

function normalizeEmailPrefix(prefix) {
  const raw = String(prefix || '').trim();
  if (!raw) return '';
  const withoutLabel = raw
    .replace(/(?:\s*(?:邮箱|账号|账户|邮件|email|e-mail|mail|username|user)\s*[:：=]?)+\s*$/i, '')
    .trim();
  return withoutLabel || '';
}

export function parseBatchImportTextLine(rawLine, lineNumber, parseProxyUrl) {
  const line = String(rawLine || '').trim();
  if (!line) return null;
  const emailMatch = line.match(EMAIL_RE);
  if (!emailMatch) {
    const token = tokenFromLine(line);
    if (token) {
      return buildEntry({ kind: 'token', lineNumber, raw: rawLine, token, label: '' });
    }
    return buildIssue({ lineNumber, raw: rawLine, code: 'ERR_FORMAT_INVALID' });
  }
  const email = emailMatch[0];
  const start = emailMatch.index || 0;
  const end = start + email.length;
  const prefix = normalizeEmailPrefix(line.slice(0, start));
  const remainder = line.slice(end);
  let proxyRaw = null;
  let proxy = null;
  if (prefix) {
    const normalizedProxy = normalizeProxy(prefix, parseProxyUrl);
    if (normalizedProxy.error) {
      return buildIssue({ lineNumber, raw: rawLine, code: normalizedProxy.error });
    }
    proxyRaw = normalizedProxy.proxyRaw;
    proxy = normalizedProxy.proxy;
  }
  const password = parsePasswordRemainder(remainder);
  if (!password) {
    return buildIssue({ lineNumber, raw: rawLine, code: 'ERR_FORMAT_INVALID' });
  }
  return buildEntry({
    kind: 'email_password',
    lineNumber,
    raw: rawLine,
    email,
    password,
    proxyRaw,
    proxy,
    label: email,
  });
}

export function parseBatchImportJsonItem(item, lineNumber, parseProxyUrl) {
  if (typeof item === 'string') return parseBatchImportTextLine(item, lineNumber, parseProxyUrl);
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return buildIssue({ lineNumber, raw: JSON.stringify(item), code: 'ERR_UNSUPPORTED_IMPORT_ITEM' });
  }

  const nestedAccount = readCaseInsensitive(item, 'account');
  const nestedAccountValue = (
    nestedAccount && typeof nestedAccount === 'object' && !Array.isArray(nestedAccount)
  ) ? nestedAccount : null;

  const email = getFirstString(item, ['email', 'username', 'account'])
    || getFirstString(nestedAccountValue, ['email', 'username', 'account']);
  const password = getFirstString(item, ['password', 'pass']);
  const token = getFirstString(item, ['token', 'access_token', 'accessToken']);
  const apiKey = getFirstString(item, ['api_key', 'apiKey', 'key']);
  const windsurfApiKey = getFirstString(item, ['windsurf_api_key'])
    || getFirstString(readCaseInsensitive(item, 'windsurf_auth_status_raw'), ['apiKey']);
  const windsurfAuthToken = getFirstString(item, ['windsurf_auth_token'])
    || getFirstString(readCaseInsensitive(item, 'windsurf_auth_status_raw'), ['authToken']);
  const windsurfApiServerUrl = getFirstString(item, ['windsurf_api_server_url'])
    || getFirstString(readCaseInsensitive(item, 'windsurf_auth_status_raw'), ['apiServerUrl', 'api_server_url']);
  const exportEmail = getFirstString(item, ['github_email'])
    || getFirstString(readCaseInsensitive(item, 'windsurf_user_status'), ['email'])
    || getFirstString(readCaseInsensitive(item, 'windsurf_auth_status_raw'), ['email']);
  const label = getFirstString(item, ['label', 'name', 'note']) || email;
  const normalizedProxy = normalizeProxy(readCaseInsensitive(item, 'proxy'), parseProxyUrl);
  if (normalizedProxy.error) {
    return buildIssue({ lineNumber, code: normalizedProxy.error });
  }

  if (token) {
    return buildEntry({
      kind: 'token',
      lineNumber,
      raw: JSON.stringify(item),
      token,
      label,
      email: email || label || '',
      proxyRaw: normalizedProxy.proxyRaw,
      proxy: normalizedProxy.proxy,
    });
  }

  if (apiKey) {
    return buildEntry({
      kind: 'api_key',
      lineNumber,
      raw: JSON.stringify(item),
      apiKey,
      label,
      email: email || label || '',
      proxyRaw: normalizedProxy.proxyRaw,
      proxy: normalizedProxy.proxy,
    });
  }

  if (windsurfApiKey) {
    return buildEntry({
      kind: 'api_key',
      lineNumber,
      raw: JSON.stringify(item),
      apiKey: windsurfApiKey,
      apiServerUrl: windsurfApiServerUrl || '',
      label: label || exportEmail,
      email: exportEmail || label || '',
      proxyRaw: normalizedProxy.proxyRaw,
      proxy: normalizedProxy.proxy,
    });
  }

  if (windsurfAuthToken) {
    return buildEntry({
      kind: 'token',
      lineNumber,
      raw: JSON.stringify(item),
      token: windsurfAuthToken,
      apiServerUrl: windsurfApiServerUrl || '',
      label: label || exportEmail,
      email: exportEmail || label || '',
      proxyRaw: normalizedProxy.proxyRaw,
      proxy: normalizedProxy.proxy,
    });
  }

  if (email && password) {
    return buildEntry({
      kind: 'email_password',
      lineNumber,
      raw: JSON.stringify(item),
      email,
      password,
      label,
      proxyRaw: normalizedProxy.proxyRaw,
      proxy: normalizedProxy.proxy,
    });
  }

  return buildIssue({
    lineNumber,
    raw: JSON.stringify(item),
    code: 'ERR_UNSUPPORTED_IMPORT_ITEM',
    label,
  });
}

function normalizeJsonContainer(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') {
    return [parsed];
  }
  const accounts = readCaseInsensitive(parsed, 'accounts');
  if (Array.isArray(accounts)) return accounts;
  const items = readCaseInsensitive(parsed, 'items');
  if (Array.isArray(items)) return items;
  return [parsed];
}

export function parseBatchImportInput(text, parseProxyUrl) {
  const source = String(text || '');
  if (!source.trim()) {
    return { mode: 'empty', items: [] };
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new BatchImportParseError('ERR_JSON_INVALID');
    }
    const items = normalizeJsonContainer(parsed)
      .map((item, index) => parseBatchImportJsonItem(item, index + 1, parseProxyUrl))
      .filter(Boolean);
    return { mode: 'json', items };
  }

  const items = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => parseBatchImportTextLine(line, index + 1, parseProxyUrl))
    .filter(Boolean);

  return { mode: 'text', items };
}
