/**
 * Single-slot registry for the live HTTP server instance.
 *
 * The server is created in index.js's main() and isn't otherwise reachable
 * from the dashboard API handlers (api.js). The dashboard-triggered restart and
 * self-update paths need the server handle to drain in-flight requests before
 * exiting, so index.js registers it here at startup and api.js reads it back.
 *
 * Mirrors sse-registry.js: a plain module-level slot, no dependencies.
 */

let activeServer = null;

export function registerServer(server) {
  activeServer = server || null;
  return () => { if (activeServer === server) activeServer = null; };
}

export function getActiveServer() {
  return activeServer;
}
