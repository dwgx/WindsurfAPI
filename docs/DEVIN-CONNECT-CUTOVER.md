# DEVIN_CONNECT Production Cutover Runbook

**Created:** 2026-06-30 (eve of Cascade retirement, 2026-07-01)
**Audience:** operator deploying WindsurfAPI to homecloud after Cascade is gone.
**Status:** **cutover is done.** `DEVIN_CONNECT=1` has been the deployed backend since
2026-07; every release since has been developed and measured against it, and the §8 paid
calibration below was captured on a real account (2026-07-27). Read this as a runbook for
a NEW deployment or a rollback, not as a pending migration.

> The line here used to read *"deploy-ready … NOT yet pushed/deployed — production still
> runs old code that 503s on Devin routes"*, with a test count from 2026-06-30. That was
> true the day it was written and became false within weeks, while
> [README.md](README.md) was telling readers this same backend was the production default.
> Two docs, opposite claims. A "Status:" field pinned to a moment needs either a date
> qualifier or no field at all — this one now says what is *durably* true and leaves the
> per-release numbers to the handoffs, which are dated by construction.

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
API_KEY=sk-REDACTED        # existing downstream proxy key — unchanged
# accounts.json already holds the free session token(s) — nothing else required
```

That is the whole minimum. The pool supplies tokens. Which connect selectors are
FREE is **derived from the live catalog, not from a fixed name**:

1. `modelCostTier` + `promoStatus` on the account's `GetCascadeModelConfigs` rows
   (per account, promo-aware). Measured on a Pro account 2026-10-22: exactly
   `swe-2-medium` / `swe-2-high` / `swe-2-max`, `MODEL_COST_TIER_FREE`, promo
   active until **2026-11-01T06:59:59Z**.
2. A `rate === 0` entry in the account's paired credit rate table (rolling
   promotions that are not encoded as a cost tier).
3. `FREE_REACHABLE_SELECTORS` (`swe-1-6-slow`) — a documented **fallback only**
   for a deployment with no live cost-tier data and no rate table (cold start).
   It is also unpaid-tier ENTITLEMENT, so a free account is still admitted to it
   when the live catalog has not been fetched. Do not treat it as "the free
   list": on the measured Pro deployment it is absent from the 240-selector live
   catalog and the upstream answers it with `failed_precondition` /
   "Your daily usage quota has been exhausted".

`GET /dashboard/api/models` exposes the derivation per row: `costTier`,
`promoEndsAt`, `freeNow` (tri-state), `freeReason`
(`cost_tier_free` | `rate_zero` | `fallback_whitelist`) and `quotaState`
(`free` | `blocked_daily` | `blocked_weekly` | `not_in_catalog` | `unknown`).
A selector absent from a non-empty live catalog is reported as
`not_in_catalog` rather than reachable+free.

A model name the catalog does not know is **rejected with `400 model_not_found`**,
not degraded. There is no opt-out: silently substituting the free selector
changes both the output and the billing semantics of an explicitly requested
paid model, so it fails loudly instead. The `STRICT_MODEL` opt-out switch
was removed — strict is the only behavior. The old opt-out degraded **only to
a selector that was callable**: the live free selectors above, restricted to
what the account's catalog actually exposed. It used to target the frozen
`swe-1-6-slow` unconditionally, which on a live-catalog deployment is absent
and answers with "Your daily usage quota has been exhausted" — so a typo came
back as a quota error that looked like an account fault.

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
(`src/auth.js:1981`). See §5.

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
API_KEY=sk-REDACTED BASE_URL=http://127.0.0.1:3003 \
  CONNECT_SMOKE_REAL_CALLS=0 npm run smoke:devin-connect

# then one real free-model call to confirm the chat path yields tokens:
API_KEY=sk-REDACTED BASE_URL=http://127.0.0.1:3003 \
  npm run smoke:devin-connect
```

A green run proves: pool token in use, GetChatMessage reachable, free selector
resolves, and (if hardening enabled) credential store + recovery-config sane.

Quick manual sanity check:

```sh
curl -s http://127.0.0.1:3003/v1/chat/completions \
  -H "Authorization: Bearer sk-REDACTED" -H "Content-Type: application/json" \
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
  account — unverified, blocked on a paid token. A free deployment's serveable
  set is the live catalog's cost-tier-FREE rows, with `swe-1-6-slow` as the
  cold-start fallback (see §1). See §8 for the one-command verification.
- **Vision/images**: native `ChatMessagePrompt.images #10` is verified by the
  extracted Devin schema and a successful SWE-1.7 image request. It is enabled
  by default; set `DEVIN_CONNECT_IMAGE_TAG=0` only for an emergency rollback.
  Images only reach the model on **user** turns: measured 2026-10-21, the same
  image on an assistant turn is accepted on the wire but ignored upstream (the
  model reports no image), so an image-only assistant turn is dropped before
  encoding. That drop is logged and counted (`assistant_images_dropped` on
  `/dashboard/api/connect-metrics`); move the image to a user turn.
- **Router models** (`adaptive`, `arena-*`): resolution via AssignModel is built
  but gated OFF (`DEVIN_CONNECT_ASSIGN_MODEL` unset) because the wire tags are
  inferred, not yet calibrated on a paid round-trip. §8 has the enable path.
- **Sequential tool calls** (`parallel_tool_calls:false`, or Anthropic's
  `tool_choice.disable_parallel_tool_use`): the request is always SERVED — the
  field is a preference and never a 400 (Codex 0.164 sends it on every request;
  the old refusal made the CLI unusable) — but the hint is only forwarded upstream
  when `DEVIN_CONNECT_TOOL_CHOICE=1` (unconfirmed `#11` tag). Otherwise the model
  may return several calls in one turn; the drop is logged once per process
  (`event=parallel_tool_calls_hint_ignored`) and counted per request as
  `parallel_tool_calls_hint_ignored` on `/dashboard/api/connect-metrics`.
- **Billing passthrough**: cache token tags `5`/`4` ship ON by default.
  `committed_acu_cost` is descriptor-verified as top-level **double field 22**
  (`leookun/devin-2api` extract) but stays **opt-in** until a paid frame
  reconciles against official cycle ACU. §8.4.
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

### 8.0.1 PAID CALIBRATION RESULTS — captured 2026-07-27 (teams account)

The §8.0/§8.1 tooling below sat "ready, blocked on a paid token" for months. A paid
`teams` account finally ran it. Recording the outcomes so nobody re-derives them:

**§8.1 paid reachability — ANSWERED.** `tier=teams paid=true`, **13/13 selectors
reachable** (claude-opus-4-6 ×4 variants, claude-sonnet-4-6 ×4, gpt-5.2 ×5). The
long-open question "does a paid token actually reach claude/gpt, or do they
tier-wall like free?" is settled: they reach.

**Free-model wall persists on a paid account.** `swe-1-6-slow` still returns
`UPSTREAM_INTERNAL` on this teams token while every paid selector works. So the
§8.8 free-tier note is NOT purely a free-account condition — do not read a
`swe-1-6-slow` failure as "the account is dead". It also means the calibrator's
default model is the one model a paid account cannot probe (see §8.0.2).

**Cache metering — the tag calibration is CORRECT, and the GPT/Claude split is
real.** Measured by replaying one identical ~2.3k-token prefix three times per
family through `/v1/chat/completions` (stable `user` field to pin the callerKey):

| | 1st call | 2nd call | 3rd call |
|---|---|---|---|
| **claude-sonnet-4.6** | `cache_creation=2268`, cached=none | `cached_tokens=2262`, creation=6 | `cached_tokens=2262`, creation=6 |
| **gpt-5.2** | no cache fields at all | `cached_tokens=1280`, creation=**none** | `cached_tokens=1280`, creation=**none** |

Conclusions:
- Claude family: write-then-read behaves exactly as `DEFAULT_BILLING_TAGS`
  (`cache_read_tokens=5,cache_write_tokens=4`) assumes. Calibration confirmed.
- GPT family: `cached_tokens` (read) IS reported, `cache_creation` (tag 4) is
  **never** reported. This confirms the `devin-connect.js` note that GPT selectors
  carry no tag 4 — their full input rides tag 2. **The cost table in PR #230,
  which claimed a tag-4 cache write on `gpt-5-6-sol-max`, does not reproduce
  here.** The PR's mechanism conclusion (rotating accounts re-pays for context)
  still holds — it is demonstrated by the Claude row above — but the GPT numbers
  in that table should not be treated as calibration data.
- **Historic note, superseded by O2 (2026-10-25):** at calibration time
  `prompt_tokens` excluded both cached and created tokens (Claude reported
  `prompt=3` while 2268 rode the cache fields), matching #118. That made a
  cache-WRITE turn report the tiny fresh tail as the prompt; it now reports
  `fresh + cache_read + cache_write`. The raw counters in the table above are
  unchanged — only the wire mapping changed (see §8.6).

**`actual_model_uid` (#47) — independently re-confirmed.** The dump shows
`sub #7.9 string="claude-sonnet-4-6"`, i.e. the concrete model rides the #7
metadata sub-message at inner tag 9 — matching the 2026-07-05 opus-4-8 frame
verification already noted in `devin-connect.js`. So
`DEVIN_CONNECT_ACTUAL_MODEL_TAG=9` is confirmed on a second model family. (Wire
position confirmed; the decode wiring was not separately exercised.)

**Newly surfaced paid-only fields** (dumped, NOT wired — pin deliberately):

| Position | Value seen | Reading |
|---|---|---|
| `#7.7` | `"msg_011CdRd3offZL5QAzA7LaNTb"` | upstream (Anthropic) message id |
| `#7.8` | nested, `Date: Mon, 27 Jul 2026 …` | upstream response headers |
| `#7.9` | `"claude-sonnet-4-6"` | actual_model_uid (see above) |
| `#28` | `"Token Usage"` block, incl. `cached_input_tokens` / `"Cached input tokens"` | human-readable usage/labels block — the `#28` trailer §8.0 flagged |
| `#2.{1,2}` | `1785112410`, `85016380` | epoch-second timestamps, NOT billing |

### 8.0.2 Calibrator gotcha: pass a SELECTOR, not an alias

`streamChat` takes `model` RAW — alias resolution lives in the chat handler, not
the transport — so `CALIBRATE_MODEL=claude-sonnet-4.6` (dotted alias) produced
`UPSTREAM_INTERNAL`, **indistinguishable from a dead token or a walled account**,
which is precisely the state a paid calibration run is trying to diagnose. Two paid
runs were burned on this. `scripts/devin-connect-calibrate.mjs` now resolves the
alias itself and logs `resolved alias X -> selector Y`, so either form works.

**Alias vs selector on the client surface (O1, measured 2026-10-25).** Two
spellings that look like the same model select DIFFERENT upstream variants:

| Client asks for | Upstream selector | Notes |
|---|---|---|
| `claude-sonnet-4.6` (dotted) | `claude-sonnet-4-6-thinking` | curated alias default; thinking tokens, credit 6 |
| `claude-sonnet-4-6` (dashed) | `claude-sonnet-4-6` | base catalog selector; no reasoning_content, credit 4 |

Both resolve `mapped:true`; the alias is deliberate (only the dotted family carries
the `-thinking` default) and must not be "fixed". A client that wants the base model
has to use the dashed catalog spelling — omp 18.12.6 asks for the dotted name, so
every omp turn on the windsurf group runs the thinking variant.

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

### 8.2 Re-calibrate the vision image tag after an upstream wire change

The production default is the verified tag `10`; ordinary SWE-1.7 input keeps
the image on its source=USER message and does not synthesize tool turns. This
probe remains only as an emergency diagnostic if a future Devin release changes
the protobuf layout. On a hit it writes `devin-connect-image-tag.json`
(gitignored) and prints the exact env override.

```sh
IMAGE_CALIBRATE_REAL=1 CONNECT_SMOKE_TOKEN=<paid-vision-token> \
  IMAGE_CALIBRATE_MODEL=claude-opus-4.8 npm run calibrate:devin-image
# only after a confirmed upstream migration, put the printed override in .env.
```

Include the current known-good tag in the sweep, for example
`IMAGE_CALIBRATE_TAGS=10,4,5,6,7`; do not change production from `10` on a
single ambiguous response.

### 8.3 Enable router models — adaptive / arena-* (AssignModel)

`adaptive`/`arena-*` are routers the server resolves per request via AssignModel;
GetChatMessage rejects the bare router uid. Turn the hop on:

```sh
# .env:
DEVIN_CONNECT_ASSIGN_MODEL=1
# If a real AssignModel round-trip shows different tags than our defaults
# (req_model_uid=2, req_cascade_id=3, resp_assignment=1, asg_model_uid=2,
# asg_jwt=1, asg_harness=3), pin them:
DEVIN_CONNECT_ASSIGN_TAGS="req_model_uid=2,req_cascade_id=3,resp_assignment=1,asg_model_uid=2,asg_jwt=1,asg_harness=3"
# Extra router names/prefixes:  DEVIN_CONNECT_ROUTER_MODELS="auto,smart-*"
```

The defaults above are the post-`86d5543` set (2026-10-15), read from
`ASSIGN_TAGS_DEFAULT` (`src/devin-connect-catalog.js:521-527`): the request now carries
`cascade_id` (#3, the schema marks it required) and `ModelAssignment`'s `model_uid` /
assignment-blob numbers were corrected (they had been swapped). An `.env` that pinned the
old set — `req_model_uid=2,resp_assignment=1,asg_model_uid=1,asg_jwt=2,asg_harness=3` — must
be re-pinned or dropped; it would re-point `asg_model_uid` at the JWT field and omit
`cascade_id` entirely.

A failed/empty resolve degrades gracefully to the original selector and bumps
the `assign_model_failed` counter on `/connect-metrics` — it never fails the
request. Calibrate by capturing one real AssignModel response and confirming the
decoded `model_uid` is a sane concrete selector.

### 8.4 Surface billing cost in usage (credit/acu)

The response carries `credit_cost`/`committed_credit_cost`/`committed_acu_cost`.
Cache token tags are default-on (`5`/`4`). ACU `#22` is still opt-in — free-tier
zeros are omitted on the wire, and live paid reconcile is not in this repo. Once known:

```sh
# Default already decodes cache_read_tokens=5,cache_write_tokens=4.
# ACU field number/type is in the Language Server descriptor (double #22).
# Still opt-in: protobuf omits zeros; live paid reconcile is not in this repo.
DEVIN_CONNECT_BILLING_TAGS=cache_read_tokens=5,cache_write_tokens=4,committed_acu_cost=^22
```

`^` means top-level of `GetChatMessageResponse`, not the `#7` metadata sub-message.
Unset `DEVIN_CONNECT_BILLING_TAGS` keeps the cache-only default. Set to `off` to decode nothing.

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
verified field names). Absent on free tier (no caching). Live default already
pins `5`/`4`; unset `DEVIN_CONNECT_BILLING_TAGS` keeps that map. Set `off` to
decode nothing. The decoder routes cache_* into `usage` (OpenAI-standard shapes)
instead of billing:

```sh
# Paid-verified (live default): cache_read=5, cache_write=4.
# Do not copy the pre-calibration guess credit_cost=6 / cache=14/15.
DEVIN_CONNECT_BILLING_TAGS=cache_read_tokens=5,cache_write_tokens=4
```

`usage` then gains `prompt_tokens_details.cached_tokens` (from cache_read),
`fresh_input_tokens` (from prompt) and `cache_creation_input_tokens` (from
cache_write). Unset = the cache-only default. Set `off` = no cache counters
decoded; `prompt_tokens_details.cached_tokens: 0` and `fresh_input_tokens` still
come from the prompt/completion fields, which are always decoded.

**`prompt_tokens` is the full input on this path** (O2, measured 2026-10-25):
`fresh + cache_read + cache_write`, so a cache-WRITE turn no longer reports the
tiny fresh remainder as the prompt (omp showed "3 in" for an 11.5k prompt on 2/7
turns — exactly the two prefix-miss turns). `total_tokens = prompt_tokens +
completion_tokens` always; `WINDSURFAPI_STRICT_USAGE_TOTAL` is a no-op here. The
Cascade path keeps the #118 split (cache_write outside `prompt_tokens`), which is
why consumers must read `fresh_input_tokens` instead of re-deriving
`prompt_tokens - cached_tokens`.

### 8.7 finish_reason calibration (already live, free-tier safe)

`mapFinishReason` maps the upstream `StopReason` enum (recon variant order:
`end_turn, max_tokens, max_turn_requests, refusal, cancelled`) to the OpenAI
vocabulary. **Two integers are LIVE-ANCHORED and must not be changed without a
capture that contradicts them:**

| value | maps to | evidence |
|---|---|---|
| `2` | `stop` | free-tier normal completion (verified) |
| `4` | `stop` | **paid teams** normal completion, calibrated 2026-07-27 — three probes on claude-sonnet-4.6 (`max_tokens` 300 / 8 / 40) all returned 4, and the `max_tokens=300` one answered "HI" (2 chars, unambiguously complete) |

`mapFinishReason` reads the descriptor-backed `STOP_REASON_DEFAULT` table
(`src/devin-connect.js:2884-2899`) and applies `DEVIN_CONNECT_STOP_REASON_MAP`
overrides on top (`:2920-2938`). The shipped map is:

| value | maps to | note |
|---|---|---|
| `0` | `stop` | `STOP_REASON_UNSPECIFIED` |
| `1` | `length` | `INCOMPLETE` |
| `2` | `stop` | **live-anchored** free-tier normal completion (verified) |
| `3` | `length` | `MAX_TOKENS` |
| `4` | `stop` | **live-anchored** paid teams normal completion, calibrated 2026-07-27 — three probes on claude-sonnet-4.6 (`max_tokens` 300 / 8 / 40) all returned 4, and the `max_tokens=300` one answered "HI" (2 chars, unambiguously complete) |
| `5` | `length` | `MAX_NEWLINES` |
| `6` | `stop` | `EXIT_SCOPE` |
| `7` | `stop` | `NONFINITE_LOGIT_OR_PROB` |
| `8` | `stop` | `FIRST_NON_WHITESPACE_LINE` |
| `9` | `length` | `PARTIAL` |
| `10` | `tool_calls` | `FUNCTION_CALL` |
| `11` | `content_filter` | `CONTENT_FILTER` |
| `12` | `stop` | `NON_INSERTION` |
| `13` | `error` | `ERROR` |

Only values **outside 0–13** (or non-numeric) fall back to `stop`
(`src/devin-connect.js:2994-3002`, logged once per distinct value). The earlier
wording — "every other value maps to
`stop`", with `3 → length` and `5 → content_filter` described as retired guesses —
was wrong: `3 → length` and `5 → length` are live, and `5` is `MAX_NEWLINES`, not
`CONTENT_FILTER` (`11`). A spurious `length` or `content_filter` closes a
`/v1/responses` turn as `response.incomplete` (a whole-turn hard failure for
Codex-style clients), and `content_filter` additionally surfaces on `/v1/messages`
as Anthropic `stop_reason:'refusal'` — reporting a completed answer as the model
refusing.

**Truncation is detected from usage, not from the enum.** `resolveFinishReason`
reports `length` when `completion_tokens` lands exactly on the cap the caller
requested — the same test an OpenAI client would apply itself, and one that does
not depend on un-calibrated integers. The check is conservative by design (exact
equality, and only when the caller set a cap), because reporting a complete answer
as truncated is the more harmful error: clients that auto-continue on `length`
would loop on a finished response.

An operator with a real capture is a better authority than either mechanism and
can override any integer — the value must be one of `stop` / `length` /
`tool_calls` / `content_filter` (`src/devin-connect.js:2927`) — and an explicit
override for a value also takes precedence over the usage inference:

```sh
# Example: treat INCOMPLETE (1) and ERROR (13) as clean stops.
DEVIN_CONNECT_STOP_REASON_MAP="1=stop,13=stop"
```

The old example `"1=stop,2=stop,3=length,5=content_filter"` was wrong twice: it
mapped `5` (`MAX_NEWLINES`) to `content_filter`, and it presented default entries
as if they were calibrations. `11` is `CONTENT_FILTER`; `8` is
`FIRST_NON_WHITESPACE_LINE → stop`.

Unknown values always fall back to `stop` so a finished stream is never an error.
Note: both historical probes (free tier 16 vs 1000, paid 16 vs 4096) saw the cap
ignored — but BOTH ran while the encoder had `max_tokens` on the wrong field (#3,
which is `max_newlines`; corrected 2026-08-09, see §8.9). Neither probe therefore
measured `max_tokens` at all. Re-run them before concluding anything about upstream
enforcement, and note that a genuinely truncated turn is what the `3 → length` /
`5 → length` entries describe; change them only from a real capture.

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

### 8.8b Surface actual_model_uid (router resolution signal)

For router selectors (`adaptive`/`arena-*`, see §8.3) the response carries
`actual_model_uid` — the concrete model that actually served the turn. Useful to
verify AssignModel resolved sanely. It rides the `#7` metadata sub-message at
inner tag `9` (frame-verified 2026-07-05, paid teams). It is not a top-level
string. Unset = null. To surface it:

```sh
# #7 inner tag 9, frame-verified 2026-07-05 (paid teams). Not top-level #13.
DEVIN_CONNECT_ACTUAL_MODEL_TAG=9
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

TAG MAP CORRECTED (2026-08-09): `max_tokens` is field **#2**, not #3 — #3 is
`max_newlines`. Four independent `.proto` definitions of `CompletionConfiguration`
(reverse-engineered by unrelated projects) agree, and the encoder now matches
(`src/devin-connect.js` `buildCompletionConfig`, pinned byte-level by
`test/completion-config-max-tokens-tag.test.js`). The old layout sent the 128000
context window as `max_tokens`, i.e. the cap was pinned wide open.

STILL UNRESOLVED: the swap explains the free-tier probe (16 vs 1000 → identical
output: the cap never reached the enforcing field) but it does **not** explain the
paid re-check recorded in §8.7 (16 vs 4096 → byte-identical output). The paid tier
is where a cap should be honoured, so that data point remains unaccounted for.
Treat "max_tokens is now enforceable" as a schema-backed expectation, NOT a
measured fact, until a paid capture shows a request with a small cap actually
truncating. The change is wire-safe either way: a large `max_newlines` is a no-op.

### 8.10 Native tool definitions (groundwork, paid-calibration gated)

The calibrated proto verifies the repeated `tools` field at request #10, but the
inner ToolDef subfield layout (name/desc/schema tags) was never decoded from a
free capture. So native tool defs are OFF by default — tools keep riding the
prompt via emulation, which works on every model. The request builder forwards
`tools` and self-gates: nothing is emitted unless the inner tags are calibrated.

To enable after a paid capture (§8.5) reveals the ToolDef inner tags:

```sh
DEVIN_CONNECT_TOOL_DEF_TAGS="outer=10,name=1,description=2,parameters=3"
```

Named form (the supported one; the legacy positional `10,1,2,3` is back-compat
only and must be exactly four numbers). Order: outer repeated tag (verified =10),
then the name/description/schema subfield tags. Malformed or wrong-arity → fails
closed to emulation (never a broken frame). Live-verified: forwarding tools with the gate OFF produces an
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

### 8.11 Session continuity (`DEVIN_CONNECT_SESSION_REUSE`) — default OFF

Every DEVIN_CONNECT request carries a protobuf session id in field `#16`. With
the switch unset (the shipped default), the handler mints a fresh `randomUUID()`
per call, so one multi-turn dialog looks like N brand-new sessions to the
upstream velocity limiter and prompt-cache reuse depends on prefix luck.

Measured 2026-10-25 (omp 18.12.6, 7 requests, 3 conversations): **7/7 distinct
session ids**, including three consecutive turns of one conversation. That is
the documented default behaviour, not a lost client path — the client never
sends a session id.

With reuse ON, `src/session-continuity.js` derives a stable id from the
conversation's own completed request/response pair chain (never from
requestId/IP/timestamp); parallel dialogs on the same key stay independent.
In-memory only, 30-minute TTL, 500 tracked dialogs by default:

```sh
DEVIN_CONNECT_SESSION_REUSE=1
# Optional features — both require the main gate:
DEVIN_CONNECT_MODEL_CONFIG_STABLE=0     # stable #15.1 + monotonic #15.2
DEVIN_CONNECT_SESSION_REASONING_INJECT=0
# Store sizing (only meaningful while reuse is on):
DEVIN_CONNECT_SESSION_TTL_MS=1800000
DEVIN_CONNECT_SESSION_MAX_STATES=500
```

Turning it on is a POLICY change, not a bug fix: the upstream session-limit
behaviour behind it is why the default stayed off. The 2026-10-25 capture did
NOT run with the gate on, so its effect on cache-hit rate and velocity limiting
is `[INFERENCE]` from the code path, not a measurement.

**Observability (added with O2/O3).** The handler now always names the source:
reuse ON logs `DEVIN_CONNECT session reuse active → session_id=… acct=…`; reuse
OFF logs `DEVIN_CONNECT session_id source=fresh-per-request
(DEVIN_CONNECT_SESSION_REUSE off …)` once at info and per request at debug. A
default deployment can therefore tell "continuity is off" from "reuse was
expected but missed".
