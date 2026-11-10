// S5-P1: caller-controlled strings must not forge log records or smuggle ANSI.
//
// The log.*() facade in src/dashboard/logger.js is the single funnel every log
// call passes through. Each call lands in four sinks:
//   1. the ring buffer   → dashboard "recent logs" + getLogs()/SSE
//   2. the JSONL files   → app-<date>.jsonl / error-<date>.jsonl
//   3. the txt export    → /logs/export?format=txt reads the same entries
//   4. the console print → pm2 journal, i.e. an operator's terminal
//
// A model name like `gpt-4\n[INFO] Account added: account=attacker` used to
// reach all four verbatim: the \n manufactured a second log line and a \u001b[
// sequence restyled the operator's terminal / any attachment opened in one.
// Scrubbing belongs at this write point — not at the ~30 call sites — because
// a call site missed (or added next month) reopens the hole, while the funnel
// covers every present and future caller for free.
//
// Importing logger.js patches the shared `log` object from config.js — the
// same object handlers import — so log.info() below IS the production path.
// DATA_DIR is the throwaway dir from test/setup-env.mjs, so the JSONL check
// reads real files without touching the operator's logs.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { log } = await import('../src/config.js');
const { getLogs, getLogDir, subscribeToLogs, unsubscribeFromLogs, withCtx } =
  await import('../src/dashboard/logger.js');

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
// Forgery payload: newline builds a fake record, ESC restyles the terminal.
const PAYLOAD = 'swe-1.7\n[INFO] Account added: account=attacker\u001b[31mRED\u001b[0m';

// Capture the console re-print (_orig[level] → config.js → console.* lazily).
function captureConsole(fn) {
  const out = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => out.push(a.join(' '));
  try { fn(); } finally {
    console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
  }
  return out;
}

function today() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

describe('S5-P1: the log boundary scrubs caller-controlled strings', () => {
  after(() => {
    // The ring buffer is module-global; leave it clean for anything that runs
    // after this file in the same process.
    getLogs().length = 0;
  });

  it('every level scrubs msg + ctx before the entry reaches any sink', () => {
    const seen = [];
    const sub = (e) => seen.push(e);
    subscribeToLogs(sub);
    try {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        log[level]('Probe', PAYLOAD, { model: PAYLOAD, nested: { leak: 'a\nb\u001bc' }, n: 7 });
      }
    } finally {
      unsubscribeFromLogs(sub);
    }
    assert.equal(seen.length, 4, 'debug/info/warn/error all land in the ring buffer');
    for (const e of seen) {
      assert.doesNotMatch(e.msg, CONTROL, `${e.level} msg still carries a control char`);
      assert.match(e.msg, /·/, 'control chars become visible middots, not silent deletion');
      assert.equal(e.ctx.model.includes('\n'), false, 'ctx.model keeps a raw newline');
      assert.equal(e.ctx.model.includes('\u001b'), false, 'ctx.model keeps a raw ESC');
      assert.equal(e.ctx.nested.leak.includes('\n'), false, 'nested ctx string keeps a raw newline');
      assert.equal(e.ctx.nested.leak.includes('\u001b'), false, 'nested ctx string keeps a raw ESC');
      assert.equal(e.ctx.n, 7, 'non-string ctx values keep their type');
    }
  });

  it('the console re-print cannot forge a second line or inject ANSI', () => {
    const lines = captureConsole(() => {
      log.info('Probe', PAYLOAD, { model: PAYLOAD });
      log.warn('Chat[r_x]', PAYLOAD);
      log.error('oops', new Error(`boom\nforged: ${PAYLOAD}`));
    });
    assert.ok(lines.length >= 3, `expected console output, got: ${JSON.stringify(lines)}`);
    for (const chunk of lines) {
      assert.doesNotMatch(chunk, CONTROL,
        `console output carries a control char — a terminal sees raw ANSI/newline: ${JSON.stringify(chunk)}`);
    }
    // The forgery text survives only as inert text inside the real line.
    assert.ok(lines.some((l) => l.includes('Account added: account=attacker')),
      'the message text should survive, minus its control chars');
    assert.ok(!lines.some((l) => /^\[INFO\] Account added/.test(l)),
      'no captured chunk may BE the forged line');
  });

  it('a bound-context logger (withCtx) is scrubbed too', () => {
    const seen = [];
    const sub = (e) => seen.push(e);
    subscribeToLogs(sub);
    try {
      withCtx({ requestId: 'r_abc', model: PAYLOAD }).info('hello');
    } finally {
      unsubscribeFromLogs(sub);
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ctx.requestId, 'r_abc');
    assert.equal(seen[0].ctx.model.includes('\n'), false);
    assert.equal(seen[0].ctx.model.includes('\u001b'), false);
  });

  it('a flood-length message is capped', () => {
    const seen = [];
    const sub = (e) => seen.push(e);
    subscribeToLogs(sub);
    try { log.info('x'.repeat(9000)); } finally { unsubscribeFromLogs(sub); }
    assert.equal(seen.length, 1);
    assert.ok(seen[0].msg.length <= 4100, `msg not capped: ${seen[0].msg.length} chars`);
    assert.match(seen[0].msg, /\u2026$/, 'a truncated msg must show the ellipsis marker');
  });

  it('the persisted JSONL stays one parseable entry per line and carries no controls', async () => {
    // The file leg is the one sink the txt export does NOT share with the ring
    // buffer, so prove it end-to-end rather than assuming the same object.
    const marker = `s5p1-${Date.now()}`;
    log.warn('Probe', `${marker} ${PAYLOAD}`, { token: `${marker}\nforged` });
    const appFile = join(getLogDir(), `app-${today()}.jsonl`);
    let line = '';
    // Stream writes flush asynchronously; poll briefly instead of sleeping blind.
    for (let i = 0; i < 50 && !line; i++) {
      await new Promise((r) => setTimeout(r, 40));
      if (!existsSync(appFile)) continue;
      line = readFileSync(appFile, 'utf8').split('\n').find((l) => l.includes(marker)) || '';
    }
    assert.ok(line, `the JSONL entry never landed in ${appFile}`);
    assert.doesNotMatch(line, /\u001b/, 'the file itself must not contain a raw ESC');
    const entry = JSON.parse(line); // each physical line is exactly one entry
    assert.equal(entry.level, 'warn');
    assert.doesNotMatch(entry.msg, CONTROL);
    assert.doesNotMatch(entry.ctx.token, CONTROL);
  });
});
