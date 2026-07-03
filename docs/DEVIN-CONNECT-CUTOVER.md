# DEVIN_CONNECT Production Cutover Runbook

**Created:** 2026-06-30 (eve of Cascade retirement, 2026-07-01)
**Audience:** operator deploying WindsurfAPI to homecloud after Cascade is gone.
**Status:** deploy-ready. Code is verified locally (1492 tests green) but NOT yet
pushed/deployed — production still runs old code that 503s on Devin routes.

---

## 0. The one thing that matters most

There are **two** Devin switches and they are not interchangeable:

| Switch | Routes to | Needs a binary? | Use on homecloud? |
|---|---|---|---|
| **`DEVIN_CONNECT=1`** | Devin **cloud** GetChatMessage over pure HTTP, riding the account pool | **No** | **YES — this one** |
| `DEVIN_ONLY=1` | the **local `devin` CLI** subprocess | Yes (`devin` binary) | No — homecloud has no binary → 503 per request |

Homecloud has neither the `language_server` binary nor the `devin` CLI, so the
cutover switch is **`DEVIN_CONNECT=1`**. Setting `DEVIN_ONLY=1` here would make
every request 503.

---

## 1. Minimal cutover config

On homecloud, in the service `.env` (workdir `/home/dwgx_user/WindsurfAPI`,
loopback `127.0.0.1:3003` per memory `homecloud-deploy`):

```sh
DEVIN_CONNECT=1
API_KEY=sk-dwgxnbnb        # existing downstream proxy key — unchanged
# accounts.json already holds the free session token(s) — nothing else required
```

That is the whole minimum. The pool supplies tokens; free-tier accounts resolve
only `swe-1-6-slow`. Any other model name degrades to that free selector.

## 2. Recommended hardening adds (optional, all default-off)

```sh
DEVIN_CONNECT_LIVENESS_PROBE=1            # zero-billable dead-token detection sweep
DEVIN_CONNECT_AUTO_RELOGIN=1              # self-heal a dead token via Auth1 re-login
DEVIN_CONNECT_CRED_KEY=<32+ char secret>  # REQUIRED for auto-relogin to do anything
```

Auto-relogin only works for accounts that have a **stored password**. An account
added by raw token (the current pooled free account, id `70da7667`) has none, so
it can fail over to other pool members but cannot self-heal its own token. To
enable self-heal, re-add the account through the email/password login path with
`DEVIN_CONNECT_CRED_KEY` set — the password is then auto-stored encrypted
(`src/auth.js:514-515`). See §5.

## 3. Deploy steps (operator runs on homecloud)

```sh
cd /home/dwgx_user/WindsurfAPI
git pull                                  # pulls the DEVIN_CONNECT commits
# edit .env: add DEVIN_CONNECT=1 (+ optional hardening from §2)
sudo systemctl restart windsurfapi
sudo systemctl status windsurfapi --no-pager   # confirm active (running)
```

No `npm install` needed unless `package.json` changed (it didn't for this work).

## 4. Post-deploy verification

```sh
# zero-billable preflight first (no model calls):
API_KEY=sk-dwgxnbnb BASE_URL=http://127.0.0.1:3003 \
  CONNECT_SMOKE_REAL_CALLS=0 npm run smoke:devin-connect

# then one real free-model call to confirm the chat path yields tokens:
API_KEY=sk-dwgxnbnb BASE_URL=http://127.0.0.1:3003 \
  npm run smoke:devin-connect
```

A green run proves: pool token in use, GetChatMessage reachable, free selector
resolves, and (if hardening enabled) credential store + recovery-config sane.

Quick manual sanity check:

```sh
curl -s http://127.0.0.1:3003/v1/chat/completions \
  -H "Authorization: Bearer sk-dwgxnbnb" -H "Content-Type: application/json" \
  -d '{"model":"swe-1-6-slow","messages":[{"role":"user","content":"ping"}]}' \
  | head -c 400
```

## 5. Enabling true self-heal for the free account (optional)

The pooled free account is token-only today. To give it self-heal:

1. Set `DEVIN_CONNECT_CRED_KEY` in `.env` and restart.
2. Remove the token-only account, re-add via the dashboard's email/password
   login (or the login API) — this stores the password encrypted.
3. Verify recovery: `npm run smoke:devin-connect` Stage 0c reports the
   credential store enabled and recovery-config sane.

## 6. Rollback

```sh
# fastest: drop the switch and restart (reverts to prior backend selection)
# edit .env: comment out DEVIN_CONNECT=1
sudo systemctl restart windsurfapi
# or revert the code:
git log --oneline -5 && git checkout <prior-sha> && sudo systemctl restart windsurfapi
```

`DEVIN_CONNECT` is a pure env flag with no migration — toggling it off is an
instant, total rollback.

## 6.5 Capacity throttling (`high demand`) — what to expect (P0 #56/#57)

The free `swe-1-6-slow` upstream intermittently rejects a completion with
`We're currently facing high demand for this model. Please try again later.`,
delivered inside an HTTP **401/403** auth-shell. This is a TRANSIENT capacity
condition, NOT a dead token. The proxy classifies it as `CAPACITY` and:

- **retries once in place** on the same token (stream + non-stream paths),
- **never triggers re-login** (so a busy blip can't burn the account),
- **never escalates to `MODEL_BLOCKED`** (so the free model is never cooled down
  permanently over a hiccup),
- on persistent busy, surfaces a clean **HTTP 503 `capacity_error`** and applies
  a short (60s) **model-scoped** soft cooldown so the pool prefers another
  account for that model — the account stays fully healthy for every other model.

Watch `capacity_throttled` on `/connect-metrics`. A steady low count is normal
free-tier behavior; a sustained spike means the upstream is genuinely saturated
(add pool accounts or back off), not that anything is broken. **Do not** re-map
`CAPACITY` to `UNAUTHORIZED` — that reintroduces the re-login storm this guards.

## 7. What's NOT covered (known limits)

- **Paid models** (claude-*/gpt-*/gemini-*) need a paid entitlement on a pooled
  account — unverified, blocked on a paid token. Free deploy serves
  `swe-1-6-slow` only. See §8 for the one-command verification.
- **Vision/images**: gated off (`DEVIN_CONNECT_IMAGE_TAG=0`); leave unset. §8
  has the one-command calibration for when a paid vision token exists.
- **Router models** (`adaptive`, `arena-*`): resolution via AssignModel is built
  but gated OFF (`DEVIN_CONNECT_ASSIGN_MODEL` unset) because the wire tags are
  inferred, not yet calibrated on a paid round-trip. §8 has the enable path.
- **Billing passthrough** (`credit_cost`/`committed_acu_cost`): decode is built
  but OFF until the tags are pinned (`DEVIN_CONNECT_BILLING_TAGS` unset). §8.
- Remaining P1/P2 hardening (hung-stream absolute deadline, quota-vs-tier
  classification, streaming transient-5xx replay, observability counters) are
  filed as backlog — not blockers for a free-tier cutover.

## 8. Paid-token activation — one command per capability

Everything below is BUILT, TESTED (offline), and OFF by default. The moment a
PAID Devin session token exists, each capability is one command away. All are
billable; none run without an explicit flag. Token can come from a pooled
account's `apiKey` or be passed directly.

### 8.0 START HERE — one command discovers every unknown tag at once

Before reaching for the per-capability tools below (§8.2/8.4/8.6/§8.5's manual
flag), run the unified calibrator. It fires ONE `DEBUG_META` completion, then
aggregates every top-level + metadata tag the stream emitted, diffs them against
the verified free baseline, classifies each NEW tag by wire shape into the field
it most likely is, writes candidate `DEVIN_CONNECT_*` env lines to disk, and
prints a per-target status table (calibrated / candidate-found / pending, and
which task each unblocks: #46 billing+cache, #47 actual_model_uid, #49 tool_calls).

```sh
CALIBRATE_REAL=1 CONNECT_SMOKE_TOKEN=<paid-token> npm run calibrate:devin
# bare run (no flag) = offline self-test (simulated paid/tool/cached/router
#   frames) — proves collect→classify→env-gen→status works with NO token/billing.
# output env file: .devin-connect-calibrated.env (gitignored) — review before pinning.
```

This replaces the hand-wiring §8.5 used to require. A free token surfaces zero
candidates (expected); a paid / tool-using / router / cached turn surfaces the
tags the sections below tell you how to pin. The image tag (#29) still needs the
dedicated vision sweep in §8.2 (it's a REQUEST-side tag, not in the response).

The calibrator also **recursively decodes the inner fields of any non-printable
top-level sub-message** — most importantly the recurring `#28` trailer (a ~186b
block present at the END of every completion, the prime usage/billing/stop-metadata
candidate). Previously the dump could only mark it `<msg 186b>` (presence), so its
guts needed a hand-written probe; now one `calibrate:devin` run prints
`sub-message #28 inner varints: {…}` for operator inspection. These sub-fields are
**surfaced, not auto-wired**: the shipped billing decoder reads the `#7` meta block,
so if `#28` turns out to carry credit_cost / cache tokens you map them deliberately
rather than the harness guessing. (PAID-1 2026-07-01 already confirmed the sibling
`#47` actual_model tag = 21 = "anthropic"; `#28` inner decode was the next step.)

> Onboarding a new account is also one command:
> `DEVIN_CONNECT_CRED_KEY=<key> LOGIN_REAL=1 LOGIN_EMAIL=<e> LOGIN_PASSWORD=<p> npm run login:devin`
> — logs in, encrypts+stores the credential (arms auto-relogin), adds to the pool,
> and verifies tier. Bare run = offline self-test.

### 8.1 Verify paid selectors are actually reachable (#15/#28)

The single command that resolves the long-blocked "does a paid token reach
claude/gpt/gemini, or do they tier-wall like free?" question. Walks every paid
selector, fires one 1-token probe each, prints a reachable/tier-wall/dead-token
matrix. Probes the free model first as a liveness baseline so it can tell a
tier-wall from a dead token.

```sh
PAID_VERIFY_REAL=1 CONNECT_SMOKE_PAID_TOKEN=<paid-token> npm run verify:devin-paid
# narrow:   PAID_VERIFY_ONLY=claude-opus-4.8,gpt-5.5  (prepend to the line)
# bare run (no flag) = offline self-test, no token/network/billing.
```

Exit 0 = all good (or free tier, where tier-walls are expected). Exit 1 = a PAID
token still has tier-walls (entitlement not really active).

### 8.2 Calibrate the vision image tag (#29)

Discovers the unknown protobuf tag for the nested `images` field by probing
candidate tags against a vision model. Free `swe-1.6` is NOT a vision model, so
this needs a paid/vision entitlement. On a hit it writes
`devin-connect-image-tag.json` (gitignored) and prints the exact env line.

```sh
IMAGE_CALIBRATE_REAL=1 CONNECT_SMOKE_TOKEN=<paid-vision-token> \
  IMAGE_CALIBRATE_MODEL=claude-opus-4.8 npm run calibrate:devin-image
# then put the printed DEVIN_CONNECT_IMAGE_TAG=<n> in .env and restart.
```

The default sweep is `[4,5,6,7]` (recon places `images` most likely at #4, right
after `content`=#3). Widen with `IMAGE_CALIBRATE_TAGS=...` if none hit.

### 8.3 Enable router models — adaptive / arena-* (AssignModel)

`adaptive`/`arena-*` are routers the server resolves per request via AssignModel;
GetChatMessage rejects the bare router uid. Turn the hop on:

```sh
# .env:
DEVIN_CONNECT_ASSIGN_MODEL=1
# If a real AssignModel round-trip shows different tags than our inferred
# defaults (req_model_uid=2, resp_assignment=1, asg_model_uid=1, asg_jwt=2,
# asg_harness=3), pin them:
DEVIN_CONNECT_ASSIGN_TAGS="req_model_uid=2,resp_assignment=1,asg_model_uid=1,asg_jwt=2,asg_harness=3"
# Extra router names/prefixes:  DEVIN_CONNECT_ROUTER_MODELS="auto,smart-*"
```

A failed/empty resolve degrades gracefully to the original selector and bumps
the `assign_model_failed` counter on `/connect-metrics` — it never fails the
request. Calibrate by capturing one real AssignModel response and confirming the
decoded `model_uid` is a sane concrete selector.

### 8.4 Surface billing cost in usage (credit/acu)

The response carries `credit_cost`/`committed_credit_cost`/`committed_acu_cost`,
dropped today. These are absent on free tier (zero-valued → not encoded), so the
tags can only be pinned from a paid response. Once known:

```sh
# .env (tags are EXAMPLES — pin the real ones from a paid capture):
DEVIN_CONNECT_BILLING_TAGS="credit_cost=6,committed_credit_cost=7,committed_acu_cost=8"
```

`chat()` and the streaming `finish` event then carry a `billing` object. Unset =
no billing keys, zero behavioral change.

### 8.5 Discover unknown metadata tags (the calibration master-key)

§8.4 and §8.6 both need integer tags that only appear on a paid/cached response.
The discovery tool is a single env flag — it dumps every varint subfield of the
#7 metadata sub-message to the log so you can read the tags straight off a real
capture:

```sh
DEVIN_CONNECT_DEBUG_META=1 <your normal request>
# log line: DEVIN_CONNECT meta dump (tag=value varints): {"2":389,"3":72,"6":6,...}
#   #2 = prompt_tokens, #3 = completion_tokens (known). Any NEW tag carrying a
#   credit/acu cost or a cache-token count is your value to pin below.
```

Free-tier baseline (verified 2026-06-30 on `swe-1-6-slow`): the terminal frame
carries only `{2: prompt, 3: completion, 6: provider}` — no cost, no cache
tokens (free tier doesn't bill or cache, and zero-valued protobuf fields aren't
encoded). That's exactly why §8.4/§8.6 are paid-only.

### 8.6 Surface prompt-cache tokens in usage

`ModelUsageStats` carries `cache_read_tokens` / `cache_write_tokens` (recon
verified field names). Absent on free tier (no caching). Once a paid/cached
capture reveals the tags via §8.5, pin them on the SAME billing-tags var — the
decoder routes cache_* into `usage` (OpenAI-standard shapes) instead of billing:

```sh
DEVIN_CONNECT_BILLING_TAGS="credit_cost=6,cache_read_tokens=14,cache_write_tokens=15"
```

`usage` then gains `prompt_tokens_details.cached_tokens` (from cache_read) and
`cache_creation_input_tokens` (from cache_write). Unset = neither key present.

### 8.7 finish_reason calibration (already live, free-tier safe)

`mapFinishReason` maps the upstream `StopReason` enum (recon variant order:
`end_turn, max_tokens, max_turn_requests, refusal, cancelled`) to the OpenAI
vocabulary. The normal-completion value `2 → stop` is LIVE-ANCHORED (free-tier
verified) and shipped on by default. The remaining integers use best-effort
defaults (`3/4 → length`, `5 → content_filter`); if a paid/edge capture shows
different integers, override the whole table:

```sh
DEVIN_CONNECT_STOP_REASON_MAP="1=stop,2=stop,3=length,5=content_filter"
```

Unknown values always fall back to `stop` so a finished stream is never an error.
Note: free-tier `swe-1-6-slow` does NOT enforce `max_tokens` (probe: 16 vs 1000
→ identical output), so `length` cannot be exercised without a paid capture.

### 8.8 Live re-login recovery check (real credentials, zero-billable)

The auto-recovery chain (#23/#24/#27) is proven end-to-end against a REAL login
two ways. Both are opt-in and billing-free (login + GetUserStatus only):

```sh
# unit/integration test — real windsurfLogin + real AES-GCM store:
RELOGIN_LIVE=1 RELOGIN_LIVE_EMAIL=<e> RELOGIN_LIVE_PASSWORD=<p> \
  DEVIN_CONNECT_CRED_KEY=<throwaway-key> \
  node --import ./test/setup-env.mjs --test test/devin-connect-relogin-live.test.js

# smoke stage — same chain inside the smoke run:
SMOKE_RELOGIN_LIVE=1 SMOKE_RELOGIN_EMAIL=<e> SMOKE_RELOGIN_PASSWORD=<p> \
  DEVIN_CONNECT_CRED_KEY=<key> npm run smoke:devin-connect
```

Unarmed (no creds / no flag) both skip cleanly — never a CI failure. Each uses a
temp cred store + an ephemeral pool account, so the real `accounts.json` /
`accounts.creds.json` are never touched.

> **Live-service note (observed 2026-06-30):** a FREE session token can pass
> `GetUserStatus` (status alive) yet have its `GetChatMessage` *completion*
> rejected with `UNAUTHORIZED an internal error occurred (trace ID:...)`, even
> immediately after a fresh login. This is a server-side free-tier condition, not
> a client bug — login + status succeed, only the billable completion is walled.
> The calibrator (§8.0) handles it gracefully: it reports the probe error, marks
> every target `pending`, and writes nothing. Retry with a paid token to capture.

### 8.8 Surface actual_model_uid (router resolution signal)

For router selectors (`adaptive`/`arena-*`, see §8.3) the response carries
`actual_model_uid` — the concrete model that actually served the turn. Useful to
verify AssignModel resolved sanely. Tag unknown from free capture; discover via
§8.5 (it's a top-level STRING field, shows up in the `frame dump` line), then:

```sh
DEVIN_CONNECT_ACTUAL_MODEL_TAG=13   # example — pin the real tag
```

The streaming `finish` event then carries `actualModel`. It is NOT echoed into
the client-facing response `model` field (clients often assert it equals the
requested name); it's a verification/observability signal. Unset = null.

### 8.9 Sampling passthrough + temperature=0 clamp (LIVE-VERIFIED)

Client sampling controls (`temperature`, `top_p`, `top_k`, `max_tokens`) now flow
from the OpenAI/Anthropic request into the connect `CompletionConfig`. Previously
they were silently dropped on the DEVIN_CONNECT path — every call ran at built-in
defaults. No env flag; on whenever the caller sends them.

**temperature=0 clamp**: live testing (free `swe-1-6-slow`, 2026-06-30) showed an
exact `temperature=0` reliably makes the upstream return "an internal error
occurred" (3/3), while `0.001` succeeds. Since OpenAI clients routinely send `0`
for deterministic output, `buildCompletionConfig` clamps any sub-`0.001` temp up
to `MIN_TEMPERATURE=0.001` (nearest-greedy the server accepts) rather than letting
the call hard-fail. Verified: temp=2 → "Elephant!", temp≈0 → stable "Dog"/"Cat",
proving sampling genuinely reaches the model.

KNOWN LIMIT (unchanged): `max_tokens` (#3) is not an enforced output cap on the
free tier (16 vs 1000 → identical output). Forwarded for paid; pin the real tag
from a paid capture (§8.5) before relying on output-length limiting.

### 8.10 Native tool definitions (groundwork, paid-calibration gated)

The calibrated proto verifies the repeated `tools` field at request #10, but the
inner ToolDef subfield layout (name/desc/schema tags) was never decoded from a
free capture. So native tool defs are OFF by default — tools keep riding the
prompt via emulation, which works on every model. The request builder forwards
`tools` and self-gates: nothing is emitted unless the inner tags are calibrated.

To enable after a paid capture (§8.5) reveals the ToolDef inner tags:

```sh
DEVIN_CONNECT_TOOL_DEF_TAGS="10,1,2,3"   # outer,name,description,schema
```

Order: outer repeated tag (verified =10), then the name/description/schema
subfield tags. Malformed or wrong-arity → fails closed to emulation (never a
broken frame). Live-verified: forwarding tools with the gate OFF produces an
identical, working request (zero regression). Response-side `ChatToolCall`
decoding (`arguments_json`/`id`/`invalid_json_str`) still needs a paid capture
and is tracked separately under #49.

**Response-side decode** is wired the same way, gated by
`DEVIN_CONNECT_TOOL_CALL_TAGS`. Once a paid frame dump (§8.5,
`DEVIN_CONNECT_DEBUG_META=1`) reveals the repeated `delta_tool_calls` tag and the
ChatToolCall subfields:

```sh
DEVIN_CONNECT_TOOL_CALL_TAGS="outer=12,id=4,name=1,arguments_json=3"
```

`outer` (the repeated-field tag) is mandatory; the streaming `finish` event then
carries `toolCalls: [{ id, name, arguments }]`. Off (default) → `toolCalls` is
null and prompt emulation (`parseToolCallsFromText`) owns tool calls on every
model, exactly as today. The decode is a pure read; an uncalibrated or absent tag
map has zero behavioral effect.

