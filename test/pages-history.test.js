import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildHistory } from '../scripts/build-pages-history.mjs';

const repo = 'https://github.com/dwgx/WindsurfAPI';
const shaMay = 'a'.repeat(40);
const shaApril = 'b'.repeat(40);
const capturedAt = '2026-11-20T23:30:01Z';
const commit = (sha, committedAt, authoredAt) => ({
  sha, committedAt, authoredAt, subject: 'Document public behavior',
  authorName: 'Public Author', parents: [], firstParent: true
});
const issue = {
  number: 2, title: '<b>literal ticket title</b>', state: 'closed',
  createdAt: '2026-04-30T18:00:00Z', author: { login: 'example' },
  comments: [{ body: 'never copy discussion text' }]
};
const github = {
  capturedAt, issues: [issue], pullRequests: [{
    ...issue, number: 1, state: 'closed', merged: true, mergedAt: capturedAt
  }],
  releases: [
    { tagName: 'v1.0.0', name: 'Public', publishedAt: capturedAt },
    { tagName: 'v2.0.0', name: 'Do not export', isDraft: true }
  ]
};
const git = {
  capturedAt, sourceCommit: shaMay, rootCommit: shaApril,
  commits: [
    commit(shaMay, '2026-05-01T02:44:27+09:00', '2026-04-30T16:00:00Z'),
    commit(shaApril, '2026-04-30T18:00:00Z', '2026-04-30T15:00:00Z')
  ],
  tags: [{ name: 'v1.0.0', annotated: true, targetSha: shaMay, targetInReachableHistory: true }]
};
const events = {
  capturedAt,
  events: [{
    id: 'git:' + shaMay, type: 'commit', occurredAt: git.commits[0].authoredAt,
    sourceRefs: [{ kind: 'commit', id: shaMay, url: repo + '/commit/' + shaMay }],
    title: 'Document public behavior'
  }, {
    id: 'activity:2:closed', type: 'issue_closed', occurredAt: issue.createdAt,
    sourceRefs: [{ kind: 'issue', id: 2, url: repo + '/issues/2' }],
    title: 'Issue closed', summary: 'never copy discussion text', humanReviewed: false,
    actors: ['example']
  }, {
    id: 'activity:2:mentioned', type: 'issue_mentioned', occurredAt: issue.createdAt,
    sourceRefs: [{ kind: 'issue', id: 2, url: repo + '/issues/2' }],
    title: 'Count only', actors: ['omitted-account']
  }]
};

test('commits and their events use committer time and UTC month', () => {
  const output = buildHistory({ github, git, events });
  const commits = output['git-history.json'].commits;
  assert.deepEqual(commits.map(row => row.sha), [shaMay, shaApril]);
  assert.equal(commits[0].date, '2026-04-30T17:44:27.000Z');
  assert.equal(commits[0].month, '2026-04');
  assert.notEqual(commits[0].authoredAt, commits[0].date);
  assert.equal(output['events.json'].events[0].date, commits[0].date);
});

test('public records exclude draft releases, private discussions and count-only identities', () => {
  const output = buildHistory({ github, git, events });
  assert.equal(output['github-items.json'].pullRequests[0].state, 'merged');
  assert.equal(output['github-items.json'].releases.length, 1);
  assert.equal(output['index.json'].counts.events, 2);
  assert.equal(output['index.json'].counts.countOnlyEvents, 1);
  assert.equal(output['github-items.json'].issues[0].title, issue.title);
  const bytes = JSON.stringify(output);
  assert.doesNotMatch(bytes, /never copy discussion text|humanReviewed|omitted-account|v2\.0\.0/);
});

test('invalid source link and unsafe source strings stay outside the output', () => {
  const source = { ...github, issues: [{ ...issue, title: 'local C:\\Users\\test\\task' }] };
  const activity = { ...events, events: [{
    ...events.events[1],
    sourceRefs: [{kind:'issue',id:2,url:'javascript:void(0)'}]
  }] };
  const output = buildHistory({ github: source, git, events: activity });
  const bytes = JSON.stringify(output);
  assert.doesNotMatch(bytes, /javascript:|Users/);
  assert.equal(output['github-items.json'].issues[0].url, repo + '/issues/2');
});

test('missing sources expose unavailable coverage and unknown counts', () => {
  const output = buildHistory({});
  assert.equal(output['index.json'].counts.issues, null);
  assert.equal(output['index.json'].coverage.github.status, 'unavailable');
  assert.equal(output['github-items.json'], undefined);
});

test('existing and new history anchors are wired in the published docs source', () => {
  const ledger = readFileSync(new URL('../docs/HISTORY-LEDGER-VIZ.html', import.meta.url), 'utf8');
  for (const id of ['history', 'history-records', 'history-legacy', 'stats', 'gittree', 'contributors']) {
    assert.match(ledger, new RegExp('id="' + id + '"'));
  }
  assert.match(ledger, /src="assets\/history\.js"/);
  assert.match(readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8'), /HISTORY-LEDGER-VIZ\.html#history/);
});


test('missing event capture leaves review and merge contributor counts unknown', () => {
  const output = buildHistory({ github, git });
  const [person] = output['github-items.json'].contributors;
  assert.equal(person.prsOpened, 1);
  assert.equal(person.prsMerged, null);
  assert.equal(person.reviews, null);
});
