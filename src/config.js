import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env file manually (zero dependencies)
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // Strip inline comments for unquoted values: PORT=3003 # port → 3003
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

// `sharedDataDir` is the cluster-shared root: a single accounts.json lives
// here so add-account writes from any replica are visible to every replica
// after restart. `dataDir` is replica-local under REPLICA_ISOLATE=1 and is
// safe to use for telemetry that does not need cross-replica visibility.
// See issue #67 — when the two were collapsed into one path, every
// docker-compose upgrade orphaned the user's accounts.json under a stale
// `replica-${HOSTNAME}` subdir.
const sharedDataDir = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : ROOT;
const dataDir = (() => {
  let base = sharedDataDir;
  if (process.env.REPLICA_ISOLATE === '1' && process.env.HOSTNAME) {
    base = join(base, `replica-${process.env.HOSTNAME}`);
  }
  return base;
})();

try {
  mkdirSync(sharedDataDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
} catch {}

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  // Bind host. Defaults to all interfaces. Set HOST=127.0.0.1 (or BIND_HOST=)
  // for localhost-only deployments — when bound non-locally, missing API_KEY /
  // DASHBOARD_PASSWORD switches to fail-closed instead of default-allow.
  host: process.env.HOST || process.env.BIND_HOST || '0.0.0.0',
  apiKey: process.env.API_KEY || '',
  dataDir,
  sharedDataDir,

  codeiumAuthToken: process.env.CODEIUM_AUTH_TOKEN || '',
  codeiumApiKey: process.env.CODEIUM_API_KEY || '',
  codeiumEmail: process.env.CODEIUM_EMAIL || '',
  codeiumPassword: process.env.CODEIUM_PASSWORD || '',

  codeiumApiUrl: process.env.CODEIUM_API_URL || 'https://server.self-serve.windsurf.com',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet-thinking',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Language server
  lsBinaryPath: process.env.LS_BINARY_PATH || (
    process.platform === 'darwin'
      ? `${process.env.HOME}/.windsurf/language_server_macos_${process.arch === 'arm64' ? 'arm' : 'x64'}`
      : '/opt/windsurf/language_server_linux_x64'
  ),
  lsPort: parseInt(process.env.LS_PORT || '42100', 10),

  // Dashboard
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
};

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

export const log = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', ...args),
};
