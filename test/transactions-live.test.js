import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { connect, tempCredentials } from './helpers/harness.js';
import { BUSINESS, TOKEN, createFakeWave } from './helpers/fake-wave.js';
import { ACC, GST, SESSION, combineFakes, createFakeInternal, makeTx } from './helpers/fake-internal.js';
import { buildPatch } from '../src/tools/transactions-live.js';
import { describeInternalInputErrors } from '../src/wave/errors.js';
import { extractCredential, runLoginCli } from '../src/auth/login-cli.js';
import { loadConfig } from '../src/config.js';

const BOTH = `WAVE_ACCESS_TOKEN=${TOKEN}\nWAVE_SESSION_TOKEN=${SESSION}\n`;

async function live(t, { transactions, credentials = BOTH } = {}) {
  const internal = createFakeInternal(transactions ? { transactions } : {});
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: tempCredentials(credentials), env: { WAVE_BUSINESS_ID: BUSINESS.id } });
  t.after(h.close);
  return { ...h, internal };
}

const patches = (internal) => internal.calls.filter((c) => c.name === 'TransactionPatch');

test('live transactions need a web session, and say how to get one', async (t) => {
  const h = await live(t, { credentials: `WAVE_ACCESS_TOKEN=${TOKEN}\n` });
  const r = await h.call('wave_list_transactions');
  assert.equal(r.isError, true);
  assert.match(r.text, /in a terminal on .+ run: node \S*wave-mcp\.js login /);
  assert.equal(h.internal.calls.length, 0, 'no request without a session');
  const c = await h.call('wave_get_context');
  assert.match(c.json.auth.webSession, /not configured/);
  assert.match(c.json.auth.signIn, /^node \S*bin\/wave-mcp\.js login /);
});

test('a login in another terminal takes effect on the next call, without a restart', async (t) => {
  const creds = tempCredentials(`WAVE_ACCESS_TOKEN=${TOKEN}\n`);
  const internal = createFakeInternal();
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: creds, env: { WAVE_BUSINESS_ID: BUSINESS.id } });
  t.after(h.close);
  assert.equal((await h.call('wave_list_transactions', { pageSize: 1 })).isError, true);
  await new Promise((r) => setTimeout(r, 20)); // distinct mtime
  fs.writeFileSync(creds.file, BOTH, { mode: 0o600 });
  const r = await h.call('wave_list_transactions', { pageSize: 1 });
  assert.equal(r.isError, false, r.text);
});

test('an expired web session gives the login hint, without retry loops', async (t) => {
  const h = await live(t, { credentials: `WAVE_ACCESS_TOKEN=${TOKEN}\nWAVE_SESSION_TOKEN=old-session\n` });
  const r = await h.call('wave_get_transaction', { id: 'tx-1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /rejected the stored web session.*wave-mcp\.js login/);
  assert.equal(h.internal.calls.length, 1);
  assert.ok(!r.text.includes('old-session'));
});

test('a web session alone also serves the public API', async (t) => {
  const h = await live(t, { credentials: `WAVE_SESSION_TOKEN=${TOKEN}\n` });
  const c = await h.call('wave_get_context');
  assert.equal(c.isError, false, c.text);
  assert.equal(c.json.auth.mode, 'session');
  assert.equal((await h.call('wave_list_customers', { pageSize: 1 })).isError, false);
});

test('list: filters, cursor pagination, page totals and summaries', async (t) => {
  const h = await live(t);
  const p1 = await h.call('wave_list_transactions', { pageSize: 10 });
  assert.equal(p1.isError, false, p1.text);
  assert.equal(p1.json.count, 10);
  assert.equal(p1.json.hasMore, true);
  assert.equal(p1.json.items[0].date, '2026-10-30', 'newest first');
  assert.equal(p1.json.pageTotals.withdrawals, '100.00');
  assert.deepEqual(Object.keys(p1.json.items[0]).sort(), ['account', 'amount', 'category', 'date', 'description', 'direction', 'id', 'source', 'verified'].sort());
  const p2 = await h.call('wave_list_transactions', { pageSize: 10, cursor: p1.json.nextCursor });
  assert.equal(p2.json.items[0].date, '2026-10-20');

  const f = await h.call('wave_list_transactions', { search: 'purchase 1', startDate: '2026-10-10', endDate: '2026-10-19', accountId: ACC.cash.id, sort: 'date_asc', uncategorizedOnly: true, categoryIds: [ACC.marketing.id] });
  const sent = h.internal.calls.findLast((c) => c.name === 'ListTransactions').variables;
  assert.deepEqual(sent.filters, { startDate: '2026-10-10', endDate: '2026-10-19', description: 'purchase 1', anchorId: ACC.cash.id, categoryIds: [ACC.marketing.id, ACC.uncat.id, ACC.uncatIncome.id] });
  assert.deepEqual(sent.sort, ['DATE_ASC']);
  assert.equal(f.json.items[0].date, '2026-10-10');
});

test('list: a page over the size cap is shortened and the cursor resumes after the last row', async (t) => {
  const internal = createFakeInternal();
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: tempCredentials(BOTH), env: { WAVE_BUSINESS_ID: BUSINESS.id, WAVE_MCP_MAX_RESPONSE_CHARS: '4000' } });
  t.after(h.close);
  const seen = [];
  let cursor;
  let shortened = 0;
  for (let i = 0; i < 40; i++) {
    const r = await h.call('wave_list_transactions', { pageSize: 100, detail: 'full', ...(cursor ? { cursor } : {}) });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.length <= 4000, `page ${i} is ${r.text.length} chars`);
    assert.equal(r.json.truncated, undefined, 'never trimmed after the fact');
    if (r.json.shortened) shortened++;
    seen.push(...r.json.items.map((x) => x.id));
    if (!r.json.hasMore) break;
    cursor = r.json.nextCursor;
  }
  assert.ok(shortened > 0, 'the cap was exercised');
  assert.equal(seen.length, 30);
  assert.equal(new Set(seen).size, 30, 'every transaction exactly once');
});

test('get: full detail with lines, tax, sequence and editable fields', async (t) => {
  const h = await live(t, { transactions: [makeTx(1, { amount: '11.30', tax: { amount: '1.30', manual: true } })] });
  const r = await h.call('wave_get_transaction', { id: 'tx-1' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.sequence, 1);
  assert.equal(r.json.amount, '11.30');
  assert.equal(r.json.lines[0].salesTax[0].amount, '1.30');
  assert.equal(r.json.lines[0].salesTax[0].manual, true);
  assert.ok(r.json.editable.includes('canDelete'));
  const none = await h.call('wave_list_transactions', { search: 'no such thing' });
  assert.deepEqual([none.json.items, none.json.count, none.json.hasMore], [[], 0, false], 'empty result keeps items: []');
  const missing = await h.call('wave_get_transaction', { id: 'nope' });
  assert.match(missing.text, /not found/);
});

test('update: header fields send the current sequence; dryRun writes nothing', async (t) => {
  const h = await live(t);
  const dry = await h.call('wave_update_transaction', { id: 'tx-1', description: 'Renamed', dryRun: true });
  assert.equal(dry.json.dryRun, true);
  assert.equal(patches(h.internal).length, 0);
  const r = await h.call('wave_update_transaction', { id: 'tx-1', description: 'Renamed', notes: 'n', date: '2026-09-30' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(patches(h.internal)[0].variables.input, { id: 'tx-1', sequence: 1, date: '2026-09-30', description: 'Renamed', notes: 'n' });
  assert.equal(r.json.transaction.sequence, 2);
  const stale = await h.call('wave_update_transaction', { id: 'tx-1', notes: 'x', expectedSequence: 1 });
  assert.match(stale.text, /sequence 2, not 1/);
});

test('update: a concurrent edit (stale sequence) is reported, not retried', async (t) => {
  const h = await live(t);
  const realFetch = h.internal.fetchImpl;
  // Bump the sequence between our read and our write, as an edit in the web app would.
  h.internal.calls.length = 0;
  const original = h.internal.txs[0];
  const origGet = original.sequence;
  const r0 = await h.call('wave_get_transaction', { id: 'tx-1' });
  assert.equal(r0.json.sequence, origGet);
  h.ctx.internal.fetch = async (url, init) => {
    if (JSON.parse(init.body).query.includes('mutation TransactionPatch')) original.sequence += 1;
    return realFetch(url, init);
  };
  const r = await h.call('wave_update_transaction', { id: 'tx-1', notes: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /changed since it was read/);
  assert.equal(patches(h.internal).length, 1);
});

test('update: category, amount and vendor on a single-line transaction', async (t) => {
  const h = await live(t, { transactions: [makeTx(1, { amount: '11.30', category: ACC.uncat, tax: { amount: '1.30', manual: true } })] });
  const review = await h.call('wave_update_transaction', { id: 'tx-1', verified: true });
  assert.equal(review.isError, true);
  assert.match(review.text, /cannot be reviewed with uncategorized item/);

  const r = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.marketing.id, amount: '22.60', vendorId: 'v-1', verified: true });
  assert.equal(r.isError, false, r.text);
  const input = patches(h.internal).at(-1).variables.input;
  assert.deepEqual(input.anchorLineItem, { order: 0, itemType: 'CREDIT', amount: '22.60', category: { type: 'ACCOUNT_ID', accountId: ACC.cash.id } });
  assert.deepEqual(input.lineItems, [{ order: 1, itemType: 'DEBIT', taxAction: 'PAYMENT', amount: '22.60', category: { type: 'ACCOUNT_ID', accountId: ACC.marketing.id }, vendorId: 'v-1' }]);
  assert.equal(input.verificationStatus, 'VERIFIED');
  assert.equal(r.json.transaction.lines[0].salesTax[0].amount, '1.30', 'manual tax kept');
  assert.match(r.json.warnings[0], /set manually/);

  const clear = await h.call('wave_update_transaction', { id: 'tx-1', vendorId: null });
  assert.equal(clear.isError, false, clear.text);
  assert.equal(patches(h.internal).at(-1).variables.input.lineItems[0].vendorId, null, 'null clears the vendor');
});

test('update: salesTax recalculates, sets or removes tax through Wave', async (t) => {
  const h = await live(t, { transactions: [makeTx(1, { amount: '22.60', tax: { amount: '1.30', manual: true } })] });
  const dry = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [{ salesTaxId: GST.id }], dryRun: true });
  assert.deepEqual(dry.json.salesTax, [{ line: 1, salesTax: [{ tax: 'GST', amount: '1.08' }] }]);
  const r = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [{ salesTaxId: GST.id }] });
  assert.deepEqual(patches(h.internal).at(-1).variables.input.lineItems[0].taxLiabilities, [{ accountId: GST.accountId }]);
  assert.equal(r.json.transaction.lines[0].salesTax[0].amount, '1.08');
  const manual = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [{ salesTaxId: GST.id, amount: 1 }] });
  assert.deepEqual(patches(h.internal).at(-1).variables.input.lineItems[0].taxLiabilities, [{ accountId: GST.accountId, amount: '1.00' }]);
  assert.equal(manual.json.transaction.lines[0].salesTax[0].manual, true);
  const none = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [] });
  assert.equal(none.json.transaction.lines[0].salesTax, undefined);
  const bad = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [{ salesTaxId: 'tax-unknown' }] });
  assert.match(bad.text, /not available in this business/);
});

test('update: split lines, balance check and line removal', async (t) => {
  const h = await live(t, { transactions: [makeTx(1, { amount: '22.60' })] });
  const unbalanced = await h.call('wave_update_transaction', { id: 'tx-1', lines: [{ order: 1, accountId: ACC.marketing.id, amount: '20' }, { accountId: ACC.uncat.id, amount: '5' }] });
  assert.match(unbalanced.text, /lines total 25.00 but the transaction amount is 22.60/);
  assert.equal(patches(h.internal).length, 0, 'checked locally first');

  const split = await h.call('wave_update_transaction', { id: 'tx-1', lines: [{ order: 1, accountId: ACC.marketing.id, amount: '17.35' }, { accountId: ACC.uncat.id, amount: '5.25', salesTax: [{ salesTaxId: GST.id }] }] });
  assert.equal(split.isError, false, split.text);
  const sent = patches(h.internal).at(-1).variables.input.lineItems;
  assert.equal(sent[1].order, undefined, 'new lines have no order');
  assert.equal(sent[1].itemType, 'DEBIT');
  assert.deepEqual(sent[1].taxLiabilities, [{ accountId: GST.accountId }]);
  assert.equal(split.json.transaction.lines.length, 2);
  assert.equal(split.json.transaction.lines[1].salesTax[0].amount, '0.25');

  const single = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.uncat.id });
  assert.match(single.text, /2 category lines/);
  const mixed = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.uncat.id, lines: [{ order: 1, accountId: ACC.marketing.id, amount: '22.60' }] });
  assert.match(mixed.text, /not both/);

  const merge = await h.call('wave_update_transaction', { id: 'tx-1', amount: '17.35', lines: [{ order: 1, accountId: ACC.marketing.id, amount: '17.35' }] });
  assert.equal(merge.isError, false, merge.text);
  assert.match(merge.json.warnings[0], /Removed 1 line/);
  assert.equal(merge.json.transaction.amount, '17.35');
});

test('update: Wave input errors are made readable', async (t) => {
  const h = await live(t);
  // Bypass the local balance check to see Wave's own answer.
  const realFetch = h.ctx.internal.fetch;
  h.ctx.internal.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes('mutation TransactionPatch')) body.variables.input.lineItems = [{ order: 1, amount: '10.5' }];
    return realFetch(url, { ...init, body: JSON.stringify(body) });
  };
  const r = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.marketing.id });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'Wave rejected the change: Line items are over balanced. (difference 0.50) [LINE_ITEM_AMOUNT_OVERBALANCED]');
});

test('delete: soft delete, then reads and repeats say it is gone', async (t) => {
  const h = await live(t);
  const r = await h.call('wave_delete_transaction', { id: 'tx-3' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(h.internal.calls.findLast((c) => c.name === 'TransactionDelete').variables.input, { id: 'tx-3', sequence: 1 });
  assert.match((await h.call('wave_get_transaction', { id: 'tx-3' })).text, /has been deleted/);
  assert.match((await h.call('wave_delete_transaction', { id: 'tx-3' })).text, /has been deleted/);
  assert.equal((await h.call('wave_list_transactions', { search: 'Purchase 3' })).json.items.some((x) => x.id === 'tx-3'), false);
});

test('read-only mode keeps list/get and hides edit/delete', async (t) => {
  const internal = createFakeInternal();
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: tempCredentials(BOTH), env: { WAVE_MCP_READ_ONLY: '1' } });
  t.after(h.close);
  const names = (await h.client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('wave_list_transactions') && names.includes('wave_get_transaction'));
  assert.ok(!names.includes('wave_update_transaction') && !names.includes('wave_delete_transaction'));
});

// ---------------------------------------------------------------- pure units

test('buildPatch refuses fields Wave marks as not editable', () => {
  const tx = makeTx(1);
  tx.detailActions.amount = false;
  assert.throws(() => buildPatch(tx, { amount: '5' }), /does not allow changing the amount/);
  assert.throws(() => buildPatch(tx, {}), /Nothing to change/);
  const { input, changed } = buildPatch(tx, { description: 'x' });
  assert.deepEqual(changed, ['description']);
  assert.deepEqual(input, { id: 'tx-1', sequence: 1, description: 'x' });
  assert.throws(() => buildPatch(tx, { lines: [{ order: 9, accountId: 'a', amount: '10' }] }), /order 9 is not a line/);
});

test('buildPatch handles journal entries (no bank side): lines only, debits = credits', () => {
  const tx = makeTx(1);
  tx.anchorLineItem = null;
  tx.direction = null;
  tx.lineItems = [
    { ...tx.lineItems[0], order: 0, itemType: 'DEBIT', amount: '5', taxAction: null },
    { ...tx.lineItems[0], order: 1, itemType: 'CREDIT', amount: '5', taxAction: null, account: ACC.uncat },
  ];
  assert.throws(() => buildPatch(tx, { amount: '7' }), /journal entry: it has no bank\/card side/);
  assert.throws(() => buildPatch(tx, { accountId: ACC.cash.id }), /journal entry/);
  assert.throws(() => buildPatch(tx, { categoryId: ACC.marketing.id }), /journal entry has 2 lines.*debits equal to credits/);
  assert.throws(() => buildPatch(tx, { lines: [{ order: 0, accountId: 'a', amount: '7' }, { order: 1, accountId: 'b', amount: '5' }] }), /Debits total 7.00 but credits total 5.00/);
  assert.throws(() => buildPatch(tx, { lines: [{ order: 0, accountId: 'a', amount: '5' }, { order: 1, accountId: 'b', amount: '4' }, { accountId: 'c', amount: '1' }] }), /give it a side/);
  const { input } = buildPatch(tx, { lines: [{ order: 0, accountId: 'a', amount: '7' }, { order: 1, accountId: 'b', amount: '5' }, { accountId: 'c', amount: '2', side: 'credit' }] });
  assert.equal(input.anchorLineItem, undefined);
  assert.deepEqual(input.lineItems[2], { itemType: 'CREDIT', taxAction: null, amount: '2.00', category: { type: 'ACCOUNT_ID', accountId: 'c' } });
});

test('dates must be real calendar dates', async (t) => {
  const h = await live(t);
  const r = await h.call('wave_list_transactions', { startDate: '2024-04-31' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Not a real calendar date/);
  assert.equal((await h.call('wave_list_transactions', { startDate: '2024-02-29' })).isError, false, 'leap day is fine');
});

test('describeInternalInputErrors digs the reason out of Wave\'s JSON strings', () => {
  assert.equal(describeInternalInputErrors([{ message: '' }, { message: '{"transactions": [{"__all__": ["Cannot do that."]}]}' }, { message: '400' }]), 'Cannot do that.');
  assert.equal(describeInternalInputErrors([{ message: '{"date": ["Enter a valid date."]}' }]), 'date: Enter a valid date.');
  assert.equal(describeInternalInputErrors([{ message: 'plain words', path: ['input', 'date'] }]), 'input.date: plain words');
  assert.equal(describeInternalInputErrors([{ code: 'INVALID', message: '' }]), 'no reason given (INVALID)');
});

// ---------------------------------------------------------------- login

const T = 'seqAbCdEf0123456789xyzXYZ0123';
test('extractCredential reads every DevTools copy format', () => {
  const pastes = {
    bash: `curl 'https://gql.waveapps.com/graphql/internal' \\\n  -H 'accept: */*' \\\n  -H 'authorization: Bearer ${T}' \\\n  -b 'a=b' \\\n  --data-raw '{"query":"q"}'`,
    cmd: `curl ^"https://gql.waveapps.com/graphql/internal^" ^\n  -H ^"authorization: Bearer ${T}^" ^\n  --data-raw ^"^{^\\^"q^\\^":1^}^"`,
    fetch: `fetch("https://gql.waveapps.com/graphql/internal", {\n  "headers": { "authorization": "Bearer ${T}" },\n  "method": "POST"\n});`,
    powershell: `$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession\nInvoke-WebRequest -UseBasicParsing -Uri "https://gql.waveapps.com/graphql/internal" \`\n-Headers @{\n"authorization"="Bearer ${T}"\n}`,
    headers: `POST /graphql/internal HTTP/2\nHost: gql.waveapps.com\nAuthorization: Bearer ${T}\nContent-Type: application/json`,
    bare: ` ${T}\n`,
  };
  for (const [kind, text] of Object.entries(pastes)) assert.equal(extractCredential(text).token, T, kind);
  assert.equal(extractCredential(pastes.bash).url, 'https://gql.waveapps.com/graphql/internal');
  assert.throws(() => extractCredential(`-H 'authorization: Bearer ${T}' -H 'authorization: Bearer ${T}x'`), /more than one/);
  assert.throws(() => extractCredential(`curl 'https://next.waveapps.com/' -H 'cookie: s=1'`), /cookies but no/);
  assert.throws(() => extractCredential('hello world'), /No "authorization/);
  assert.throws(() => extractCredential('   '), /Nothing was pasted/);
});

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
}

function loginFetch(kind) {
  return async (url, init) => {
    const ok = init.headers.authorization === `Bearer ${T}`;
    const internal = String(url).includes('/internal');
    if (!ok || kind === 'expired') return Response.json({ errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }], data: { user: null } });
    if (internal && kind === 'access') return Response.json({ errors: [{ message: 'API Application not approved for access.', extensions: { code: 'FORBIDDEN' } }], data: { user: null } });
    return Response.json({ data: { user: { firstName: 'Ada', lastName: 'Owner', defaultEmail: 'owner@example.com' } } });
  };
}

test('login stores a web session as WAVE_SESSION_TOKEN without printing it', async () => {
  const { file } = tempCredentials(`WAVE_ACCESS_TOKEN=${TOKEN}\n`);
  const out = sink();
  const err = sink();
  const config = loadConfig({ WAVE_CREDENTIALS_FILE: file });
  const code = await runLoginCli({ file, config, out: out.stream, err: err.stream, input: Readable.from([`curl 'https://gql.waveapps.com/graphql/internal' \\\n -H 'authorization: Bearer ${T}'\n`]), fetchImpl: loginFetch('session') });
  assert.equal(code, 0, err.text);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, new RegExp(`WAVE_SESSION_TOKEN=${T}`));
  assert.match(text, new RegExp(`WAVE_ACCESS_TOKEN=${TOKEN}`), 'other keys kept');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(out.text, /Signed in as Ada Owner/);
  assert.match(out.text, /keeps using your stored API token/);
  assert.ok(!(out.text + err.text).includes(T), 'token never printed');
});

test('login recognizes a public API token and rejects expired ones', async () => {
  const { file } = tempCredentials(null);
  const config = loadConfig({ WAVE_CREDENTIALS_FILE: file });
  const out = sink();
  const code = await runLoginCli({ file, config, out: out.stream, err: sink().stream, input: Readable.from([`${T}\n`]), fetchImpl: loginFetch('access') });
  assert.equal(code, 0);
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`^WAVE_ACCESS_TOKEN=${T}$`, 'm'));
  assert.match(out.text, /public API token/);

  const { file: f2 } = tempCredentials(null);
  const err = sink();
  const bad = await runLoginCli({ file: f2, config, out: sink().stream, err: err.stream, input: Readable.from([`${T}\n`]), fetchImpl: loginFetch('expired') });
  assert.equal(bad, 1);
  assert.match(err.text, /expired or signed out/);
  assert.equal(fs.existsSync(f2), false, 'nothing written');
});
