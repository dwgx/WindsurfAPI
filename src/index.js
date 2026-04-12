// Logger must be imported first to patch log functions before other modules use them
import './dashboard/logger.js';
import { initAuth, isAuthenticated } from './auth.js';
import { startLanguageServer, waitForReady, isLanguageServerRunning, stopLanguageServer } from './langserver.js';
import { startServer } from './server.js';
import { config, log } from './config.js';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

export const BRAND = 'WindsurfAPI bydwgx1337';
export const VERSION = '1.2.0';

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

  // Start language server binary
  const binaryPath = config.lsBinaryPath;
  if (existsSync(binaryPath)) {
    try {
      // Wipe the workspace on every startup. If we don't, files created by
      // previous chat sessions (e.g. Claude "editing" config.yaml/lru_cache.py
      // via the baked-in Cascade tool prompts) persist and pollute the next
      // request — the model sees them at session init and starts narrating
      // edits to files the caller never mentioned.
      execSync('mkdir -p /opt/windsurf/data/db /tmp/windsurf-workspace && rm -rf /tmp/windsurf-workspace/* /tmp/windsurf-workspace/.[!.]* 2>/dev/null || true', { stdio: 'ignore' });
    } catch {}

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
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    server.close(() => {
      log.info('HTTP server closed, stopping language server');
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('Drain timeout, forcing exit');
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    }, 30_000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
