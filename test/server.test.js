import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, tempCredentials } from './helpers/harness.js';
import { BUSINESS, createFakeWave, makeInvoice } from './helpers/fake-wave.js';

test('tool catalog: names, annotations, descriptions and schemas', async (t) => {
  const h = await connect(createFakeWave());
  t.after(h.close);
  const { tools } = await h.client.listTools();
  assert.equal(tools.length, 72);
  for (const tool of tools) {
    assert.match(tool.name, /^wave_[a-z_]+$/);
    assert.ok(tool.description.length > 20, `${tool.name} description`);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
    assert.equal(tool.inputSchema.type, 'object');
  }
  const sends = tools.filter((x) => /^wave_send_/.test(x.name));
  assert.equal(sends.length, 5);
  for (const s of sends) assert.deepEqual([s.annotations.destructiveHint, s.annotations.openWorldHint], [true, true], s.name);
  for (const d of tools.filter((x) => /^wave_(delete|archive)_/.test(x.name))) assert.equal(d.annotations.destructiveHint, true, d.name);
  const { resources } = await h.client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ['wave://guide', 'wave://limitations', 'wave://schema']);
  const guide = (await h.client.readResource({ uri: 'wave://guide' })).contents[0].text;
  assert.match(guide, /^# Wave accounting/, 'skill text without frontmatter');
  assert.match(guide, /node \S*bin\/wave-mcp\.js login/, 'the real sign-in command is filled in');
  assert.ok(!guide.includes('<package>'));
  const { prompts } = await h.client.listPrompts();
  assert.equal(prompts.length, 3);
});

test('read-only mode and toolsets hide tools', async (t) => {
  const ro = await connect(createFakeWave(), { env: { WAVE_MCP_READ_ONLY: '1' } });
  t.after(ro.close);
  const { tools } = await ro.client.listTools();
  // wave_import_ledger only writes this server's own ledger file, so it stays.
  assert.deepEqual(tools.filter((x) => x.annotations.readOnlyHint !== true).map((x) => x.name), ['wave_import_ledger']);
  assert.equal(tools.length, 29);
  const subset = await connect(createFakeWave(), { env: { WAVE_MCP_TOOLSETS: 'context,reports' } });
  t.after(subset.close);
  const names = (await subset.client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['wave_get_business', 'wave_get_context', 'wave_get_reference', 'wave_list_businesses', 'wave_run_report']);
});

test('context resolves the default business, skipping the personal one', async (t) => {
  const h = await connect(createFakeWave());
  t.after(h.close);
  const r = await h.call('wave_get_context');
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.defaultBusinessId, BUSINESS.id);
  assert.equal(r.json.user.defaultEmail, 'owner@example.com');
  assert.equal(r.json.auth.mode, 'token');
  assert.equal(r.json.businesses.length, 2);
  assert.ok(!r.text.includes('test-token'), 'never echoes the token');
});

test('without credentials, data tools explain setup', async (t) => {
  const h = await connect(createFakeWave(), { credentials: tempCredentials(null) });
  t.after(h.close);
  const r = await h.call('wave_list_customers');
  assert.equal(r.isError, true);
  assert.match(r.text, /No Wave credentials found/);
  const c = await h.call('wave_get_context');
  assert.equal(c.isError, false);
  assert.equal(c.json.auth.mode, 'none');
  assert.match(c.json.setup, /WAVE_ACCESS_TOKEN/);
});

test('lists paginate with a compact envelope', async (t) => {
  const h = await connect(createFakeWave());
  t.after(h.close);
  const p1 = await h.call('wave_list_customers');
  assert.equal(p1.json.items.length, 20);
  assert.deepEqual([p1.json.page, p1.json.totalCount, p1.json.totalPages, p1.json.hasMore, p1.json.nextPage], [1, 45, 3, true, 2]);
  assert.equal(p1.json.items[0].currency, 'CAD', 'currency wrappers collapse');
  assert.deepEqual(p1.json.items[0].outstandingAmount, { value: '0.00', currency: 'CAD' });
  assert.ok(!('internalNotes' in p1.json.items[0]), 'summary omits notes');
  const p3 = await h.call('wave_list_customers', { page: 3 });
  assert.equal(p3.json.items.length, 5);
  assert.equal(p3.json.hasMore, false);
  assert.ok(!('nextPage' in p3.json));
  const bad = await h.call('wave_list_customers', { pageSize: 500 });
  assert.equal(bad.isError, true);
});

test('search scans the whole list and filters client-side', async (t) => {
  const h = await connect(createFakeWave());
  t.after(h.close);
  const r = await h.call('wave_list_customers', { search: 'globex' });
  assert.equal(r.json.totalCount, 1);
  assert.equal(r.json.items[0].name, 'Globex');
});

test('get returns full detail; missing records are clear errors', async (t) => {
  const h = await connect(createFakeWave());
  t.after(h.close);
  const r = await h.call('wave_get_customer', { id: 'cust-2' });
  assert.equal(r.json.internalNotes.length, 600, 'full detail is not clipped');
  const missing = await h.call('wave_get_customer', { id: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Customer nope was not found/);
});

test('create customer resolves the business and sends only given fields', async (t) => {
  const fake = createFakeWave();
  const h = await connect(fake);
  t.after(h.close);
  const r = await h.call('wave_create_customer', { name: 'Initech', email: 'ap@initech.test' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.customer.id, 'cust-new');
  assert.deepEqual(fake.mutations.at(-1), ['customerCreate', { businessId: BUSINESS.id, name: 'Initech', email: 'ap@initech.test' }]);
});

test('mutation input errors become actionable tool errors', async (t) => {
  const h = await connect(createFakeWave());
  t.after(h.close);
  const r = await h.call('wave_delete_invoice', { invoiceId: 'inv-1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /invoiceId: Invoice has payments \[INVALID\]/);
});

test('money transactions are balance-checked, dry-runnable and get an externalId', async (t) => {
  const fake = createFakeWave();
  const h = await connect(fake);
  t.after(h.close);
  const base = { date: '2026-03-05', description: 'Office Depot', anchor: { accountId: 'acct-card', amount: '45.99', direction: 'WITHDRAWAL' } };
  const unbalanced = await h.call('wave_create_transaction', { ...base, lineItems: [{ accountId: 'acct-rent', amount: '40.00' }] });
  assert.equal(unbalanced.isError, true);
  assert.match(unbalanced.text, /anchor is 45\.99 but the line items total 40\.00/);
  const dry = await h.call('wave_create_transaction', { ...base, lineItems: [{ accountId: 'acct-rent', amount: 45.99 }], dryRun: true });
  assert.equal(dry.json.dryRun, true);
  assert.equal(fake.mutations.length, 0, 'dry run writes nothing');
  const real = await h.call('wave_create_transaction', { ...base, lineItems: [{ accountId: 'acct-rent', amount: '30.00' }, { accountId: 'acct-cogs', amount: '15.99', balance: 'INCREASE' }] });
  assert.equal(real.isError, false, real.text);
  assert.equal(real.json.transactionId, 'txn-1');
  const [, input] = fake.mutations.at(-1);
  assert.match(input.externalId, /^wave-mcp-[0-9a-f-]{36}$/);
  assert.equal(input.lineItems[0].balance, 'INCREASE');
  const bulk = await h.call('wave_create_transactions', { transactions: [{ ...base, externalId: 'a1', lineItems: [{ accountId: 'acct-rent', amount: '45.99' }] }, { ...base, externalId: 'a2', lineItems: [{ accountId: 'acct-rent', amount: '45.99' }] }] });
  assert.deepEqual(bulk.json.created.map((c) => [c.externalId, c.transactionId]), [['a1', 'txn-1'], ['a2', 'txn-2']]);
});

test('update account fetches the sequence and can clear a field with null', async (t) => {
  const fake = createFakeWave();
  const h = await connect(fake);
  t.after(h.close);
  const r = await h.call('wave_update_account', { id: 'acct-rent', name: 'Office Rent', description: null });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(fake.mutations.at(-1), ['accountPatch', { id: 'acct-rent', sequence: 1, name: 'Office Rent', description: null }]);
});

test('graphql escape hatch runs queries only', async (t) => {
  const h = await connect(createFakeWave());
  t.after(h.close);
  const ok = await h.call('wave_graphql_query', { query: 'query { user { id } }' });
  assert.deepEqual(ok.json, { user: { id: 'user-1' } });
  const no = await h.call('wave_graphql_query', { query: 'mutation { customerDelete(input: {id: "x"}) { didSucceed } }' });
  assert.equal(no.isError, true);
  assert.match(no.text, /only runs queries/);
  const invalid = await h.call('wave_graphql_query', { query: 'query { nope }' });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /Cannot query field "nope"/);
});

test('rate limits are retried transparently', async (t) => {
  const fake = createFakeWave({ failures: [429] });
  const h = await connect(fake);
  t.after(h.close);
  const r = await h.call('wave_list_accounts', { businessId: BUSINESS.id });
  assert.equal(r.isError, false, r.text);
  assert.equal(h.ctx.client.stats.rateLimited, 1);
});

test('oversized responses are trimmed with an explanation', async (t) => {
  const h = await connect(createFakeWave(), { env: { WAVE_MCP_MAX_RESPONSE_CHARS: '4000' } });
  t.after(h.close);
  const r = await h.call('wave_list_customers', { pageSize: 100, detail: 'full' });
  assert.ok(r.text.length <= 4000);
  assert.ok(r.json.truncated.returned < r.json.truncated.of);
  assert.match(r.json.truncated.reason, /smaller pageSize/);
});

test('reports: receivables, sales, tax and balances', async (t) => {
  const invoices = [
    makeInvoice(1, { dueDate: '2026-01-10', invoiceDate: '2026-01-01' }),
    makeInvoice(2, { customer: { id: 'cust-2', name: 'Initech' }, total: '113.00', paid: '113.00', invoiceDate: '2026-02-01', payments: [{ id: 'pay-1', paymentDate: '2026-02-15', amount: '113.00', paymentMethod: 'BANK_TRANSFER', active: true, account: { id: 'acct-bank', name: 'Chequing' } }] }),
    makeInvoice(3, { status: 'DRAFT', invoiceDate: '2026-02-02' }),
    makeInvoice(4, { currency: 'USD', exchangeRate: '1.35', total: '100.00', subtotal: '100.00', taxTotal: '0.00', items: [], invoiceDate: '2026-02-03', dueDate: '2099-01-01' }),
  ];
  const h = await connect(createFakeWave({ invoices }));
  t.after(h.close);

  const aged = await h.call('wave_run_report', { report: 'aged_receivables' });
  assert.equal(aged.isError, false, aged.text);
  assert.equal(aged.json.openInvoices, 2, 'paid and draft invoices are excluded');
  assert.equal(aged.json.totals.over90['CAD'] ?? aged.json.totals.over90, '113.00');
  assert.equal(aged.json.totals.total.CAD, '248.00', '113 CAD + 100 USD × 1.35');
  assert.deepEqual(aged.json.totals.total.byOriginalCurrency, { CAD: '113.00', USD: '100.00' });

  const income = await h.call('wave_run_report', { report: 'income_by_customer', startDate: '2026-01-01', endDate: '2026-12-31' });
  assert.equal(income.json.totals.invoiced.CAD, '361.00');
  assert.equal(income.json.totals.paid, '113.00');
  assert.equal(income.json.items[0].customer.name, 'Globex');

  const tax = await h.call('wave_run_report', { report: 'sales_tax', startDate: '2026-01-01', endDate: '2026-12-31' });
  assert.equal(tax.json.items[0].taxCollected, '26.00');
  assert.equal(tax.json.items[0].taxableSales, '200.00');

  const products = await h.call('wave_run_report', { report: 'sales_by_product', startDate: '2026-01-01', endDate: '2026-12-31' });
  assert.equal(products.json.items[0].quantity, 2);

  const tb = await h.call('wave_run_report', { report: 'trial_balance' });
  assert.deepEqual(tb.json.totals, { debit: '7530.00', credit: '7530.00', difference: '0.00', balanced: true });
  const bs = await h.call('wave_run_report', { report: 'balance_sheet' });
  assert.equal(bs.json.assets.total, '6130.00');
  assert.equal(bs.json.equity.netIncomeFromIncomeAndExpenseAccounts, '2600.00');
  assert.equal(bs.json.difference, '0.00');
  const pl = await h.call('wave_run_report', { report: 'profit_and_loss' });
  assert.deepEqual([pl.json.income.total, pl.json.costOfGoodsSold, pl.json.grossProfit, pl.json.netProfit], ['4000.00', '500.00', '3500.00', '2600.00']);
  assert.match(pl.json.caveat, /as of now only/);
  const balances = await h.call('wave_run_report', { report: 'account_balances', limit: 3 });
  assert.equal(balances.json.items.length, 3);
  assert.equal(balances.json.totalCount, 8, 'zero balances excluded');
  assert.equal(balances.json.nextOffset, 3);

  const statement = await h.call('wave_run_report', { report: 'customer_statement', customerId: 'cust-1' });
  assert.deepEqual(statement.json.items.map((i) => i.invoiceNumber), ['1', '4'], 'outstanding only, drafts excluded, oldest first');
  assert.ok(statement.json.items[0].daysOverdue > 0);
  assert.equal(statement.json.items[1].daysOverdue, 0);

  const payments = await h.call('wave_list_payments', { startDate: '2026-02-01', endDate: '2026-02-28' });
  assert.equal(payments.json.totalCount, 1);
  assert.equal(payments.json.items[0].invoice.invoiceNumber, '2');
  assert.equal(payments.json.totals.received, '113.00');
});

test('aged receivables stops scanning once nothing is due', async (t) => {
  const invoices = Array.from({ length: 450 }, (_, i) => makeInvoice(i + 1, i < 10 ? { dueDate: '2026-01-01' } : { paid: '113.00' }));
  const fake = createFakeWave({ invoices });
  const h = await connect(fake);
  t.after(h.close);
  const r = await h.call('wave_run_report', { report: 'aged_receivables', limit: 5 });
  assert.equal(r.json.openInvoices, 10);
  assert.equal(r.json.complete, true);
  const scans = fake.calls.filter((c) => c.body.query.startsWith('query ScanInvoices'));
  assert.equal(scans.length, 1, 'one page of 200 instead of three');
  assert.deepEqual(scans[0].body.variables.sort, ['AMOUNT_DUE_DESC']);
  assert.equal(r.json.items.length, 1);
  assert.equal(r.json.items[0].invoices, 10);
});
