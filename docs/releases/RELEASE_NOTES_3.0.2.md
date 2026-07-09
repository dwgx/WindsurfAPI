# v3.0.2 — Foolproof deploy, public onboarding, global settings

2026-07-09 (UTC+9)

A feature + hardening release focused on making WindsurfAPI easy and safe for
anyone to deploy and operate, with a much stronger account-onboarding surface.

## Added

- **Global Settings page.** New dashboard panel for shared preferences and
  security thresholds (stored server-side, shared across browsers). Adjust the
  email / dashboard-IP lockout thresholds and durations, or disable a lockout
  entirely by setting its threshold to `0`.
- **Public remote onboarding.** Add accounts from a public deployment, not just
  loopback: email/password login can optionally encrypt-and-store the password
  for auto-relogin (gated by `DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE=1` + an
  explicit per-request opt-in), plus an in-memory OAuth session flow
  (`/oauth/start` · `/oauth/callback` · `/oauth/status`) that lets you finish
  Google/GitHub/Devin sign-in in your own browser and paste the callback URL
  back — no localhost callback needed.
- **OAuth login chooser.** Clicking Google/GitHub offers "open login page" vs
  "copy login URL", with a "don't ask again" preference (re-enable it from
  Settings).

## Fixed

- **Deploy foolproofing (both Docker and bare source).**
  - `DEVIN_CONNECT` / `DEVIN_ONLY` deployments skip the language-server startup
    and its auto-install entirely — no more downloading a ~100 MB binary a
    binary-less Devin deploy never uses, and no spawn/ENOENT noise on boot.
  - `docker compose up` on a fresh clone no longer aborts on a missing `.env`
    (`env_file` is now optional); the bundled nginx LB sets `TRUST_PROXY_*` so
    per-caller lockout works behind it.
  - `install-ls.sh` runs under a timeout so a slow network can't hang boot;
    `DATA_DIR` mkdir failures are surfaced instead of silently swallowed.
- **Dashboard lockout false-positives.** Opening the dashboard fired ~a dozen
  authenticated API calls with an empty password before you'd typed anything,
  and each empty-password `401` counted as a failed attempt — banning your IP
  the instant the page loaded. Empty-password preloads no longer count; only a
  submitted wrong password does. The frontend now halts polling and shows a
  countdown on `429` instead of stacking error toasts.
- **Lockouts are configurable and releasable.** Setting a lockout threshold to
  `0` now releases any active ban immediately (not just at natural expiry). A
  no-password / OAuth-only account no longer counts a wrong-method attempt
  toward the email lockout.
- **Account onboarding token routing.** A `devin-session-token$…` pasted into
  the OAuth flow or smart-import is now added via the api-key path, not the
  Firebase-only RegisterUser path, so session-token onboarding succeeds.
- **Credential-store gate hardened for reverse proxies.** The "store my
  password" gate now requires the request to come from a loopback peer (not
  just a loopback bind host), so a reverse proxy in front can't let a remote
  user bypass the operator opt-in.

## Notes

- No breaking API changes. Docker users: `docker compose pull && docker compose up -d`.
- All new UI is fully bilingual (English + 简体中文). Plaintext passwords and
  tokens are never written to logs.
