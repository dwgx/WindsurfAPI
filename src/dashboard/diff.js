/**
 * Minimal line diff — pure functions, zero dependency (no diff library).
 *
 * Used by the dashboard's "show what will change before you save" gate on
 * dangerous writes (runtime-config / accounts.json / tunables). We render the
 * additions/deletions in a confirm modal so an operator sees the exact change
 * before it commits.
 *
 * INLINE MIRROR: index.html inlines an equivalent copy (single-file constraint);
 * src/dashboard/check-inline-sync.js keeps them in sync. Edit both.
 *
 * Algorithm: classic LCS (longest common subsequence) over lines, then walk the
 * DP table to emit a unified add/del/context sequence. O(n*m) — fine for config
 * blobs (tens–hundreds of lines), never fed megabytes.
 */

// Normalize any value to an array of display lines. Objects → pretty JSON.
export function toLines(value) {
  if (value == null) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.split('\n');
}

// Compute a line diff. Returns [{ op:'ctx'|'add'|'del', text }] in order.
export function lineDiff(before, after) {
  const a = toLines(before);
  const b = toLines(after);
  const n = a.length, m = b.length;
  // LCS DP table: lcs[i][j] = LCS length of a[i:] and b[j:].
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'ctx', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: 'del', text: a[i] }); i++; }
    else { out.push({ op: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ op: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ op: 'add', text: b[j] }); j++; }
  return out;
}

// Convenience: is there any real change? (used to skip the modal on no-op saves)
export function hasChange(before, after) {
  return lineDiff(before, after).some(d => d.op !== 'ctx');
}

// Summary counts for a one-line "+X / -Y" header.
export function diffStat(before, after) {
  let add = 0, del = 0;
  for (const d of lineDiff(before, after)) {
    if (d.op === 'add') add++;
    else if (d.op === 'del') del++;
  }
  return { add, del };
}
