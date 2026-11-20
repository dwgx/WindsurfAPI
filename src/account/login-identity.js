/** Case- and whitespace-insensitive identity key. */
export function normalizeLoginIdentity(email) {
  return String(email ?? '').trim().toLowerCase();
}

/** A verified address, including historical credential-store bindings. */
export function accountLoginIdentity(account) {
  return normalizeLoginIdentity(account?.identityEmail) || normalizeLoginIdentity(account?.credentialEmail);
}

/** The address proved by a successful upstream login. */
export function loginResultIdentity(result) {
  return normalizeLoginIdentity(result?.identityEmail) || normalizeLoginIdentity(result?.email);
}
