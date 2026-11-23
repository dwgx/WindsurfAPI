/**
 * DevIn panel — one truthful snapshot of the Devin surface the proxy can see.
 *
 * WHY: the Devin state is spread across four pages and two layers. The switches
 * live in Settings, LS/detach health on Overview, ACU on Usage, pricing in Model
 * Control, and per-account turns only inside the account drawer. During an
 * incident nobody can answer "what is Devin doing right now" in one screen.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO:
 *   - No upstream call. Every field is in-process state (config switches, the LS
 *     pool, the detached registry, the per-account billed-turn rings) or a
 *     cached upstream-derived summary (drought). The route is safe to open on a
 *     cold pool and costs no quota.
 *   - No invented sessions. Cascade trajectories live behind local-LS gRPC
 *     (`GetAllCascadeTrajectories` / `GetCascadeTranscriptForTrajectoryId`) and
 *     ACP runs are not registered anywhere, so both are reported as
 *     `available:false` WITH a machine-readable reason. An empty array would
 *     read as "no sessions", which is a different and false claim.
 *
 * The builders are pure: the route gathers inputs (auth/langserver/runtime
 * config) and passes them in, so every shape below is executable in a test
 * without a server, a token or a clock.
 */

/** Rows the panel renders for the fleet turn list (merged, newest first). */
export const TURN_ROW_CAP = 50;
export const TURN_PAGE_SIZES = Object.freeze([100, 200, 500, 1000]);
/** Per-account ring read. ACCOUNT_REQUEST_CAP is 100; read the whole ring so
 *  the last-hour tally is complete for the retained window, then slice for display. */
export const TURN_PER_ACCOUNT_LIMIT = 100;
/** "Recent" = the trailing hour, matching the connect-metrics copy. */
export const TURN_WINDOW_MS = 60 * 60 * 1000;
/** Accounts scanned per request. Sorted by lastUsed first, so the cap only
 *  drops accounts that have never served a turn. */
export const MAX_SCAN_ACCOUNTS = 500;

/** Effective-value rows the runtime card shows (same whitelist as
 *  GET /runtime-env-status — the credential-store switches stay read-only). */
export const RUNTIME_SWITCH_KEYS = Object.freeze([
  'devinConnect', 'devinOnly', 'devinCliMode', 'allowClientTools', 'loginHostFallback', 'autoRelogin',
]);

/** Quota/spend knobs from GET /quota-config (the only writer is PUT /quota-config). */
export const QUOTA_KNOB_KEYS = Object.freeze([
  'cooldownEnabled', 'cooldownMs', 'dryThreshold', 'spendOnDemand', 'onDemandReserveUsd',
]);

/** Machine-readable reasons a Devin source has no rows to show. The UI maps
 *  these to copy; it must never render them as zeros. */
export const SOURCE_REASONS = Object.freeze({
  /** Reachable only through the local language server's binary gRPC surface. */
  LS_ONLY: 'ls_only',
  /** Runs exist but no registry/counter keeps them after the turn ends. */
  NOT_TRACKED: 'not_tracked',
  /** Billed successes only: aborts/429s never reach spend accounting. */
  BILLED_ONLY: 'billed_successes_only',
  /** Process-local ring: a restart is a new window. */
  PROCESS_LOCAL: 'process_local',
});

const MAX_TEXT = 160;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const t = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function knobRow(key, tunables, overrides) {
  const override = overrides && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
  return {
    key,
    value: tunables && Object.prototype.hasOwnProperty.call(tunables, key) ? tunables[key] : null,
    override,
    // Same vocabulary as /runtime-env-status: "env" = no runtime-config
    // override (the effective value may still be a code default).
    source: override === null ? 'env' : 'config',
    overridden: override !== null,
  };
}

// ─── 1. Runtime ────────────────────────────────────────────────────────────

/**
 * Devin runtime: switches, credential-store boundary, LS pool, detach cache.
 *
 * @param {object} input
 * @param {number|null} [input.uptimeSec]
 * @param {number|null} [input.startedAt]
 * @param {object} [input.switches]  key → {value, override, source}
 * @param {boolean} [input.credStoreEnabled]
 * @param {boolean} [input.remoteCredStore]
 * @param {object|null} [input.langServer] getLsStatus()
 * @param {object|null} [input.detach]     {enabled, ...registry.stats()}
 */
export function buildRuntimeSection({
  uptimeSec = null,
  startedAt = null,
  switches = {},
  credStoreEnabled = false,
  remoteCredStore = false,
  langServer = null,
  detach = null,
} = {}) {
  const rows = RUNTIME_SWITCH_KEYS.map((key) => {
    const row = obj(switches[key]) || {};
    return {
      key,
      value: row.value ?? null,
      source: row.source === 'config' ? 'config' : 'env',
      overridden: row.override !== null && row.override !== undefined,
    };
  });
  const instances = Array.isArray(langServer?.instances) ? langServer.instances : [];
  const activeRequests = instances.reduce((n, i) => n + (num(i?.activeRequests) || 0), 0);
  const admission = obj(langServer?.admissionStats);
  const detachStats = obj(detach);
  const counters = detachStats ? { ...detachStats } : null;
  if (counters) {
    delete counters.enabled;
    delete counters.entries;
    delete counters.bytes;
    delete counters.draining;
  }
  return {
    uptimeSec: num(uptimeSec),
    startedAt: num(startedAt),
    switches: rows,
    credentials: {
      // The two credential-store switches are an env-only security boundary:
      // reported as presence booleans, never writable through the dashboard.
      credStoreEnabled: !!credStoreEnabled,
      remoteCredStore: !!remoteCredStore,
      writable: false,
    },
    langServer: {
      running: !!langServer?.running,
      pid: num(langServer?.pid),
      port: num(langServer?.port),
      instances: instances.length,
      ready: instances.filter((i) => i?.ready).length,
      activeRequests,
      totalRssBytes: num(langServer?.totalRssBytes),
      admission: admission
        ? {
            startAttempts: num(admission.startAttempts),
            startSuccesses: num(admission.startSuccesses),
            startFailures: num(admission.startFailures),
            poolWaits: num(admission.poolWaits),
            memoryWaits: num(admission.memoryWaits),
            poolExhausted: num(admission.poolExhausted),
            memoryGuardBlocks: num(admission.memoryGuardBlocks),
            evictions: num(admission.evictions),
            lastFailure: admission.lastFailure
              ? {
                  kind: str(admission.lastFailure.kind, 40),
                  errorType: str(admission.lastFailure.errorType, 60),
                  at: num(admission.lastFailure.at),
                }
              : null,
          }
        : null,
    },
    detach: detachStats
      ? {
          enabled: detachStats.enabled === true,
          entries: num(detachStats.entries),
          bytes: num(detachStats.bytes),
          draining: detachStats.draining === true,
          counters,
        }
      : { enabled: false, entries: null, bytes: null, draining: null, counters: null },
  };
}

// ─── 2. Sessions / trajectories ────────────────────────────────────────────

/**
 * Merge the per-account billed-turn rings into one fleet view.
 *
 * `accounts` is `[{id, ref, lastUsed}]` (ref = the dashboard hash, never the raw
 * account id or email). `readRequests(id, {limit})` is injected so the builder
 * stays pure; the route passes `getAccountRequests`. `totalAccounts` is the
 * pool size before the route's scan cap; when it exceeds the rows handed in,
 * the section reports `capped:true` so the UI can say "N / M" instead of
 * implying the whole pool was read.
 *
 * Totals come from each ring's own `summary` (whole retained window), while the
 * last-hour tally is computed over the rows we actually read. Reading the full
 * ring per account (TURN_PER_ACCOUNT_LIMIT === ACCOUNT_REQUEST_CAP) is what
 * makes that tally complete rather than a sample of the newest rows.
 */
export function buildTurnsSection({
  accounts = [],
  totalAccounts = null,
  readRequests = null,
  now = Date.now(),
  rowCap = TURN_ROW_CAP,
  page = 1,
  perAccount = TURN_PER_ACCOUNT_LIMIT,
  windowMs = TURN_WINDOW_MS,
} = {}) {
  const items = [];
  let retained = 0;
  let accountsWithTurns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let credit = 0;
  let acu = 0;
  let lastTs = 0;
  const window = { ms: windowMs, turns: 0, totalTokens: 0, credit: 0, acu: 0 };
  const cutoff = now - windowMs;
  const scan = Array.isArray(accounts) ? accounts : [];

  for (const acct of scan) {
    if (!acct || !acct.id || typeof readRequests !== 'function') continue;
    let page = null;
    try {
      page = readRequests(acct.id, { limit: perAccount });
    } catch {
      // A broken ring must not fail the whole panel; the account simply
      // contributes no rows and stays counted in `scanned`.
      continue;
    }
    if (!page) continue;
    const sum = obj(page.summary) || {};
    const ringTotal = num(sum.requests) || 0;
    if (ringTotal > 0) {
      accountsWithTurns++;
      retained += ringTotal;
      promptTokens += num(sum.promptTokens) || 0;
      completionTokens += num(sum.completionTokens) || 0;
      totalTokens += num(sum.totalTokens) || 0;
      credit += num(sum.credit) || 0;
      acu += num(sum.acu) || 0;
      lastTs = Math.max(lastTs, num(sum.lastTs) || 0);
    }
    const rows = Array.isArray(page.items) ? page.items : [];
    for (const row of rows) {
      if (!row || !Number.isFinite(row.ts)) continue;
      // This section is "billed turns": the shared ring also retains failed
      // attempts (billed:false), which carry zero cost and must not inflate the
      // last-hour turn count or the rendered turn table.
      if (row.billed === false) continue;
      const entry = {
        ts: row.ts,
        accountRef: str(acct.ref, 40),
        model: str(row.model, 120),
        promptTokens: num(row.promptTokens),
        completionTokens: num(row.completionTokens),
        totalTokens: num(row.totalTokens),
        credit: num(row.credit),
        acu: num(row.acu),
      };
      items.push(entry);
      if (row.ts >= cutoff) {
        window.turns++;
        window.totalTokens += entry.totalTokens || 0;
        window.credit += entry.credit || 0;
        window.acu += entry.acu || 0;
      }
    }
  }

  items.sort((a, b) => b.ts - a.ts);
  const size = Math.max(0, Math.min(TURN_PAGE_SIZES.at(-1), Math.trunc(Number(rowCap) || 0)));
  const pages = size > 0 ? Math.max(1, Math.ceil(items.length / size)) : 1;
  const number = Math.min(pages, Math.max(1, Math.trunc(Number(page) || 1)));
  const offset = (number - 1) * size;
  const pageItems = items.slice(offset, offset + size);
  const scanned = scan.length;
  const total = num(totalAccounts);
  return {
    available: true,
    scanned,
    // The scan is bounded. Reporting only `scanned` would let a 500-account
    // cap read as "the whole pool was checked", so the unfiltered count and a
    // flag ride along; the UI says "N / M" and names the cap when it bites.
    totalAccounts: total == null ? scanned : total,
    capped: total != null && total > scanned,
    accountsWithTurns,
    retained,
    perAccountLimit: perAccount,
    summary: { promptTokens, completionTokens, totalTokens, credit, acu, lastTs: lastTs || null },
    window,
    shown: pageItems.length,
    page: { number, size, pages, offset, total: items.length, sizes: TURN_PAGE_SIZES },
    items: pageItems,
  };
}

/**
 * The session source table. `proxyTurns` is the only available source; the
 * other two are named so the panel can say WHY, not just show nothing.
 */
export function buildSessionSources() {
  return [
    {
      id: 'proxyTurns',
      available: true,
      scope: 'process',
      notes: [SOURCE_REASONS.BILLED_ONLY, SOURCE_REASONS.PROCESS_LOCAL],
    },
    {
      id: 'cascadeTrajectories',
      available: false,
      reason: SOURCE_REASONS.LS_ONLY,
      rpcs: [
        'LanguageServerService/GetAllCascadeTrajectories',
        'LanguageServerService/GetCascadeTranscriptForTrajectoryId',
        'LanguageServerService/GetCascadeTrajectorySteps',
      ],
    },
    {
      id: 'acpSessions',
      available: false,
      reason: SOURCE_REASONS.NOT_TRACKED,
    },
  ];
}

/** Compose the sessions section: real turns + the source table. */
export function buildSessionsSection({ turns = null, sources = buildSessionSources() } = {}) {
  return {
    sources,
    turns: turns || buildTurnsSection(),
  };
}

// ─── 3. Quota & spend policy ───────────────────────────────────────────────

/**
 * Quota snapshot: the drought decision and its inputs (all cached/local), plus
 * the quota/spend knobs the settings page does not surface.
 */
export function buildQuotaSection({ drought = null, tunables = null, overrides = null } = {}) {
  const d = obj(drought) || {};
  return {
    drought: {
      active: d.drought === true,
      threshold: num(d.threshold),
      activeAccounts: num(d.activeAccounts),
      knownAccounts: num(d.knownAccounts),
      quotaKnownAccounts: num(d.quotaKnownAccounts),
      droughtAccounts: num(d.droughtAccounts),
      coverageMet: d.coverageMet === true,
      lowestWeeklyPercent: num(d.lowestWeeklyPercent),
      lowestDailyPercent: num(d.lowestDailyPercent),
      restrictEnabled: d.restrictEnabled === true,
      restrictionFailOpen: d.restrictionFailOpen === true,
      freeTierModels: Array.isArray(d.freeTierModels)
        ? d.freeTierModels.map((m) => str(m, 120)).filter(Boolean).slice(0, 40)
        : [],
    },
    knobs: QUOTA_KNOB_KEYS.map((key) => knobRow(key, tunables, overrides)),
  };
}

// ─── Aggregate ─────────────────────────────────────────────────────────────

/**
 * Assemble the panel payload from already-built sections. Keeping this a thin
 * wrapper (instead of one mega-builder) lets each section be tested alone.
 */
export function buildDevinPanel({ now = Date.now(), runtime = null, sessions = null, quota = null } = {}) {
  return {
    ok: true,
    generatedAt: now,
    runtime: runtime || buildRuntimeSection(),
    sessions: sessions || buildSessionsSection(),
    quota: quota || buildQuotaSection(),
  };
}
