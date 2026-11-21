const root = document.getElementById('history');
const repo = 'https://github.com/dwgx/WindsurfAPI';
const types = ['pr', 'issue', 'commit', 'release', 'tag', 'activity'];
const pagesize = 24;
const byId = id => document.getElementById(id);
const language = (() => {
  try { return localStorage.getItem('viz_lang') || navigator.language; }
  catch { return navigator.language; }
})();
const chinese = /^zh/i.test(language);
const dict = {
  en: {
    shortTitle: 'Project history', title: 'Project history & evidence',
    lead: 'Follow the code, community and releases from the first commit through the latest recorded public snapshot. Every record leads back to its source.',
    eraTitle: 'Development chronology', eraIntro: 'Key engineering changes with primary records. Dates are in UTC.',
    recordTitle: 'Find records', recordIntro: 'Search by number, title, tag, SHA or contributor. Commits use committer time for ordering and show author time separately.',
    contribTitle: 'Contributions', contribIntro: 'The public GitHub record distinguishes PR authors, merge actors, issue authors and reviewers.',
    coverageTitle: 'Source coverage', search: 'Search', view: 'Record type', month: 'Month · UTC', state: 'State / action',
    reset: 'Reset', previous: 'Previous', next: 'Next', showPeople: 'Show contributor index',
    hidePeople: 'Hide contributor index', closed: 'Closed', merged: 'Merged',
    releaseAssets: 'release assets', comments: 'comments', memberCommits: 'commit memberships', legacy: 'Original visual ledger · through 2026-09-15',
    allMonths: 'All months', allStates: 'Any state / action', loading: 'Loading records…',
    failure: 'This dataset could not be loaded. Use the source and archive links below, or switch record type.',
    unavailable: 'This dataset is unavailable in the captured source.', empty: 'No records match these filters.',
    source: 'Primary source', copyLink: 'Record link', rootCommit: 'First commit', baseCommit: 'Snapshot commit',
    snapshot: 'Captured', total: 'records', authorship: 'Author time', committed: 'Committer time',
    firstParent: 'First-parent history', role: 'Contributor', openedPr: 'PRs opened', mergedPr: 'PRs merged',
    openedIssue: 'Issues opened', reviews: 'Reviews', bot: 'bot',
    issue: 'Issues', pr: 'Pull requests', commit: 'Commits', release: 'Releases', tag: 'Git tags', activity: 'Activity'
  },
  zh: {
    shortTitle: '项目史', title: '项目史与证据账本',
    lead: '追踪从首个提交到当前公开快照的代码演进、社区协作与发布。每项记录可回到原始来源。',
    eraTitle: '开发历程', eraIntro: '通过有出处的里程碑回看工程变化。日期以 UTC 表示。',
    recordTitle: '查找记录', recordIntro: '按编号、标题、tag、SHA 或作者筛选。提交按 committer 时间排列，作者时间在详情中独立显示。',
    contribTitle: '贡献', contribIntro: '按公开 GitHub 角色记录贡献。PR 作者、合并操作者、Issue 作者、评审分别统计。',
    coverageTitle: '覆盖范围', search: '搜索', view: '记录类型', month: '月份 · UTC', state: '状态 / 动作',
    reset: '重置', previous: '上一页', next: '下一页', showPeople: '展开贡献索引',
    hidePeople: '收起贡献索引', closed: '关闭', merged: '合并',
    releaseAssets: '发布资产', comments: '评论', memberCommits: '提交关联', legacy: '旧可视账本 · 截至 2026-09-15',
    allMonths: '所有月份', allStates: '所有状态 / 动作', loading: '正在加载记录…',
    failure: '当前数据无法加载。可使用下方原始来源和归档链接，或切换记录类型。',
    unavailable: '此次快照缺少该类数据。', empty: '当前筛选条件没有匹配记录。',
    source: '原始来源', copyLink: '记录链接', rootCommit: '首个提交', baseCommit: '快照提交',
    snapshot: '采集时间', total: '条记录', authorship: '作者时间', committed: '提交者时间',
    firstParent: '第一父链', role: '贡献者', openedPr: '发起 PR', mergedPr: '合并 PR',
    openedIssue: '发起 Issue', reviews: '评审', bot: '机器人',
    issue: 'Issue', pr: 'Pull Request', commit: '提交', release: '发布', tag: 'Git tag', activity: '活动'
  }
};
const t = key => dict[chinese ? 'zh' : 'en'][key] ?? key;
const numberText = value => Number.isInteger(value) ? value.toLocaleString(chinese ? 'zh-CN' : 'en-US') : '—';
const formatTime = value => value ? value.replace('T', ' ').slice(0, 19) + ' UTC' : '—';
const titleOf = row => row.number ? '#' + row.number : row.tag ?? row.sha?.slice(0, 11) ?? '';
const statusOf = row => row.state ?? row.action ?? '';
const topic = { pr: 'github', issue: 'github', release: 'github', commit: 'git', tag: 'git', activity: 'events' };
const collection = { pr: 'pullRequests', issue: 'issues', release: 'releases', commit: 'commits', tag: 'tags', activity: 'events' };
const metrics = { pr: 'pullRequests', issue: 'issues', commit: 'commits', release: 'releases', tag: 'tags' };

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function link(label, href, className) {
  const node = element('a', label, className);
  node.href = href;
  return node;
}

function githubUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && !url.username && !url.password
      && /^\/dwgx\/WindsurfAPI\/(?:commit\/|pull\/|issues\/|releases\/tag\/|actions\/runs\/)/i.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
}

const eras = [
  ['2026-04-09 – 04-17', 'Proxy origins', '从兼容代理起步',
    'The first commit establishes the Windsurf-to-OpenAI proxy. The earliest visible PR and issue show community involvement within eight days.',
    '首个提交落下 Windsurf-to-OpenAI 代理。八天后，首个可见 PR 和 Issue 留下社区协作记录。',
    [['First commit', '/commit/395311f216fb3806c38245c544639e04af2f41f0'], ['PR #1', '/pull/1'], ['Issue #2', '/issues/2']]],
  ['2026-06-17 – 06-30', 'Architecture and Devin Connect', '架构梳理与 Devin Connect',
    'The architecture review documents the route and pool structure. A separate cutover runbook records the new operating path.',
    '架构审阅记录请求路由与池化。之后的切换手册为 Devin Connect 增加独立运行依据。',
    [['Architecture', '/commit/8e352a97272cef907e7f47b24e339eaeed88a01c'], ['Cutover runbook', '/commit/bca363c4676f3399faede5b1d2ec467082ea8ece']]],
  ['2026-07-08 – 07-27', 'v3 and audit records', 'v3 与审计台账',
    'An annotated v3.0.0 tag identifies the new baseline. Later in July, protocol hardening work gained a tracked audit ledger.',
    'v3.0.0 annotated tag 固定新基线。7 月后续的协议加固工作开始用入库审计台账记录。',
    [['v3.0.0', '/releases/tag/v3.0.0'], ['Audit ledger', '/commit/0179306264b4aeb349cac4c30fd4015749734168']]],
  ['2026-08-11 – 09-15', 'The first visual ledger', '可视化账本成形',
    'The static visual ledger captures sampled Git trees and contributor views. Its final update fixes the historical scope at v3.9.34.',
    '静态账本把采样 Git 树与贡献记录放到同一页。最后一次更新将其快照范围固定到 v3.9.34。',
    [['First visual ledger', '/commit/1bb54803636095d791768c3df678b56f5818107e'], ['Historical cutoff', '/commit/21fc76ec9d617b86a93d22335e4eecafde2ff3fb']]],
  ['2026-10-22', 'Release signing is documented', '发布签名形成公开说明',
    'Release signing gained its own documentation. Each release with signing evidence can be tracked to its workflow and artifacts.',
    '发布签名形成独立文档。含签名证据的版本可追到对应工作流和资产。',
    [['Signing documentation', '/commit/0b624c9eb4dc41a90d62a31b2828ff4e815bbf0e']]],
  ['2026-11-20', 'v3.2.10 enters the public record', 'v3.2.10 公开发布',
    'The release tag points to the public snapshot commit. The Release object and Actions run record publication separately from production acceptance.',
    'tag 指向公开快照提交。Release 对象和 Actions 执行分别记录公开发布证据，线上验收有独立口径。',
    [['Snapshot commit', '/commit/f3b47990b372d12d9cfed76cc4ed0a4538383c0e'], ['v3.2.10', '/releases/tag/v3.2.10'], ['Release run', '/actions/runs/44828123952']]]
];

const form = byId('history-filter');
const query = byId('history-query');
const view = byId('history-view');
const month = byId('history-month');
const state = byId('history-state');
const results = byId('history-results');
const status = byId('history-results-status');
const previous = byId('history-prev');
const next = byId('history-next');
const pagination = byId('history-pages');

let index;
let revision = 0;
let page = 1;
let record = '';
let peopleOpen = false;
const cache = new Map();
const dataUrl = file => new URL('../history/' + file, import.meta.url);

async function getData(file) {
  const response = await fetch(dataUrl(file));
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const data = await response.json();
  if (data.schemaVersion !== 1) throw new Error('Unsupported history schema');
  return data;
}

function getSet(key) {
  const file = index?.fileNames?.[key];
  const allowed = { github: 'github-items.json', git: 'git-history.json', events: 'events.json' };
  if (file !== allowed[key]) return Promise.resolve(null);
  if (!cache.has(key)) cache.set(key, getData(file).then(data => {
    if (data.snapshotAt !== index.snapshotAt) throw new Error('History snapshots disagree');
    return data;
  }).catch(error => { cache.delete(key); throw error; }));
  return cache.get(key);
}

function fillSelect(input, values, value) {
  input.replaceChildren(...values.map(([key, label]) => {
    const option = element('option', label);
    option.value = key;
    return option;
  }));
  input.value = values.some(([key]) => key === value) ? value : values[0][0];
}

function setFromUrl() {
  const url = new URL(location.href);
  const kind = url.searchParams.get('view') || 'pr';
  fillSelect(view, types.map(type => [type, t(type)]), kind);
  query.value = (url.searchParams.get('q') || '').slice(0, 160);
  page = Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1);
  record = (url.searchParams.get('record') || '').slice(0, 100);
  return { month: url.searchParams.get('month') || '', state: url.searchParams.get('state') || '' };
}

function stateUrl(override = {}) {
  const url = new URL(location.href);
  const values = { view: view.value, q: query.value.trim(), month: month.value, state: state.value, page: page > 1 ? page : '', record, ...override };
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  return url;
}

function matches(row, search) {
  const number = /^#(\d+)$/.exec(search);
  if (number) return row.number === Number(number[1]);
  return !search || [row.title, row.author, row.tag, row.sha, row.number, ...(row.labels ?? [])]
    .some(value => String(value ?? '').toLowerCase().includes(search));
}

function rowItem(row) {
  const li = element('li', undefined, 'history-row');
  li.dataset.historyRecord = row.id;
  if (row.id === record) li.setAttribute('aria-current', 'true');
  const meta = element('div', undefined, 'history-row-top');
  const key = titleOf(row);
  if (key) meta.append(element('span', key, 'history-key'));
  meta.append(element('time', formatTime(row.date), 'history-time'));
  if (row.date) meta.lastElementChild.dateTime = row.date;
  const stateValue = statusOf(row);
  if (stateValue) meta.append(element('span', stateValue.replaceAll('_', ' '), 'history-pill'));
  if (row.firstParent) meta.append(element('span', t('firstParent'), 'history-key'));
  const heading = element('h3');
  const href = githubUrl(row.url);
  if (href) heading.append(link(row.title, href));
  else heading.textContent = row.title;
  li.append(meta, heading);
  const details = [row.author, ...(row.labels ?? [])].filter(Boolean);
  if (row.kind === 'commit') details.push(t('committed') + ' · ' + formatTime(row.date), t('authorship') + ' · ' + formatTime(row.authoredAt));
  if (row.kind === 'tag') details.push(row.dateBasis === 'tagger' ? 'Tagger time' : 'Target commit time');
  if (row.mergedAt) details.push(t('merged') + ' · ' + formatTime(row.mergedAt));
  else if (row.closedAt) details.push(t('closed') + ' · ' + formatTime(row.closedAt));
  if (row.stateReason) details.push(row.stateReason);
  for (const [key, label] of [['commentCount', 'comments'], ['reviewCount', 'reviews'],
    ['commitMembershipCount', 'memberCommits'], ['assetCount', 'releaseAssets']]) {
    if (Number.isInteger(row[key])) details.push(numberText(row[key]) + ' ' + t(label));
  }
  if (details.length) li.append(element('p', details.join(' · ')));
  const tools = element('div', undefined, 'history-source-links');
  const deepLink = stateUrl({ record: row.id });
  deepLink.hash = 'history-records';
  tools.append(link(t('copyLink'), deepLink.href, 'history-record-link'));
  if (row.mergeCommitSha) tools.append(link(t('merged') + ' · ' + row.mergeCommitSha.slice(0, 11), repo + '/commit/' + row.mergeCommitSha));
  for (const source of (row.sources ?? []).filter(value => value !== href)) {
    const valid = githubUrl(source);
    if (valid) tools.append(link(t('source'), valid));
  }
  li.append(tools);
  return li;
}

async function draw(facets = { month: month.value, state: state.value }, syncUrl = true) {
  const request = ++revision;
  const kind = view.value;
  status.textContent = t('loading');
  results.replaceChildren();
  pagination.hidden = true;
  try {
    const dataset = await getSet(topic[kind]);
    if (request !== revision) return;
    if (!dataset) { status.textContent = t('unavailable'); return; }
    const rows = dataset[collection[kind]];
    if (!Array.isArray(rows)) throw new Error('Missing source rows');
    const descending = [...rows].sort((left, right) => {
      const difference = (right.date ? Date.parse(right.date) : -Infinity) - (left.date ? Date.parse(left.date) : -Infinity);
      return difference || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
    const months = [...new Set(rows.map(row => row.month).filter(Boolean))].sort().reverse();
    const statuses = [...new Set(rows.map(statusOf).filter(Boolean))].sort();
    fillSelect(month, [['', t('allMonths')], ...months.map(value => [value, value])], facets.month);
    fillSelect(state, [['', t('allStates')], ...statuses.map(value => [value, value.replaceAll('_', ' ')])], facets.state);
    const search = query.value.trim().toLowerCase();
    const filtered = descending.filter(row => (!month.value || row.month === month.value)
      && (!state.value || statusOf(row) === state.value) && matches(row, search));
    const recordIndex = record ? filtered.findIndex(row => row.id === record) : -1;
    if (recordIndex >= 0) page = Math.floor(recordIndex / pagesize) + 1;
    const pages = Math.max(1, Math.ceil(filtered.length / pagesize));
    page = Math.min(page, pages);
    const start = (page - 1) * pagesize;
    if (syncUrl) history.replaceState(null, '', stateUrl());
    if (!filtered.length) { status.textContent = t('empty'); return; }
    status.textContent = numberText(filtered.length) + ' ' + t('total');
    results.replaceChildren(...filtered.slice(start, start + pagesize).map(rowItem));
    byId('history-page').textContent = page + ' / ' + pages;
    previous.disabled = page <= 1;
    next.disabled = page >= pages;
    pagination.hidden = pages <= 1;
  } catch {
    if (request === revision) status.textContent = t('failure');
  }
}

function showChronology() {
  byId('history-eras').replaceChildren(...eras.map(([date, enTitle, zhTitle, enBody, zhBody, sources]) => {
    const item = element('li', undefined, 'history-era');
    const sourceList = element('div', undefined, 'history-source-links');
    for (const [label, path] of sources) sourceList.append(link(label, repo + path));
    item.append(element('div', date, 'history-time'), element('h3', chinese ? zhTitle : enTitle),
      element('p', chinese ? zhBody : enBody), sourceList);
    return item;
  }));
}

function showCoverage() {
  const counts = index.counts;
  const coverage = byId('history-coverage-list');
  const short = value => value?.slice(0, 12);
  const notes = [
    chinese ? '社区条目为项目可见的 PR 与 Issue 对象。发布数含预发布。git tag 与 GitHub Release 分列。'
      : 'PRs and issues are visible repository objects. Public Releases include prereleases. Git tags are counted independently.',
    chinese ? '提交限于快照 SHA 可达祖先图。第一父链 ' + numberText(counts.firstParentCommits) + '，可见 PR–提交关联 ' + numberText(counts.prMemberships) + '。'
      : 'Commits are reachable from the snapshot SHA. First-parent commits: ' + numberText(counts.firstParentCommits)
       + '. Observed PR–commit memberships: ' + numberText(counts.prMemberships) + '.',
    chinese ? numberText(counts.events) + ' 条活动可检索，' + numberText(counts.countOnlyEvents) + ' 条仅计数。缺少可公开出处的活动 ' + numberText(counts.omittedActivityRows) + ' 条。'
      : numberText(counts.events) + ' searchable activity records, ' + numberText(counts.countOnlyEvents)
        + ' count-only, and ' + numberText(counts.omittedActivityRows) + ' omitted when a public source link was unavailable.',
    chinese ? '正文、评论和私下交接不进入此静态索引。GitHub 状态反映采集时决策。提交者时间和发布上线时间分别取证。'
      : 'The public files carry selected metadata and source links. GitHub states reflect the collection time. Committer, publication and deployment times have distinct evidence.'
  ];
  const origins = element('li');
  if (index.rootCommit) origins.append(link(t('rootCommit') + ' ' + short(index.rootCommit), repo + '/commit/' + index.rootCommit));
  if (index.baseCommit) origins.append(' · ', link(t('baseCommit') + ' ' + short(index.baseCommit), repo + '/commit/' + index.baseCommit));
  if (index.projectCreatedAt) origins.append(' · ' + (chinese ? 'GitHub 建库 ' : 'GitHub repository created ') + formatTime(index.projectCreatedAt));
  coverage.replaceChildren(origins, ...notes.map(note => element('li', note)));
}

async function togglePeople() {
  const button = byId('history-show-people');
  const list = byId('history-people');
  const stateLabel = byId('history-people-status');
  peopleOpen = !peopleOpen;
  button.setAttribute('aria-expanded', String(peopleOpen));
  button.textContent = t(peopleOpen ? 'hidePeople' : 'showPeople');
  list.hidden = !peopleOpen;
  if (!peopleOpen || list.childElementCount) return;
  stateLabel.textContent = t('loading');
  try {
    const dataset = await getSet('github');
    if (!dataset?.contributors) { stateLabel.textContent = t('unavailable'); return; }
    const table = element('table', undefined, 'history-contrib');
    const header = table.createTHead().insertRow();
    for (const label of ['role', 'openedPr', 'mergedPr', 'openedIssue', 'reviews']) {
      const cell = element('th', t(label));
      cell.scope = 'col';
      header.append(cell);
    }
    const body = table.createTBody();
    for (const person of dataset.contributors) {
      const row = body.insertRow();
      const label = person.login + (person.bot ? ' · ' + t('bot') : '');
      if (/^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i.test(person.login)) {
        row.insertCell().append(link(label, 'https://github.com/' + encodeURIComponent(person.login)));
      } else row.insertCell().textContent = label;
      for (const key of ['prsOpened', 'prsMerged', 'issuesOpened', 'reviews']) row.insertCell().textContent = numberText(person[key]);
    }
    list.replaceChildren(table);
    stateLabel.textContent = '';
  } catch { stateLabel.textContent = t('failure'); }
}

function openLegacy(id) {
  const archive = byId('history-legacy');
  const target = byId(id);
  if (!target || !archive.contains(target) || target === archive) return;
  archive.open = true;
  requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}

function archiveNavigation() {
  openLegacy(location.hash.slice(1));
  addEventListener('hashchange', () => openLegacy(location.hash.slice(1)));
  document.addEventListener('click', event => {
    const anchor = event.target.closest('.ledger-tab[href^="#"]');
    if (anchor && byId('history-legacy').contains(byId(anchor.hash.slice(1)))) byId('history-legacy').open = true;
  }, { capture: true });
}

if (root) {
  archiveNavigation();
  for (const label of document.querySelectorAll('[data-history-copy]')) label.textContent = t(label.dataset.historyCopy);
  showChronology();
  const initialFacets = setFromUrl();
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', event => {
    record = '';
    page = 1;
    draw(event.target === view ? { month: '', state: '' } : undefined);
  });
  form.addEventListener('reset', event => {
    event.preventDefault();
    query.value = '';
    record = '';
    page = 1;
    draw({ month: '', state: '' });
  });
  previous.addEventListener('click', () => { record = ''; page -= 1; draw(); });
  next.addEventListener('click', () => { record = ''; page += 1; draw(); });
  byId('history-show-people').addEventListener('click', togglePeople);
  addEventListener('popstate', () => draw(setFromUrl(), false));

  try {
    index = await getData('index.json');
    byId('history-snapshot').textContent = t('snapshot') + ' · ' + formatTime(index.snapshotAt);
    for (const [kind, key] of Object.entries(metrics)) {
      const metric = link('', '#history-records', 'history-metric');
      metric.append(element('strong', numberText(index.counts[key])), element('span', t(kind)));
      metric.addEventListener('click', () => {
        view.value = kind;
        query.value = '';
        record = '';
        page = 1;
        draw({ month: '', state: '' });
      });
      byId('history-metrics').append(metric);
    }
    showCoverage();
    await draw(initialFacets, false);
  } catch {
    status.textContent = t('failure');
    byId('history-snapshot').textContent = t('unavailable');
  }
}
