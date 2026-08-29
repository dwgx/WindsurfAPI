/**
 * OrcaRouter — OpenAI-compatible AI gateway provider (https://www.orcarouter.ai).
 *
 * Unlike the Windsurf/Devin backends (Cascade, Devin CLI, Devin Connect), an
 * OrcaRouter request is not translated into the Windsurf gRPC protocol. It is
 * forwarded verbatim to https://api.orcarouter.ai/v1 with the operator's own
 * ORCAROUTER_API_KEY, and the OpenAI-compatible response (JSON or SSE) is
 * streamed straight back to the caller.
 *
 * Routing decision lives in chat.js: a resolved model whose catalog entry has
 * provider:'orcarouter' short-circuits the Windsurf backends entirely. See
 * src/models.js for the registered `orcarouter/*` model ids.
 */

import https from 'https';

const ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1';
const ORCAROUTER_CHAT_PATH = '/chat/completions';

// Transport seam: defaults to https.request. Swappable in tests so the request
// path can be exercised without a real socket. Mirrors the __setCatalogRequestImpl
// seam in devin-connect-catalog.js.
let requestImpl = https.request;
export function __setOrcaRouterRequestImpl(fn) { requestImpl = fn || https.request; }

/** Whether the resolved model info routes through the OrcaRouter gateway. */
export function isOrcaRouterModel(modelInfo) {
  return modelInfo?.provider === 'orcarouter';
}

/** Operator-configured OrcaRouter API key (ORCAROUTER_API_KEY). Empty if unset. */
export function orcaRouterApiKey(env = process.env) {
  return String(env.ORCAROUTER_API_KEY || '').trim();
}

/**
 * Forward one /v1/chat/completions request to OrcaRouter.
 *
 * Resolves with the upstream HTTP status and raw response body for BOTH success
 * and error responses, so the caller can relay OpenAI-shaped error bodies
 * verbatim. Streamed SSE comes back as an opaque Buffer — the caller decides how
 * to relay it. Rejects only on transport errors (network, timeout, abort).
 *
 * @param {object} body       parsed JSON request body (model, messages, …)
 * @param {object} [opts]
 * @param {string} [opts.apiKey]  ORCAROUTER_API_KEY value
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{status:number, body:Buffer}>}
 */
export function forwardChatCompletions(body, { apiKey = null, signal = null } = {}) {
  const key = apiKey || orcaRouterApiKey();
  if (!key) {
    return Promise.reject(new Error('ORCAROUTER_API_KEY is not set. Configure it to use orcarouter/* models.'));
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(ORCAROUTER_BASE_URL + ORCAROUTER_CHAT_PATH);
    const reqOpts = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': body.stream ? 'text/event-stream' : 'application/json',
        'User-Agent': 'windsurf-api',
      },
    };

    const req = requestImpl(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Resolve with the upstream status and body for BOTH success and error
        // responses so the caller can relay 4xx/5xx bodies verbatim (OpenAI
        // error shapes carry useful `type`/`code` fields).
        resolve({ status: res.statusCode, body: buf });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(240_000, () => req.destroy(new Error('OrcaRouter upstream timeout')));
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.write(payload);
    req.end();
  });
}
