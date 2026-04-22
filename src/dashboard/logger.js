/**
 * Structured logging with ring buffer, SSE, and on-disk JSONL persistence.
 *
 * Patches the primitive `log` object from config.js so every log call also:
 *   1. lands in an in-memory ring buffer (dashboard "recent logs")
 *   2. fans out to live SSE subscribers
 *   3. appends a structured JSONL line to logs/app.jsonl (daily-rotated)
 *   4. errors/warns also go to logs/error.jsonl
 *
 * Structured context: the last argument to log.*() may be a plain object.
 * It is stripped from the message and attached as `ctx`, so callers can do:
 *     log.info('Chat request', { requestId, model, account: acct.email });
 * and the dashboard can filter/group by ctx fields.
 */

import { mkdirSync, createWriteStream, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { config, log } from '../config.js';

const MAX_BUFFER = 1000;
const _buffer = [];
const _subscribers = new Set();

const LOG_DIR = join(config.dataDir, 'logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// Rotate by UTC date. One stream per day, lazily recreated at midnight.
let _appStream = null;
let _errStream = null;
let _streamDate = '';

function today() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getStreams() {
  const date = today();
  if (date !== _streamDate) {
    try { _appStream?.end(); } catch {}
    try { _errStream?.end(); } catch {}
    _appStream = createWriteStream(join(LOG_DIR, `app-${date}.jsonl`), { flags: 'a' });
    _errStream = createWriteStream(join(LOG_DIR, `error-${date}.jsonl`), { flags: 'a' });
    _streamDate = date;
  }
  return { app: _appStream, err: _errStream };
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Detect "context object": plain object, not array, not Error, reasonable size.
function isCtx(x) {
  return x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Error)
    && Object.getPrototypeOf(x) === Object.prototype;
}

// Save originals before patching
const _orig = {
  debug: log.debug,
  info: log.info,
  warn: log.warn,
  error: log.error,
};

for (const level of ['debug', 'info', 'warn', 'error']) {
  log[level] = (...args) => {
    // Pull trailing context object out of args.
    let ctx = null;
    if (args.length > 1 && isCtx(args[args.length - 1])) {
      ctx = args[args.length - 1];
      args = args.slice(0, -1);
    }
    const msg = args.map(formatArg).join(' ');

    const entry = { ts: Date.now(), level, msg };
    if (ctx) entry.ctx = ctx;

    _buffer.push(entry);
    if (_buffer.length > MAX_BUFFER) _buffer.shift();

    for (const fn of _subscribers) {
      try { fn(entry); } catch {}
    }

    // Persist to disk
    try {
      const { app, err } = getStreams();
      const line = JSON.stringify(entry) + '\n';
      app.write(line);
      if (level === 'error' || level === 'warn') err.write(line);
    } catch {}

    // Also print to console so pm2 logs still work
    if (ctx) {
      const ctxStr = Object.entries(ctx)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      _orig[level](...args, ctxStr ? `{${ctxStr}}` : '');
    } else {
      _orig[level](...args);
    }
  };
}

/**
 * Return a logger bound to a fixed context (e.g. { requestId }).
 * Later args to .info/.warn/.error can still add more context fields.
 */
export function withCtx(baseCtx) {
  const bind = (level) => (...args) => {
    let extra = null;
    if (args.length > 1 && isCtx(args[args.length - 1])) {
      extra = args[args.length - 1];
      args = args.slice(0, -1);
    }
    log[level](...args, { ...baseCtx, ...(extra || {}) });
  };
  return {
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
    requestId: baseCtx.requestId,
  };
}

/** Generate a short request id for tracing a single chat call end-to-end. */
export function newRequestId() {
  return 'r_' + randomUUID().replace(/-/g, '').slice(0, 10);
}

/** Get recent logs, optionally filtered by since/level/ctx. */
export function getLogs(since = 0, level = null, ctxFilter = null) {
  let result = _buffer;
  if (since > 0) result = result.filter(e => e.ts > since);
  if (level) result = result.filter(e => e.level === level);
  if (ctxFilter && typeof ctxFilter === 'object') {
    result = result.filter(e => {
      if (!e.ctx) return false;
      for (const [k, v] of Object.entries(ctxFilter)) {
        if (e.ctx[k] !== v) return false;
      }
      return true;
    });
  }
  return result;
}

export function subscribeToLogs(callback) { _subscribers.add(callback); }
export function unsubscribeFromLogs(callback) { _subscribers.delete(callback); }

/** Get current log directory (for dashboard to display). */
export function getLogDir() { return LOG_DIR; }
