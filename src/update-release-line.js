function stableReleaseVersion(tag) {
  const match = String(tag || '').match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? match.slice(1) : null;
}

function compareDecimalComponents(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareStableReleaseTags(left, right) {
  const a = stableReleaseVersion(left);
  const b = stableReleaseVersion(right);
  for (let i = 0; i < 3; i++) {
    const compared = compareDecimalComponents(a[i], b[i]);
    if (compared) return compared;
  }
  return 0;
}

function validRemoteTagName(tag) {
  return !!tag
    && !tag.startsWith('.')
    && !tag.endsWith('.')
    && !tag.startsWith('/')
    && !tag.endsWith('/')
    && !tag.includes('..')
    && !tag.includes('//')
    && !tag.includes('@{')
    && !/[\x00-\x20\x7f~^:?*[\\]/.test(tag);
}

export function parseRemoteStableReleaseTags(output) {
  const byName = new Map();
  for (const line of String(output || '').split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/tags\/(.+)$/i);
    if (!match) throw new Error('remote tag enumeration returned a malformed record');
    const oid = match[1].toLowerCase();
    const peeled = match[2].endsWith('^{}');
    const name = peeled ? match[2].slice(0, -3) : match[2];
    if (!validRemoteTagName(name)) throw new Error('remote tag enumeration returned an invalid ref name');
    if (!stableReleaseVersion(name)) continue;

    const entry = byName.get(name) || { name, object: '', peeled: '' };
    const field = peeled ? 'peeled' : 'object';
    if (entry[field]) throw new Error(`remote tag enumeration duplicated ${name}${peeled ? '^{}' : ''}`);
    entry[field] = oid;
    byName.set(name, entry);
  }

  const candidates = [...byName.values()];
  for (const candidate of candidates) {
    if (!candidate.object) throw new Error(`remote tag ${candidate.name} has a peeled record without its tag ref`);
  }
  candidates.sort((left, right) => compareStableReleaseTags(right.name, left.name));
  return candidates;
}

// The project resumed ordinary stable numbering (3.x and later majors share this
// ancestry) at this immutable public commit. Numeric comparison within this
// ancestry also admits future minor releases.
export const RELEASE_LINE_START = 'f3b47990b372d12d9cfed76cc4ed0a4538383c0e';

export async function selectReleaseLine(line, remoteRef, advertised, git) {
  const lineMatch = String(line || '').match(/^([0-9]+)\.x$/);
  if (!lineMatch) throw new Error('Unsupported release line; expected <major>.x (e.g. 3.x)');
  const majorPrefix = 'v' + lineMatch[1] + '.';
  const head = (await git(['rev-parse', remoteRef + '^{commit}'])).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error('Invalid release branch commit');
  const base = (await git(['merge-base', RELEASE_LINE_START, head])).trim();
  if (base !== RELEASE_LINE_START) throw new Error('Release branch does not contain the start of the stable release line');
  const history = await git(['rev-list', '--ancestry-path', RELEASE_LINE_START + '..' + head]);
  const eligible = new Set([RELEASE_LINE_START, ...history.trim().split(/\s+/)]);
  const selected = advertised.find(tag => tag.name.startsWith(majorPrefix) && eligible.has(tag.peeled || tag.object));
  if (!selected?.peeled) throw new Error(`No eligible annotated release at the head of the ${line} line`);
  return selected;
}
