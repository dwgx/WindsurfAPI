#!/usr/bin/env node

import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function printHelp() {
  console.log(`WindsurfAPI starter

Usage:
  node scripts/start.js [local|public] [options]

Modes:
  local    Safe default. Binds to 127.0.0.1 unless --host is provided.
  public   Binds to 0.0.0.0 by default. Requires API auth or dashboard auth.

Options:
  --host <value>                  Override bind host
  --port <value>                  Override port (default: 3003)
  --api-key <value>               Set API_KEY for this launch
  --dashboard-password <value>    Set DASHBOARD_PASSWORD for this launch
  --ls-binary-path <value>        Override LS binary path
  --ls-data-dir <value>           Override LS data dir
  --workspace-dir <value>         Override workspace dir
  --help                          Show this help

Examples:
  node scripts/start.js local
  node scripts/start.js local --port 3005
  node scripts/start.js public --api-key your-api-key
  node scripts/start.js public --dashboard-password your-dashboard-password
`);
}

function readOption(args, index) {
  const token = args[index];
  if (!token.startsWith('--')) return { key: '', value: '', nextIndex: index + 1 };
  const eq = token.indexOf('=');
  if (eq !== -1) {
    return {
      key: token.slice(2, eq),
      value: token.slice(eq + 1),
      nextIndex: index + 1,
    };
  }
  return {
    key: token.slice(2),
    value: args[index + 1] ?? '',
    nextIndex: index + 2,
  };
}

function parseArgs(argv) {
  const options = {};
  let mode = 'local';
  let modeSet = false;

  for (let i = 0; i < argv.length;) {
    const token = argv[i];
    if (!token) {
      i += 1;
      continue;
    }
    if (!modeSet && (token === 'local' || token === 'public')) {
      mode = token;
      modeSet = true;
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      options.help = true;
      i += 1;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    const { key, value, nextIndex } = readOption(argv, i);
    if (!key) throw new Error(`Invalid option: ${token}`);
    options[key] = value;
    i = nextIndex;
  }

  return { mode, options };
}

function buildEnv(mode, options) {
  const env = { ...process.env };
  env.HOST = options.host || (mode === 'public' ? '0.0.0.0' : '127.0.0.1');
  env.PORT = options.port || env.PORT || '3003';

  if (Object.prototype.hasOwnProperty.call(options, 'api-key')) {
    env.API_KEY = options['api-key'];
  }
  if (Object.prototype.hasOwnProperty.call(options, 'dashboard-password')) {
    env.DASHBOARD_PASSWORD = options['dashboard-password'];
  }
  if (options['ls-binary-path']) env.LS_BINARY_PATH = options['ls-binary-path'];
  if (options['ls-data-dir']) env.LS_DATA_DIR = options['ls-data-dir'];
  if (options['workspace-dir']) env.WORKSPACE_DIR = options['workspace-dir'];

  return env;
}

function ensurePublicAuth(env) {
  if (env.HOST === '127.0.0.1' || env.HOST === 'localhost' || env.HOST === '::1' || env.HOST === '[::1]') {
    return;
  }
  if (env.API_KEY || env.DASHBOARD_PASSWORD) return;
  throw new Error(
    'Public mode requires API_KEY or DASHBOARD_PASSWORD. ' +
    'Use --api-key / --dashboard-password, or switch back to local mode.'
  );
}

function main() {
  const { mode, options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const env = buildEnv(mode, options);
  if (mode === 'public') ensurePublicAuth(env);

  const authSummary = [
    `apiKey=${env.API_KEY ? 'set' : 'empty'}`,
    `dashboardPassword=${env.DASHBOARD_PASSWORD ? 'set' : 'empty'}`,
  ].join(' ');
  console.log(`Starting WindsurfAPI mode=${mode} host=${env.HOST} port=${env.PORT} ${authSummary}`);

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });

  child.on('error', (error) => {
    console.error(`Failed to start WindsurfAPI: ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  printHelp();
  process.exit(1);
}
