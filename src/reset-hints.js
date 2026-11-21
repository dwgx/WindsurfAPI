// A transient reset hint describes when to retry this request. Quota snapshots
// describe a different clock and can legitimately span a weekly billing period.
export const MAX_RATE_RESET_MS = 6 * 60 * 60 * 1000;
export const MAX_QUOTA_RESET_MS = 8 * 24 * 60 * 60 * 1000;

export function quotaResetDelay(credits, period, now) {
  if (!credits || credits.lastError || !['daily', 'weekly'].includes(period)) return null;
  // REST reset timestamps are Unix seconds. The newer Connect plan status
  // contributes Unix milliseconds under the historical periodStart/End names.
  const seconds = period === 'weekly' ? credits.weeklyResetAt : credits.dailyResetAt;
  const millis = period === 'weekly' ? credits.periodEnd : credits.periodStart;
  for (const timestamp of [Number.isSafeInteger(seconds) ? seconds * 1000 : null, millis]) {
    if (!Number.isSafeInteger(timestamp)) continue;
    const delay = timestamp - now;
    if (delay > 0 && delay <= MAX_QUOTA_RESET_MS) return delay;
  }
  return null;
}

export function boundResetMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_RATE_RESET_MS) : null;
}

export function resetSecondsToMs(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(Math.min(seconds, MAX_RATE_RESET_MS / 1000) * 1000);
}

export function retryAfterHeaderMs(value, now = Date.now()) {
  if (value == null) return null;
  const text = String(value).trim();
  const seconds = resetSecondsToMs(text);
  if (seconds !== null) return seconds;
  // An HTTP-date starts with a weekday. Date.parse also accepts strings such
  // as "-2" as calendar dates, which would turn a malformed hint into zero.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? boundResetMs(Math.max(0, at - now)) : null;
}

const durationUnits = { h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, 'µs': 0.001, 'μs': 0.001, ns: 0.000001 };

export function parseGoResetMs(text) {
  const match = /\bresets?\s+in\s*:?\s*((?:\d+(?:\.\d+)?\s*(?:ms|us|µs|μs|ns|h|m|s)\s*)+)(?!\w|\.\d)/iu.exec(String(text || ''));
  if (!match) return null;
  let total = 0;
  for (const [, number, unit] of match[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|us|µs|μs|ns|h|m|s)/giu)) {
    total = Math.min(MAX_RATE_RESET_MS, total + Number(number) * durationUnits[unit.toLowerCase()]);
  }
  return total > 0 ? Math.ceil(total) : null;
}
