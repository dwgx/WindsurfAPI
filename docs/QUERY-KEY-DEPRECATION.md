# `?key=` query-parameter auth — status, risk, and removal plan

> **Status: supported on two surfaces, deprecated.** `?key=` still authenticates
> on `/v1/models` and the Gemini-native (`/v1beta`) surface, the places the Google
> SDK can legitimately send it. It is **not** accepted on chat, completions,
> responses or messages. It is a compatibility carrier, not the recommended form.
> No removal has shipped, and none can ship in a patch release. The phases below
> are a plan, not a schedule: each one needs an Owner decision and a release note.

## What is accepted today

`extractToken` (`src/server.js`) is **surface-scoped**: the router derives the
surface from the request path (`credentialSurfaceFor`) and reads only the carriers
that surface defines. A credential minted for one protocol cannot be replayed
against another.

| Surface | Routes | Accepted carriers |
|---|---|---|
| `openai` | `/v1/chat/completions`, `/v1/completions`, `/v1/responses` | `Authorization: Bearer` only |
| `messages` | `/v1/messages`, `/v1/messages/count_tokens` | `Authorization: Bearer`, `x-api-key` |
| `models` | `/v1/models`, `/v1/models/:id` | `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `?key=` |
| `gemini` | `/v1beta/*` (including `:generateContent`, `:streamGenerateContent`) | `Authorization: Bearer`, `x-goog-api-key`, `?key=` |
| `operator` | `/auth/*`, `/health` | `Authorization: Bearer`, `x-api-key` |

The query form is parsed from `req.url` with `URL.searchParams.get('key')` and
trimmed. It is accepted **only** on the `models` and `gemini` surfaces — not on
chat, completions, responses or messages. Inside a surface the precedence is
Bearer, then `x-api-key`, then `x-goog-api-key`, then `?key=`, skipping any carrier
that surface does not allow; a header always wins when several are present.

The bundled `nginx.conf` defines `log_format main_no_query` and logs `$uri` —
the normalized path only — so the query string from the request line never
reaches its access log. The format also omits the `Referer` header: a `Referer`
is itself a URL, so a link clicked on a page that was opened with `?key=` would
copy that query into the log even when the request line is clean. Both
properties are pinned by `test/nginx-access-log.test.js` (`$request_uri`, `$args`
and `$http_referer` are forbidden in the format). The application itself does not
log the raw request line; the places that derive a path from `req.url` slice at
`?` (`src/server.js`).

## Compressed request bodies are refused (415)

`readBody()` never decompressed anything, so a `Content-Encoding: gzip` (or
`br`/`deflate`) body used to die later as a confusing `400 Invalid JSON`. The
server now checks the header **before** reading the body and returns **415** with
`type: "unsupported_content_encoding"` (the envelope follows the surface:
OpenAI/Anthropic/Gemini/legacy). No header or `Content-Encoding: identity` is still
accepted. This is deliberate: inflating caller bytes would hand a gzip bomb (a few
KB on the wire, gigabytes in memory) to the proxy, so the only supported request
body is uncompressed. The check keys on the header alone, so a chunked request
with no `Content-Length` is covered too.

## Why it is discouraged

A key in the query string is a key in the URL, and URLs are logged. That is the
reason `?key=` is now limited to the two surfaces where the Google SDK sends it
and rejected outright on chat: the carrier itself is the leak, not the key's
scope.

| Sink | What happens |
|---|---|
| Reverse-proxy access logs | nginx's default `combined` format logs `$request_uri`; the bundled config no longer does, but proxies you add are yours to configure |
| Browser history / bookmarks | opening a Gemini URL in a browser stores the key |
| `Referer` | a URL used as a link can leak the query to the next site (browsers usually strip it cross-origin, but not every client does); a proxy that logs the `Referer` header records it too — the bundled nginx does not log that header |
| Packet captures / support bundles | full request lines travel in both |
| Upstream logs | outside this project's control |

The chat key is the only credential on the API surface: it unlocks chat,
`/auth/status` and every model. The key is not scoped to Gemini, but the
**carrier** is: a `?key=` accepted by a Gemini route no longer opens chat, and an
`x-api-key` accepted by `/v1/messages` no longer opens `/v1/chat/completions`. The
dashboard API (`/dashboard/api/*`) uses its own operator credential; `?key=` is
not one.

The app never logs the query string, and the bundled nginx no longer logs either
the request-line query or the `Referer` header that could repeat it. That reduces
the blast radius; it does not make the URL a safe carrier — browser history,
captures and any proxy you add still see the full URL.

## Use a header instead

Use the carrier your surface defines; the three forms below are each accepted on
the surface it belongs to:

```bash
# Gemini native (preferred for Gemini clients)
curl "http://HOST:3003/v1beta/models/MODEL:generateContent" \
  -H "x-goog-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'

# OpenAI-compatible clients
curl "http://HOST:3003/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"MODEL","messages":[{"role":"user","content":"hello"}]}'

# Anthropic SDKs
curl "http://HOST:3003/v1/messages" \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H 'content-type: application/json' \
  -d '{"model":"MODEL","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}'
```

`Authorization: Bearer` works on every surface. `x-api-key` works only on
`/v1/messages`, `/v1/models` and the operator surface; `x-goog-api-key` works only
on `/v1/models` and the Gemini surface. A `/v1/chat/completions`, `/v1/completions`
or `/v1/responses` caller must use Bearer — the other carriers are refused there.

The Google GenAI SDK path in the README uses `x-goog-api-key`, so the Python/JS
SDK example needs no change:

```python
from google import genai
client = genai.Client(
    api_key="YOUR_API_KEY",
    http_options={"base_url": "http://HOST:3003"},
)
```

If a client can only build `?key=` URLs, it can reach `/v1/models` and the Gemini
surface only; it cannot call chat, completions, responses or messages. For those
two surfaces:

- keep it behind the bundled nginx (no request-line query, no `Referer` in the
  access log) and accept the residual exposure in browser history and captures;
  or
- put a small proxy in front that moves the parameter into `x-goog-api-key` and
  strips the query before forwarding.

Audit client configs for `?key=` / `key=` and migrate them before Phase 2. No
in-repo client uses the query form for this API; the remaining `?key=` strings in
the tree are Firebase upstream URLs (`src/dashboard/windsurf-login.js`), the
scoped query-parsing branch and its comment (`src/server.js`), and the nginx
regression test.

## Removal plan (proposed)

| Phase | Earliest version | Behavior | Status |
|---|---|---|---|
| 0 — current | 3.9.x | accepted on `/v1/models` and the Gemini surface only; documented as compatibility-only | shipped |
| 1 — announce | first minor after this doc (3.10.0 or later) | still accepted; responses authenticated via `?key=` carry `Deprecation: true` and a `Sunset` date; a rate-limited `WARN` records a key hash (never the key); release notes name the migration | not implemented |
| 2 — default off | next major (4.0.0 or later) | `?key=` returns 401 `query_key_removed` unless the temporary escape hatch is set; the error names `x-goog-api-key` | not implemented |
| 3 — remove | following major (5.0.0 or later) | the escape hatch and the query-parsing branch are deleted | not implemented |

Proposed escape-hatch name for Phase 2: `WINDSURFAPI_ALLOW_QUERY_KEY=1`. It does
not exist today; setting it has no effect. It is named here so the name is not
invented twice.

Rules that keep the removal from surprising anyone:

- no removal in a patch release;
- at least one minor release between Phase 1 and Phase 2;
- every phase updates this file, both READMEs, and the release notes;
- Phase 2 and Phase 3 need an explicit Owner decision — the phases are a plan,
  not a promise of dates;
- if operator reports show a client that cannot send headers, extend Phase 1
  rather than breaking it.

## What this does not change

- `Authorization: Bearer` keeps working on every surface; `x-api-key` keeps
  working on `/v1/messages`, `/v1/models` and the operator surface;
  `x-goog-api-key` keeps working on `/v1/models` and the Gemini surface.
- The dashboard API keeps its own auth; this plan does not touch it.
- The nginx `$uri` format stays, and it must keep omitting `$http_referer` — a
  `Referer` URL can carry the query even when `$uri` is clean. Do not restore
  query logging for debugging; log a dedicated non-secret parameter instead.
