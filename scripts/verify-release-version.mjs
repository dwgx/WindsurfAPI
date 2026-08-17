import { readFileSync } from 'node:fs';

const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const actualTag = String(process.env.GITHUB_REF_NAME || '').trim();
const expectedTag = `v${packageVersion}`;

if (actualTag !== expectedTag) {
  console.error(
    `Release identity mismatch: tag is ${actualTag || '(missing)'}, `
      + `but package.json requires ${expectedTag}.`,
  );
  process.exit(1);
}

console.log(`Release identity verified: ${actualTag} matches package.json ${packageVersion}.`);
