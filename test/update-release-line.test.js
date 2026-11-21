import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRemoteStableReleaseTags, selectReleaseLine, RELEASE_LINE_START } from '../src/update-release-line.js';

const head = 'a'.repeat(40);
const future = 'b'.repeat(40);
const older = 'c'.repeat(40);
const offBranch = 'd'.repeat(40);
function tag(name, commit, annotated = true) {
  const ref = 'refs/tags/' + name;
  return annotated ? 'e'.repeat(40) + '\t' + ref + '\n' + commit + '\t' + ref + '^{}' : commit + '\t' + ref;
}

async function git(args) {
  if (args[0] === 'rev-parse') return head;
  if (args[0] === 'merge-base') {
    assert.deepEqual(args, ['merge-base', RELEASE_LINE_START, head]);
    return RELEASE_LINE_START;
  }
  assert.deepEqual(args, ['rev-list', '--ancestry-path', RELEASE_LINE_START + '..' + head]);
  return future + '\n' + head + '\n';
}

test('the new v3 line includes later minor releases and excludes the historical series', async () => {
  const tags = parseRemoteStableReleaseTags([
    tag('v3.141.592661', older), tag('v3.10.1', older), tag('v4.0.0', head),
    tag('v3.2.10', RELEASE_LINE_START), tag('v3.3.0', future), tag('v3.8.0', offBranch),
  ].join('\n'));
  assert.equal((await selectReleaseLine('3.x', head, tags, git)).name, 'v3.3.0');
  assert.equal((await selectReleaseLine('3.x', head, tags.filter(t => t.name !== 'v3.3.0'), git)).name, 'v3.2.10');
});

test('the 4.x line selects v4.x tags off the same ancestry and never a v3.x tag', async () => {
  const tags = parseRemoteStableReleaseTags([
    tag('v3.2.10', RELEASE_LINE_START), tag('v3.3.0', future),
    tag('v4.0.0', head), tag('v4.1.0', future),
  ].join('\n'));
  assert.equal((await selectReleaseLine('4.x', head, tags, git)).name, 'v4.1.0');
  await assert.rejects(selectReleaseLine('4.x', head, tags.filter(t => !t.name.startsWith('v4.')), git), /No eligible/);
});

test('a selected lightweight tag, other branch history or unknown line cannot silently downgrade', async () => {
  const tags = parseRemoteStableReleaseTags([tag('v3.2.10', RELEASE_LINE_START), tag('v3.3.0', future, false)].join('\n'));
  await assert.rejects(selectReleaseLine('3.x', head, tags, git), /annotated/);
  await assert.rejects(selectReleaseLine('stable', head, tags, git), /Unsupported/);
  await assert.rejects(selectReleaseLine('v3', head, tags, git), /Unsupported/);
  await assert.rejects(selectReleaseLine('3.x', head, tags, args => args[0] === 'merge-base' ? older : git(args)), /does not contain/);
});
