import http from 'node:http';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { postTokenEndpoint } from './tokens.js';

/** Everything this server can use. Wave scopes are `resource:operation`; write does not imply read. */
export const FULL_SCOPES = [
  'account:*', 'business:*', 'customer:*', 'estimate:*', 'invoice:*', 'product:*',
  'sales_tax:*', 'transaction:*', 'user:read', 'vendor:read', 'checkout:read',
];
export const READ_SCOPES = [
  'account:read', 'business:read', 'customer:read', 'estimate:read', 'invoice:read', 'product:read',
  'sales_tax:read', 'user:read', 'vendor:read', 'checkout:read',
];

export function buildAuthorizeUrl({ oauthBaseUrl, clientId, redirectUri, scopes, state, businessId }) {
  const url = new URL(`${oauthBaseUrl}/authorize/`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  if (businessId) url.searchParams.set('businessId', businessId);
  return url.toString();
}

/** Pull `code` out of a pasted redirect URL (or a bare code), checking state. */
export function parseCallback(input, expectedState) {
  const text = String(input).trim();
  let params;
  try {
    params = new URL(text).searchParams;
  } catch {
    params = new URLSearchParams(text.includes('=') ? text.replace(/^\?/, '') : `code=${text}`);
  }
  if (params.get('error')) throw new Error(`Wave returned an error: ${params.get('error_description') || params.get('error')}`);
  const code = params.get('code');
  if (!code) throw new Error('No authorization code found in what was pasted.');
  const state = params.get('state');
  if (state !== null && state !== expectedState) throw new Error('State mismatch: the redirect does not belong to this authorization attempt.');
  return code;
}

const PAGE = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * Interactive authorization-code flow.
 * Works when the browser is on another machine: the user can paste the URL
 * the browser was sent to (even if that page failed to load).
 */
export async function runAuthCli({ ctx, scopes = FULL_SCOPES, businessId, listen = true, out = process.stderr, input = process.stdin }) {
  const creds = ctx.tokens.load();
  const missing = ['clientId', 'clientSecret', 'redirectUri'].filter((k) => !creds[k]);
  if (missing.length) {
    const names = { clientId: 'WAVE_CLIENT_ID', clientSecret: 'WAVE_CLIENT_SECRET', redirectUri: 'WAVE_REDIRECT_URI' };
    throw new Error(
      `Missing ${missing.map((k) => names[k]).join(', ')} in ${ctx.config.credentialsFile}. Copy them from developer.waveapps.com → Manage applications → your app. ` +
        'WAVE_REDIRECT_URI must be one of the app\'s registered redirect URIs, e.g. http://localhost:8765/callback.',
    );
  }
  const state = randomBytes(16).toString('hex');
  const authorizeUrl = buildAuthorizeUrl({ oauthBaseUrl: ctx.config.oauthBaseUrl, clientId: creds.clientId, redirectUri: creds.redirectUri, scopes, state, businessId });
  out.write(`\nOpen this URL in a browser and approve access:\n\n  ${authorizeUrl}\n\n`);

  const redirect = new URL(creds.redirectUri);
  const canListen = listen && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  const code = await new Promise((resolve, reject) => {
    let server;
    let rl;
    const done = (err, value) => {
      server?.close();
      rl?.close();
      if (err) reject(err);
      else resolve(value);
    };
    if (canListen) {
      server = http.createServer((req, res) => {
        const url = new URL(req.url, creds.redirectUri);
        if (url.pathname !== redirect.pathname) {
          res.writeHead(404).end();
          return;
        }
        try {
          const value = parseCallback(url.toString(), state);
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Wave connected', 'You can close this tab and return to the terminal.'));
          done(null, value);
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(PAGE('Authorization failed', String(error.message)));
          done(error);
        }
      });
      server.on('error', (error) => out.write(`(Could not listen on ${redirect.host}: ${error.message}. Paste the redirect URL instead.)\n`));
      server.listen(Number(redirect.port || 80), redirect.hostname === '[::1]' ? '::1' : redirect.hostname);
      out.write(`Waiting for the redirect on ${creds.redirectUri} …\n`);
    }
    out.write('If the browser is on another machine, approve there, then paste the full URL it was redirected to (the page may not load; copy the address bar):\n> ');
    {
      rl = readline.createInterface({ input, terminal: false });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          done(null, parseCallback(line, state));
        } catch (error) {
          out.write(`${error.message}\n> `);
        }
      });
    }
    setTimeout(() => done(new Error('Timed out after 10 minutes (authorization codes expire after 10 minutes).')), 10 * 60 * 1000).unref();
  });

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: creds.redirectUri,
  });
  const data = await postTokenEndpoint(ctx.tokens.fetch, `${ctx.config.oauthBaseUrl}/token/`, body, { timeoutMs: ctx.config.requestTimeoutMs, retries: 1 });
  ctx.tokens.saveTokenResponse(data, { ...creds, refreshToken: data.refresh_token });
  return { scope: data.scope, expiresIn: data.expires_in, businessId: data.businessId, userId: data.userId };
}
