import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { loadConfig } from '../../src/config.js';
import { WaveContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { TOKEN } from './fake-wave.js';

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function tempCredentials(content = `WAVE_ACCESS_TOKEN=${TOKEN}\n`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-mcp-test-'));
  const file = path.join(dir, 'credentials.env');
  if (content !== null) fs.writeFileSync(file, content, { mode: 0o600 });
  return { dir, file };
}

/**
 * Connect a real MCP client to a real server instance over the in-process
 * Streamable HTTP handler (2026-07-28 era), backed by the fake Wave API.
 */
export async function connect(fake, { env = {}, credentials } = {}) {
  const { file } = credentials || tempCredentials();
  const config = loadConfig({ WAVE_CREDENTIALS_FILE: file, WAVE_MCP_MAX_RETRIES: '2', WAVE_MCP_CACHE_TTL_MS: '60000', ...env });
  const ctx = new WaveContext({ config, env: {}, fetchImpl: fake.fetchImpl, logger: silentLogger });
  const handler = createMcpHandler(() => createServer(ctx));
  const transport = new StreamableHTTPClientTransport(new URL('http://wave.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) });
  const client = new Client({ name: 'wave-mcp-tests', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: Boolean(result.isError), text, json };
  };
  return {
    client,
    ctx,
    call,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}
