// This MCP server relays requests; execution and approval remain in the client.
import http from 'node:http';
import readline from 'node:readline';

const port = Number(process.env.SWE2_RELAY_PORT);
const token = process.env.SWE2_RELAY_TOKEN;

function relay(rpc) {
  // A tool call waits for the calling client's result. Fetch/Undici imposes a
  // five-minute response-headers timeout; node:http does not. Session expiry,
  // client disconnects and the owning CLI process control this request's life.
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        agent: false,
        timeout: 0,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('error', reject);
        response.on('aborted', () =>
          reject(new Error('Client relay response was interrupted')),
        );
        response.on('end', () => {
          if (response.statusCode !== 200)
            return reject(
              new Error(`Client bridge returned HTTP ${response.statusCode}`),
            );
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(rpc));
  });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let rpc;
  try {
    rpc = JSON.parse(line);
  } catch {
    return;
  }
  if (rpc.id == null) return;
  try {
    process.stdout.write(JSON.stringify(await relay(rpc)) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32603, message: error.message },
      }) + '\n',
    );
  }
});
