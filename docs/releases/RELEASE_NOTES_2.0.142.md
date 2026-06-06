## v2.0.142 - partial stream cleanup

This release keeps native bridge defaults unchanged.

### Cursor / streaming compatibility

- Fixed the OpenAI streaming error tail after partial assistant content was
  already delivered. The stream now finishes with a normal `finish_reason:
  "stop"` chunk and `[DONE]` instead of appending a structured `{"error": ...}`
  frame after user-visible content.
- Empty streams that fail before any real content/tool/thinking payload is sent
  still return the structured stream error frame, so clients keep actionable
  diagnostics when no answer was delivered.

### Validation

- Added regression coverage for partial upstream deadline failures after content
  is emitted, plus the opposite case where only an empty role chunk was emitted.
