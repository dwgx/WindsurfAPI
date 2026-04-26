/**
 * Language server pool manager.
 * Spawns multiple LS instances — one per unique outbound proxy (plus a default
 * no-proxy instance). Accounts are routed to the LS instance matching their
 * configured proxy so that each upstream Codeium request goes out through the
 * right egress IP. Also avoids the LS state-pollution bug where switching
 * accounts within a single LS session causes workspace setup streams to be
 * canceled.
 */

import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { existsSync } from 'fs';
import http2 from 'http2';
import net from 'net';
import { resolve } from 'path';
import { config, log } from './config.js';
import { closeSessionForPort } from './grpc.js';

const DEFAULT_BINARY = config.lsBinaryPath;
const DEFAULT_PORT = 42100;
const DEFAULT_CSRF = 'windsurf-api-csrf-fixed-token';
const DEFAULT_API_URL = 'https://server.self-serve.windsurf.com';
const DEFAULT_DATA_ROOT = config.lsDataDir;

// Pool: key -> { process, port, csrfToken, proxy, startedAt, ready }
const _pool = new Map();
// In-flight Promise map so two concurrent ensureLs(proxy) calls for the
// same key share one spawn + readiness wait. Without this, both callers
// would each spawn an LS process, race on the port, and leave an orphan.
const _pending = new Map();
let _nextPort = DEFAULT_PORT + 1;
let _binaryPath = DEFAULT_BINARY;
let _apiServerUrl = DEFAULT_API_URL;

function proxyKey(proxy) {
  if (!proxy || !proxy.host) return 'default';
  // Sanitize to [A-Za-z0-9_] — the key flows into a filesystem path
  // (`${LS_DATA_DIR}/${key}`) and a shell-quoted mkdir, so strip any
  // special character that could slip past execSync's naive quoting.
  const safeHost = proxy.host.replace(/[^a-zA-Z0-9]/g, '_');
  const safePort = String(proxy.port || 8080).replace(/[^0-9]/g, '');
  return `px_${safeHost}_${safePort}`;
}

function dataDirForKey(key) {
  const root = process.env.LS_DATA_DIR
    ? resolve(process.cwd(), process.env.LS_DATA_DIR)
    : DEFAULT_DATA_ROOT;
  return `${root}/${key}`;
}

function proxyUrl(proxy) {
  if (!proxy || !proxy.host) return null;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `http://${auth}${proxy.host}:${proxy.port || 8080}`;
}

const LS_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'LANG', 'TMPDIR', 'TMP', 'TEMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];

export function buildLanguageServerEnv(source = process.env, options = {}) {
  const env = {};
  for (const key of LS_ENV_ALLOWLIST) {
    if (source[key] != null && source[key] !== '') env[key] = source[key];
  }
  if (!env.HOME) {
    env.HOME = source.HOME || '/root';
  }
  const pUrl = options.proxyUrl || null;
  if (pUrl) {
    env.HTTPS_PROXY = pUrl;
    env.HTTP_PROXY = pUrl;
    env.https_proxy = pUrl;
    env.http_proxy = pUrl;
  }
  if (options.extra && typeof options.extra === 'object') {
    for (const [k, v] of Object.entries(options.extra)) {
      if (v != null && v !== '') env[k] = String(v);
    }
  }
  return env;
}

export function redactProxyUrl(urlOrProxy) {
  if (!urlOrProxy) return 'none';
  if (typeof urlOrProxy === 'object') {
    const host = urlOrProxy.host || '';
    const port = urlOrProxy.port || 8080;
    return `${host}:${port}${urlOrProxy.username ? ' (auth=true)' : ''}`;
  }
  try {
    const u = new URL(String(urlOrProxy));
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}${u.username || u.password ? ' (auth=true)' : ''}`;
  } catch {
    return String(urlOrProxy).replace(/\/\/([^:@/\s]+):([^@/\s]*)@/g, '//***:***@');
  }
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

  // Coalesce concurrent callers onto a single spawn. The chat handlers
  // call ensureLs(acct.proxy) on every request; before this guard, a burst
  // of requests for a never-seen proxy would spawn N LS processes that
  // all tried to bind the same _nextPort.
  const pending = _pending.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const isDefault = key === 'default';
    let port = isDefault ? DEFAULT_PORT : _nextPort++;

    // If something is already listening on the default port (e.g. leftover
    // from a previous crashed run), adopt it rather than fight for the port.
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

    // Non-default ports: skip anything already bound. A PM2 restart can
    // race the old LS's TCP teardown — if we spawn while the dying
    // process still owns 42101, waitPortReady would succeed by connecting
    // to the corpse and every request would hang. Advance _nextPort until
    // we find a free slot.
    if (!isDefault) {
      let tries = 0;
      while (await isPortInUse(port)) {
        if (++tries > 50) throw new Error(`No free port for LS in range starting ${DEFAULT_PORT + 1}`);
        log.debug(`LS port ${port} busy, advancing`);
        port = _nextPort++;
      }
    }

    const dataDir = dataDirForKey(key);
    try { mkdirSync(`${dataDir}/db`, { recursive: true }); } catch (e) { log.warn(`mkdirSync ${dataDir}/db: ${e.message}`); }

    const args = [
      `--api_server_url=${_apiServerUrl}`,
      `--server_port=${port}`,
      `--csrf_token=${DEFAULT_CSRF}`,
      `--register_user_url=https://api.codeium.com/register_user/`,
      `--codeium_dir=${dataDir}`,
      `--database_dir=${dataDir}/db`,
      '--detect_proxy=false',
    ];

    const pUrl = proxyUrl(proxy);
    const env = buildLanguageServerEnv(process.env, { proxyUrl: pUrl });

    // One-shot readable warning when the LS binary is missing — the generic
    // ENOENT from spawn leaves users guessing which file is expected.
    if (!existsSync(_binaryPath)) {
      log.error(
        `Language server binary not found at ${_binaryPath}. ` +
        `Install it with:  bash install-ls.sh  (or set LS_BINARY_PATH env var)`
      );
    }

    log.info(`Starting LS instance key=${key} port=${port} proxy=${redactProxyUrl(pUrl)}`);

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
      if (line) log.warn(`[LS:${key}:err] ${line}`);
    });
    proc.on('exit', (code, signal) => {
      log.warn(`LS instance ${key} exited: code=${code} signal=${signal}`);
      if (code === 1) {
        log.error('LS crashed on startup. Common causes:');
        log.error('  1. Binary incompatible with this OS/arch — re-download with: bash install-ls.sh');
        log.error('  2. Missing glibc/libstdc++ — run: ldd ' + _binaryPath + ' | grep "not found"');
        log.error('  3. Binary corrupted — delete and re-download: rm ' + _binaryPath + ' && bash install-ls.sh');
        log.error('  4. Port already in use — check: lsof -i :' + port);
      }
      const gone = _pool.get(key);
      _pool.delete(key);
      if (gone?.port) {
        // Drop the pooled HTTP/2 session so the next request to the
        // replacement LS opens a fresh one instead of writing into a
        // dead socket (grpc.js caches one session per port).
        closeSessionForPort(gone.port);
        import('./conversation-pool.js').then(m => m.invalidateFor({ lsPort: gone.port })).catch(() => {});
      }
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOEXEC') {
        const os = process.platform;
        log.error(
          `LS binary is not executable on this platform (${os}). ` +
          `The binary at ${_binaryPath} is likely built for a different OS/arch. ` +
          (os === 'darwin'
            ? 'You need the macOS build: copy language_server_macos_arm (Apple Silicon) or language_server_macos_x64 (Intel) from your Windsurf desktop app.'
            : os === 'win32'
              ? 'LS binary only runs on Linux. Use WSL2 or a Linux VM.'
              : `Ensure the binary matches your arch: ${process.arch}`)
        );
      } else {
        log.error(`LS instance ${key} spawn error: ${err.message}`);
      }
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

    try {
      await waitPortReady(port, 25000);
      entry.ready = true;
      log.info(`LS instance ${key} ready on port ${port}`);
    } catch (err) {
      log.error(`LS instance ${key} failed to become ready: ${err.message}`);
      try { proc.kill('SIGKILL'); } catch {}
      _pool.delete(key);
      throw err;
    }
    return entry;
  })();

  _pending.set(key, promise);
  try {
    return await promise;
  } finally {
    _pending.delete(key);
  }
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
 * Get the LS entry matching a proxy, or null if it hasn't been spawned.
 * Callers should `await ensureLs(proxy)` first — don't silently fall back
 * to the default LS, because that sends the request through the wrong
 * egress IP (Codeium will see the wrong source, invalidate the session,
 * and falsely mark the account expired).
 */
export function getLsFor(proxy) {
  return _pool.get(proxyKey(proxy)) || null;
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
