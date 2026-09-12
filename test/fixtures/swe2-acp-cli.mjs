#!/usr/bin/env node
// A deterministic ACP peer; it never contacts Devin or executes client tools.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

const model = process.argv[process.argv.indexOf('--model') + 1];
const config = JSON.parse(
  readFileSync(join(process.cwd(), '.devin/mcp_config.local.json')),
);
const env = config.mcpServers.client.env;
let callId = 0;
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
async function call(name, args) {
  const response = await fetch(`http://127.0.0.1:${env.SWE2_RELAY_PORT}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.SWE2_RELAY_TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++callId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return (await response.json()).result;
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const rpc = JSON.parse(line);
  if (rpc.method === 'initialize')
    send({ id: rpc.id, result: { protocolVersion: 1 } });
  if (rpc.method === 'session/new') {
    send({
      id: rpc.id,
      result: {
        sessionId: 'fixture-session',
        configOptions: [{ id: 'model', currentValue: model }],
      },
    });
  }
  if (rpc.method === 'session/prompt') {
    if (rpc.params.prompt[0].text.includes('STOP_AFTER_READ')) {
      send({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'New instructions received; no additional client tool requested.',
            },
          },
        },
      });
      send({ id: rpc.id, result: { stopReason: 'end_turn' } });
      return;
    }
    await call('get_client_tools', { names: ['read'] });
    const result = await call('call_client_tool', {
      name: 'read',
      arguments: { path: 'fixture.txt' },
    });
    send({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `${model}: ${result.content[0].text}`,
          },
        },
      },
    });
    send({
      id: rpc.id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      },
    });
  }
});
