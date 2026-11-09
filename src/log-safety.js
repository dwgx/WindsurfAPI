import { createHash } from 'crypto';

export function logHash(value, len = 12) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, len);
}

export function safeAccountRef(accountOrId, label = '') {
  const id = typeof accountOrId === 'object'
    ? (accountOrId?.id || 'unknown')
    : (accountOrId || 'unknown');
  const rawLabel = typeof accountOrId === 'object'
    ? (accountOrId?.email || accountOrId?.name || label || '')
    : (label || '');
  const out = `account=${id}`;
  return rawLabel ? `${out} labelHash=${logHash(rawLabel)}` : out;
}

export function accountRef(id) {
  return `acct-${logHash(id, 8)}`;
}

export function safeEmailRef(email) {
  return `emailHash=${logHash(email)}`;
}

export function safeKeyRef(key, prefix = 'key') {
  return `${prefix}Hash=${logHash(key)}`;
}

// Operator-facing errors (dashboard toast, RegisterUser wrap) used to echo
// upstream bodies that included the pasted JWT / session string (#257).
export function redactCredentialFragments(text) {
  return String(text ?? '')
    .replace(/devin-session-token\$[A-Za-z0-9._-]+/g, 'devin-session-token$[redacted]')
    .replace(/auth1_[A-Za-z0-9_-]{8,}/g, 'auth1_[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt-redacted]');
}

// Slice AFTER redaction. RegisterUser used to slice(0,120) first, which
// split a JWT at the first dot so the regex missed it. Same trap is in
// windsurf-login PostAuth / OneTimeToken error wrapping.
export function sliceRedactedJson(value, n = 120) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return redactCredentialFragments(raw).slice(0, n);
}

// Client-supplied strings (model names, selectors) are interpolated straight into
// log lines. Raw control characters let an authenticated caller forge log records
// or inject ANSI escape sequences into an operator's terminal, so strip them at
// the log boundary. Only C0/C1 controls and DEL are replaced (the value stays
// readable), and the length is bounded so one request cannot flood a line.
const LOG_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export function safeLogValue(value, max = 120) {
  const cleaned = String(value ?? '').replace(LOG_CONTROL_CHARS, '\u00b7');
  return cleaned.length > max ? `${cleaned.slice(0, max)}\u2026` : cleaned;
}

// The Gemini surface accepts the API key as `?key=` — a verbatim request-URL
// log line (https-proxy.js prints `${method} ${url}`) writes a live credential
// into the journal. Replace the value; keep the param name so the line still
// explains which carrier the client used. Applied on the raw string so a
// malformed URL cannot sneak the key past a parser.
export function redactUrlForLog(url) {
  const raw = String(url ?? '');
  return raw
    .replace(/([?&]key=)[^&\s]*/gi, '$1[redacted]')
    .replace(LOG_CONTROL_CHARS, '·');
}
