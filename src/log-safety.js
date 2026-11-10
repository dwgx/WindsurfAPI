import { createHash } from 'crypto';

export function logHash(value, len = 12) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, len);
}

export function safeAccountRef(accountOrId, label = '') {
  const id = typeof accountOrId === 'object'
    ? (accountOrId?.id || 'unknown')
    : (accountOrId || 'unknown');
  const rawLabel = typeof accountOrId === 'object'
    ? (accountOrId?.email || accountOrId?.name || label || '')
    : (label || '');
  const out = `account=${id}`;
  return rawLabel ? `${out} labelHash=${logHash(rawLabel)}` : out;
}

export function accountRef(id) {
  return `acct-${logHash(id, 8)}`;
}

export function safeEmailRef(email) {
  return `emailHash=${logHash(email)}`;
}

export function safeKeyRef(key, prefix = 'key') {
  return `${prefix}Hash=${logHash(key)}`;
}

// Operator-facing errors (dashboard toast, RegisterUser wrap) used to echo
// upstream bodies that included the pasted JWT / session string (#257).
export function redactCredentialFragments(text) {
  return String(text ?? '')
    .replace(/devin-session-token\$[A-Za-z0-9._-]+/g, 'devin-session-token$[redacted]')
    .replace(/auth1_[A-Za-z0-9_-]{8,}/g, 'auth1_[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt-redacted]');
}

// Slice AFTER redaction. RegisterUser used to slice(0,120) first, which
// split a JWT at the first dot so the regex missed it. Same trap is in
// windsurf-login PostAuth / OneTimeToken error wrapping.
export function sliceRedactedJson(value, n = 120) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return redactCredentialFragments(raw).slice(0, n);
}

// Client-supplied strings (model names, selectors) are interpolated straight into
// log lines. Raw control characters let an authenticated caller forge log records
// or inject ANSI escape sequences into an operator's terminal, so strip them at
// the log boundary. Only C0/C1 controls and DEL are replaced (the value stays
// readable), and the length is bounded so one request cannot flood a line.
const LOG_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export function safeLogValue(value, max = 120) {
  const cleaned = String(value ?? '').replace(LOG_CONTROL_CHARS, '\u00b7');
  return cleaned.length > max ? `${cleaned.slice(0, max)}\u2026` : cleaned;
}

// The Gemini surface accepts the API key as `?key=` — a verbatim request-URL
// log line (https-proxy.js prints `${method} ${url}`) writes a live credential
// into the journal. Replace the value; keep the param name so the line still
// explains which carrier the client used. Applied on the raw string so a
// malformed URL cannot sneak the key past a parser.
export function redactUrlForLog(url) {
  const raw = String(url ?? '');
  return raw
    .replace(/([?&]key=)[^&\s]*/gi, '$1[redacted]')
    .replace(LOG_CONTROL_CHARS, '·');
}

// ── Subprocess environment hygiene (L3b env-leak fix) ─────────────────────
// Every spawn/exec site used to pass the full process.env (or an implicit
// inherit) to its child, forwarding the credential-store KEK
// (DEVIN_CONNECT_CRED_KEY), the proxy's own API_KEY, the dashboard password
// and any ambient CI token to binaries that never asked for them — the L3b
// audit measured 15/15 sentinel keys reaching spawned subprocesses.
//
// The language server solved the same problem with an ALLOWLIST
// (buildLanguageServerEnv in langserver.js) because the LS binary only needs
// ~8 vars. The children covered here are different: the Devin CLI and
// install-ls.sh legitimately want the operator's general environment (PATH,
// HOME, proxy/CA-trust vars, DEVIN_* CLI config, WINDSURFAPI_LS_* installer
// overrides), so these builders take a DENYLIST approach — copy everything
// that does not look like a credential, then let each call site re-add
// exactly the secrets it deliberately channels (`keep`).

// Substring layer: words that mark a credential wherever they appear,
// including fused names with no separator (PGPASSWORD, AWSSECRETACCESSKEY,
// npm_config__authToken). Proxy-internal config that trips these
// (MAX_TOKENS, *_ALLOW_*_AUTH flags) is still stripped — none of it is
// consumed by spawned children, and over-stripping is the safe side.
const SECRET_NAME_SUBSTRING =
  /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|BEARER|COOKIE/i;

// Boundary layer: short marker words that also appear inside NON-secret
// names (SSH_ASKPASS/GIT_ASKPASS hold program paths, MONKEY ends in "key"),
// so they only match at a `_` or string boundary — never mid-word.
//   stripped: SSH_AUTH_SOCK, MYSQL_PWD, npm_config__auth, BASIC_AUTH_PASS
//   kept:     SSH_ASKPASS, MONKEY, OLDPWD, DBUS_SESSION_BUS_ADDRESS
const SECRET_NAME_WORD =
  /(?:^|_)(?:KEY|AUTH|AUTHENTICATION|AUTHORIZATION|PWD|PASS|CRED)(?:_|$)/i;

// Explicit name denylist: this repo's own credentials, pinned by name so a
// future regex tune can never silently re-admit them. All of them are also
// caught by the shape tests above; the list is the audit record.
const SUBPROCESS_ENV_DENYLIST = new Set([
  'API_KEY',                  // this proxy's own inbound credential
  'DASHBOARD_PASSWORD',       // dashboard auth (runtime-rotatable)
  'DASHBOARD_PASSWORD_HASH',
  'DEVIN_CONNECT_CRED_KEY',   // KEK for the on-disk credential store
  'DEVIN_CONNECT_ADMIN_TOKEN',
  'DEVIN_CONNECT_TOKEN',      // devin-connect upstream bearer
  'DEVIN_BACKEND_TOKEN',
  'DEVIN_API_KEY',
  'DEVIN_CLI_API_KEY',
  'WINDSURF_API_KEY',         // upstream Windsurf credential (re-added by
                            // the devin -p site as the deliberate channel)
  'CODEIUM_API_KEY',
  'CODEIUM_AUTH_TOKEN',
  'CODEIUM_PASSWORD',
  'ASTRAFLOW_API_KEY',
  'ASTRAFLOW_CN_API_KEY',
  'GMAIL_IMAP_PASSWORD',      // email-otp dashboard login
]);

function isSecretEnvName(name) {
  return SUBPROCESS_ENV_DENYLIST.has(name)
    || SECRET_NAME_SUBSTRING.test(name)
    || SECRET_NAME_WORD.test(name);
}

// Filtered copy of `source`: every var except secret-shaped names. `keep`
// re-admits specific names the call site deliberately channels to the child
// (e.g. the devin -p pool-credential var, SSH_AUTH_SOCK for agent git work).
// Entries with null/undefined values are never copied.
export function buildSubprocessEnv(source = process.env, { keep = [] } = {}) {
  const keepSet = new Set(keep);
  const env = {};
  for (const key of Object.keys(source)) {
    if (source[key] == null) continue;
    if (!keepSet.has(key) && isSecretEnvName(key)) continue;
    env[key] = source[key];
  }
  return env;
}

// Strict allowlist for the STRICTEST children — a PATH-resolved probe like
// `devin --version` where a hijacked binary is the threat model. The child
// gets only what it needs to load and run; no proxy vars, no HOME secrets
// beyond the directory itself, nothing an OS needs beyond the platform set.
const MINIMAL_ENV_ALLOWLIST = new Set([
  'HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
  'USER', 'LOGNAME', 'SHELL',
]);
const MINIMAL_ENV_ALLOWLIST_WIN32 = new Set([
  // Windows env keys are case-insensitive (`Path`, `ComSpec`), so the win32
  // build compares uppercased names and preserves the source spelling.
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'PROGRAMDATA',
  'PUBLIC', 'PROCESSOR_ARCHITECTURE', 'OS', 'NUMBER_OF_PROCESSORS',
  'PSMODULEPATH', 'USERNAME', 'USERDOMAIN',
]);

export function buildMinimalSubprocessEnv(source = process.env, { platform = process.platform } = {}) {
  const env = {};
  if (platform === 'win32') {
    for (const key of Object.keys(source)) {
      const upper = key.toUpperCase();
      if (source[key] == null) continue;
      if (MINIMAL_ENV_ALLOWLIST.has(upper) || MINIMAL_ENV_ALLOWLIST_WIN32.has(upper)) {
        env[key] = source[key];
      }
    }
    return env;
  }
  for (const key of MINIMAL_ENV_ALLOWLIST) {
    if (source[key] != null && source[key] !== '') env[key] = source[key];
  }
  return env;
}
