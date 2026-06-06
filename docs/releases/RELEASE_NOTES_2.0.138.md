# v2.0.138 - release gate, dashboard pagination, and memory guardrails

## What changed

- CI now runs the full top-level test suite through deterministic shards instead of reusing the bounded release gate.
- The release gate remains bounded, but now covers the files touched by this stabilization pass: response cache, dashboard syntax, native bridge docs, shard runner, proto trace, secret scan, release workflow, and version metadata.
- Modern dashboard proxy-account and abnormal-account tables now use paged account summaries instead of loading hundreds or thousands of rows in one request. The experimental sketch skin now uses lightweight summary rows for those two panels; its main account table still uses the full account payload because the inline detail editor depends on full fields.
- Native bridge documentation now states the safe default more explicitly: command tools remain the only mature production default; Read, Grep, Glob, WebSearch, and WebFetch stay protocol-lab gated until trace evidence is complete.
- SWE-1.6 is documented as a special-agent / ACP route, not a normal catalog-model fix.
- Response cache now has a byte budget (`RESPONSE_CACHE_MAX_BYTES` / `WINDSURFAPI_RESPONSE_CACHE_MAX_BYTES`, default 16 MiB). Values accept bytes or units such as `16m` / `1g`. Oversized entries are skipped, and old entries are evicted when total cached response bytes exceed the budget.

## Not changed

- Read `type=14 / field=19` reverse engineering is still not declared complete.
- WebFetch/WebSearch native LS executor support is still not production-open.
- SSE drain/backpressure handling remains a separate follow-up because it touches the streaming hot path.

## Validation

- `node --test test/cache.test.js`
- `node --test test/dashboard-syntax.test.js`
- `node --test test/native-bridge-docs.test.js`
- `node --test test/test-shard-script.test.js test/release-workflow.test.js`
- `npm.cmd run test:release`
