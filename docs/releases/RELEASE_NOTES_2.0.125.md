## v2.0.125 - Web tool protocol-lab hooks

- Added a lab-only `WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL=1` switch
  for protocol tracing. When enabled with the native bridge, Cascade polling
  continues after the first `cascade_native` tool proposal so traces can capture
  post-tool result payloads. The default production behavior is unchanged: stop
  at the native tool proposal and let the OpenAI client execute the tool.
- `WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW` can now inject unknown top-level
  `CascadeToolConfig` fields with `fieldNN:<hex>`, `field_NN:<hex>`, or
  `fNN:<hex>`. This is for WebSearch/WebFetch field-matrix canaries; field 32
  remains reserved for the managed allowlist.
- Proto tracing now summarizes unknown native tool-config fields and richer
  `search_web` / `read_url_content` trajectory shapes, including nested message
  fields that should reveal `web_documents` payload placement during real
  smoke tests.
- WebSearch/WebFetch are still not in the default native bridge allowlist. This
  release only makes the gated canary measurable enough to decide the next
  mapping safely.

Verification:

- `node --check src\client.js`
- `node --check src\windsurf.js`
- `node --check src\proto-trace.js`
- `node --test test\client-panel-retry.test.js`
- `node --test test\cascade-native-bridge.test.js test\proto-trace.test.js test\native-tool-routing.test.js`
- `node --test --test-timeout=120000 --test-force-exit test\*.test.js` passes: 1025/1025.
