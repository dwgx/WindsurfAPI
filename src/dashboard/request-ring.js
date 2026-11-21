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
 * server request ids are random. The cursor is an opaque base64url of
 * `s:${seq}`; legacy `${ts}:${id}` cursors are still accepted while their row
 * remains in the ring. This is a process-local snapshot and resets on restart.
 */

import { createHash } from 'node:crypto';

const CAP = 2000;
const rows = [];
const rowSeq = [];
let next = 0;
let count = 0;
let seq = 0;
let tick = 0;

function callerRef(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function encodeCursor(recordSeq) {
  return Buffer.from(`s:${recordSeq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    if (raw.startsWith('s:')) {
      const value = Number(raw.slice(2));
      if (!Number.isSafeInteger(value) || value < 0) return null;
      return { seq: value };
    }
    const idx = raw.indexOf(':');
    if (idx <= 0) return null;
    const ts = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(ts) || !id) return null;
    return { ts, id };
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
 * Resolve a legacy `${ts}:${id}` cursor to the newest matching row's recording
 * sequence. Returns null once that row has been evicted.
 */
function anchorSeqForLegacy(anchor) {
  for (let i = 0; i < count; i++) {
    const idx = ringIndex(i);
    const row = rows[idx];
    if (row && row.ts === anchor.ts && row.id === anchor.id) return rowSeq[idx];
  }
  return null;
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
  rows[next] = entry;
  rowSeq[next] = ++tick;
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
  let anchorSeq = anchor && anchor.seq != null ? anchor.seq : null;
  let legacy = null;
  if (anchor && anchor.seq == null) {
    anchorSeq = anchorSeqForLegacy(anchor);
    // Evicted legacy anchor: fall back to the old (ts,id) predicate rather than
    // restarting the page from the newest row.
    if (anchorSeq == null) legacy = anchor;
  }
  const out = [];
  let lastSeq = null;
  for (let i = 0; i < count; i++) {
    const idx = ringIndex(i);
    const row = rows[idx];
    if (!row) continue;
    if (anchorSeq != null && !(rowSeq[idx] < anchorSeq)) continue;
    if (legacy && !(row.ts < legacy.ts || (row.ts === legacy.ts && row.id < legacy.id))) continue;
    if (filter.model && row.model !== filter.model) continue;
    if (filter.status != null && row.status !== Number(filter.status)) continue;
    if (filter.class && row.class !== filter.class) continue;
    out.push(row);
    lastSeq = rowSeq[idx];
    if (out.length >= n) break;
  }
  return {
    items: out,
    nextCursor: out.length === n ? encodeCursor(lastSeq) : null,
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
  rowSeq.length = 0;
  next = 0;
  count = 0;
  seq = 0;
  tick = 0;
}
