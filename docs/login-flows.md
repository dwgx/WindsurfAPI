# Dashboard login flows

The dashboard offers account sign-in and explicit credential import. The dashboard probes the account first and
shows only the form that can work, so a password is never submitted for an
account that has none (that used to surface as `ERR_INVALID_CREDENTIALS`).

| Account shape | What the probe returns | What the dashboard shows |
|---|---|---|
| Password account | `has_password: true` | email + password |
| Email-code account (most OAuth signups) | `has_password: false`, email connection enabled | email + **verification code** form |
| OAuth-only account | `has_password: false`, no email connection | Devin website and existing integration credential |
| No such account | `method: "not_found"` | "No Windsurf account uses this email" |
| Probe unavailable | nothing usable | password form, plus the code form as a fallback |

The probe is `POST /_devin-auth/connections` (`auth_method.has_password`), which
is exactly what windsurf.com's own login page branches on. `CheckUserLoginMethod`
returns `{}` for real accounts and is only an enrichment when connections cannot
answer.

## 1. Password login

1. Add-account modal → **登录** tab.
2. Type the email. The probe runs on blur and prints the detected method.
3. `has_password: true` → type the password → **登录**.
4. On success the account is added to the pool and the masked key is shown.

The backend never calls `password/login` when the probe says
`has_password: false`, and never counts that answer toward the per-email
lockout. If the probe is unavailable **and** the password is rejected, the
error carries `probeUnknown: true` and the UI offers the email-code or existing-credential alternatives instead of a dead end.

## 2. Email-code login

1. Type the email. The probe runs on blur; an account without a password shows
   the code form immediately.
2. Click **登录** (or **发送验证码**) — this calls
   `POST /_devin-auth/email/start` `{email, mode:"login", product:"Windsurf"}`.
   One send per click; the upstream `email_verification_token` stays in server
   memory keyed by an opaque `flowId` and is never returned to the browser.
3. The status line reads "Code sent to …", the send button counts down 30 s.
4. Type the 6-digit code → **验证并登录** →
   `POST /_devin-auth/email/complete` → Auth1 token → `WindsurfPostAuth` →
   `devin-session-token$…`, stored as the pool key.

Notes:

- The code is single-use upstream. A PostAuth failure keeps the Auth1 token for
  2 minutes so "retry the same code" works without a new email (max 3 exchange
  attempts).
- Only a positive "invalid verification code" answer feeds the email lockout. An
  expired token (`401 Invalid verification token`) drops the flow and locks
  nothing.
- **Mail not received?** Use *"没收到邮件？改用 app.devin.ai 发送"* under the code
  form. It calls `POST /api/auth1/email/start` on app.devin.ai (Devin's own
  payload: `{email, mode:"login"}`) and verifies on the same host. This is an
  explicit operator choice, not the automatic cross-host fallback, so it works
  with `DEVIN_CONNECT_LOGIN_HOST_FALLBACK` unset.
- The automatic fallback stays behind `DEVIN_CONNECT_LOGIN_HOST_FALLBACK=1`:
  `email/start` falls through to the other host only on 404/405 (proof the
  endpoint is gone) and never after a transport error, because that could send
  a second email.

## 3. Portal access and manual credential import

**Open Devin** opens [Devin](https://app.devin.ai/) in a separate tab.
Portal sign-in leaves the gateway account pool as it was. Automatic account
enrollment requires a provider-authorized integration for this gateway.

To add an account with a credential already issued for this integration, use
**Paste a credential** in the dashboard. Existing credential types and
account-bound replacement continue to use the account-management endpoints.
Keep authorization codes and client session credentials in the client that
owns the sign-in flow.

Old browser onboarding requests to /oauth/start, /oauth/callback and
/oauth/status return HTTP 410 with ERR_BROWSER_ENROLLMENT_UNAVAILABLE. Clear
the old login attempt and reopen the current account dialog.

### Local WindsurfAPI browser sign-in

A loopback instance may enable **Sign in to WindsurfAPI with Devin** by setting
DEVIN_BROWSER_LOGIN=1 and binding directly to 127.0.0.1. Open the Devin page
from the account dialog. The provider must accept the instance's own callback.
Then confirm account addition in the same dashboard dialog. Opening the
provider website alone leaves the account pool as it was.

Only this instance's unexpired sign-in can use its callback. Closing the
dialog cancels the transaction. The authorization code stays in process memory
and is cleared after use, cancellation, or expiry. Check the actual provider
result for this instance before treating the sign-in as supported.

## 4. Devin (app.devin.ai)

The same modal covers it, because both hosts speak the same Auth1 protocol:

- **Email code**: the *"改用 app.devin.ai 发送"* action (or the
  `DEVIN_CONNECT_LOGIN_HOST_FALLBACK=1` automatic fallback) sends and verifies on
  `app.devin.ai/api/auth1/email/{start,complete}`.
- The probe remembers which host answered (`host` in the
  `/windsurf-login/probe` response) and starts the code flow there, so a
  windsurf.com outage does not send the request straight back into it.

`[UNVERIFIED]` The final hop — feeding an Auth1 token minted on app.devin.ai
into `WindsurfPostAuth` — is exercised by the same `postAuthDualPath` exchanger
as the windsurf.com token but has not been confirmed with a live Devin account.

## Errors you may see

| Code | Meaning | What to do |
|---|---|---|
| `ERR_NO_PASSWORD_OAUTH_ACCOUNT` | the account has no password | use the code form or an existing integration credential |
| `ERR_EMAIL_NOT_FOUND` | no account for that address | check the address |
| `ERR_EMAIL_LOCKED` | 3 failed attempts for this address | wait out `retryAfterMs` |
| `ERR_EMAIL_CODE_COOLDOWN` | a code was just sent | the button counts down the remainder |
| `ERR_EMAIL_FLOW_EXPIRED` | the code/token expired or was used | request a new code |
| `ERR_EMAIL_VERIFY_UNAVAILABLE` | upstream did not answer; the code was **not** checked | retry the same code |
| `ERR_POSTAUTH_FAILED` | code accepted, session exchange failed | retry the same code within 2 min |
| `ERR_NO_TOKEN_IN_INPUT` | nothing token-shaped in the pasted text | copy the token itself or the whole URL |
| `ERR_BROWSER_ENROLLMENT_UNAVAILABLE` | the legacy browser flow has ended | reopen the account dialog and use an available method |
