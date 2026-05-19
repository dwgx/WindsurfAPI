const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

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

function normalizeProxy(rawProxy, parseProxyUrl) {
  if (!rawProxy) return { proxyRaw: null, proxy: null };
  if (typeof rawProxy === 'object' && !Array.isArray(rawProxy)) {
    const host = toTrimmedString(rawProxy.host);
    const port = Number.parseInt(rawProxy.port, 10);
    if (!host || !Number.isInteger(port) || port <= 0) {
      return { error: 'ERR_PROXY_FORMAT_INVALID' };
    }
    return {
      proxyRaw: `${toTrimmedString(rawProxy.type || 'http')}://${host}:${port}`,
      proxy: {
        type: toTrimmedString(rawProxy.type || 'http'),
        host,
        port,
        username: toTrimmedString(rawProxy.username),
        password: toTrimmedString(rawProxy.password),
      },
    };
  }
  const proxyRaw = toTrimmedString(rawProxy);
  if (!proxyRaw) return { proxyRaw: null, proxy: null };
  const proxy = parseProxyUrl(proxyRaw);
  if (!proxy) return { error: 'ERR_PROXY_FORMAT_INVALID' };
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
  if (/^\s+/.test(remainder)) return remainder.trim();
  const trimmed = remainder.trimStart();
  for (const separator of ['----', '|', ',', ':']) {
    if (trimmed.startsWith(separator)) return trimmed.slice(separator.length).trim();
  }
  return '';
}

export function parseBatchImportTextLine(rawLine, lineNumber, parseProxyUrl) {
  const line = String(rawLine || '').trim();
  if (!line) return null;
  const emailMatch = line.match(EMAIL_RE);
  if (!emailMatch) {
    return buildIssue({ lineNumber, raw: rawLine, code: 'ERR_FORMAT_INVALID' });
  }
  const email = emailMatch[0];
  const start = emailMatch.index || 0;
  const end = start + email.length;
  const prefix = line.slice(0, start).trim();
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
    return buildIssue({ lineNumber, raw: JSON.stringify(item), code: normalizedProxy.error, label });
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
