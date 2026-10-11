import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, unlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createLogFileWriter, readLogPolicy } from '../src/dashboard/log-files.js';

const START = Date.parse('2026-10-08T12:00:00Z');
const line = msg => JSON.stringify({ msg }) + '\n';

async function fixture(t, policy = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'windsurf-log-policy-'));
  let writer;
  t.after(async () => { await writer?.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, start(extra = {}) {
    writer = createLogFileWriter({ dir, now: () => START, ...policy, ...extra });
    return writer;
  } };
}

test('disk limits are opt-in, independently configurable and reject invalid values', () => {
  assert.deepEqual(readLogPolicy({}), { retentionDays: 0, maxFileBytes: 0, maxTotalBytes: 0 });
  assert.deepEqual(readLogPolicy({ LOG_RETENTION_DAYS: '14', LOG_MAX_FILE_MB: '20', LOG_MAX_TOTAL_MB: '500' }),
    { retentionDays: 14, maxFileBytes: 20 * 1024 ** 2, maxTotalBytes: 500 * 1024 ** 2 });
  for (const value of ['0', '-1', '1.5', '20oops', 'Infinity', 'NaN', '9007199254740992']) {
    assert.deepEqual(readLogPolicy({ LOG_RETENTION_DAYS: value, LOG_MAX_FILE_MB: value, LOG_MAX_TOTAL_MB: value }),
      { retentionDays: 0, maxFileBytes: 0, maxTotalBytes: 0 }, value);
  }
  assert.equal(readLogPolicy({ LOG_MAX_FILE_MB: '9007199254740991' }).maxFileBytes, 0);
});

test('startup retention includes today and N-1 prior UTC days, ignoring mtime', async t => {
  const f = await fixture(t, { retentionDays: 3 });
  const names = ['app-2026-10-05.jsonl', 'error-2026-10-05-000001.jsonl',
    'app-2026-10-06.jsonl', 'error-2026-10-07.jsonl', 'app-2026-10-08.jsonl', 'app-2026-10-09.jsonl'];
  for (const name of names) await writeFile(join(f.dir, name), line(name));
  await f.start().flush();
  assert.deepEqual((await readdir(f.dir)).sort(), names.slice(2).sort());
});

test('retention disabled preserves arbitrarily old application logs', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'app-2000-01-01.jsonl'), 'old\n');
  const writer = f.start();
  await writer.write('info', line('new'));
  assert.equal(await readFile(join(f.dir, 'app-2000-01-01.jsonl'), 'utf8'), 'old\n');
});

test('cleanup leaves unknown files, invalid dates, symlinks and subdirectories intact', async t => {
  const f = await fixture(t, { retentionDays: 1, maxTotalBytes: 1 });
  const untouched = ['notes.jsonl', 'app-2026-02-30.jsonl', 'error-2025-01-01.jsonl.bak', 'app-2025-01-01-abc.jsonl'];
  for (const name of untouched) await writeFile(join(f.dir, name), 'keep');
  await mkdir(join(f.dir, 'app-2025-01-01.jsonl'));
  await writeFile(join(f.dir, 'app-2025-01-01.jsonl', 'keep'), 'nested');
  await symlink(join(f.dir, 'notes.jsonl'), join(f.dir, 'error-2025-01-01.jsonl'));
  await f.start().flush();
  for (const name of untouched) assert.equal(await readFile(join(f.dir, name), 'utf8'), 'keep');
  assert.equal(await readFile(join(f.dir, 'error-2025-01-01.jsonl'), 'utf8'), 'keep');
  assert.equal(await readFile(join(f.dir, 'app-2025-01-01.jsonl', 'keep'), 'utf8'), 'nested');
});

test('file rotation uses UTF-8 bytes and preserves complete JSONL records', async t => {
  const record = line('中文');
  const f = await fixture(t, { maxFileBytes: Buffer.byteLength(record) * 2 });
  const writer = f.start();
  await Promise.all(Array.from({ length: 5 }, () => writer.write('info', record)));
  const names = (await readdir(f.dir)).sort();
  assert.deepEqual(names, ['app-2026-10-08-000001.jsonl', 'app-2026-10-08-000002.jsonl', 'app-2026-10-08.jsonl']);
  let records = 0;
  for (const name of names) {
    const contents = await readFile(join(f.dir, name));
    assert.ok(contents.length <= Buffer.byteLength(record) * 2);
    for (const entry of contents.toString().trim().split('\n')) {
      assert.deepEqual(JSON.parse(entry), { msg: '中文' });
      records++;
    }
  }
  assert.equal(records, 5);
});

test('restart resumes the latest segment and rotates without overwriting history', async t => {
  const f = await fixture(t, { maxFileBytes: 20 });
  await writeFile(join(f.dir, 'app-2026-10-08.jsonl'), '12345678901234567890');
  await writeFile(join(f.dir, 'app-2026-10-08-000004.jsonl'), 'old\n');
  const writer = f.start();
  await writer.write('info', 'new\n');
  await writer.write('info', '123456789012345\n');
  assert.equal(await readFile(join(f.dir, 'app-2026-10-08-000004.jsonl'), 'utf8'), 'old\nnew\n');
  assert.equal(await readFile(join(f.dir, 'app-2026-10-08-000005.jsonl'), 'utf8'), '123456789012345\n');
});

test('total budget counts app and error copies and evicts the oldest UTC files first', async t => {
  const f = await fixture(t, { maxTotalBytes: 50 });
  await writeFile(join(f.dir, 'error-2026-10-05.jsonl'), 'x'.repeat(30));
  await writeFile(join(f.dir, 'app-2026-10-06.jsonl'), 'y'.repeat(10));
  const writer = f.start();
  await writer.write('warn', 'z'.repeat(15));
  assert.deepEqual((await readdir(f.dir)).sort(), ['app-2026-10-06.jsonl', 'app-2026-10-08.jsonl', 'error-2026-10-08.jsonl']);
  assert.equal(await readFile(join(f.dir, 'app-2026-10-06.jsonl'), 'utf8'), 'y'.repeat(10));
  const sizes = await Promise.all((await readdir(f.dir)).map(name => stat(join(f.dir, name))));
  assert.equal(sizes.reduce((sum, s) => sum + s.size, 0), 40);
});

test('total budget can reclaim today’s files and remains bounded without a file-size limit', async t => {
  const f = await fixture(t, { maxTotalBytes: 30 });
  const writer = f.start();
  for (let i = 0; i < 10; i++) await writer.write('error', line(String(i)));
  const names = await readdir(f.dir);
  const sizes = await Promise.all(names.map(name => stat(join(f.dir, name))));
  assert.ok(sizes.reduce((sum, s) => sum + s.size, 0) <= 30);
  for (const name of names) {
    for (const record of (await readFile(join(f.dir, name), 'utf8')).trim().split('\n')) JSON.parse(record);
  }
});

test('an oversized record is not partially persisted and later normal logs still work', async t => {
  const f = await fixture(t, { maxFileBytes: 20 });
  const errors = [];
  const writer = f.start({ onError: e => errors.push(e.message) });
  await writer.write('info', line('x'.repeat(30)));
  await writer.write('info', line('ok'));
  assert.deepEqual(errors, ['log entry exceeds disk limit']);
  assert.equal(await readFile(join(f.dir, 'app-2026-10-08.jsonl'), 'utf8'), line('ok'));
});

test('UTC rollover and cleanup after idle time expire logs without requiring a new write', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t, { retentionDays: 1 });
  let time = START;
  const writer = f.start({ now: () => time });
  await writer.write('info', line('old'));
  time += 86_400_000;
  t.mock.timers.tick(60 * 60 * 1000);
  await writer.flush();
  assert.deepEqual(await readdir(f.dir), []);
  await writer.write('info', line('new'));
  assert.deepEqual(await readdir(f.dir), ['app-2026-10-09.jsonl']);
});

test('IO failures report an error and recover after the directory becomes writable', async t => {
  const f = await fixture(t);
  const blocked = join(f.dir, 'blocked');
  await writeFile(blocked, 'not a directory');
  const errors = [];
  const writer = f.start({ dir: blocked, onError: e => errors.push(e.code) });
  await writer.write('info', line('lost'));
  assert.ok(errors.length > 0);
  await unlink(blocked);
  await writer.write('info', line('recovered'));
  assert.equal(await readFile(join(blocked, 'app-2026-10-08.jsonl'), 'utf8'), line('recovered'));
});

test('an owned current-day symlink cannot receive log data', async t => {
  const f = await fixture(t, { maxFileBytes: 100 });
  const target = join(f.dir, 'keep');
  await writeFile(target, 'untouched');
  await symlink(target, join(f.dir, 'app-2026-10-08.jsonl'));
  const errors = [];
  await f.start({ onError: e => errors.push(e.message) }).write('info', line('new'));
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  assert.equal(errors.length, 1);
});

test('the real logger applies environment limits while preserving memory, SSE and console output', async t => {
  const f = await fixture(t);
  const dir = join(f.dir, 'logs');
  await mkdir(dir);
  await writeFile(join(dir, 'app-2000-01-01.jsonl'), 'expired\n');
  const loggerUrl = new URL('../src/dashboard/logger.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { getLogs, subscribeToLogs } = await import(${JSON.stringify(loggerUrl)});
    const { log } = await import(${JSON.stringify(configUrl)});
    let delivered = 0;
    subscribeToLogs(() => delivered++);
    log.debug('disk-debug-sentinel');
    log.warn('disk-warning-sentinel');
    log.info('x'.repeat(1024 * 1024));
    console.log(JSON.stringify({ buffered: getLogs().length, delivered }));
  `], { encoding: 'utf8', timeout: 10_000, maxBuffer: 3 * 1024 * 1024,
    env: { ...process.env, WINDSURFAPI_SKIP_DOTENV: '1', DATA_DIR: f.dir,
      REPLICA_ISOLATE: '0', LOG_LEVEL: 'warn', LOG_RETENTION_DAYS: '14', LOG_MAX_FILE_MB: '1', LOG_MAX_TOTAL_MB: '2' } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /"buffered":3,"delivered":3/);
  assert.match(child.stderr, /disk-warning-sentinel/);
  assert.match(child.stderr, /Disk log write\/cleanup failed/);
  assert.doesNotMatch(child.stdout, /disk-debug-sentinel/);
  const names = (await readdir(dir)).sort();
  assert.equal(names.length, 2);
  const contents = await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')));
  assert.ok(contents.some(text => text.includes('disk-debug-sentinel')));
  assert.ok(contents.every(text => text.includes('disk-warning-sentinel')));
  assert.ok(contents.every(text => Buffer.byteLength(text) < 1024 * 1024));
});
