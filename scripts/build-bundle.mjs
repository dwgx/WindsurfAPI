import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageAssetDigest } from '../src/package-assets.js';

function git(root, args, extraEnv) {
  // A parent process can set GIT_DIR, GIT_INDEX_FILE, or other repository
  // overrides. Inspect this checkout, including its linked-worktree index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return execFileSync('git', ['--no-optional-locks', '--git-dir=.git', '--work-tree=.',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000,
  }).split('\0').filter(Boolean);
}

export function cleanBuildCommit(root) {
  if (!existsSync(join(root, '.git'))) return '';
  try {
    const state = git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
    if (state.some(line => !line.startsWith('# '))) return '';
    // Ignored inputs can enter esbuild or a pkg glob, and index flags can
    // hide changes from status. An existing generated bundle is expected.
    if (git(root, ['ls-files', '--others', '-z', '--', 'src']).some(path => path !== 'src/_bundle.cjs')) return '';
    if (git(root, ['ls-files', '-v', '-z']).some(entry => !entry.startsWith('H '))) return '';
    return state.find(line => line.startsWith('# branch.oid '))?.match(/^# branch\.oid ([a-f0-9]{40})$/)?.[1] || '';
  } catch { return ''; }
}

function compile(root) {
  // The fixed shell command also resolves npm's esbuild.cmd shim on Windows.
  return execSync('esbuild src/index.js --bundle --platform=node --format=cjs --target=node22 '
    + '--external:node:* --define:import.meta.url=__WA_IMPORT_META_URL__', {
    cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function buildBundle(root) {
  const commit = cleanBuildCommit(root);
  let identity = null;
  let code;
  if (commit) {
    // Freeze esbuild's input and pkg's expected asset bytes at the same commit.
    // Git reads and materializes this private index without changing the caller's.
    const scratch = mkdtempSync(join(tmpdir(), 'wa-build-'));
    try {
      const snapshot = join(scratch, 'checkout');
      mkdirSync(snapshot);
      const env = { GIT_INDEX_FILE: join(scratch, 'index') };
      git(root, ['read-tree', commit], env);
      git(root, ['-c', 'core.autocrlf=false', 'checkout-index', '--all', '--prefix=' + snapshot.replaceAll('\\', '/') + '/'], env);
      code = compile(snapshot);
      identity = { commit, assets: packageAssetDigest(snapshot) };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  } else {
    code = compile(root);
  }
  const banner = "const __WA_IMPORT_META_URL__=require('node:url').pathToFileURL(__filename).href;\n"
    + 'const __WA_BUILD_IDENTITY__=' + JSON.stringify(identity) + ';\n';
  const output = join(root, 'src', '_bundle.cjs');
  const temporary = output + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, Buffer.concat([Buffer.from(banner), code]), { flag: 'wx' });
    renameSync(temporary, output);
  } finally { rmSync(temporary, { force: true }); }
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === script) buildBundle(dirname(dirname(script)));
