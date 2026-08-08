import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkTextClassifier } from '../src/response-classifier.js';

const OPEN = '<' + 'think' + '>';
const CLOSE = '<' + '/' + 'think' + '>';

function runAll(parts) {
  const c = new ThinkTextClassifier();
  let text = '', thinking = '';
  for (const p of parts) {
    const r = c.feed(p);
    text += r.text;
    thinking += r.thinking;
  }
  text += c.flush();
  return { text, thinking };
}

describe('ThinkTextClassifier', () => {
  it('passes plain text through unchanged', () => {
    const { text, thinking } = runAll(['Hello, ', 'world!']);
    assert.equal(text, 'Hello, world!');
    assert.equal(thinking, '');
  });

  it('routes a full think block to thinking', () => {
    const { text, thinking } = runAll([OPEN + 'Let me compute. ' + CLOSE, 'The answer is 42.']);
    assert.equal(thinking, 'Let me compute. ');
    assert.equal(text, 'The answer is 42.');
  });

  it('routes think block split across many deltas', () => {
    const { text, thinking } = runAll(['<' + 'thin', 'k' + '>step ', 'one; step two', '<' + '/thi', 'nk' + '>', 'Final: 7.']);
    assert.equal(thinking, 'step one; step two');
    assert.equal(text, 'Final: 7.');
  });

  it('routes a bare opening marker (loop artifact) to thinking', () => {
    const { text, thinking } = runAll([OPEN]);
    assert.equal(thinking, '');
    assert.equal(text, '');
  });

  it('does not reroute text that merely mentions the word think', () => {
    const { text, thinking } = runAll(['I think this is correct.']);
    assert.equal(text, 'I think this is correct.');
    assert.equal(thinking, '');
  });

  it('does not reroute when real text precedes the marker in the same delta', () => {
    const { text, thinking } = runAll(['Here is a sample: ' + OPEN + 'inner' + CLOSE + ' done.']);
    assert.equal(thinking, '');
    assert.equal(text, 'Here is a sample: ' + OPEN + 'inner' + CLOSE + ' done.');
  });

  it('allows leading whitespace before the marker', () => {
    const { text, thinking } = runAll(['  \n' + OPEN + 'reasoning' + CLOSE + 'Answer.']);
    assert.equal(thinking, 'reasoning');
    assert.equal(text, 'Answer.'); // leading whitespace-only prefix is dropped
  });

  it('does not reroute once real text was committed (mid-answer marker)', () => {
    const { text, thinking } = runAll(['Real answer here. ', OPEN + 'late noise' + CLOSE]);
    assert.equal(thinking, '');
    assert.equal(text, 'Real answer here. ' + OPEN + 'late noise' + CLOSE);
  });

  it('flush releases an unterminated span as text (visible beats dropped)', () => {
    const c = new ThinkTextClassifier();
    const r = c.feed(OPEN + 'dangling reasoning without close');
    assert.equal(r.text, '');
    assert.equal(r.thinking, '');
    assert.equal(c.flush(), 'dangling reasoning without close');
  });

  it('empty and null deltas are inert', () => {
    const c = new ThinkTextClassifier();
    assert.deepEqual(c.feed(''), { text: '', thinking: '' });
    assert.equal(c.flush(), '');
  });
});
