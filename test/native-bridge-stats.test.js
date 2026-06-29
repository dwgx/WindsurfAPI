import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getNativeBridgeStats,
  recordNativeBridgeAccountGateReject,
  recordNativeBridgeAccountGateSkip,
  recordNativeBridgeCascadeToolCall,
  recordNativeBridgeEmittedToolCall,
  recordNativeBridgeNoToolCallResponse,
  recordNativeBridgeDecision,
  recordNativeBridgeRequest,
  recordNativeBridgeUnmappedCascadeToolCall,
  resetNativeBridgeStats,
} from '../src/native-bridge-stats.js';

describe('native bridge runtime stats', () => {
  beforeEach(() => resetNativeBridgeStats());

  it('records request, tool, cascade kind, fallback and gate counters', () => {
    recordNativeBridgeRequest({
      mappedTools: ['Read', 'Bash'],
      unmappedTools: ['update_plan'],
      additionalSteps: 2,
    });
    recordNativeBridgeCascadeToolCall('run_command');
    recordNativeBridgeEmittedToolCall('Bash', { source: 'cascade' });
    recordNativeBridgeEmittedToolCall('Read', { source: 'provider_xml' });
    recordNativeBridgeUnmappedCascadeToolCall('list_directory');
    recordNativeBridgeAccountGateReject();
    recordNativeBridgeAccountGateSkip();
    recordNativeBridgeNoToolCallResponse();

    const stats = getNativeBridgeStats();
    assert.equal(stats.requests, 1);
    assert.equal(stats.mappedTools, 2);
    assert.equal(stats.unmappedTools, 1);
    assert.equal(stats.additionalSteps, 2);
    assert.equal(stats.cascadeToolCalls, 1);
    assert.equal(stats.emittedToolCalls, 2);
    assert.equal(stats.providerXmlToolCalls, 1);
    assert.equal(stats.unmappedCascadeToolCalls, 1);
    assert.equal(stats.accountGateRejects, 1);
    assert.equal(stats.accountGateSkips, 1);
    assert.equal(stats.noToolCallResponses, 1);
    assert.equal(stats.requestedByTool.Read, 1);
    assert.equal(stats.requestedByTool.Bash, 1);
    assert.equal(stats.unmappedRequestedByTool.update_plan, 1);
    assert.equal(stats.emittedByTool.Read, 1);
    assert.equal(stats.emittedByTool.Bash, 1);
    assert.equal(stats.byCascadeKind.run_command, 1);
    assert.equal(stats.byCascadeKind.list_directory, undefined);
    assert.equal(stats.unmappedByCascadeKind.list_directory, 1);
  });

  it('records native bridge decision reasons without leaking caller secrets', () => {
    recordNativeBridgeDecision({
      enabled: false,
      reason: 'native_bridge_model_not_allowed',
      mode: 'all_mapped',
      useCascade: true,
      modelKey: 'gpt-5.5-medium',
      requestedModel: 'gpt-5.5',
      provider: 'openai',
      route: 'chat',
      callerKey: 'api:secret-hash',
      hasTools: true,
      toolCount: 2,
      mappedCount: 1,
      unmappedCount: 1,
      mappedTools: ['Read'],
      unmappedTools: ['update_plan'],
    });
    recordNativeBridgeDecision({
      enabled: true,
      reason: 'native_bridge_enabled',
      mode: '1',
      useCascade: true,
      modelKey: 'claude-sonnet-4.6',
      requestedModel: 'claude-sonnet-4.6',
      provider: 'anthropic',
      route: 'chat',
      hasTools: true,
      toolCount: 1,
      mappedTools: ['Bash'],
      unmappedTools: [],
    });

    const stats = getNativeBridgeStats();
    assert.equal(stats.decisions, 2);
    assert.equal(stats.enabledDecisions, 1);
    assert.equal(stats.disabledDecisions, 1);
    assert.equal(stats.decisionReasons.native_bridge_model_not_allowed, 1);
    assert.equal(stats.decisionReasons.native_bridge_enabled, 1);
    assert.equal(stats.lastDecision.reason, 'native_bridge_enabled');
    assert.equal(stats.recentDecisions[0].modelKey, 'gpt-5.5-medium');
    assert.equal(stats.recentDecisions[0].requestedModel, 'gpt-5.5');
    assert.equal(stats.recentDecisions.length, 2);
    assert.equal(JSON.stringify(stats).includes('secret-hash'), false);
  });

  it('caps distinct keys in client-controlled tool maps to prevent unbounded growth', () => {
    const prev = process.env.WINDSURFAPI_NATIVE_BRIDGE_STATS_KEY_LIMIT;
    process.env.WINDSURFAPI_NATIVE_BRIDGE_STATS_KEY_LIMIT = '10';
    try {
      // 50 unique client-supplied tool names, far past the cap of 10.
      for (let i = 0; i < 50; i++) {
        recordNativeBridgeRequest({ mappedTools: [`tool_${i}`] });
      }
      const stats = getNativeBridgeStats();
      const keys = Object.keys(stats.requestedByTool);
      // 10 real keys + the (other) overflow bucket, never 50.
      assert.ok(keys.length <= 11, `expected <=11 keys, got ${keys.length}`);
      assert.ok(keys.includes('(other)'), 'overflow folds into (other) bucket');
      // No counts lost: 50 requests recorded across the capped key space.
      const total = keys.reduce((s, k) => s + stats.requestedByTool[k], 0);
      assert.equal(total, 50);
    } finally {
      if (prev === undefined) delete process.env.WINDSURFAPI_NATIVE_BRIDGE_STATS_KEY_LIMIT;
      else process.env.WINDSURFAPI_NATIVE_BRIDGE_STATS_KEY_LIMIT = prev;
    }
  });

  it('returns copies so callers cannot mutate counters', () => {
    recordNativeBridgeRequest({ mappedTools: ['Glob'] });
    recordNativeBridgeDecision({
      enabled: false,
      reason: 'native_bridge_all_mapped_required',
      mappedTools: ['Glob'],
      unmappedTools: ['update_plan'],
    });
    const snapshot = getNativeBridgeStats();
    snapshot.requestedByTool.Glob = 0;
    snapshot.unmappedRequestedByTool.Edit = 1;
    snapshot.unmappedByCascadeKind.find = 1;
    snapshot.decisionReasons.native_bridge_all_mapped_required = 0;
    snapshot.recentDecisions[0].mappedTools[0] = 'Mutated';
    assert.equal(getNativeBridgeStats().requestedByTool.Glob, 1);
    assert.equal(getNativeBridgeStats().unmappedRequestedByTool.Edit, undefined);
    assert.equal(getNativeBridgeStats().unmappedByCascadeKind.find, undefined);
    assert.equal(getNativeBridgeStats().decisionReasons.native_bridge_all_mapped_required, 1);
    assert.equal(getNativeBridgeStats().recentDecisions[0].mappedTools[0], 'Glob');
  });
});
