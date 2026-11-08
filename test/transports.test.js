import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig } from '../src/config.js';
import { WaveContext } from '../src/context.js';
import { serveHttp } from '../src/http.js';
import { createFakeWave } from './helpers/fake-wave.js';
import { silentLogger, tempCredentials } from './helpers/harness.js';

const BIN = new URL('../bin/wave-mcp.js', import.meta.url).pathname;

test('stdio: the real binary handshakes (2025 era), lists tools and answers a call', async (t) => {
  const { file } = tempCredentials(null);
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { PATH: process.env.PATH, WAVE_CREDENTIALS_FILE: file, WAVE_MCP_LOG_LEVEL: 'silent' } }));
  t.after(() => client.close());
  assert.equal(client.getServerVersion().name, 'wave-mcp');
  assert.match(client.getInstructions(), /wave_get_context/);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 72);
  const r = await client.callTool({ name: 'wave_get_context', arguments: {} });
  assert.equal(JSON.parse(r.content[0].text).auth.mode, 'none');
});

test('stdio: read-only mode via env', async (t) => {
  const { file } = tempCredentials(null);
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { PATH: process.env.PATH, WAVE_CREDENTIALS_FILE: file, WAVE_MCP_READ_ONLY: 'true', WAVE_MCP_LOG_LEVEL: 'silent' } }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  // Only wave_import_ledger may write, and only to this server's own ledger file.
  assert.deepEqual(tools.filter((x) => !x.annotations.readOnlyHint).map((x) => x.name), ['wave_import_ledger']);
  assert.equal(tools.length, 29);
});

async function httpServer(t, credentials, env = {}) {
  const { file } = tempCredentials(credentials);
  const config = loadConfig({ WAVE_CREDENTIALS_FILE: file, WAVE_MCP_HTTP_PORT: '0', ...env });
  const ctx = new WaveContext({ config, env: {}, fetchImpl: createFakeWave().fetchImpl, logger: silentLogger });
  const handle = await serveHttp(ctx, { port: 0 });
  t.after(() => handle.close());
  return { base: `http://127.0.0.1:${handle.port}`, ctx };
}

test('http: serves both protocol eras on loopback', async (t) => {
  const { base } = await httpServer(t, 'WAVE_ACCESS_TOKEN=test-token\n');
  for (const mode of ['auto', 'legacy']) {
    const client = new Client({ name: 'http-test', version: '1.0.0' }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const r = await client.callTool({ name: 'wave_get_context', arguments: {} });
    assert.equal(JSON.parse(r.content[0].text).user.firstName, 'Ada', mode);
    await client.close();
  }
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test('http: bearer token is enforced when configured', async (t) => {
  const { base } = await httpServer(t, 'WAVE_ACCESS_TOKEN=test-token\nWAVE_MCP_HTTP_TOKEN=s3cret-value\n');
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };
  assert.equal((await fetch(`${base}/mcp`, init)).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, Authorization: 'Bearer wrong' } })).status, 401);
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer s3cret-value' } } }));
  assert.equal((await client.listTools()).tools.length, 72);
  await client.close();
});

test('http: DNS-rebinding guard rejects foreign Host and Origin headers', async (t) => {
  const { base } = await httpServer(t, 'WAVE_ACCESS_TOKEN=test-token\n');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
});

test('http: refuses a non-loopback bind without a bearer token', async () => {
  const { file } = tempCredentials('WAVE_ACCESS_TOKEN=x\n');
  const ctx = new WaveContext({ config: loadConfig({ WAVE_CREDENTIALS_FILE: file }), env: {}, logger: silentLogger });
  await assert.rejects(serveHttp(ctx, { host: '0.0.0.0', port: 0 }), /Refusing to listen on 0\.0\.0\.0 without WAVE_MCP_HTTP_TOKEN/);
});
