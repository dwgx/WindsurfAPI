## v2.0.117 - Native bridge smoke source checks

This release does not widen native bridge by default. It tightens the real smoke
criteria so rollout decisions are based on actual native bridge tool calls, not
text or NLU recovery fallbacks.

### Native bridge smoke

- `scripts/native-bridge-smoke.mjs` now classifies tool-call sources in stream
  and non-stream diagnostics:
  - `cascade_native` for Cascade trajectory tool calls.
  - `provider_xml` for Claude-style XML calls converted by the native bridge.
  - `nlu_recovery` for heuristic recovery calls.
  - `openai_tool_call` for ordinary OpenAI tool-call responses.
- Native bridge smoke now requires a native bridge source by default. A matching
  `nlu_*` recovery call no longer counts as success.
- `NATIVE_BRIDGE_SMOKE_REQUIRE_NATIVE=0` restores the older permissive smoke
  behavior for debugging.

### Verification

- `node --check scripts/native-bridge-smoke.mjs`
- `node --test test/native-bridge-smoke.test.js test/native-tool-routing.test.js`
- `node --test test/*.test.js`
