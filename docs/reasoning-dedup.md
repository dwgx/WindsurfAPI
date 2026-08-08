# Reasoning/content duplicate suppression (incremental)

The upstream behind devin-connect can deliver the reasoning twice in one
response: first as reasoning tokens (`reasoning_content`), then verbatim as
content. `src/reasoning-dedup.js` suppresses that duplicate **without holding
the normal answer** — the rework of the earlier settle-flush design, which was
rejected because holding the whole stream breaks progressive streaming for all
thinking models.

## How it works

- While a content chunk byte-matches a prefix of the accumulated reasoning, the
  chunk is held in a tiny in-memory buffer that lives fractions of a second.
- The moment content diverges from the reasoning prefix, everything held so far
  plus the current chunk is emitted immediately — one SSE frame — and the rest
  of the stream passes through untouched.
- At stream end, suppression fires **only** if the accumulated content equals
  the *full* reasoning byte-for-byte: that is the true duplicate, and it is
  silently dropped. A strict prefix (content shorter than the reasoning, the
  stream ends there) is **released** — suppressing it would hand clients that
  collapse the thinking blocks an empty reply.
- On a stream error/abort the held tail is emitted unconditionally
  (`release()`): nothing is suppressed on the failure path — a duplicate tail
  beats a silently missing one.
- The held buffer is capped at 1 MiB (`HELD_CAP`); crossing the cap latches
  divergence and flushes. In practice the buffer is already bounded by the
  reasoning length — the cap is defense in depth on a default-on path.

## Why default-ON is safe

A normal answer never waits for a single extra chunk:

- divergence → immediate release (no buffered delay beyond the divergence
  frame);
- only a full-length byte-identical duplicate is suppressed at the end when
  the caller requested thinking (`wantThinking: true`), so the client never sees
  the reasoning twice;
- when `wantThinking` is false (default), standard OpenAI SDK clients only read
  `delta.content` (reasoning is invisible), so the full duplicate is released at
  `settle()` — the dedup cannot produce an empty answer;
- the strict-prefix shape (the answer restates the opening of the reasoning
  and the stream ends) is released, never suppressed.

## Invariants

| Stream shape | Held | Emitted | Suppressed at settle() |
| --- | --- | --- | --- |
| content == reasoning AND wantThinking: true | all chunks | nothing | yes |
| content == reasoning AND wantThinking: false | all chunks | everything, at settle() | no |
| content is a strict prefix of the reasoning | all chunks | everything, at settle() | no |
| content diverges (anywhere) | only until divergence | everything, at the divergence frame | no |
| reasoning shorter than content | only until content outruns the reasoning | everything | no |
| stream error/abort | — | held tail via release() | no (never on failure path) |
| no reasoning seen | nothing | everything | no |
| non-stream path | — | — | untouched (no dedup) |

## Integration

- `src/handlers/chat.js` wires the module into the unified stream inside
  `streamResponse` — the four egress protocols (openai chat, anthropic
  messages, gemini, responses) all consume the same stream, so one integration
  covers all four.
- `noteReasoning()` is fed from `emitThinking`, `feed()` from `emitContent`,
  `settle()` runs once at stream end (success path), and `release()` runs on
  the partial-failure path before the clean stop.
- `accText`/`accThinking` keep the full view for the fallback, narrative-scan
  and cascade-history logic — the dedup is client-visible only.
