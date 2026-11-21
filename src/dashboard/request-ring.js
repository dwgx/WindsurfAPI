/**
 * Bounded request ring for dashboard troubleshooting.
 *
 * One row per completed /v1/chat/completions call. The ring is deliberately
 * metadata-only: no headers, no prompt text, no upstream body. Callers are
 * identified by a short hash so an operator can correlate repeated requests
 * without the dashboard retaining an API key.
 *
 * Pages are ordered by recording sequence, not by `(ts,id)`: concurrent
 * completions can share a millisecond or land out of timestamp order, and
 * server request ids are random. Each cursor carries the ring instance id plus
 * the last returned row's insertion serial, so a cursor from another process
 * (or from before a reset) is recognized as expired and yields an empty page
 * instead of being replayed against unrelated newer rows. Legacy `${ts}:${id}`
 * cursors are still accepted while their row remains in the ring. This is a
 * process-local snapshot and resets on restart.
 */

import { createHash, randomUUID } from 'node:crypto';

const CAP = 2000;
const rows = [];
let next = 0;
let count = 0;
let seq = 0;
let tick = 0;
let ringId = randomUUID();

function callerRef(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function encodeCursor(serial) {
  return Buffer.from(`s:${ringId}:${serial}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    if (raw.startsWith('s:')) {
      const rest = raw.slice(2);
      const split = rest.indexOf(':');
      if (split < 0) {
        // Cursor from the pre-identity revision (`s:<serial>`). It is a
        // recognized cursor but cannot prove it belongs to this ring, so it is
        // treated as expired rather than replayed as a fresh first page.
        if (!/^\d+$/.test(rest)) return null;
        const serial = Number(rest);
        if (!Number.isSafeInteger(serial)) return null;
        return { kind: 'seq', ring: null, serial };
      }
      const ring = rest.slice(0, split);
      const serialText = rest.slice(split + 1);
      if (!ring || !/^\d+$/.test(serialText)) return null;
      const serial = Number(serialText);
      if (!Number.isSafeInteger(serial)) return null;
      return { kind: 'seq', ring, serial };
    }
    const idx = raw.indexOf(':');
    if (idx <= 0) return null;
    const ts = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(ts) || !id) return null;
    return { kind: 'legacy', ts, id };
  } catch {
    return null;
  }
}

/** Array index of the i-th newest row (0 = newest). */
function ringIndex(i) {
  const start = count < CAP ? 0 : next;
  return (start + count - 1 - i) % CAP;
}

/**
 * Resolve a legacy `${ts}:${id}` cursor to the newest matching row's insertion
 * serial. Returns null once that row has been evicted: no ordinal survives an
 * overwrite, so the cursor cannot be continued without exposing newer rows.
 */
function anchorSerialForLegacy(anchor) {
  for (let i = 0; i < count; i++) {
    const row = rows[ringIndex(i)];
    if (row && row.ts === anchor.ts && row.id === anchor.id) return tick - i;
  }
  return null;
}

function emptyPage() {
  return { items: [], nextCursor: null, total: count, capacity: CAP };
}

/** Record one completed request. `row` is copied; unknown fields are dropped. */
export function recordRequest(row = {}) {
  const id = String(row.id || `ring_${++seq}`);
  const entry = {
    id,
    ts: Number.isFinite(row.ts) ? row.ts : Date.now(),
    model: typeof row.model === 'string' ? row.model.slice(0, 200) : null,
    selector: typeof row.selector === 'string' ? row.selector.slice(0, 200) : null,
    status: Number.isFinite(row.status) ? row.status : null,
    stream: !!row.stream,
    durationMs: Number.isFinite(row.durationMs) ? Math.max(0, Math.round(row.durationMs)) : null,
    class: typeof row.class === 'string' ? row.class.slice(0, 80) : null,
    protocol: typeof row.protocol === 'string' ? row.protocol.slice(0, 32) : null,
    caller: callerRef(row.caller),
  };
  tick += 1;
  rows[next] = entry;
  next = (next + 1) % CAP;
  count = Math.min(count + 1, CAP);
  return entry;
}

/**
 * Patch an existing row in place (used by streaming routes after the handler
 * finishes). Only the fields the ring owns are copied; unknown fields are
 * ignored. Returns the row or null when the id is no longer in the ring.
 */
export function updateRequest(id, patch = {}) {
  const key = String(id || '');
  if (!key) return null;
  const row = rows.find((r) => r && r.id === key);
  if (!row) return null;
  if (Number.isFinite(patch.durationMs)) row.durationMs = Math.max(0, Math.round(patch.durationMs));
  if (Number.isFinite(patch.status)) row.status = patch.status;
  if (typeof patch.class === 'string') row.class = patch.class.slice(0, 80);
  if (typeof patch.stream === 'boolean') row.stream = patch.stream;
  return row;
}

/** Newest-first page. `filter` supports model/status/class exact matches. */
export function listRequests({ cursor = null, limit = 50, filter = {} } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const anchor = decodeCursor(cursor);
  let after = null;
  if (anchor && anchor.kind === 'seq') {
    // Foreign instance (another process or a pre-reset ring) or a serial that
    // this ring never issued: the history it refers to is gone. Return empty
    // instead of replaying newer rows as if they were the continuation.
    if (anchor.ring !== ringId || anchor.serial > tick) return emptyPage();
    after = anchor.serial;
  } else if (anchor) {
    after = anchorSerialForLegacy(anchor);
    if (after == null) return emptyPage();
  }
  const out = [];
  let lastSerial = null;
  for (let i = 0; i < count; i++) {
    // Resident rows are exactly the serials tick, tick-1, ... tick-count+1.
    const serial = tick - i;
    if (after != null && serial >= after) continue;
    const row = rows[ringIndex(i)];
    if (!row) continue;
    if (filter.model && row.model !== filter.model) continue;
    if (filter.status != null && row.status !== Number(filter.status)) continue;
    if (filter.class && row.class !== filter.class) continue;
    out.push(row);
    lastSerial = serial;
    if (out.length >= n) break;
  }
  return {
    items: out,
    nextCursor: out.length === n ? encodeCursor(lastSerial) : null,
    total: count,
    capacity: CAP,
  };
}

export function requestRingStats() {
  return { total: count, capacity: CAP };
}

/** Test seam: empty the ring without touching production state. */
export function __resetRequestRingForTest() {
  rows.length = 0;
  next = 0;
  count = 0;
  seq = 0;
  tick = 0;
  // A reset models a restart: cursors issued before it must not replay.
  ringId = randomUUID();
}
