// Logger must be imported first to patch log functions before other modules use them
import './dashboard/logger.js';
import { emitNoAuthWarnings, initAuth, isAuthenticated, saveAccountsSync, shouldRejectInsecureExternalBind } from './auth.js';
import { startLanguageServer, waitForReady, isLanguageServerRunning, stopLanguageServer } from './langserver.js';
import { startServer } from './server.js';
import { config, log } from './config.js';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { VERSION, BRAND } from './version.js';
import { abortActiveSse } from './sse-registry.js';
export { VERSION, BRAND };

function resetWorkspace() {
  const wsBase = config.workspaceDir;
  try {
    mkdirSync(wsBase, { recursive: true });
    for (const name of readdirSync(wsBase)) {
      rmSync(join(wsBase, name), { recursive: true, force: true });
    }
  } catch {}
  try {
    mkdirSync(join(config.lsDataDir, 'db'), { recursive: true });
  } catch {}
}

async function main() {
  const banner = `
   _    _ _           _                   __    _    ____ ___
  | |  | (_)         | |                 / _|  / \\  |  _ \\_ _|
  | |  | |_ _ __   __| |___ _   _ _ __ _| |_  / _ \\ | |_) | |
  | |/\\| | | '_ \\ / _\` / __| | | | '__|_   _|/ ___ \\|  __/| |
  \\  /\\  / | | | | (_| \\__ \\ |_| | |    |_| /_/   \\_\\_|  |___|
   \\/  \\/|_|_| |_|\\__,_|___/\\__,_|_|
                                          ${BRAND} v${VERSION}
`;
  console.log(banner);
  console.log(`  OpenAI-compatible proxy for Windsurf — by dwgx1337\n`);
  if (shouldRejectInsecureExternalBind(config.host)) {
    log.error(`Refusing to start with HOST=${config.host} while API_KEY and DASHBOARD_PASSWORD are both empty.`);
    log.error('Set HOST=127.0.0.1 for local-only mode, or configure API_KEY / DASHBOARD_PASSWORD before external bind.');
    process.exit(1);
  }
  emitNoAuthWarnings(config.host);

  // Start language server binary.
  // Auto-install if missing — users repeatedly miss the manual install step
  // and open "request crashes" issues (see #18), so we just do it ourselves.
  // Skipped when install-ls.sh isn't present.
  const binaryPath = config.lsBinaryPath;
  const canAutoInstallLs = process.platform === 'linux' || process.platform === 'darwin';
  if (!existsSync(binaryPath) && canAutoInstallLs) {
    const scriptPath = (() => {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        return join(here, '..', 'install-ls.sh');
      } catch { return null; }
    })();
    if (scriptPath && existsSync(scriptPath)) {
      log.info(`Language server binary missing at ${binaryPath}`);
      log.info(`Auto-installing via ${scriptPath} — this runs once.`);
      try {
        execSync(`bash "${scriptPath}"`, {
          stdio: 'inherit',
          env: { ...process.env, LS_INSTALL_PATH: binaryPath },
        });
        log.info('Language server binary installed.');
      } catch (err) {
        log.error(`Auto-install failed: ${err.message}`);
        log.error('Run manually:  bash install-ls.sh  (or set LS_BINARY_PATH to point at an existing binary)');
      }
    }
  }

  if (existsSync(binaryPath)) {
    // Reset LS workspace each startup; using Node fs APIs keeps this
    // cross-platform and avoids Linux-specific shell assumptions.
    resetWorkspace();

    await startLanguageServer({
      binaryPath,
      port: config.lsPort,
      apiServerUrl: config.codeiumApiUrl,
    });

    try {
      await waitForReady(15000);
    } catch (err) {
      log.error(`Language server failed to start: ${err.message}`);
      log.error('Chat completions will not work without the language server.');
    }
  } else {
    log.warn(`Language server binary not found at ${binaryPath}`);
    log.warn('Install it with: download Windsurf Linux tarball and extract language_server_linux_x64');
  }

  // Init auth pool
  await initAuth();

  if (!isAuthenticated()) {
    log.warn('No accounts configured. Add via:');
    log.warn('  POST /auth/login {"token":"..."}');
    log.warn('  POST /auth/login {"api_key":"..."}');
  }

  const server = startServer();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const inflight = server.getActiveRequests?.() ?? '?';
    log.info(`${signal} received — draining ${inflight} in-flight requests (up to 30s)...`);
    const abortedSse = abortActiveSse('server shutting down');
    if (abortedSse) log.warn(`Aborted ${abortedSse} active SSE stream(s): server shutting down`);
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    server.close(() => {
      log.info('HTTP server closed, flushing state + stopping language server');
      // Persist any in-memory account updates (capability probes, error
      // counts, rate-limit cooldowns) before PM2 restarts us. Debounced
      // saves would otherwise be killed by the exit below.
      try { saveAccountsSync(); } catch {}
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('Drain timeout, forcing exit');
      try { saveAccountsSync(); } catch {}
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    }, 30_000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
