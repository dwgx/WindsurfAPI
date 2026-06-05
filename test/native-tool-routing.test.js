import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  getApiKey,
  removeAccount,
} from '../src/auth.js';
import {
  applyToolPreambleBudget,
  buildToolRoutingPlan,
  handleChatCompletions,
} from '../src/handlers/chat.js';

const createdAccountIds = [];

const fnTool = (name) => ({
  type: 'function',
  function: {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
  },
});

const originalNativeBridge = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
const originalNativeBridgeOff = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

afterEach(() => {
  if (originalNativeBridge === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = originalNativeBridge;
  if (originalNativeBridgeOff === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF = originalNativeBridgeOff;
  while (createdAccountIds.length) {
    removeAccount(createdAccountIds.pop());
  }
});

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseChatFrames(raw) {
  return raw
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
      const payload = dataLine?.slice(6) || '';
      return payload === '[DONE]' ? '[DONE]' : JSON.parse(payload);
    });
}

describe('native mapped-tool routing', () => {
  it('all_mapped mode routes Read/Bash/Grep/Glob/WebSearch/WebFetch through native bridge only', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('Read'),
      fnTool('Bash'),
      fnTool('Grep'),
      fnTool('Glob'),
      fnTool('WebSearch'),
      fnTool('WebFetch'),
    ], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, true);
    assert.equal(plan.partition.mapped.length, 6);
    assert.equal(plan.partition.unmapped.length, 0);
    assert.deepEqual(plan.emulationTools, []);
    assert.equal(plan.shouldBuildToolPreamble, false);

    const preamble = applyToolPreambleBudget(plan.emulationTools, 'auto', '', {
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });
    assert.equal(preamble.preamble, '');
    assert.equal(preamble.tier, 'empty');
  });

  it('all_mapped mode refuses mixed toolsets so unmapped tools still get prompt emulation', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('Read'),
      fnTool('Bash'),
      fnTool('update_plan'),
    ], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, false);
    assert.equal(plan.partition.mapped.length, 2);
    assert.equal(plan.partition.unmapped.length, 1);
    assert.equal(plan.emulationTools.length, 3);
    assert.equal(plan.shouldBuildToolPreamble, true);
  });

  it('force mode keeps partition behavior: mapped native plus unmapped preamble', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('Read'),
      fnTool('update_plan'),
    ], {
      useCascade: true,
      modelKey: 'gpt-5.5-medium',
      provider: 'openai',
      route: 'responses',
    });

    assert.equal(plan.nativeBridgeOn, true);
    assert.equal(plan.nativeCallerTools.length, 1);
    assert.equal(plan.emulationTools.length, 1);
    assert.equal(plan.emulationTools[0].function.name, 'update_plan');
    assert.equal(plan.shouldBuildToolPreamble, true);
  });

  it('stream native bridge converts provider-native XML before content is emitted', async () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
    const account = addAccountByKey(`native-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'native-stream');
    createdAccountIds.push(account.id);

    class FakeClient {
      async cascadeChat(_messages, _modelEnum, _modelUid, opts) {
        assert.equal(opts.nativeMode, true);
        opts.onChunk({ text: 'before <fun' });
        opts.onChunk({ text: 'ction_calls><invoke name="read_file">' });
        opts.onChunk({ text: '<parameter name="path">README.md</parameter></invoke></function_calls> after' });
        return { text: '', toolCalls: [] };
      }
    }

    const result = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'read the readme' }],
      tools: [fnTool('Read')],
    }, {
      waitForAccount(tried, _signal, _maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
      ensureLs: async () => {},
      getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
      WindsurfClient: FakeClient,
    });

    assert.equal(result.status, 200);
    assert.equal(result.stream, true);
    const res = fakeRes();
    await result.handler(res);
    assert.equal(res.body.includes('<function_calls>'), false);
    assert.equal(res.body.includes('<invoke'), false);

    const frames = parseChatFrames(res.body).filter(f => f !== '[DONE]');
    const content = frames.flatMap(f => f.choices || [])
      .map(c => c.delta?.content || '')
      .join('');
    assert.equal(content, 'before  after');
    const toolDeltas = frames.flatMap(f => f.choices || [])
      .map(c => c.delta?.tool_calls?.[0])
      .filter(Boolean);
    assert.ok(toolDeltas.length >= 1);
    assert.equal(toolDeltas[0].function.name, 'Read');
    assert.match(toolDeltas.map(t => t.function.arguments || '').join(''), /README\.md/);
    const finish = frames.flatMap(f => f.choices || []).find(c => c.finish_reason);
    assert.equal(finish.finish_reason, 'tool_calls');
  });
});
