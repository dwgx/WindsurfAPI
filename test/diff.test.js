import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toLines, lineDiff, hasChange, diffStat } from '../src/dashboard/diff.js';

describe('toLines', () => {
  it('null/undefined → []', () => {
    assert.deepEqual(toLines(null), []);
    assert.deepEqual(toLines(undefined), []);
  });
  it('string → split lines', () => {
    assert.deepEqual(toLines('a\nb'), ['a', 'b']);
  });
  it('object → pretty JSON lines', () => {
    assert.deepEqual(toLines({ x: 1 }), ['{', '  "x": 1', '}']);
  });
});

describe('lineDiff', () => {
  it('identical → all context', () => {
    const d = lineDiff('a\nb', 'a\nb');
    assert.ok(d.every(x => x.op === 'ctx'));
  });
  it('pure addition', () => {
    const d = lineDiff('a', 'a\nb');
    assert.deepEqual(d, [{ op: 'ctx', text: 'a' }, { op: 'add', text: 'b' }]);
  });
  it('pure deletion', () => {
    const d = lineDiff('a\nb', 'a');
    assert.deepEqual(d, [{ op: 'ctx', text: 'a' }, { op: 'del', text: 'b' }]);
  });
  it('replacement shows del then add', () => {
    const d = lineDiff('x', 'y');
    assert.deepEqual(d, [{ op: 'del', text: 'x' }, { op: 'add', text: 'y' }]);
  });
  it('middle change preserves surrounding context', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc');
    assert.deepEqual(d, [
      { op: 'ctx', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'ctx', text: 'c' },
    ]);
  });
  it('diffs objects by pretty-JSON lines', () => {
    const d = lineDiff({ port: 3003 }, { port: 3004 });
    assert.ok(d.some(x => x.op === 'del' && x.text.includes('3003')));
    assert.ok(d.some(x => x.op === 'add' && x.text.includes('3004')));
  });
  it('empty before → all additions', () => {
    const d = lineDiff(null, 'a\nb');
    assert.deepEqual(d, [{ op: 'add', text: 'a' }, { op: 'add', text: 'b' }]);
  });
});

describe('hasChange', () => {
  it('false for identical, true for any change', () => {
    assert.equal(hasChange('a\nb', 'a\nb'), false);
    assert.equal(hasChange('a', 'a\nb'), true);
    assert.equal(hasChange({ x: 1 }, { x: 1 }), false);
    assert.equal(hasChange({ x: 1 }, { x: 2 }), true);
  });
});

describe('diffStat', () => {
  it('counts additions and deletions', () => {
    assert.deepEqual(diffStat('a\nb\nc', 'a\nX\nc'), { add: 1, del: 1 });
    assert.deepEqual(diffStat('a', 'a\nb\nc'), { add: 2, del: 0 });
    assert.deepEqual(diffStat('a\nb', 'a'), { add: 0, del: 1 });
  });
});
