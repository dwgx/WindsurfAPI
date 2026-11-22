/**
 * Normalize the app.devin.ai billing reads into one dashboard payload.
 *
 * Pure and defensive: the upstream shape is FastAPI JSON, but a missing field
 * must degrade to null rather than NaN or a thrown render error.
 */

function num(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value, fallback = null) {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value) {
  return typeof value === 'string' && value ? value : null;
}

/** Clamp a percentage to 0–100. Non-numbers stay null (no string coercion). */
export function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/**
 * Render an ACU limit. `null` means unlimited (the upstream sends null, never 0),
 * so it must render as ∞ rather than as a zero budget.
 */
export function formatAcuLimit(value) {
  if (value === null || value === undefined) return '∞';
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return String(value);
}

/**
 * Milliseconds until an ISO reset timestamp, or null when the timestamp is
 * missing/invalid. `Date.parse` honours the embedded offset, so the countdown
 * does not depend on the browser's local timezone.
 */
export function resetCountdown(resetAt, now = Date.now()) {
  if (typeof resetAt !== 'string') return null;
  const at = Date.parse(resetAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

function normalizeDays(days) {
  if (!Array.isArray(days)) return [];
  return days.slice(0, 366).map((day) => ({
    date: str(day?.date),
    // A row exists only when the upstream sent a date. `amount`/`cumulative`
    // may still be absent on that row: unknown is null, never a fabricated 0.
    amount: num(day?.amount),
    cumulative: num(day?.cumulative),
  })).filter((day) => day.date);
}

export function normalizeUsage({ quota, status, limits, dailyUsage, now = Date.now() } = {}) {
  const q = quota && typeof quota === 'object' ? quota : {};
  const s = status && typeof status === 'object' ? status : {};
  const l = limits && typeof limits === 'object' ? limits : {};
  const d = dailyUsage && typeof dailyUsage === 'object' ? dailyUsage : {};
  const days = normalizeDays(d.days);
  const products = Array.isArray(d.products)
    ? d.products.slice(0, 12).map((product) => ({
      view: str(product?.view),
      total: num(product?.total),
      days: normalizeDays(product?.days),
    })).filter((product) => product.view)
    : [];

  return {
    plan: str(s.plan_slug),
    billingValid: bool(s.is_subscription_valid),
    billingMethod: str(s.billing_method),
    availableCredits: num(s.available_credits),
    // Signed on-demand (overage) balance in USD, passed through verbatim. A
    // negative value is a real overdraft (usage posted beyond the prepaid
    // amount), not a rounding error and not an "unknown" sentinel; the panel
    // renders it with its sign instead of clamping it to zero.
    overageCredits: num(s.overage_credits),
    quota: {
      isQuotaPlan: bool(q.is_quota_plan),
      hasAllocation: bool(q.has_quota_allocation),
      // Devin's usage endpoint reports consumed percentages. Account status
      // carries separate remaining percentages from the plan-status endpoint.
      dailyPercentage: clampPercent(q.daily_percentage),
      weeklyPercentage: clampPercent(q.weekly_percentage),
      dailyResetAt: str(q.daily_reset_at),
      weeklyResetAt: str(q.weekly_reset_at),
      overageBalance: num(q.overage_balance),
      hideDailyQuota: bool(q.hide_daily_quota),
    },
    limits: {
      maxAcuLimit: num(l.max_acu_limit),
      maxTotalSessionAcuLimit: num(l.max_total_session_acu_limit),
    },
    cycle: {
      start: str(d.cycle_start),
      end: str(d.cycle_end),
      previousAvailable: bool(d.previous_cycle_available),
      // `null` when the daily-usage read did not carry a total: a cycle total of
      // 0 would assert "no ACU spent this cycle", which is the fabricated-zero
      // class this payload exists to avoid. A real reported 0 stays 0.
      total: num(d.total),
    },
    days,
    products,
    reset: {
      dailyInMs: resetCountdown(q.daily_reset_at, now),
      weeklyInMs: resetCountdown(q.weekly_reset_at, now),
    },
    serverNow: now,
  };
}
