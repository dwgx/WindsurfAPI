#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseRemoteStableReleaseTags, selectReleaseLine } from '../src/update-release-line.js';

try {
  const [line, head] = process.argv.slice(2);
  const lineMatch = String(line || '').match(/^([0-9]+)\.x$/);
  if (!lineMatch) throw new Error('Expected a release line like 3.x or 4.x');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head || '')) throw new Error('Expected a frozen release branch commit');
  const git = args => execFileSync('git', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  const tags = parseRemoteStableReleaseTags(git(['ls-remote', '--tags', 'origin', `refs/tags/v${lineMatch[1]}.*`]));
  const selected = await selectReleaseLine(line, head, tags, git);
  console.log(selected.name, selected.peeled, selected.object);
} catch (error) {
  console.error('Could not select a signed release line:', error.message);
  process.exitCode = 1;
}
