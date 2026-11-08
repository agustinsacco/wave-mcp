import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compact, fromMinor, paginateArray, toMinor, toText, windowRows } from '../src/format.js';
import { parseEnvText, readCredentialFile, withFileLock, writeCredentialFile } from '../src/auth/credentials.js';
import { TokenProvider } from '../src/auth/tokens.js';
import { WaveClient, cleanVariables } from '../src/wave/client.js';
import { loadConfig } from '../src/config.js';
import { checkBalanced, checkSides } from '../src/tools/transactions.js';
import waveExtension, { nodeCommand, signInNotice } from '../extensions/wave.js';
import { detect, runSetupCli } from '../src/setup-cli.js';
import { assertQueryOnly } from '../src/tools/context.js';
import { parseCallback, buildAuthorizeUrl } from '../src/auth/oauth-cli.js';
import { paymentRows, paymentTotals, trialBalance, daysBetween } from '../src/reports/compute.js';
import { redact } from '../src/log.js';
import { silentLogger, tempCredentials } from './helpers/harness.js';

// ------------------------------------------------------------ money & shaping

test('toMinor/fromMinor are exact for decimal strings', () => {
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor('0.3'));
  assert.equal(toMinor('1234.565'), 123457, 'half-up on the third decimal');
  assert.equal(toMinor('-12.5'), -1250);
  assert.equal(toMinor('1,234.00'), 123400);
  assert.equal(toMinor(19.99), 1999);
  assert.equal(toMinor(''), 0);
  assert.equal(fromMinor(-5), '-0.05');
  assert.equal(fromMinor(123400), '1234.00');
});

test('compact drops empties and collapses code/value wrappers', () => {
  const out = compact({ a: null, b: '', c: [], d: {}, e: { code: 'CAD' }, f: { value: '1.00' }, g: { value: '2.00', currency: { code: 'USD' } }, h: false, __typename: 'X' });
  assert.deepEqual(out, { e: 'CAD', f: '1.00', g: { value: '2.00', currency: 'USD' }, h: false });
  assert.deepEqual(compact({ discounts: [{ __typename: 'FixedInvoiceDiscount', amount: '5' }] }), { discounts: [{ type: 'FixedInvoiceDiscount', amount: '5' }] });
  assert.match(compact('x'.repeat(400), { clip: 10 }), /^x{10}… \[\+390 chars\]$/);
});

test('pagination helpers report hasMore and next cursors', () => {
  const rows = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(paginateArray(rows, { page: 2, pageSize: 3 }), { items: [3, 4, 5], page: 2, pageSize: 3, totalCount: 7, totalPages: 3, hasMore: true, nextPage: 3 });
  assert.deepEqual(windowRows(rows, { offset: 5, limit: 5 }), { items: [5, 6], offset: 5, limit: 5, totalCount: 7, hasMore: false });
});

test('toText enforces the budget even without a list', () => {
  const text = toText({ blob: 'y'.repeat(10_000) }, 5000);
  assert.ok(text.length <= 5000);
  assert.equal(JSON.parse(text).truncated, true);
});

test('cleanVariables omits null/undefined so Wave defaults apply', () => {
  assert.deepEqual(cleanVariables({ a: 1, b: null, c: undefined, d: { e: null, f: [1, null] } }), { a: 1, d: { f: [1, null] } });
});

test('logs never contain tokens or secrets', () => {
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer [redacted]');
  assert.equal(redact('refresh_token=abcdefghijkl&client_secret=shhh1234'), 'refresh_token=[redacted]&client_secret=[redacted]');
});

// ------------------------------------------------------------ credentials file

test('credential file: parse, atomic merge, comments preserved, mode 600', () => {
  const { file } = tempCredentials('# my wave creds\nexport WAVE_CLIENT_ID="abc"\nOTHER=keep\n');
  assert.deepEqual(parseEnvText(fs.readFileSync(file, 'utf8')), { WAVE_CLIENT_ID: 'abc', OTHER: 'keep' });
  writeCredentialFile(file, { WAVE_REFRESH_TOKEN: 'r1', WAVE_CLIENT_ID: 'xyz' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# my wave creds\nWAVE_CLIENT_ID=xyz\nOTHER=keep\nWAVE_REFRESH_TOKEN=r1\n$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeCredentialFile(file, { OTHER: '' });
  assert.ok(!readCredentialFile(file).values.OTHER, 'empty removes a key');
  assert.throws(() => writeCredentialFile(file, { X: 'a\nb' }), /newlines/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['credentials.env'], 'no temp files left behind');
});

test('file lock serializes critical sections', async () => {
  const { dir } = tempCredentials(null);
  const lock = path.join(dir, 'x.lock');
  const order = [];
  await Promise.all(
    [1, 2, 3].map((n) =>
      withFileLock(lock, async () => {
        order.push(`start${n}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end${n}`);
      }, { pollMs: 5 }),
    ),
  );
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].replace('start', ''), order[i + 1].replace('end', ''));
});

// ------------------------------------------------------------ OAuth tokens

function oauthSetup({ expiresAt = new Date(Date.now() - 1000).toISOString() } = {}) {
  const { file } = tempCredentials(
    `WAVE_CLIENT_ID=cid\nWAVE_CLIENT_SECRET=secret\nWAVE_REDIRECT_URI=http://localhost:8765/callback\nWAVE_REFRESH_TOKEN=r0\nWAVE_ACCESS_TOKEN=a0\nWAVE_ACCESS_TOKEN_EXPIRES_AT=${expiresAt}\n`,
  );
  const config = loadConfig({ WAVE_CREDENTIALS_FILE: file });
  const requests = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    requests.push(Object.fromEntries(new URLSearchParams(init.body)));
    await new Promise((r) => setTimeout(r, 10));
    n++;
    return Response.json({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 7200, scope: 'invoice:*', token_type: 'Bearer' });
  };
  return { file, config, requests, fetchImpl };
}

test('oauth: expired token refreshes once for concurrent callers and persists rotation', async () => {
  const { file, config, requests, fetchImpl } = oauthSetup();
  const tokens = new TokenProvider(config, { env: {}, fetchImpl, logger: silentLogger });
  assert.equal(tokens.describe().mode, 'oauth');
  const results = await Promise.all([tokens.getAccessToken(), tokens.getAccessToken(), tokens.getAccessToken()]);
  assert.deepEqual(results, ['a1', 'a1', 'a1']);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { client_id: 'cid', client_secret: 'secret', refresh_token: 'r0', grant_type: 'refresh_token', redirect_uri: 'http://localhost:8765/callback' });
  const saved = readCredentialFile(file).values;
  assert.equal(saved.WAVE_REFRESH_TOKEN, 'r1');
  assert.equal(saved.WAVE_ACCESS_TOKEN, 'a1');
  assert.ok(Date.parse(saved.WAVE_ACCESS_TOKEN_EXPIRES_AT) > Date.now() + 7000 * 1000);
  assert.equal(await tokens.getAccessToken(), 'a1', 'fresh token reused');
  assert.equal(requests.length, 1);
});

test('oauth: a second process sharing the file reuses the refreshed token', async () => {
  const { config, requests, fetchImpl } = oauthSetup();
  const p1 = new TokenProvider(config, { env: {}, fetchImpl, logger: silentLogger });
  const p2 = new TokenProvider(config, { env: {}, fetchImpl, logger: silentLogger });
  const [t1, t2] = await Promise.all([p1.getAccessToken(), p2.getAccessToken()]);
  assert.equal(t1, t2);
  assert.equal(requests.length, 1, 'the lock + re-read prevents a second (rotating) refresh');
});

test('oauth: a rejected token forces exactly one refresh', async () => {
  const { config, requests, fetchImpl } = oauthSetup({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const tokens = new TokenProvider(config, { env: {}, fetchImpl, logger: silentLogger });
  assert.equal(await tokens.getAccessToken(), 'a0');
  assert.equal(await tokens.getAccessToken({ rejectedToken: 'a0' }), 'a1');
  assert.equal(requests.length, 1);
});

test('oauth: refresh failures explain the fix', async () => {
  const { config } = oauthSetup();
  const deny = new TokenProvider(config, { env: {}, fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }), logger: silentLogger });
  await assert.rejects(deny.getAccessToken(), /invalid_grant.*wave-mcp\.js auth/);
  const lapsed = new TokenProvider(config, { env: {}, fetchImpl: async () => Response.json({ error: 'forbidden' }, { status: 403 }), logger: silentLogger });
  await assert.rejects(lapsed.getAccessToken(), /Pro or Wave Advisors/);
});

test('static token: a rejection says to regenerate, never loops', async () => {
  const { file } = tempCredentials('WAVE_ACCESS_TOKEN=static\n');
  const tokens = new TokenProvider(loadConfig({ WAVE_CREDENTIALS_FILE: file }), { env: {}, logger: silentLogger });
  assert.equal(await tokens.getAccessToken(), 'static');
  await assert.rejects(tokens.getAccessToken({ rejectedToken: 'static' }), /rejected the configured access token/);
});

test('env-only credentials work when no file exists', async () => {
  const { file } = tempCredentials(null);
  const tokens = new TokenProvider(loadConfig({ WAVE_CREDENTIALS_FILE: file }), { env: { WAVE_ACCESS_TOKEN: 'from-env' }, logger: silentLogger });
  assert.equal(await tokens.getAccessToken(), 'from-env');
  assert.equal(tokens.describe().source, 'env');
});

// ------------------------------------------------------------ client retry rules

function clientWith(fetchImpl) {
  const config = { ...loadConfig({}), maxRetries: 2, requestTimeoutMs: 2000 };
  const tokens = { getAccessToken: async () => 't', load: () => ({}) };
  return new WaveClient({ config, tokens, logger: silentLogger, fetchImpl });
}

test('queries retry on network errors and 5xx', async () => {
  let n = 0;
  const client = clientWith(async () => {
    n++;
    if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (n === 2) return new Response('oops', { status: 502 });
    return Response.json({ data: { user: { id: 'u' } } });
  });
  assert.deepEqual(await client.request('query Q { user { id } }'), { user: { id: 'u' } });
  assert.equal(n, 3);
});

test('mutations are not retried after an ambiguous network failure', async () => {
  let n = 0;
  const client = clientWith(async () => {
    n++;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  });
  await assert.rejects(client.request('mutation M { _ }'), /Could not reach Wave/);
  assert.equal(n, 1);
  let m = 0;
  const refused = clientWith(async () => {
    m++;
    if (m === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return Response.json({ data: { _: true } });
  });
  assert.deepEqual(await refused.request('mutation M { _ }'), { _: true }, 'never-sent requests are safe to retry');
});

test('concurrency is capped', async () => {
  let active = 0;
  let peak = 0;
  const client = clientWith(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return Response.json({ data: { _: true } });
  });
  await Promise.all(Array.from({ length: 8 }, () => client.request('query Q { _ }')));
  assert.equal(peak, 2);
});

// ------------------------------------------------------------ misc logic

test('transaction balance check works in cents and accepts tax-inclusive anchors', () => {
  assert.doesNotThrow(() => checkBalanced({ anchor: { amount: '0.30' }, lineItems: [{ amount: '0.10' }, { amount: 0.2 }] }));
  assert.doesNotThrow(() => checkBalanced({ anchor: { amount: '113.00' }, lineItems: [{ amount: '100.00', taxes: [{ amount: '13.00' }] }] }));
  assert.doesNotThrow(() => checkBalanced({ anchor: { amount: '113.00' }, lineItems: [{ amount: '113.00', taxes: [{ amount: '13.00' }] }] }));
  assert.throws(() => checkBalanced({ anchor: { amount: '50' }, lineItems: [{ amount: '49.99' }] }), /difference|does not balance/);
});

test('graphql guard rejects mutations and subscriptions, but not strings mentioning them', () => {
  assert.doesNotThrow(() => assertQueryOnly('query { business(id: "mutation") { id } }'));
  assert.doesNotThrow(() => assertQueryOnly('{ user { id } } # mutation in a comment'));
  assert.throws(() => assertQueryOnly('mutation { _ }'), /only runs queries/);
  assert.throws(() => assertQueryOnly('query A { _ }\nmutation B { _ }'), /only runs queries/);
  assert.throws(() => assertQueryOnly('subscription { x }'), /only runs queries/);
});

test('oauth helpers: authorize URL and pasted callbacks', () => {
  const url = new URL(buildAuthorizeUrl({ oauthBaseUrl: 'https://api.waveapps.com/oauth2', clientId: 'c', redirectUri: 'http://localhost:8765/callback', scopes: ['invoice:*', 'user:read'], state: 's1' }));
  assert.equal(url.pathname, '/oauth2/authorize/');
  assert.equal(url.searchParams.get('scope'), 'invoice:* user:read');
  assert.equal(parseCallback('http://localhost:8765/callback?code=abc&state=s1', 's1'), 'abc');
  assert.equal(parseCallback('abc', 's1'), 'abc');
  assert.throws(() => parseCallback('http://x/cb?code=abc&state=other', 's1'), /State mismatch/);
  assert.throws(() => parseCallback('http://x/cb?error=access_denied', 's1'), /access_denied/);
});

test('payments: refunds subtract, voids and inactive drop out', () => {
  const invoices = [
    {
      id: 'i1', invoiceNumber: '1', currency: { code: 'CAD' }, customer: { id: 'c1' }, exchangeRate: '1',
      payments: [
        { id: 'p1', paymentDate: '2026-01-05', amount: '100.00' },
        { id: 'p2', paymentDate: '2026-01-06', amount: '20.00', transactionType: 'REFUND' },
        { id: 'p3', paymentDate: '2026-01-07', amount: '5.00', active: false },
        { id: 'p4', paymentDate: '2025-12-31', amount: '9.00' },
      ],
    },
  ];
  const rows = paymentRows({ invoices, startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.equal(rows.length, 3);
  const totals = JSON.parse(JSON.stringify(paymentTotals(rows, 'CAD')));
  assert.deepEqual(totals, { received: '100.00', refunded: '20.00', count: 3 });
});

test('trial balance puts negative balances on the opposite side', () => {
  const tb = trialBalance([
    { id: 'a', name: 'Bank', type: { value: 'ASSET' }, subtype: { value: 'CASH_AND_BANK' }, normalBalanceType: 'DEBIT', balanceInBusinessCurrency: '-50.00' },
    { id: 'b', name: 'Loan', type: { value: 'LIABILITY' }, subtype: { value: 'LOANS' }, normalBalanceType: 'CREDIT', balanceInBusinessCurrency: '-50.00' },
  ]);
  assert.deepEqual(tb.totals, { debit: '50.00', credit: '50.00', difference: '0.00', balanced: true });
  assert.equal(tb.rows.find((r) => r.id === 'a').credit, '50.00');
});

test('daysBetween counts calendar days', () => {
  assert.equal(daysBetween('2026-01-31', '2026-03-01'), 29);
  assert.equal(daysBetween('2026-03-01', '2026-03-01'), 0);
});

test('config validates toolsets', () => {
  assert.throws(() => loadConfig({ WAVE_MCP_TOOLSETS: 'invoices,bogus' }), /bogus/);
  assert.equal(loadConfig({ WAVE_MCP_TOOLSETS: 'all' }).toolsets.length, 13);
  assert.equal(loadConfig({ WAVE_MCP_MAX_CONCURRENCY: '99' }).maxConcurrency, 8);
});

test('checkSides catches transactions whose parts all land on one side', () => {
  const accounts = new Map([
    ['bank', { name: 'Chequing', normalBalanceType: 'DEBIT' }],
    ['exp', { name: 'Office Supplies', normalBalanceType: 'DEBIT' }],
    ['inc', { name: 'Sales', normalBalanceType: 'CREDIT' }],
  ]);
  const tx = (direction, accountId, balance) => ({ anchor: { accountId: 'bank', amount: '1', direction }, lineItems: [{ accountId, amount: '1', balance }] });
  assert.throws(() => checkSides(tx('DEPOSIT', 'exp', 'INCREASE'), accounts), /deposit on Chequing and every line \(Office Supplies\) are all on the debit side.*Money in needs credit lines/);
  assert.throws(() => checkSides(tx('WITHDRAWAL', 'inc', 'INCREASE'), accounts), /all on the credit side.*Money out needs debit lines/);
  assert.throws(() => checkSides(tx('WITHDRAWAL', 'exp', 'CREDIT'), accounts), /credit side/);
  for (const ok of [tx('DEPOSIT', 'inc'), tx('DEPOSIT', 'exp', 'DECREASE'), tx('WITHDRAWAL', 'exp', 'INCREASE'), tx('WITHDRAWAL', 'inc', 'DECREASE'), tx('DEPOSIT', 'unknown', 'INCREASE')]) {
    assert.doesNotThrow(() => checkSides(ok, accounts));
  }
});

test('pi package: the extension registers the wave server with this checkout\'s bin', () => {
  const calls = [];
  const handlers = [];
  waveExtension({ registerMcpServer: (name, config) => calls.push([name, config]), on: (event, fn) => handlers.push([event, fn]) });
  assert.deepEqual(handlers.map(([e]) => e), ['session_start']);
  assert.match(signInNotice({ WAVE_CREDENTIALS_FILE: '/nonexistent/credentials.env' }), /not signed in on .+ run: node \S*wave-mcp\.js login/);
  assert.equal(signInNotice({ WAVE_CREDENTIALS_FILE: '/nonexistent/credentials.env', WAVE_ACCESS_TOKEN: 't' }), undefined);
  assert.equal(calls.length, 1);
  const [name, config] = calls[0];
  assert.equal(name, 'wave');
  assert.match(config.args[0], /\/bin\/wave-mcp\.js$/);
  assert.equal(config.exposure, 'codemode');
  assert.match(config.description, /skill wave-accounting.*wave-mcp\.js login/);
  assert.equal(nodeCommand('/opt/node/bin/node'), '/opt/node/bin/node');
  assert.equal(nodeCommand('/usr/local/bin/pi'), 'node', 'a compiled pi binary is not Node');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.pi, { extensions: ['./extensions/wave.js'], skills: ['./skills'] });
  assert.ok(pkg.keywords.includes('pi-package') && pkg.files.includes('extensions') && pkg.files.includes('skills'));
});

test('setup: detects existing pi/Claude setups and changes nothing without --yes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-setup-'));
  const env = { PATH: '/nonexistent', HOME: home };
  assert.deepEqual([detect({ env, home }).pi.installed, detect({ env, home }).claude.installed], [false, false]);
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['git:github.com/someone/wave-mcp@v1'] }));
  assert.deepEqual([detect({ env, home }).pi.server, detect({ env, home }).pi.skill], ['package', 'package']);
  let text = '';
  const out = { write: (s) => (text += s) };
  const code = await runSetupCli({ env, home, out, err: out, input: { isTTY: false }, login: false });
  assert.equal(code, 0);
  assert.match(text, /pi not found; skipped[\s\S]*claude not found; skipped[\s\S]*wave:\/\/guide[\s\S]*wave-mcp\.js login/);
  assert.deepEqual(fs.readdirSync(home).sort(), ['.pi']);
});
