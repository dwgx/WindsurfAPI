#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repo = 'https://github.com/dwgx/WindsurfAPI';
const version = 1;
const shaPattern = /^[0-9a-f]{40}$/;
const loginPattern = /^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i;
const privateText = /(?:\b[A-Z]:[\\/]+(?:Users|Project|Windows)[\\/]|(?:^|[\s'"(])\/(?:home|workspace|mnt|Users|private)\/\w|(?:\.agent|\.claude|\.dwgx|extra-hands)[\\/]|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{18,}\b|\bBearer\s+[A-Za-z0-9_.-]{22,})/i;

export function isoTime(value) {
  const epoch = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

const text = (value, fallback = '') => typeof value === 'string' && value.trim()
  ? (privateText.test(value) ? fallback : value.trim().slice(0, 280))
  : fallback;
const login = value => typeof value === 'string' && loginPattern.test(value) ? value : null;
const sha = value => typeof value === 'string' && shaPattern.test(value) ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const arrays = (value, key) => {
  if (!Array.isArray(value?.[key])) throw new Error('Missing input array ' + key);
  return value[key];
};

function sourceUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search) return null;
  if (!/^\/dwgx\/windsurfapi\/(?:issues\/\d+|pull\/\d+|commit\/[0-9a-f]{40}|releases\/tag\/[^/]+|actions\/runs\/\d+)$/i.test(url.pathname)) return null;
  if (url.hash && !/^#[a-z0-9_-]{1,80}$/i.test(url.hash)) return null;
  return url.href;
}

function timeFields(date) {
  return { date, month: date?.slice(0, 7) ?? null };
}

function order(left, right) {
  if (!left.date || !right.date) {
    if (left.date !== right.date) return left.date ? -1 : 1;
  } else {
    const difference = Date.parse(left.date) - Date.parse(right.date);
    if (difference) return difference;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function unique(rows, key) {
  if (new Set(rows.map(row => row[key])).size !== rows.length) throw new Error('Duplicate public ' + key);
  return rows;
}

function ticket(raw, kind) {
  const number = positive(raw.number);
  if (!number) throw new Error('Invalid public ticket number');
  const mergedAt = kind === 'pr' ? isoTime(raw.mergedAt) : null;
  const state = raw.merged === true || mergedAt ? 'merged' : raw.state === 'open' ? 'open' : 'closed';
  return {
    id: kind + ':' + number, kind, number, title: text(raw.title, 'GitHub #' + number),
    state, draft: kind === 'pr' && raw.draft === true,
    author: login(raw.author?.login), authorType: raw.author?.type === 'Bot' ? 'bot' : null,
    labels: (raw.labels ?? []).map(label => text(label.name ?? label)).filter(Boolean),
    ...timeFields(isoTime(raw.createdAt)), updatedAt: isoTime(raw.updatedAt),
    closedAt: isoTime(raw.closedAt), mergedAt,
    mergeCommitSha: kind === 'pr' && state === 'merged' ? sha(raw.mergeCommitSha) : null,
    stateReason: kind === 'issue' ? text(raw.stateReason) || null : null,
    commentCount: Number.isSafeInteger(raw.commentCount) ? raw.commentCount : null,
    reviewCount: Array.isArray(raw.reviews) ? raw.reviews.length : null,
    commitMembershipCount: Number.isSafeInteger(raw.commitListReportedCount) ? raw.commitListReportedCount : null,
    url: repo + (kind === 'pr' ? '/pull/' : '/issues/') + number
  };
}

function release(raw) {
  const tag = text(raw.tagName);
  if (!tag) throw new Error('Invalid public release tag');
  return {
    id: 'release:' + tag, kind: 'release', tag, title: text(raw.name, tag),
    state: raw.prerelease ? 'prerelease' : 'published', author: login(raw.author?.login),
    ...timeFields(isoTime(raw.publishedAt)),
    createdAt: isoTime(raw.createdAt), assetCount: Array.isArray(raw.assets) ? raw.assets.length : null,
    url: repo + '/releases/tag/' + encodeURIComponent(tag)
  };
}

function commit(raw) {
  const hash = sha(raw.sha);
  const date = isoTime(raw.committedAt);
  if (!hash || !date) throw new Error('Invalid public Git commit identity or committer time');
  return {
    id: 'commit:' + hash, kind: 'commit', sha: hash, title: text(raw.subject, 'Git commit ' + hash.slice(0, 12)),
    author: text(raw.authorName) || null, authoredAt: isoTime(raw.authoredAt),
    ...timeFields(date), firstParent: raw.firstParent === true,
    parents: (raw.parents ?? []).map(sha).filter(Boolean),
    url: repo + '/commit/' + hash
  };
}

function tagRecord(raw) {
  const name = text(raw.name);
  const target = sha(raw.targetSha);
  if (!name || !target) throw new Error('Invalid public tag identity');
  return {
    id: 'tag:' + name, kind: 'tag', tag: name, title: name, sha: target,
    state: raw.annotated === true ? 'annotated' : 'lightweight',
    ...timeFields(isoTime(raw.taggerAt ?? raw.taggedAt ?? raw.targetCommittedAt)),
    dateBasis: raw.taggerAt || raw.taggedAt ? 'tagger' : 'target-committer',
    url: repo + '/releases/tag/' + encodeURIComponent(name)
  };
}

function activity(raw, byCommit) {
  if (typeof raw.id !== 'string' || typeof raw.type !== 'string' || !/^[a-z_]+$/.test(raw.type)) {
    throw new Error('Invalid event identity');
  }
  const refs = (raw.sourceRefs ?? []).map(ref => sourceUrl(ref.url)).filter(Boolean);
  const url = sourceUrl(raw.sourceUrl) ?? refs[0];
  if (!url) return null;
  const commitRef = raw.sourceRefs?.find(ref => ref.kind === 'commit');
  const gitRecord = raw.type === 'commit' ? byCommit.get(sha(commitRef?.id)) : null;
  const date = gitRecord?.date ?? isoTime(raw.occurredAt);
  const actor = login(raw.actor?.login) ?? login(raw.actor)
    ?? login(raw.actors?.[0]?.login) ?? login(raw.actors?.[0]);
  const subjectRef = raw.sourceRefs?.find(ref => ref.kind === 'pull_request' || ref.kind === 'issue');
  return {
    id: 'activity:' + createHash('sha256').update(raw.id).digest('hex').slice(0, 24),
    kind: 'activity', action: raw.type,
    title: gitRecord?.title ?? text(raw.title, raw.type.split('_').join(' ')),
    author: gitRecord?.author ?? actor,
    number: positive(Number(subjectRef?.id)), sha: gitRecord?.sha ?? null,
    ...timeFields(date), url, sources: [...new Set(refs)].slice(0, 5),
    evidence: 'verified'
  };
}

function contributionRows(issues, prs, activities, eventsAvailable) {
  const people = new Map();
  const add = (name, role, bot = false) => {
    if (!login(name)) return;
    const key = name.toLowerCase();
    const person = people.get(key) ?? { login: name, bot: false, prsOpened: 0, prsMerged: eventsAvailable ? 0 : null, issuesOpened: 0, reviews: eventsAvailable ? 0 : null };
    person.bot ||= bot || name.endsWith('[bot]');
    person[role] += 1;
    people.set(key, person);
  };
  for (const row of issues) add(row.author, 'issuesOpened', row.authorType === 'bot');
  for (const row of prs) add(row.author, 'prsOpened', row.authorType === 'bot');
  for (const event of activities) {
    if (event.action === 'pull_request_merged') add(event.author, 'prsMerged');
    if (event.action === 'pull_request_review') add(event.author, 'reviews');
  }
  return [...people.values()].sort((left, right) => {
    const count = row => row.prsOpened + (row.prsMerged ?? 0) + row.issuesOpened + (row.reviews ?? 0);
    return count(right) - count(left) || left.login.localeCompare(right.login, 'en');
  });
}

function countOnly(raw) {
  return /_(?:mentioned|subscribed|unsubscribed)$/.test(raw.type)
    || raw.publicListing === false || raw.visibility === 'count-only';
}

export function buildHistory({ github, git, events, census } = {}) {
  const snapshots = [github, git, events].filter(Boolean).map(source => isoTime(source.capturedAt));
  if (snapshots.includes(null) || new Set(snapshots).size > 1) throw new Error('Corpus inputs have different or invalid snapshot times');
  const snapshotAt = snapshots[0] ?? null;
  const baseCommit = sha(git?.sourceCommit ?? census?.sourceCommit);
  if (git && !baseCommit) throw new Error('Git snapshot has no public base commit');
  if (census?.sourceCommit && baseCommit !== census.sourceCommit) throw new Error('Census and Git base commits disagree');
  const issues = github ? arrays(github, 'issues').map(row => ticket(row, 'issue')).sort(order) : [];
  const pullRequests = github ? arrays(github, 'pullRequests').map(row => ticket(row, 'pr')).sort(order) : [];
  const releases = github ? arrays(github, 'releases').filter(row => row.isDraft !== true).map(release).sort(order) : [];
  unique([...issues, ...pullRequests], 'number');
  unique(releases, 'id');
  const commits = git ? unique(arrays(git, 'commits').map(commit).sort(order), 'sha') : [];
  const tags = git ? unique(arrays(git, 'tags').map(tagRecord).sort(order), 'tag') : [];
  const byCommit = new Map(commits.map(row => [row.sha, row]));
  const rawEvents = events ? arrays(events, 'events') : [];
  const countOnlyEvents = rawEvents.filter(countOnly).length;
  const candidates = rawEvents.filter(row => !countOnly(row));
  const projectedEvents = unique(candidates.map(row => activity(row, byCommit)).filter(Boolean).sort(order), 'id');
  const omittedActivityRows = candidates.length - projectedEvents.length;
  const contributors = contributionRows(issues, pullRequests, projectedEvents, Boolean(events));
  const counts = {
    issues: github ? issues.length : null, pullRequests: github ? pullRequests.length : null,
    releases: github ? releases.length : null, tags: git ? tags.length : null,
    commits: git ? commits.length : null, firstParentCommits: git ? commits.filter(row => row.firstParent).length : null,
    events: events ? projectedEvents.length : null, countOnlyEvents: events ? countOnlyEvents : null,
    omittedActivityRows: events ? omittedActivityRows : null,
    prMemberships: Number.isSafeInteger(census?.entityCounts?.pullRequestCommitMemberships)
      ? census.entityCounts.pullRequestCommitMemberships : null
  };
  const index = {
    schemaVersion: version, snapshotAt, baseCommit,
    rootCommit: sha(git?.rootCommit),
    projectCreatedAt: isoTime(census?.repo?.createdAt),
    counts,
    fileNames: {
      github: github ? 'github-items.json' : null,
      git: git ? 'git-history.json' : null,
      events: events ? 'events.json' : null
    },
    coverage: {
      github: { status: github ? 'available' : 'unavailable', capturedAt: github ? snapshotAt : null },
      git: { status: git ? 'available' : 'unavailable', capturedAt: git ? snapshotAt : null },
      events: { status: events ? (countOnlyEvents || omittedActivityRows ? 'partial' : 'available') : 'unavailable', capturedAt: events ? snapshotAt : null },
      census: { status: census?.verification?.ok === true ? 'checked' : census ? 'available' : 'unavailable' }
    }
  };
  return {
    ...(github ? { 'github-items.json': { schemaVersion: version, snapshotAt, issues, pullRequests, releases, contributors } } : {}),
    ...(git ? { 'git-history.json': { schemaVersion: version, snapshotAt, commits, tags } } : {}),
    ...(events ? { 'events.json': { schemaVersion: version, snapshotAt, events: projectedEvents } } : {}),
    'index.json': index
  };
}

function readJson(file) {
  if (!file) return null;
  try { return JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function main() {
  const { values } = parseArgs({ options: {
    github: { type: 'string' }, git: { type: 'string' }, events: { type: 'string' },
    census: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help || !values.out) {
    console.log('Usage: node scripts/build-pages-history.mjs --github <file> --git <file> --events <file> --census <file> --out <directory>');
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const projection = buildHistory({
    github: readJson(values.github), git: readJson(values.git),
    events: readJson(values.events), census: readJson(values.census)
  });
  const destination = resolve(values.out);
  mkdirSync(destination, { recursive: true });
  const outputs = {};
  for (const [name, data] of Object.entries(projection)) {
    const body = JSON.stringify(data) + '\n';
    const file = join(destination, name);
    const temporary = file + '.' + process.pid + '.tmp';
    try {
      writeFileSync(temporary, body, { flag: 'wx' });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
    outputs[name] = { bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  }
  for (const name of ['github-items.json', 'git-history.json', 'events.json']) {
    if (!projection[name]) rmSync(join(destination, name), { force: true });
  }
  console.log(JSON.stringify({ counts: projection['index.json'].counts, outputs }, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
