# v2.0.137 - dashboard pagination and protocol trace evidence

## What changed

- Dashboard accounts now load a lightweight paged summary list instead of the full heavy account payload.
- Account row expansion and model block editing now lazy-load one full account detail via `GET /dashboard/api/accounts/:id`.
- The abnormal accounts panel now loads only flagged summary rows and uses server-side account stats.
- Added safe Read wrapper trace evidence for `type=14 / field=19`: accepted field, path-like fields, prompt-like rejected fields, and ambiguity, without raw path or prompt text by default.
- Added WebFetch trajectory branch evidence for pending permission, completed `web_document`, auto-run-only, legacy-summary-only, and permission/precondition error states.
- Replaced real-looking email/password examples in `docs/releases/RELEASE_NOTES_2.0.39.md` with non-login placeholders.
- Added `scripts/secret-scan.mjs` and `npm run secret-scan` for tracked-file secret scanning.
- Secret scan findings print only `path:line rule`; matched secret values are never printed.
- Added regression tests for secret-scan output redaction and release workflow ordering.
- Release workflow now runs a bounded release test gate first, makes Docker depend on tests, and makes GitHub Release depend on Docker.
- CI now uses the same bounded release gate; `npm test` remains the local full-suite entry point.
- Docker builds now receive `BUILD_VERSION`, `BUILD_COMMIT`, `BUILD_COMMIT_MESSAGE`, `BUILD_COMMIT_DATE`, and `BUILD_BRANCH`.

## Validation

- `npm.cmd run secret-scan`
- `npm.cmd run test:release`
- `node --test test/dashboard-api.test.js`
- `node --test test/proto-trace.test.js`
- `node --test test/secret-scan.test.js test/release-workflow.test.js`
- `node --test test/*.test.js`
