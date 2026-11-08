import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createServer, SERVER_NAME, VERSION } from './server.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function sameSecret(a, b) {
  // Hash first so lengths match and the comparison is constant-time.
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Serve MCP over Streamable HTTP (stateless, one server instance per request).
 *
 * Safety defaults:
 *  - binds 127.0.0.1 unless WAVE_MCP_HTTP_HOST says otherwise;
 *  - a non-loopback bind refuses to start without WAVE_MCP_HTTP_TOKEN;
 *  - when a token is configured every MCP request needs `Authorization: Bearer <token>`;
 *  - Host and Origin headers are validated (DNS-rebinding protection).
 */
export async function serveHttp(ctx, { host = ctx.config.http.host, port = ctx.config.http.port, path = ctx.config.http.path } = {}) {
  const token = ctx.tokens.load().httpToken;
  const loopback = LOOPBACK.has(host);
  if (!loopback && !token) {
    throw new Error(`Refusing to listen on ${host} without WAVE_MCP_HTTP_TOKEN. Set it in ${ctx.config.credentialsFile} (e.g. openssl rand -hex 32), or bind 127.0.0.1.`);
  }
  const allowed = ctx.config.http.allowedHosts || (loopback ? ['localhost', '127.0.0.1', '[::1]'] : ['localhost', '127.0.0.1', '[::1]', host]);
  const validateHost = hostHeaderValidation(allowed);
  const validateOrigin = originValidation(allowed);
  const handler = createMcpHandler(() => createServer(ctx));
  const nodeHandler = toNodeHandler(handler);

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, name: SERVER_NAME, version: VERSION }));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found', mcpPath: path }));
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (token) {
      const header = req.headers.authorization || '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!presented || !sameSecret(presented, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="wave-mcp"' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    void nodeHandler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  ctx.logger.info(`Streamable HTTP on http://${host}:${address.port}${path}${token ? ' (bearer token required)' : ''}`);
  return {
    server,
    port: address.port,
    close: async () => {
      await handler.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
