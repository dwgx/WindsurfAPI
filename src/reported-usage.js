// An internal carrier for provider counts before the public usage object is
// defaulted or estimated. It must not appear in protocol payloads.
export const REPORTED_USAGE = Symbol('reported token usage');

export function markReportedUsage(usage, report) {
  return Object.defineProperty(usage, REPORTED_USAGE, { value: report });
}

export function tokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
