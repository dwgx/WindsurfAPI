#!/usr/bin/env node
// Verify a downloaded WindsurfAPI release against its cosign keyless signatures.
//
// The release workflow signs five blobs — the four published binaries/zips and
// SHA256SUMS — and publishes one signature bundle per blob:
//
//   <name>.sigstore.json   Sigstore bundle (signature + Fulcio certificate +
//                          Rekor inclusion proof), the only artifact the
//                          release workflow publishes for each signed blob
//
// The bundle is the durable proof. Fulcio certificates live for minutes, so a
// detached certificate only verifies while it is still inside its validity
// window; the bundle's signed Rekor entry is what lets cosign verify the same
// bytes years later. This helper therefore verifies bundles only.
//
// It never downloads anything: point it at a directory that already contains
// the release assets. Cosign v3 or newer must be installed (https://docs.sigstore.dev).
//
// Usage:
//   node scripts/verify-release-assets.mjs [dir]
//   node scripts/verify-release-assets.mjs --dir downloads --cosign /usr/local/bin/cosign
//
// Exit codes: 0 verified, 1 verification failed, 2 usage/environment error.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The four assets the release `files:` block publishes, by release-asset name. */
export const RELEASE_ASSETS = Object.freeze([
  'windsurfapi.exe',
  'windsurfapi-windows.zip',
  'windsurfapi-macos-arm64',
  'windsurfapi-macos.zip',
]);

export const MANIFEST_NAME = 'SHA256SUMS';
export const SIGNATURE_SUFFIXES = Object.freeze(['.sigstore.json']);

// The certificate identity is the workflow ref that GitHub's OIDC token
// carries for a tag push. Keep this in sync with the workflow path; the
// workflow test asserts both.
export const DEFAULT_IDENTITY_REGEXP =
  String.raw`^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$`;
export const DEFAULT_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * Parse `sha256sum` output into a name -> digest map.
 *
 * The manifest is flat by contract: release assets have no directories, and
 * accepting `../` or absolute names here would let a manifest read outside the
 * download directory. Reject both instead of silently normalising.
 */
export function parseManifest(text) {
  const entries = new Map();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (!match) {
      throw new CliError(`SHA256SUMS line ${index + 1} is not "<64 hex> <name>": ${raw}`);
    }
    const [, digest, name] = match;
    if (
      name !== name.trim()
      || name === '.'
      || name === '..'
      || name.startsWith('/')
      || name.includes('/')
      || name.includes('\\')
      || name.includes('\0')
      || name.includes(':')
    ) {
      throw new CliError(`SHA256SUMS line ${index + 1} has an unsafe or non-flat name: ${name}`);
    }
    if (entries.has(name)) {
      throw new CliError(`SHA256SUMS lists ${name} more than once`);
    }
    entries.set(name, digest);
  }
  return entries;
}

/** Require the manifest to cover exactly the published assets and match their bytes. */
export async function verifyManifest(entries, dir) {
  const expected = new Set(RELEASE_ASSETS);
  for (const name of entries.keys()) {
    if (!expected.has(name)) {
      throw new CliError(`SHA256SUMS names a file this release does not publish: ${name}`);
    }
  }
  for (const name of expected) {
    if (!entries.has(name)) {
      throw new CliError(`SHA256SUMS is missing ${name}`);
    }
  }
  for (const [name, digest] of entries) {
    const actual = await sha256File(join(dir, name));
    if (actual !== digest) {
      throw new CliError(`SHA-256 mismatch for ${name}: manifest ${digest}, file ${actual}`);
    }
  }
}

export function runCosignCommand(cosign, args) {
  const result = spawnSync(cosign, args, { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new CliError(
        `cosign not found (${cosign}); install Cosign v3 from https://docs.sigstore.dev or pass --cosign <path>`,
        2,
      );
    }
    throw new CliError(`failed to run cosign: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const blob = args[args.length - 1];
    throw new CliError(`cosign verification failed for ${blob}${detail ? `:\n${detail}` : ''}`);
  }
}

function verifyArgs(dir, name, identity, issuer) {
  return [
    'verify-blob',
    '--bundle',
    join(dir, `${name}.sigstore.json`),
    '--certificate-identity-regexp',
    identity,
    '--certificate-oidc-issuer',
    issuer,
    join(dir, name),
  ];
}

/**
 * Verify every signature bundle and the signed manifest hashes.
 *
 * `runCosign` is injectable so the tests can exercise ordering and failure
 * handling without a cosign binary; production callers use the default.
 */
export async function verifyDirectory(dir, options = {}) {
  const runCosign = options.runCosign ?? runCosignCommand;
  const cosign = options.cosign ?? process.env.COSIGN ?? 'cosign';
  const identity = options.identity ?? DEFAULT_IDENTITY_REGEXP;
  const issuer = options.issuer ?? DEFAULT_OIDC_ISSUER;
  const log = options.log ?? (() => {});
  const signed = [...RELEASE_ASSETS, MANIFEST_NAME];

  const missing = [];
  for (const name of signed) {
    if (!isFile(join(dir, name))) missing.push(name);
    for (const suffix of SIGNATURE_SUFFIXES) {
      if (!isFile(join(dir, `${name}${suffix}`))) missing.push(`${name}${suffix}`);
    }
  }
  if (missing.length > 0) {
    throw new CliError(`missing release files in ${dir}: ${missing.join(', ')}`);
  }

  // Trust anchor first: the manifest's own signature. Everything after this
  // point relies on bytes that signature covers.
  await runCosign(cosign, verifyArgs(dir, MANIFEST_NAME, identity, issuer));
  log(`verified signature: ${MANIFEST_NAME}`);

  const entries = parseManifest(readFileSync(join(dir, MANIFEST_NAME), 'utf8'));
  await verifyManifest(entries, dir);
  log(`verified hashes: ${entries.size} manifest entries`);

  for (const name of RELEASE_ASSETS) {
    await runCosign(cosign, verifyArgs(dir, name, identity, issuer));
    log(`verified signature: ${name}`);
  }

  return { signed, manifestEntries: entries.size };
}

function usage() {
  return `Verify a downloaded WindsurfAPI release against its cosign signatures.

Usage:
  node scripts/verify-release-assets.mjs [options] [dir]

Arguments:
  dir                        directory holding the downloaded assets (default: .)

Options:
  --dir <dir>                same as the positional argument
  --cosign <path>            Cosign v3 or newer binary (default: $COSIGN, then "cosign")
  --identity <regexp>        certificate identity regexp
  --tag <vX.Y.Z>             pin the exact release tag (builds the identity regexp)
                             (default: ${DEFAULT_IDENTITY_REGEXP})
  --issuer <url>             OIDC issuer (default: ${DEFAULT_OIDC_ISSUER})
  -h, --help                 show this help

The directory must contain ${[...RELEASE_ASSETS, MANIFEST_NAME].join(', ')}
plus one .sigstore.json bundle per signed file. Verify with Cosign v3 or newer.
Exit codes:
0 verified, 1 verification failed, 2 usage/environment error.`;
}

export async function main(argv) {
  const options = { dir: process.cwd() };
  let positional = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      return 0;
    }
    if (arg === '--dir' || arg === '--cosign' || arg === '--identity' || arg === '--issuer' || arg === '--tag') {
      const value = argv[index + 1];
      if (value === undefined || value === '') {
        throw new CliError(`${arg} needs a value`, 2);
      }
      index += 1;
      if (arg === '--dir') options.dir = value;
      if (arg === '--cosign') options.cosign = value;
      if (arg === '--identity') options.identity = value;
      if (arg === '--issuer') options.issuer = value;
      if (arg === '--tag') options.tag = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CliError(`unknown option: ${arg}`, 2);
    }
    if (positional !== null) {
      throw new CliError('only one download directory may be given', 2);
    }
    positional = arg;
  }
  if (positional !== null) options.dir = positional;

  options.dir = resolve(options.dir);
  if (options.tag) {
    const tag = options.tag.startsWith('v') ? options.tag : `v${options.tag}`;
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) {
      throw new CliError(`--tag must be vX.Y.Z, got ${options.tag}`, 2);
    }
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    options.identity = `^https://github\\.com/dwgx/WindsurfAPI/\\.github/workflows/release\\.yml@refs/tags/${escaped}$`;
  }
  const result = await verifyDirectory(options.dir, {
    cosign: options.cosign,
    identity: options.identity,
    issuer: options.issuer,
    log: (message) => console.log(message),
  });
  console.log(
    `Verified ${result.signed.length} signed files and ${result.manifestEntries} manifest entries in ${options.dir}`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => {
      // Set exitCode instead of calling process.exit so piped stdout is not
      // truncated before it drains.
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`error: ${err.message}`);
      process.exitCode = err instanceof CliError ? err.exitCode : 1;
    });
}
