import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

// pkg reads these assets separately, after esbuild produces the JavaScript.
// Include names as well as bytes so additions to an asset glob change the digest.
export function packageAssetDigest(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
  const { assets } = manifest.pkg;
  // pkg converts ESM manifests to CommonJS and serializes them again.
  if (manifest.type === 'module') manifest.type = 'commonjs';
  const digest = createHash('sha256').update(JSON.stringify(manifest));
  for (const pattern of assets) {
    if (pattern === 'package.json') continue;
    // The package uses explicit paths and single-directory extension globs.
    if (!/^src\/(?:[\w-]+\/)*(?:[\w.-]+|\*\.[\w-]+)$/.test(pattern)) {
      throw new Error('Unsupported pkg asset pattern');
    }
    const basename = posix.basename(pattern);
    const directory = posix.dirname(pattern);
    const names = basename.startsWith('*.')
      ? readdirSync(join(root, directory)).filter(name => name.endsWith(basename.slice(1))).sort()
      : [basename];
    for (const name of names) {
      const path = posix.join(directory, name);
      digest.update(path).update('\0').update(createHash('sha256').update(readFileSync(join(root, path))).digest());
    }
  }
  return digest.digest('hex');
}
