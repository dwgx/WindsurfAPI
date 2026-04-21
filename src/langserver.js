/**
 * Language server pool manager.
 * Spawns multiple LS instances — one per unique outbound proxy (plus a default
 * no-proxy instance). Accounts are routed to the LS instance matching their
 * configured proxy so that each upstream Codeium request goes out through the
 * right egress IP. Also avoids the LS state-pollution bug where switching
 * accounts within a single LS session causes workspace setup streams to be
 * canceled.
 */

import { spawn, execSync } from 'child_process';
import http2 from 'http2';
import net from 'net';
import { log } from './config.js';

const DEFAULT_BINARY = '/opt/windsurf/language_server_linux_x64';
const DEFAULT_PORT = 42100;
const DEFAULT_CSRF = 'windsurf-api-csrf-fixed-token';
const DEFAULT_API_URL = 'https://server.self-serve.windsurf.com';

// Pool: key -> { process, port, csrfToken, proxy, startedAt, ready }
const _pool = new Map();
const _pending = new Map();
let _nextPort = DEFAULT_PORT + 1;
let _binaryPath = DEFAULT_BINARY;
let _apiServerUrl = DEFAULT_API_URL;

function proxyKey(proxy) {
  if (!proxy || !proxy.host) return 'default';
  return `px_${proxy.host.replace(/[^a-zA-Z0-9]/g, '_')}_${proxy.port}`;
}

function proxyUrl(proxy) {
  if (!proxy || !proxy.host) return null;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `http://${auth}${proxy.host}:${proxy.port || 8080}`;
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy(); resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

async function waitPortReady(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const client = http2.connect(`http://localhost:${port}`);
        const timer = setTimeout(() => { try { client.close(); } catch {} reject(new Error('timeout')); }, 2000);
        client.on('connect', () => { clearTimeout(timer); client.close(); resolve(); });
        client.on('error', (e) => { clearTimeout(timer); try { client.close(); } catch {} reject(e); });
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`LS port ${port} not ready after ${timeoutMs}ms`);
}

/**
 * Spawn an LS instance for the given proxy (or no-proxy default).
 * Idempotent — returns the existing entry if one is already running.
 */
export async function ensureLs(proxy = null) {
  const key = proxyKey(proxy);
  const existing = _pool.get(key);
  if (existing && existing.ready) return existing;

  // Check if another call is already starting this LS
  const pending = _pending.get(key);
  if (pending) return pending;

  // Start the LS and store the promise
  const startPromise = (async () => {
    try {
      const isDefault = key === 'default';
      const port = isDefault ? DEFAULT_PORT : _nextPort++;

      // If something is already listening on the default port (e.g. leftover from
      // a previous crashed run), adopt it rather than fight for the port.
      if (isDefault && await isPortInUse(port)) {
        log.info(`LS default port ${port} already in use — adopting existing instance`);
        const entry = {
          process: null, port, csrfToken: DEFAULT_CSRF,
          proxy: null, startedAt: Date.now(), ready: true,
          workspaceInit: null, sessionId: null,
        };
        _pool.set(key, entry);
        return entry;
      }

      const dataDir = `/opt/windsurf/data/${key}`;
      try { execSync(`mkdir -p ${dataDir}/db`, { stdio: 'ignore' }); } catch {}

      const args = [
        `--api_server_url=${_apiServerUrl}`,
        `--server_port=${port}`,
        `--csrf_token=${DEFAULT_CSRF}`,
        `--register_user_url=https://api.codeium.com/register_user/`,
        `--codeium_dir=${dataDir}`,
        `--database_dir=${dataDir}/db`,
        '--enable_local_search=false',
        '--enable_index_service=false',
        '--enable_lsp=false',
        '--detect_proxy=false',
      ];

      const env = { ...process.env, HOME: '/root' };
      const pUrl = proxyUrl(proxy);
      if (pUrl) {
        env.HTTPS_PROXY = pUrl;
        env.HTTP_PROXY = pUrl;
        env.https_proxy = pUrl;
        env.http_proxy = pUrl;
      }

      log.info(`Starting LS instance key=${key} port=${port} proxy=${pUrl || 'none'}`);

      const proc = spawn(_binaryPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      proc.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          if (/ERROR|error/.test(line)) log.error(`[LS:${key}] ${line}`);
          else log.debug(`[LS:${key}] ${line}`);
        }
      });
      proc.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) log.debug(`[LS:${key}:err] ${line}`);
      });
      proc.on('exit', (code, signal) => {
        log.warn(`LS instance ${key} exited: code=${code} signal=${signal}`);
        const gone = _pool.get(key);
        _pool.delete(key);
        if (gone?.port) {
          import('./conversation-pool.js').then(m => m.invalidateFor({ lsPort: gone.port })).catch(() => {});
        }
      });
      proc.on('error', (err) => {
        log.error(`LS instance ${key} spawn error: ${err.message}`);
        _pool.delete(key);
      });

      const entry = {
        process: proc, port, csrfToken: DEFAULT_CSRF,
        proxy, startedAt: Date.now(), ready: false,
        // One-shot Cascade workspace init promise. cascadeChat() awaits this so
        // the heavy InitializePanelState / AddTrackedWorkspace / UpdateWorkspaceTrust
        // trio only runs once per LS lifetime instead of once per request.
        workspaceInit: null,
        sessionId: null,
      };
      _pool.set(key, entry);

      await waitPortReady(port, 25000);
      entry.ready = true;
      log.info(`LS instance ${key} ready on port ${port}`);
      return entry;
    } catch (err) {
      log.error(`LS instance ${key} failed to become ready: ${err.message}`);
      const entry = _pool.get(key);
      if (entry?.process) {
        try { entry.process.kill('SIGKILL'); } catch {}
      }
      _pool.delete(key);
      throw err;
    } finally {
      _pending.delete(key);
    }
  })();

  _pending.set(key, startPromise);
  return startPromise;
}

/**
 * Stop and remove the LS instance associated with a given proxy.
 * Used when a proxy is reassigned so the old egress no longer exists.
 */
export async function restartLsForProxy(proxy) {
  const key = proxyKey(proxy);
  const entry = _pool.get(key);
  if (entry?.process) {
    try { entry.process.kill('SIGTERM'); } catch {}
  }
  _pool.delete(key);
  return ensureLs(proxy);
}

/**
 * Get the LS entry matching a proxy (or default when proxy is null).
 * Returns the default instance as a fallback if the proxy-specific one hasn't
 * been spawned yet.
 */
export function getLsFor(proxy) {
  const key = proxyKey(proxy);
  return _pool.get(key) || _pool.get('default') || null;
}

/**
 * Look up an LS pool entry by its gRPC port. Used by WindsurfClient so it
 * can attach per-LS state (one-shot cascade workspace init, persistent
 * sessionId) without plumbing the entry through every call site.
 */
export function getLsEntryByPort(port) {
  for (const entry of _pool.values()) {
    if (entry.port === port) return entry;
  }
  return null;
}

// ─── Backward-compat API ───────────────────────────────────

export function getLsPort() {
  return _pool.get('default')?.port || DEFAULT_PORT;
}
export function getCsrfToken() {
  return _pool.get('default')?.csrfToken || DEFAULT_CSRF;
}

/**
 * Legacy entry point used by index.js — starts the default (no-proxy) LS.
 */
export async function startLanguageServer(opts = {}) {
  _binaryPath = opts.binaryPath || process.env.LS_BINARY_PATH || _binaryPath;
  _apiServerUrl = opts.apiServerUrl || process.env.CODEIUM_API_URL || _apiServerUrl;
  const def = await ensureLs(null);
  return { port: def.port, csrfToken: def.csrfToken };
}

export function stopLanguageServer() {
  for (const [key, entry] of _pool) {
    try { entry.process?.kill('SIGTERM'); } catch {}
    log.info(`LS instance ${key} stopped`);
  }
  _pool.clear();
}

export function isLanguageServerRunning() {
  return _pool.size > 0;
}

export async function waitForReady(/* timeoutMs */) {
  const def = _pool.get('default');
  if (!def) throw new Error('default LS not initialized');
  if (def.ready) return true;
  await waitPortReady(def.port, 20000);
  def.ready = true;
  return true;
}

export function getLsStatus() {
  const def = _pool.get('default');
  return {
    running: _pool.size > 0,
    pid: def?.process?.pid || null,
    port: def?.port || DEFAULT_PORT,
    startedAt: def?.startedAt || null,
    restartCount: 0,
    instances: Array.from(_pool.entries()).map(([key, e]) => ({
      key, port: e.port,
      pid: e.process?.pid || null,
      proxy: e.proxy ? `${e.proxy.host}:${e.proxy.port}` : null,
      startedAt: e.startedAt,
      ready: e.ready,
    })),
  };
}
