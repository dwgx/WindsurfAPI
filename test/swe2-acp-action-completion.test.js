import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionIssue,
  completionNudge,
  isPendingAction,
  pendingSkillRead,
} from '../src/swe2-acp/protocol.mjs';
import {
  __test,
  closeAllSessions,
  handleSwe2AcpChat,
} from '../src/swe2-acp/bridge.mjs';

const announcement = '도구 연결 확인. 스킬부터 읽을게.';
const skillPath = '/Users/test/.agents/skills/ultraresearch/SKILL.md';
const readTool = {
  function: {
    name: 'read_file',
    description: 'Read a client file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

test('Explicit Aside skill links require the matching client read result', () => {
  const messages = [
    {
      role: 'user',
      content: `Use [$Ultraresearch](${skillPath}) for this task.`,
    },
  ];
  const defs = [
    {
      originalName: 'read_file',
      inputSchema: readTool.function.parameters,
    },
  ];
  assert.deepEqual(pendingSkillRead(messages, defs), {
    index: 0,
    name: 'Ultraresearch',
    path: skillPath,
    toolNames: ['read_file'],
  });
  assert.equal(
    completionIssue({ attemptText: 'I can help.', messages, body: {}, defs })
      .kind,
    'skill_read_required',
  );
});

test('A matching read result satisfies the explicit skill contract', () => {
  const messages = [
    {
      role: 'user',
      content: `Use [$Ultraresearch](${skillPath}) for this task.`,
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'callskill',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: skillPath }),
          },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'callskill', content: 'skill contents' },
  ];
  const defs = [
    {
      originalName: 'read_file',
      inputSchema: readTool.function.parameters,
    },
  ];
  assert.equal(pendingSkillRead(messages, defs), null);
});

test('An empty post-tool turn gets a replay-safe final-answer continuation', () => {
  const issue = completionIssue({
    attemptText: '',
    messages: [],
    body: {},
    defs: [],
    receivedToolResults: true,
  });
  assert.deepEqual(issue, { kind: 'empty_post_tool' });
  assert.match(completionNudge(issue), /complete final answer now/);
  assert.match(completionNudge(issue), /Do not repeat completed side effects/);
});
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

test('An empty turn after a real client tool result continues to a final answer', async () => {
  const begin = __test.Session.prototype.begin;
  let continuations = 0;
  const call = {
    id: 'callposttool',
    type: 'function',
    function: {
      name: 'read_file',
      arguments: JSON.stringify({ path: skillPath }),
    },
  };
  const body = {
    model: 'swe-2-high',
    reasoning_effort: 'high',
    tools: [readTool],
    messages: [
      {
        role: 'user',
        content: `Use [$Ultraresearch](${skillPath}) for this task.`,
      },
      { role: 'assistant', content: null, tool_calls: [call] },
      {
        role: 'tool',
        tool_call_id: call.id,
        content: 'PROBE_VALUE=post-tool-recovered',
      },
    ],
  };
  const context = { callerKey: 'post-tool-regression' };
  const session = new __test.Session(body, context);
  session.id = 'post-tool-fixture';
  __test.sessions.add(session);
  const pending = {
    session,
    call,
    send() {
      session.push({ type: 'done', result: { stopReason: 'end_turn' } });
    },
  };
  session.calls.set(call.id, pending);
  __test.pendingCalls.set(call.id, pending);
  __test.Session.prototype.begin = function () {
    continuations++;
    this.push({
      type: 'text',
      text: 'Final answer: post-tool-recovered',
    });
    this.push({ type: 'done', result: { stopReason: 'end_turn' } });
  };
  try {
    const result = await handleSwe2AcpChat(body, context);
    assert.equal(result.status, 200);
    assert.equal(
      result.body.choices[0].message.content,
      'Final answer: post-tool-recovered',
    );
    assert.equal(continuations, 1);
  } finally {
    __test.Session.prototype.begin = begin;
    await closeAllSessions();
  }
});
