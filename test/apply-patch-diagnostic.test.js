import test from 'node:test';
import assert from 'node:assert/strict';
import { __setStreamChatForTest, toChatCompletion, streamChatCompletion } from '../src/devin-connect-openai.js';
import { observeApplyPatch, getApplyPatchDiagnostics } from '../src/apply-patch-diagnostic.js';
import { resetConnectMetrics } from '../src/devin-connect-metrics.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { config } from '../src/config.js';

const privateText = 'fixture-private-file-content';
const privateError = 'fixture-private-error';
const patch = '*** Begin Patch\n*** Add File: local.txt\n+' + privateText + '\n*** End Patch\n';
const params = { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'fixture' }],
  tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }] };

for (const stream of [false, true]) {
  test((stream ? 'stream' : 'buffer') + ' records a bare invalid_json_str once without forwarding or storing its bytes', async t => {
    resetConnectMetrics();
    t.after(() => { __setStreamChatForTest(null); resetConnectMetrics(); });
    __setStreamChatForTest(async function* () {
      yield { type: 'finish', reason: 'tool_calls', toolCalls: [{ name: 'apply_patch', id: 'fixture-id',
        arguments: '{}', invalidJson: { str: patch, err: privateError } }] };
    });
    const frames = [];
    const out = stream
      ? await streamChatCompletion(params, async frame => frames.push(frame), { maxRetries: 0 })
      : await toChatCompletion(params, { maxRetries: 0 });
    const call = stream ? frames.flatMap(f => f.choices?.[0]?.delta?.tool_calls || [])[0]
      : out.body.choices[0].message.tool_calls[0];
    assert.equal(call.function.arguments, '{}');
    assert.ok(!JSON.stringify([frames, out]).includes(privateText));
    const old = config.dashboardPassword; config.dashboardPassword = 'fixture-dashboard';
    let data, headers;
    try {
      await handleDashboardApi('GET', '/connect-metrics', null,
        { url: '/dashboard/api/connect-metrics?applyPatch=1', headers: { 'x-dashboard-password': config.dashboardPassword }, socket: { remoteAddress: '127.0.0.1' } },
        { writeHead(status, h) { assert.equal(status, 200); headers = h; }, end(body) { data = JSON.parse(body); } });
    } finally { config.dashboardPassword = old; }
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(data.applyPatch.calls, 1);
    assert.deepEqual(data.applyPatch.recent, [{ source: 'native', argumentShape: 'json_other', argumentUnits: 2,
      invalidShape: 'bare_patch', invalidUnits: patch.length, invalidErrorUnits: privateError.length }]);
    for (const text of [privateText, privateError, 'local.txt', 'fixture-id']) assert.ok(!JSON.stringify(data).includes(text));
  });

  test((stream ? 'stream' : 'buffer') + ' records the emulated apply_patch tool', async t => {
    resetConnectMetrics();
    t.after(() => { __setStreamChatForTest(null); resetConnectMetrics(); });
    __setStreamChatForTest(async function* () {
      yield { type: 'content', text: '<tool_call>' + JSON.stringify({ name: 'apply_patch', arguments: { input: patch } }) + '</tool_call>' };
      yield { type: 'finish', reason: 'stop' };
    });
    if (stream) await streamChatCompletion(params, async () => {}, { emulateTools: true, maxRetries: 0 });
    else await toChatCompletion(params, { emulateTools: true, maxRetries: 0 });
    const info = getApplyPatchDiagnostics();
    assert.equal(info.calls, 1);
    assert.equal(info.recent[0].source, 'emulated');
    assert.equal(info.recent[0].argumentShape, 'json_input_patch');
  });
}

test('sample count and inspection work are bounded, and reset clears the diagnostic', () => {
  resetConnectMetrics();
  const { sampleLimit, inspectionLimitUnits } = getApplyPatchDiagnostics();
  const big = 'x'.repeat(inspectionLimitUnits + 1);
  observeApplyPatch('another_tool', big, null, 'native');
  for (let i = 0; i <= sampleLimit; i++) observeApplyPatch('apply_patch', i ? big : '{}', null, 'native');
  const summary = getApplyPatchDiagnostics();
  assert.equal(summary.calls, sampleLimit + 1);
  assert.equal(summary.recent.length, sampleLimit);
  assert.ok(summary.recent.every(s => s.argumentShape === 'over_limit' && s.argumentUnits === big.length));
  resetConnectMetrics();
  assert.deepEqual(getApplyPatchDiagnostics().recent, []);
});
