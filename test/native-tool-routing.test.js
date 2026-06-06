import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  getApiKey,
  removeAccount,
} from '../src/auth.js';
import { parseFields, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';
import {
  applyToolPreambleBudget,
  buildToolRoutingPlan,
  effectiveToolsForToolChoice,
  handleChatCompletions,
  summarizeToolRoutingDiagnostics,
} from '../src/handlers/chat.js';
import {
  buildReverseLookup,
  decodeCascadeStepToToolCall,
  getNativeBridgeConfigStatus,
  getNativeBridgeDecision,
  nativeAllowlistNameForTool,
} from '../src/cascade-native-bridge.js';
import {
  getNativeBridgeStats,
  resetNativeBridgeStats,
} from '../src/native-bridge-stats.js';

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
const originalNativeBridgeTools = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
const originalNativeBridgeModels = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS;
const originalNativeBridgeProviders = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_PROVIDERS;
const originalNativeBridgeRoutes = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ROUTES;
const originalNativeBridgeCallers = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CALLERS;
const originalNativeBridgeApiKeys = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS;
const originalNativeBridgeAccounts = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS;
const originalNativeBridgeAllowlistNames = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES;
const originalNativeBridgeRawConfig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW;

afterEach(() => {
  if (originalNativeBridge === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = originalNativeBridge;
  if (originalNativeBridgeOff === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF = originalNativeBridgeOff;
  if (originalNativeBridgeTools === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = originalNativeBridgeTools;
  if (originalNativeBridgeModels === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS = originalNativeBridgeModels;
  if (originalNativeBridgeProviders === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_PROVIDERS;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_PROVIDERS = originalNativeBridgeProviders;
  if (originalNativeBridgeRoutes === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ROUTES;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ROUTES = originalNativeBridgeRoutes;
  if (originalNativeBridgeCallers === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CALLERS;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CALLERS = originalNativeBridgeCallers;
  if (originalNativeBridgeApiKeys === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS = originalNativeBridgeApiKeys;
  if (originalNativeBridgeAccounts === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS = originalNativeBridgeAccounts;
  if (originalNativeBridgeAllowlistNames === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES = originalNativeBridgeAllowlistNames;
  if (originalNativeBridgeRawConfig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW;
  else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW = originalNativeBridgeRawConfig;
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

describe('native bridge config status', () => {
  it('summarizes gates without exposing API keys or account values', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF = '0';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read,Bash';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS = 'claude-4.5-haiku';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_PROVIDERS = 'anthropic';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ROUTES = 'chat';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CALLERS = 'caller-a';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS = 'secret-key';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS = 'secret-account';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES = 'Read:read_file';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW = 'read_file:7801';

    const status = getNativeBridgeConfigStatus();
    assert.equal(status.mode, 'all_mapped');
    assert.equal(status.off, false);
    assert.deepEqual(status.tools, ['Read', 'Bash']);
    assert.deepEqual(status.models, ['claude-4.5-haiku']);
    assert.deepEqual(status.providers, ['anthropic']);
    assert.deepEqual(status.routes, ['chat']);
    assert.deepEqual(status.callers, ['caller-a']);
    assert.deepEqual(status.allowlistNameOverrides, ['Read:read_file']);
    assert.equal(status.hasApiKeyGate, true);
    assert.equal(status.hasAccountGate, true);
    assert.equal(status.hasRawConfig, true);
    assert.equal(JSON.stringify(status).includes('secret-key'), false);
    assert.equal(JSON.stringify(status).includes('secret-account'), false);
  });
});

describe('native mapped-tool routing', () => {
  it('applies tool_choice before native bridge routing', () => {
    const tools = [fnTool('Read'), fnTool('Bash')];
    assert.deepEqual(effectiveToolsForToolChoice(tools, 'none'), []);
    assert.deepEqual(
      effectiveToolsForToolChoice(tools, { type: 'function', function: { name: 'Read' } }).map(t => t.function.name),
      ['Read'],
    );

    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
    const nonePlan = buildToolRoutingPlan(effectiveToolsForToolChoice(tools, 'none'), {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });
    assert.equal(nonePlan.nativeBridgeOn, false);

    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
    const forcedPlan = buildToolRoutingPlan(effectiveToolsForToolChoice(tools, { type: 'function', function: { name: 'Read' } }), {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });
    assert.equal(forcedPlan.nativeBridgeOn, true);
    assert.deepEqual(forcedPlan.nativeCallerTools.map(t => t.function.name), ['Read']);
  });

  it('diagnoses forced tool_choice that leaves no effective tools', () => {
    const tools = [fnTool('Read'), fnTool('Bash')];
    const effective = effectiveToolsForToolChoice(tools, { type: 'function', function: { name: 'MissingTool' } });
    const plan = buildToolRoutingPlan(effective, {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });
    const diag = summarizeToolRoutingDiagnostics({
      tools,
      effectiveTools: effective,
      toolChoice: { type: 'function', function: { name: 'MissingTool' } },
      toolRouting: plan,
    });

    assert.deepEqual(diag.requested, ['Read', 'Bash']);
    assert.deepEqual(diag.effective, []);
    assert.equal(diag.forcedName, 'MissingTool');
    assert.ok(diag.reasons.includes('forced_tool_not_declared'));
    assert.ok(diag.reasons.includes('effective_tools_empty'));
  });

  it('defaults native bridge production canaries to Bash/run_command only', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('Read'),
      fnTool('Bash'),
      fnTool('Grep'),
      fnTool('Glob'),
    ], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, false);
    assert.equal(plan.nativeDecision.reason, 'native_bridge_all_mapped_required');
    assert.deepEqual(plan.partition.mapped.map(t => t.function.name), ['Bash']);
    assert.deepEqual(plan.partition.unmapped.map(t => t.function.name), ['Read', 'Grep', 'Glob']);
  });

  it('explicit native tool allowlist can opt Read/Grep/Glob into protocol matrix canaries', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read,Bash,Grep,Glob';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('Read'),
      fnTool('Bash'),
      fnTool('Grep'),
      fnTool('Glob'),
    ], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, true);
    assert.equal(plan.partition.mapped.length, 4);
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

  it('keeps Read/WebSearch/WebFetch on emulation by default when only Bash is mature', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('Read'),
      fnTool('WebSearch'),
      fnTool('WebFetch'),
    ], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, false);
    assert.deepEqual(plan.partition.mapped.map(t => t.function.name), []);
    assert.deepEqual(plan.partition.unmapped.map(t => t.function.name), ['Read', 'WebSearch', 'WebFetch']);
    assert.deepEqual(plan.emulationTools.map(t => t.function.name), ['Read', 'WebSearch', 'WebFetch']);
  });

  it('keeps read/edit/write/web tools out of native bridge unless explicitly allowlisted', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('Read'),
      fnTool('Write'),
      fnTool('Edit'),
      fnTool('MultiEdit'),
      fnTool('WebSearch'),
      fnTool('WebFetch'),
    ], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, false);
    assert.deepEqual(plan.partition.mapped.map(t => t.function.name), []);
    assert.deepEqual(plan.partition.unmapped.map(t => t.function.name), ['Read', 'Write', 'Edit', 'MultiEdit', 'WebSearch', 'WebFetch']);
  });

  it('explicit native tool allowlist can opt WebSearch/WebFetch into native bridge', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read,WebSearch,WebFetch';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('Read'),
      fnTool('WebSearch'),
      fnTool('WebFetch'),
    ], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, true);
    assert.deepEqual(plan.partition.mapped.map(t => t.function.name), ['Read', 'WebSearch', 'WebFetch']);
    assert.deepEqual(plan.partition.unmapped, []);
  });

  it('keeps only shell aliases in the default native scope', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([
      fnTool('shell_command'),
      fnTool('read_file'),
      fnTool('grep_v2'),
      fnTool('grep_search_v2'),
      fnTool('find'),
    ], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, false);
    assert.deepEqual(plan.partition.mapped.map(t => t.function.name), ['shell_command']);
    assert.deepEqual(plan.partition.unmapped.map(t => t.function.name), ['read_file', 'grep_v2', 'grep_search_v2', 'find']);
  });

  it('can override Cascade allowlist names for proto matrix experiments only', () => {
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES;
    assert.equal(nativeAllowlistNameForTool('Read'), 'read_file');
    assert.equal(nativeAllowlistNameForTool('view_file'), 'read_file');
    assert.equal(nativeAllowlistNameForTool('Grep'), 'grep_search_v2');
    assert.equal(nativeAllowlistNameForTool('Glob'), 'find');

    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES = 'Read:read_file,Grep:grep_v2,find:list_dir';
    assert.equal(nativeAllowlistNameForTool('Read'), 'read_file');
    assert.equal(nativeAllowlistNameForTool('Grep'), 'grep_v2');
    assert.equal(nativeAllowlistNameForTool('Glob'), 'list_dir');
    assert.equal(nativeAllowlistNameForTool('Bash'), 'run_command');
  });

  it('maps list_directory native steps back to caller Glob when find is allowlist-overridden', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES = 'find:list_dir';
    const lookup = buildReverseLookup([fnTool('Glob')]);
    assert.deepEqual(lookup.get('find'), ['Glob']);
    assert.deepEqual(lookup.get('list_directory'), ['Glob']);

    const stepBuf = Buffer.concat([
      writeVarintField(1, 15),
      writeVarintField(4, 7),
      writeMessageField(15, writeStringField(1, 'file:///home/user/projects/workspace-test')),
    ]);
    const parsed = decodeCascadeStepToToolCall(
      parseFields(stepBuf),
      'list_directory',
      lookup,
    );
    assert.equal(parsed.name, 'Glob');
    assert.equal(parsed.cascade_kind, 'list_directory');
    assert.deepEqual(parsed.arguments, {
      pattern: '*',
      path: '/home/user/projects/workspace-test',
    });
  });

  it('all_mapped mode refuses mixed toolsets so unmapped tools still get prompt emulation', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read,Bash';
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
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
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

  it('honors model and caller gray gates before enabling native bridge', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS = 'claude-sonnet-4.6';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CALLERS = 'caller-allowed';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const deniedModel = buildToolRoutingPlan([fnTool('Read')], {
      useCascade: true,
      modelKey: 'gpt-5.5-medium',
      provider: 'openai',
      route: 'chat',
      callerKey: 'caller-allowed',
    });
    assert.equal(deniedModel.nativeBridgeOn, false);
    assert.equal(deniedModel.nativeDecision.reason, 'native_bridge_model_not_allowed');

    const deniedCaller = buildToolRoutingPlan([fnTool('Read')], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
      callerKey: 'caller-denied',
    });
    assert.equal(deniedCaller.nativeBridgeOn, false);
    assert.equal(deniedCaller.nativeDecision.reason, 'native_bridge_caller_not_allowed');

    const allowed = buildToolRoutingPlan([fnTool('Read')], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
      callerKey: 'caller-allowed',
    });
    assert.equal(allowed.nativeBridgeOn, true);
    assert.equal(allowed.nativeDecision.reason, 'native_bridge_enabled');
  });

  it('honors requested model aliases in native bridge model gray gates', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS = 'claude-haiku-4.5';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const plan = buildToolRoutingPlan([fnTool('Read')], {
      useCascade: true,
      modelKey: 'claude-4.5-haiku',
      model: 'claude-haiku-4.5',
      provider: 'anthropic',
      route: 'chat',
    });

    assert.equal(plan.nativeBridgeOn, true);
    assert.equal(plan.nativeDecision.reason, 'native_bridge_enabled');
    assert.equal(plan.nativeDecision.modelKey, 'claude-4.5-haiku');
    assert.equal(plan.nativeDecision.requestedModel, 'claude-haiku-4.5');
  });

  it('explains native bridge disabled decisions for operators', () => {
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
    assert.equal(
      getNativeBridgeDecision([fnTool('Bash')], {
        useCascade: true,
        modelKey: 'claude-sonnet-4.6',
        provider: 'anthropic',
        route: 'chat',
      }).reason,
      'native_bridge_mode_not_enabled',
    );

    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
    const noMapped = getNativeBridgeDecision([fnTool('update_plan')], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
    });
    assert.equal(noMapped.enabled, false);
    assert.equal(noMapped.reason, 'native_bridge_no_mapped_tools');
    assert.deepEqual(noMapped.unmappedTools, ['update_plan']);

    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF = '1';
    assert.equal(
      getNativeBridgeDecision([fnTool('Read')], {
        useCascade: true,
        modelKey: 'claude-sonnet-4.6',
        provider: 'anthropic',
        route: 'chat',
      }).reason,
      'native_bridge_off',
    );
  });

  it('requires the API-key sentinel when API key gray gate is configured', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS = 'sk-test';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const denied = buildToolRoutingPlan([fnTool('Read')], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
      callerKey: 'api:hash',
    });
    assert.equal(denied.nativeBridgeOn, false);

    const allowed = buildToolRoutingPlan([fnTool('Read')], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
      callerKey: 'api:hash:api_key_allowed',
    });
    assert.equal(allowed.nativeBridgeOn, true);
  });

  it('matches caller gray gate even when API-key sentinel is appended', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS = 'sk-test';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CALLERS = 'api:hash';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const allowed = buildToolRoutingPlan([fnTool('Read')], {
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
      callerKey: 'api:hash:api_key_allowed',
    });
    assert.equal(allowed.nativeBridgeOn, true);
  });

  it('fails fast when native account gate has no active match', async () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS = 'missing@example.com';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;

    const result = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      stream: false,
      messages: [{ role: 'user', content: 'read the readme' }],
      tools: [fnTool('Read')],
    });

    assert.equal(result.status, 503);
    assert.equal(result.body.error.type, 'native_bridge_account_unavailable');
  });

  it('skips non-allowlisted accounts before starting LS in native mode', async () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS = 'allowed@example.com';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
    const seen = [];
    const deniedAccount = addAccountByKey(`native-denied-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'denied@example.com');
    const allowedAccount = addAccountByKey(`native-allowed-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'allowed@example.com');
    createdAccountIds.push(deniedAccount.id, allowedAccount.id);
    const denied = { ...deniedAccount, reservationTimestamp: Date.now() };
    const allowed = { ...allowedAccount, reservationTimestamp: Date.now() };

    class FakeClient {
      constructor(apiKey) {
        assert.equal(apiKey, allowed.apiKey);
      }
      async cascadeChat(_messages, _modelEnum, _modelUid, opts) {
        assert.equal(opts.nativeMode, true);
        opts.onChunk({ text: 'ok' });
        return { text: '', toolCalls: [] };
      }
    }

    const result = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'read the readme via provider-native xml' }],
      tools: [fnTool('Read')],
    }, {
      waitForAccount(tried) {
        seen.push([...tried]);
        if (tried.length === 0) return denied;
        if (tried.length === 1) return allowed;
        return null;
      },
      releaseAccount: () => {},
      ensureLs: async () => {},
      getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
      WindsurfClient: FakeClient,
    });

    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);
    assert.equal(seen.length >= 2, true);
    assert.equal(res.body.includes('ok'), true);
  });

  it('stream native bridge converts provider-native XML before content is emitted', async () => {
    resetNativeBridgeStats();
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read';
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

    const stats = getNativeBridgeStats();
    assert.equal(stats.requests, 1);
    assert.equal(stats.providerXmlToolCalls, 1);
    assert.equal(stats.emittedToolCalls, 1);
    assert.equal(stats.requestedByTool.Read, 1);
    assert.equal(stats.emittedByTool.Read, 1);
  });

  it('stream native bridge filters cascade tool calls through forced tool_choice', async () => {
    resetNativeBridgeStats();
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read,Bash';
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
    const account = addAccountByKey(`native-choice-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'native-choice');
    createdAccountIds.push(account.id);

    class FakeClient {
      async cascadeChat(_messages, _modelEnum, _modelUid, opts) {
        assert.equal(opts.nativeMode, true);
        assert.deepEqual(opts.nativeAllowlist, ['read_file']);
        opts.onChunk({
          nativeToolCall: {
            cascade_native: true,
            name: 'run_command',
            argumentsJson: JSON.stringify({ command_line: 'echo should_not_surface' }),
          },
        });
        return { text: '', toolCalls: [] };
      }
    }

    const result = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'read the readme' }],
      tools: [fnTool('Read'), fnTool('Bash')],
      tool_choice: { type: 'function', function: { name: 'Read' } },
    }, {
      waitForAccount(tried, _signal, _maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
      ensureLs: async () => {},
      getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
      WindsurfClient: FakeClient,
    });

    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);
    assert.equal(res.body.includes('should_not_surface'), false);
    const frames = parseChatFrames(res.body).filter(f => f !== '[DONE]');
    const toolDeltas = frames.flatMap(f => f.choices || [])
      .map(c => c.delta?.tool_calls?.[0])
      .filter(Boolean);
    assert.equal(toolDeltas.length, 0);
    const stats = getNativeBridgeStats();
    assert.equal(stats.requests, 1);
    assert.equal(stats.cascadeToolCalls, 1);
    assert.equal(stats.unmappedCascadeToolCalls, 1);
    assert.equal(stats.emittedToolCalls, 0);
  });
});
