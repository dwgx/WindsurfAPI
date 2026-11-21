// Platform-free structured test evidence. No Git discovery or product imports.
import { relative, resolve } from 'node:path';

export default async function* baselineReporter(source) {
  for await (const event of source) {
    const d = event.data;
    if (event.type === 'test:summary' && d?.counts) {
      yield `${d.file == null ? '@@BASELINE_SUMMARY ' : '@@BASELINE_FILE '}${JSON.stringify(d)}\n`;
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      yield '@@BASELINE_RESULT ' + JSON.stringify({
        file: d.file, name: d.name, line: d.line, type: d.details?.type,
        status: event.type === 'test:pass' ? 'pass' : 'fail',
        skip: d.skip, todo: d.todo, failureType: d.details?.error?.failureType,
      }) + '\n';
    }
    // Test stdout/stderr is deliberately not a count-authoring channel.
  }
}

const FIELDS = ['tests', 'passed', 'failed', 'skipped', 'cancelled', 'todo'];
function validCounts(counts) {
  return counts && FIELDS.every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0)
    && counts.tests === counts.passed + counts.failed + counts.skipped + counts.cancelled + counts.todo;
}
const fail = message => { throw new Error(message); };
const leafKey = row => `${row.file}\0${row.name}`;

export function measureEvidence(result, files, root, policy, platform = process.platform) {
  if (result.error || result.signal || result.status !== 0) fail('abnormal child termination; counts cannot override exit/signal/error');
  const summaries = [], fileRows = [], leaves = [];
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const prefix = ['@@BASELINE_SUMMARY ', '@@BASELINE_FILE ', '@@BASELINE_RESULT '].find(p => line.startsWith(p));
    if (!prefix) fail('unexpected reporter output');
    let row;
    try { row = JSON.parse(line.slice(prefix.length)); } catch { fail('malformed reporter record'); }
    if (prefix === '@@BASELINE_SUMMARY ') summaries.push(row);
    else if (prefix === '@@BASELINE_FILE ') fileRows.push(row);
    else leaves.push(row);
  }
  if (summaries.length !== 1) fail('exactly one aggregate summary is required');
  const summary = summaries[0], counts = summary.counts;
  if (!validCounts(counts) || summary.success !== true || counts.tests === 0
      || counts.failed || counts.cancelled || counts.todo) fail('incomplete, failed, cancelled or todo baseline');
  const normalize = file => typeof file === 'string' ? relative(resolve(root), resolve(file)).replace(/\\/g, '/') : '';
  const wanted = new Set(files);
  if (wanted.size !== files.length) fail('duplicate test files');
  const measured = new Map(), totals = Object.fromEntries(FIELDS.map(k => [k, 0]));
  for (const row of fileRows) {
    const file = normalize(row.file);
    if (!wanted.has(file) || measured.has(file)) fail('unexpected or duplicate file receipt');
    if (!validCounts(row.counts) || row.success !== true || row.counts.tests === 0
        || row.counts.failed || row.counts.cancelled || row.counts.todo) fail(`incomplete file receipt: ${file}`);
    measured.set(file, row.counts);
    for (const k of FIELDS) totals[k] += row.counts[k];
  }
  if (measured.size !== wanted.size || FIELDS.some(k => totals[k] !== counts[k])) fail('file coverage or aggregate reconciliation failed');
  const policyForPlatform = policy?.platforms?.[platform];
  if (policy?.version !== 1 || !policy.platforms || typeof policy.platforms !== 'object') fail('invalid platform skip policy');
  const approved = new Map((policyForPlatform?.tests || []).filter(x => wanted.has(x.file))
    .map((x) => [leafKey(x), x.reason ?? policyForPlatform.reason]));
  const seenNames = new Set(), skippedNames = new Set();
  let actualSkipped = 0;
  for (const row of leaves) {
    const file = normalize(row.file);
    if (!wanted.has(file) || typeof row.name !== 'string') fail('result from an unplanned test file');
    const key = leafKey({ file, name: row.name });
    seenNames.add(key);
    if (row.status !== 'pass' || row.todo) fail('non-passing test result');
    if (!row.skip) continue;
    if (row.type !== 'test' || !approved.has(key) || row.skip !== approved.get(key)
        || skippedNames.has(key)) fail(`unapproved or duplicate platform skip: ${file}: ${row.name}`);
    skippedNames.add(key); actualSkipped++;
  }
  if (actualSkipped !== counts.skipped) fail('skip events do not reconcile with measured counts');
  for (const key of approved.keys()) if (!seenNames.has(key)) fail('a named machine-gated test disappeared');
  return { pass: counts.passed, skipped: counts.skipped, total: counts.tests,
    disposition: counts.skipped ? 'COUNT_COMPATIBLE_WITH_APPROVED_SKIPS' : 'MEASURED_NO_SKIPS' };
}
