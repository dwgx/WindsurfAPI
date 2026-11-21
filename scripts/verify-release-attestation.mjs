#!/usr/bin/env node
// Verify the D9 source-OTA attestation before an update mutates Git.
//
// Used by update.sh; the dashboard calls the same module directly. Exit codes:
//   0  proceed (verified, or a warn-mode downgrade was logged)
//   1  refuse (mismatch, invalid signature, or missing material in required mode)
//   2  usage/environment error
//
// Usage:
//   node scripts/verify-release-attestation.mjs --tag v1.2.3 --commit <sha> \
//     [--dir <attestation dir>] [--repository dwgx/WindsurfAPI] \
//     [--mode warn|required] [--cosign <path>] [--identity <regexp>] [--issuer <url>]

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ATTESTATION_FILENAME,
  DEFAULT_ATTESTATION_IDENTITY_REGEXP,
  DEFAULT_OIDC_ISSUER,
  ReleaseAttestationError,
  normalizeAttestationMode,
  verifyReleaseAttestation,
} from '../src/release-attestation.js';

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const options = {
    tag: '',
    commit: '',
    tree: '',
    dir: '',
    repository: '',
    mode: 'warn',
    cosign: '',
    identity: DEFAULT_ATTESTATION_IDENTITY_REGEXP,
    issuer: DEFAULT_OIDC_ISSUER,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (!['--tag', '--commit', '--tree', '--dir', '--repository', '--mode', '--cosign', '--identity', '--issuer'].includes(arg)) {
      throw new CliError(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value === '') throw new CliError(`${arg} needs a value`);
    index += 1;
    if (arg === '--tag') options.tag = value;
    if (arg === '--commit') options.commit = value;
    if (arg === '--tree') options.tree = value;
    if (arg === '--dir') options.dir = value;
    if (arg === '--repository') options.repository = value;
    if (arg === '--mode') options.mode = value;
    if (arg === '--cosign') options.cosign = value;
    if (arg === '--identity') options.identity = value;
    if (arg === '--issuer') options.issuer = value;
  }
  if (!options.tag) throw new CliError('--tag is required');
  if (!options.commit) throw new CliError('--commit is required');
  options.mode = normalizeAttestationMode(options.mode);
  return options;
}

export function usage() {
  return `Verify a WindsurfAPI release attestation before a source update.

Usage:
  node scripts/verify-release-attestation.mjs --tag <vX.Y.Z> --commit <sha> [options]

Options:
  --tag <vX.Y.Z>       selected release tag (required)
  --commit <sha>       peeled tag commit that the update will install (required)
  --tree <sha>         tree object of that commit for exact source verification
  --dir <dir>          pre-staged directory containing ${ATTESTATION_FILENAME}
                       and ${ATTESTATION_FILENAME}.sigstore.json
                       (default: download from the canonical GitHub release)
  --repository <owner/name>  GitHub repository to download from
  --mode <warn|required>     warn (default): missing material logs a warning;
                             required: missing material refuses the update
  --cosign <path>      cosign binary (default: $COSIGN, then "cosign")
  --identity <regexp>  certificate identity regexp
  --issuer <url>       OIDC issuer
  -h, --help           show this help

Exit codes: 0 proceed, 1 refused, 2 usage/environment error.`;
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const result = await verifyReleaseAttestation({
    tag: options.tag,
    commit: options.commit,
    tree: options.tree,
    dir: options.dir ? resolve(options.dir) : '',
    repository: options.repository,
    mode: options.mode,
    cosign: options.cosign || undefined,
    identity: options.identity,
    issuer: options.issuer,
    log: (message) => console.error(`warning: ${message}`),
  });
  console.log(`release attestation ${result.status}: ${result.tag} @ ${result.commit}`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`error: ${err.message}`);
      process.exitCode = err instanceof CliError || err instanceof ReleaseAttestationError
        ? (err.code === 'ERR_RELEASE_ATTESTATION_MODE' ? 2 : err.exitCode || 1)
        : 1;
    });
}
