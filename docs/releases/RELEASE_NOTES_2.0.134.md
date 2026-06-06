# v2.0.134

- Corrected the `read_url_content` trajectory schema to match the official
  Windsurf 2.3.15 generated client. `CortexStepReadUrlContent` now treats
  field `2` as `web_document` (`KnowledgeBaseItem`) and no longer writes the
  legacy guessed top-level `summary=5` during history injection.
- `parseTrajectorySteps()` now extracts WebFetch results from
  `KnowledgeBaseItem.text`, chunk text, or `KnowledgeBaseItem.summary`, with
  field `5` retained only as a legacy trace fallback.
- Proto tracing now summarizes `read_url_content.web_document` shape and
  `requested_interaction=56` read-url permission prompts without logging raw
  URLs.
- Documented the official WebFetch direction: there is still no
  descriptor-backed direct URL-content API. The client path is LS
  `HandleCascadeUserInteraction` for `RequestedInteraction.read_url_content`,
  followed by a completed `read_url_content` step.

Verification:

- `node --test test/cascade-native-bridge.test.js`
- `node --test test/v2070-issue-fixes.test.js`
- `node --test test/proto-trace.test.js`
