## v2.0.103 - LS admission telemetry

This release adds the missing observability around Language Server pool
admission. It does not change the pool policy; it makes pool pressure,
memory-guard decisions, and recent admission failures visible before they turn
into guesswork.

### LSP scheduling visibility

- `/health?verbose=1` and the dashboard overview now expose a structured
  `lsPool.pool` summary with occupancy, ready/starting/pending/stopping counts,
  active request count, idle-eviction availability, and the current non-default
  spawn block reason.
- `lsPool.admissionStats` records start attempts, successes, failures, pool
  waits, memory-guard waits, pool exhaustion, memory-guard blocks, and recent
  eviction/failure/wait events.
- The dashboard LS pool cards now show a compact Pool / Guard / Last event line
  so operators can see whether new proxy-isolated LS instances are blocked by
  pool capacity, memory headroom, or a real startup failure.

### Guardrails

- Admission telemetry is sanitized: it records LS keys, process ids, counters,
  timestamps, and error codes/messages, but not account secrets or proxy
  credentials.
- Account-level admission remains lightweight; the full pool summary is exposed
  once through overview/health instead of duplicated for every account row.
- Tests now assert that LS status includes pool/admission telemetry and that
  dashboard i18n remains clean.
