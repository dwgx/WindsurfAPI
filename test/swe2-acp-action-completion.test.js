import test from 'node:test';
import assert from 'node:assert/strict';
import { isPendingAction } from '../src/swe2-acp/protocol.mjs';
import {
  __test,
  closeAllSessions,
  handleSwe2AcpChat,
} from '../src/swe2-acp/bridge.mjs';

const announcement = '도구 연결 확인. 스킬부터 읽을게.';
test('Korean informal action announcements are unfinished, including the reported stall', () => {
  for (const text of [
    announcement,
    '스킬부터 읽을게요.',
    '자료를 찾아볼게.',
    '사이트를 살펴보겠습니다.',
    '공식 사이트와 약관 순으로 볼게.',
    '공개 자료 감사 시작할게.',
    '지금 실행하겠습니다.',
    '파일을 읽어볼게요.',
    '먼저 확인할게.',
    '검색하겠습니다.',
  ]) {
    assert.equal(isPendingAction(text), true, text);
  }
});
test('Completed answers, quoted examples, offers and blockers do not trigger continuation', () => {
  for (const text of [
    '확인했습니다. 결과는 42입니다.',
    '파일을 읽었고 검증을 마쳤습니다.',
    '원하시면 파일을 읽을게요.',
    '필요하면 더 찾아볼게.',
    '권한이 없어 파일을 읽을 수 없습니다.',
    '요청이 콘텐츠 정책에 의해 차단되었습니다.',
    '다음 주에 확인할게요.',
    '예시 문장: "스킬부터 읽을게."',
    'The product is 3973.',
    'The request was blocked by our content policy.',
  ]) {
    assert.equal(isPendingAction(text), false, text);
  }
});

// Exercise the real handler and SSE finish frame with a deterministic ACP peer.
// This does not execute native or client tools or make a provider request.
for (const stream of [false, true]) {
  test(`A premature Korean end_turn continues to a client tool (stream=${stream})`, async () => {
    const start = __test.Session.prototype.start;
    const begin = __test.Session.prototype.begin;
    let prompts = 0;
    __test.Session.prototype.start = async function () {
      this.id = 'korean-action-fixture';
    };
    __test.Session.prototype.begin = function () {
      prompts++;
      if (prompts === 1) {
        this.push({ type: 'text', text: announcement });
        this.push({ type: 'done', result: { stopReason: 'end_turn' } });
      } else {
        this.push({
          type: 'tool',
          call: {
            id: 'callfixture',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"fixture.md"}' },
          },
        });
      }
    };
    try {
      const result = await handleSwe2AcpChat(
        {
          stream,
          model: 'swe-2-high',
          reasoning_effort: 'medium',
          tools: [{ function: { name: 'read_file' } }],
          messages: [
            { role: 'user', content: 'Read the requested skill and continue.' },
          ],
        },
        { callerKey: 'korean-regression' },
      );
      assert.equal(result.status, 200);
      if (stream) {
        let wire = '';
        await result.handler({
          writableEnded: false,
          write(chunk) {
            wire += chunk;
          },
          end() {
            this.writableEnded = true;
          },
        });
        const frames = wire
          .split('\n')
          .filter((line) => line.startsWith('data: {'))
          .map((line) => JSON.parse(line.slice(6)));
        assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls');
        assert.equal(
          frames.some((f) => f.choices?.[0].finish_reason === 'stop'),
          false,
        );
        assert.equal(
          frames.flatMap((f) => f.choices?.[0].delta.tool_calls || [])[0]
            .function.name,
          'read_file',
        );
      } else {
        assert.equal(result.body.choices[0].finish_reason, 'tool_calls');
        assert.equal(
          result.body.choices[0].message.tool_calls[0].function.name,
          'read_file',
        );
      }
      assert.equal(prompts, 2);
    } finally {
      __test.Session.prototype.start = start;
      __test.Session.prototype.begin = begin;
      await closeAllSessions();
    }
  });
}

test('A second unfinished announcement fails explicitly after one continuation', async () => {
  const start = __test.Session.prototype.start;
  const begin = __test.Session.prototype.begin;
  let prompts = 0;
  __test.Session.prototype.start = async function () {
    this.id = 'bounded-fixture';
  };
  __test.Session.prototype.begin = function () {
    prompts++;
    this.push({ type: 'text', text: announcement });
    this.push({ type: 'done', result: { stopReason: 'end_turn' } });
  };
  try {
    const result = await handleSwe2AcpChat(
      {
        model: 'swe-2-high',
        reasoning_effort: 'medium',
        tools: [{ function: { name: 'read_file' } }],
        messages: [{ role: 'user', content: 'Read the skill.' }],
      },
      { callerKey: 'bounded-regression' },
    );
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, 'SWE2_TOOL_CALL_REQUIRED');
    assert.equal(prompts, 2);
  } finally {
    __test.Session.prototype.start = start;
    __test.Session.prototype.begin = begin;
    await closeAllSessions();
  }
});
