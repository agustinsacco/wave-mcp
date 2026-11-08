import { readCredentialFile, writeCredentialFile } from './credentials.js';
import { cli } from '../cli.js';

/**
 * `wave-mcp login`: paste a request copied from the browser's DevTools
 * ("Copy as cURL", "Copy as fetch", "Copy as PowerShell" or the request
 * headers) and store the bearer token it carries. The token is checked with
 * Wave first, which also tells what kind it is:
 *
 *  - a web session token (works on Wave's web-app API) → WAVE_SESSION_TOKEN
 *  - a full access token (public API only)            → WAVE_ACCESS_TOKEN
 *
 * Nothing else from the request (cookies, other headers) is kept, and the
 * token is never printed. Input is read with echo off, or from stdin.
 */

const TOKEN_CHARS = /^[A-Za-z0-9._~+/=-]+$/;
const BEARER = /authorization\s*['"]?\s*[:=]\s*['"]?\s*bearer\s+([A-Za-z0-9._~+/=-]{8,})/gi;

export class LoginError extends Error {}

/** Find the bearer token (and the Wave URL, if any) in pasted text. */
export function extractCredential(text) {
  const cleaned = String(text || '')
    // Windows cmd "Copy as cURL" escapes with ^; line continuations vary by shell.
    .replace(/\^(.)/g, '$1')
    .replace(/\\\r?\n/g, ' ')
    .trim();
  if (!cleaned) throw new LoginError('Nothing was pasted.');
  const url = cleaned.match(/https?:\/\/[A-Za-z0-9.-]*waveapps\.com\/[^\s'"`]*/)?.[0];
  const tokens = [...new Set([...cleaned.matchAll(BEARER)].map((m) => m[1]))];
  if (tokens.length > 1) throw new LoginError('The paste holds more than one bearer token; copy a single request.');
  if (tokens.length === 1) return { token: tokens[0], url, kind: 'request' };
  if (!/\s/.test(cleaned) && TOKEN_CHARS.test(cleaned) && cleaned.length >= 16 && cleaned.length <= 4096) {
    return { token: cleaned, url: undefined, kind: 'bare' };
  }
  if (/cookie/i.test(cleaned)) {
    throw new LoginError(
      'That request has cookies but no "authorization: Bearer" header. Copy a request to gql.waveapps.com/graphql/internal (filter the Network tab by "graphql") instead.',
    );
  }
  throw new LoginError('No "authorization: Bearer ..." header found. In DevTools → Network, filter by "graphql", right-click a gql.waveapps.com request → Copy → Copy as cURL, then paste it here.');
}

async function post(fetchImpl, url, token, query) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'wave-mcp', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  return { status: response.status, user: payload.data?.user, errors, codes: errors.map((e) => e.extensions?.code).filter(Boolean) };
}

/** Ask Wave what the token is: a web session, a public API token, or nothing. */
export async function classifyToken(token, { config, fetchImpl = globalThis.fetch }) {
  const internal = await post(fetchImpl, config.internalApiUrl, token, 'query { user { firstName lastName defaultEmail } }');
  if (internal.user) return { type: 'session', user: internal.user };
  if (internal.codes.includes('UNAUTHENTICATED')) {
    throw new LoginError('Wave says this token is expired or signed out. Reload the Wave web app, copy a fresh request, and try again.');
  }
  // A full access token is refused by the web-app API ("not approved"); check the public API.
  const pub = await post(fetchImpl, config.apiUrl, token, 'query { user { firstName lastName defaultEmail } }');
  if (pub.user) return { type: 'access', user: pub.user };
  if (pub.codes.includes('UNAUTHENTICATED')) throw new LoginError('Wave rejected this token (expired or revoked).');
  throw new LoginError(`Wave did not accept the token (${[...internal.codes, ...pub.codes].join(', ') || `HTTP ${internal.status}`}).`);
}

/**
 * Read a paste with echo off. Multi-line pastes are kept whole: bracketed
 * paste is switched on so the terminal marks where the paste ends, and a
 * line ending in a continuation (\ ^ `) waits for the next line.
 */
export function readPaste(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => (data += chunk));
      input.on('end', () => resolve(data));
      input.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    output.write(prompt);
    output.write('\u001b[?2004h'); // bracketed paste on
    let value = '';
    let seq = null;
    let pasting = false;
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = (err) => {
      output.write('\u001b[?2004l');
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const ready = () => {
      try {
        extractCredential(value);
        return true;
      } catch {
        return false;
      }
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (seq !== null) {
          seq += ch;
          if (ch >= '@' && ch <= '~' && ch !== '[') {
            if (seq === '[200~') pasting = true;
            else if (seq === '[201~') {
              pasting = false;
              if (ready()) return finish();
            }
            seq = null;
          }
          continue;
        }
        if (ch === '\u001b') {
          seq = '';
          continue;
        }
        if (ch === '\u0003' || ch === '\u0004') return finish(new LoginError('Cancelled.'));
        if (ch === '\r' || ch === '\n') {
          if (pasting || /[\\^`]\s*$/.test(value)) value += '\n';
          else if (value.trim()) return finish();
          continue;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ' || ch === '\t') value += ch;
      }
    };
    input.on('data', onData);
  });
}

export async function runLoginCli({ file, config, out = process.stdout, err = process.stderr, input = process.stdin, fetchImpl = globalThis.fetch } = {}) {
  if (input.isTTY) {
    err.write(
      [
        'Sign in to Wave for wave-mcp.',
        '  1. Open https://next.waveapps.com and sign in.',
        '  2. Open DevTools (F12) → Network, and type "graphql" in the filter box. Reload if the list is empty.',
        '  3. Right-click a gql.waveapps.com request → Copy → Copy as cURL (any variant works).',
        '',
        'Paste it below. Input is hidden; only the authorization token is kept.',
        '',
      ].join('\n'),
    );
  }
  let found;
  try {
    found = extractCredential(await readPaste('Paste: ', { input, output: err }));
  } catch (error) {
    err.write(`${error.message}\n`);
    return 1;
  }
  if (found.url && !/gql\.waveapps\.com\/graphql\//.test(found.url)) {
    err.write(`Note: the request went to ${found.url.split('?')[0]}, not gql.waveapps.com/graphql; checking the token anyway.\n`);
  }
  let result;
  try {
    result = await classifyToken(found.token, { config, fetchImpl });
  } catch (error) {
    err.write(`${error instanceof LoginError ? error.message : `Could not check the token with Wave: ${error.message}`}\n`);
    return 1;
  }
  const key = result.type === 'session' ? 'WAVE_SESSION_TOKEN' : 'WAVE_ACCESS_TOKEN';
  const before = readCredentialFile(file).values;
  writeCredentialFile(file, { [key]: found.token });
  const who = [result.user.firstName, result.user.lastName].filter(Boolean).join(' ') || 'unknown user';
  out.write(`Signed in as ${who}${result.user.defaultEmail ? ` <${result.user.defaultEmail}>` : ''}.\n`);
  if (result.type === 'session') {
    out.write(`Saved the web session as WAVE_SESSION_TOKEN in ${file} (mode 600; token not shown).\n`);
    out.write('It enables live transactions (list, get, edit, delete)');
    out.write(before.WAVE_ACCESS_TOKEN || before.WAVE_REFRESH_TOKEN ? '; the public API keeps using your stored API token.\n' : ' and, with no API token stored, every other tool too.\n');
    out.write(`The session ends when you sign out of Wave or it times out; then run ${cli('login')} again.\n`);
  } else {
    out.write(`That is a public API token (Wave's web-app API refuses it). Saved as WAVE_ACCESS_TOKEN in ${file} (mode 600; token not shown).\n`);
    out.write(
      before.WAVE_SESSION_TOKEN
        ? 'A web session is also stored, so live transaction tools stay enabled while it lasts.\n'
        : `Live transaction tools also need a web session: run ${cli('login')} again with a request copied from next.waveapps.com.\n`,
    );
  }
  return 0;
}
