# v2.0.132

- Added dedicated proto trace summaries for the Read `type=14` / `field=19`
  wrapper. Traces now expose `semantic.steps[].readWrapperField19` with child
  field numbers, byte lengths, hashes, and safe `looksPathLike` /
  `looksPromptLike` classifications. Raw previews stay off by default and
  require `WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_STRINGS=1` for gated lab runs.
- Kept Read promotion conservative. v2.0.131's path guard remains the runtime
  boundary; nested wrapper fields are not promoted until live traces confirm the
  schema.
- Added coverage for generic `BUILD_*` health metadata. The VPS deployment can
  inject `WINDSURFAPI_BUILD_VERSION`, `WINDSURFAPI_BUILD_COMMIT`, commit
  message/date, and branch through `.env` so `/health` reports the deployed
  revision. Automatic GHCR build-arg wiring still requires a workflow-scope
  GitHub token and is intentionally left out of this tag.
- Added `npm run smoke:special-agent` for the SWE/Devin special-agent POC. The
  smoke preflights `/health?verbose=1`, sends a text-only `swe-1.6-fast`
  request, and refuses to run unless the backend is explicitly enabled.
- WebSearch remains on the direct `GetWebSearchResults` probe path, and
  WebFetch has no guessed direct endpoint. LS-native WebSearch/WebFetch stay
  out of the production native bridge defaults.

Verification:

- `node --check src/proto-trace.js`
- `node --check scripts/special-agent-smoke.mjs`
- `node --test test/proto-trace.test.js test/native-read-wrapper.test.js test/version.test.js test/special-agent-smoke.test.js test/docker-script-packaging.test.js test/web-search-direct-probe.test.js`
