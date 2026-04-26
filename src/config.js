import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
export const DEFAULT_HOST = '127.0.0.1';

function isTruthyEnvValue(raw) {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function shouldForwardCallerEnvironment(raw) {
  return isTruthyEnvValue(raw);
}

export function parseForwardCallerEnvFields(raw) {
  const items = String(raw || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  const out = new Set();
  for (const item of items) {
    const normalized = item === 'os_version' || item === 'osversion' ? 'os' : item;
    if (normalized === 'cwd' || normalized === 'git' || normalized === 'platform' || normalized === 'os') {
      out.add(normalized);
    }
  }
  return [...out];
}

export function defaultLsBinaryPath({ platform = process.platform, arch = process.arch, home = process.env.HOME || '' } = {}) {
  if (platform === 'darwin') {
    return `${home}/.windsurf/language_server_macos_${arch === 'arm64' ? 'arm' : 'x64'}`;
  }
  return '/opt/windsurf/language_server_linux_x64';
}

export function defaultLsDataDir({ platform = process.platform, home = process.env.HOME || '', rootDir = ROOT } = {}) {
  if (platform === 'darwin') return join(home || rootDir, '.windsurf', 'data');
  return '/opt/windsurf/data';
}

export function defaultWorkspaceDir({ tmpDir = process.env.TEMP || process.env.TMP || tmpdir(), hostname = process.env.HOSTNAME || '' } = {}) {
  const suffix = hostname ? `-${hostname}` : '';
  const folder = `windsurf-workspace${suffix}`;
  return join(tmpDir || '/tmp', folder);
}

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

const dataDir = (() => {
  let base = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : ROOT;
  if (process.env.REPLICA_ISOLATE === '1' && process.env.HOSTNAME) {
    base = join(base, `replica-${process.env.HOSTNAME}`);
  }
  return base;
})();

try {
  mkdirSync(dataDir, { recursive: true });
} catch {}

export const config = {
  host: process.env.HOST || DEFAULT_HOST,
  port: parseInt(process.env.PORT || '3003', 10),
  apiKey: process.env.API_KEY || '',
  dataDir,

  codeiumAuthToken: process.env.CODEIUM_AUTH_TOKEN || '',
  codeiumApiKey: process.env.CODEIUM_API_KEY || '',
  codeiumEmail: process.env.CODEIUM_EMAIL || '',
  codeiumPassword: process.env.CODEIUM_PASSWORD || '',

  codeiumApiUrl: process.env.CODEIUM_API_URL || 'https://server.self-serve.windsurf.com',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet-thinking',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  logPromptSamples: isTruthyEnvValue(process.env.LOG_PROMPT_SAMPLES),
  forwardCallerEnv: shouldForwardCallerEnvironment(process.env.FORWARD_CALLER_ENV),
  forwardCallerEnvFields: parseForwardCallerEnvFields(process.env.FORWARD_CALLER_ENV_FIELDS),

  // Language server
  lsBinaryPath: process.env.LS_BINARY_PATH || defaultLsBinaryPath(),
  lsDataDir: process.env.LS_DATA_DIR || defaultLsDataDir(),
  workspaceDir: process.env.WORKSPACE_DIR || defaultWorkspaceDir(),
  lsPort: parseInt(process.env.LS_PORT || '42100', 10),

  // Dashboard
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  enableRevealApiKey: isTruthyEnvValue(process.env.ENABLE_REVEAL_API_KEY),
  enableSelfUpdate: isTruthyEnvValue(process.env.ENABLE_SELF_UPDATE),
  enableBatchLogin: isTruthyEnvValue(process.env.ENABLE_BATCH_LOGIN),
  enableTokenRefresh: process.env.ENABLE_TOKEN_REFRESH == null
    ? true
    : isTruthyEnvValue(process.env.ENABLE_TOKEN_REFRESH),
  enableLsRestart: isTruthyEnvValue(process.env.ENABLE_LS_RESTART),
};

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

export const log = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', ...args),
};
