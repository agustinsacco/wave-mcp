#!/usr/bin/env node
/**
 * Live smoke test with real credentials, through the real stdio binary.
 *
 *   npm run smoke                 read-only: every read tool and every report
 *   npm run smoke -- --writes     also a reversible round trip in the default
 *                                 business: customer create/update/delete and a
 *                                 draft invoice create/delete. Use a TEST business.
 *
 * Money transactions are only dry-run: the API cannot delete them.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const writes = process.argv.includes('--writes');
const client = new Client({ name: 'wave-mcp-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../bin/wave-mcp.js', import.meta.url).pathname], env: { ...process.env }, stderr: 'inherit' }));

let failures = 0;
async function call(name, args = {}, { expectError = false } = {}) {
  const started = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || '';
  const ok = Boolean(r.isError) === expectError;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(36)} ${String(Date.now() - started).padStart(5)} ms ${String(text.length).padStart(6)} chars${r.isError ? `  ${text.slice(0, 160)}` : ''}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const context = await call('wave_get_context');
if (!context.defaultBusinessId) {
  console.log('\nNo default business:', context.defaultBusinessNote || context.setup);
  process.exit(1);
}
await call('wave_get_business');
await call('wave_list_businesses');
for (const kind of ['currencies', 'account_types', 'account_subtypes']) await call('wave_get_reference', { kind, pageSize: 5 });
await call('wave_get_reference', { kind: 'country', code: 'CA' });

const lists = {};
for (const [tool, key] of [
  ['wave_list_customers', 'customer'],
  ['wave_list_vendors', 'vendor'],
  ['wave_list_products', 'product'],
  ['wave_list_accounts', 'account'],
  ['wave_list_sales_taxes', 'sales_tax'],
  ['wave_list_invoices', 'invoice'],
  ['wave_list_estimates', 'estimate'],
]) {
  lists[key] = await call(tool, { pageSize: 5 });
  await call(tool, { pageSize: 2, detail: 'full' });
}
const first = (key) => lists[key]?.items?.[0]?.id;
if (first('customer')) await call('wave_get_customer', { id: first('customer') });
if (first('vendor')) await call('wave_get_vendor', { id: first('vendor') });
if (first('product')) await call('wave_get_product', { id: first('product') });
if (first('account')) await call('wave_get_account', { id: first('account') });
if (first('sales_tax')) await call('wave_get_sales_tax', { id: first('sales_tax') });
if (first('estimate')) await call('wave_get_estimate', { id: first('estimate') });
if (first('invoice')) {
  const inv = await call('wave_get_invoice', { id: first('invoice') });
  if (inv.payments?.[0]) await call('wave_get_invoice_payment', { id: inv.payments[0].id });
}
await call('wave_list_customers', { search: 'a', pageSize: 3 });
await call('wave_list_payments', { limit: 5 });
for (const report of ['profit_and_loss', 'balance_sheet', 'trial_balance', 'account_balances', 'aged_receivables', 'income_by_customer', 'sales_by_product', 'sales_tax', 'invoice_summary']) {
  const r = await call('wave_run_report', { report, limit: 5 });
  if (report === 'trial_balance' && r.totals) console.log(`     trial balance: debit ${r.totals.debit} credit ${r.totals.credit} balanced=${r.totals.balanced}`);
  if (report === 'balance_sheet' && r.difference !== undefined) console.log(`     balance sheet difference: ${r.difference}`);
}
await call('wave_graphql_query', { query: 'query { user { id defaultEmail } }' });

// Live transactions (web-app API) when a web session is stored.
if (/^configured/.test(context.auth?.webSession || '')) {
  const txs = await call('wave_list_transactions', { pageSize: 5 });
  await call('wave_list_transactions', { pageSize: 100, detail: 'full' });
  if (txs.nextCursor) await call('wave_list_transactions', { pageSize: 5, cursor: txs.nextCursor });
  await call('wave_list_transactions', { uncategorizedOnly: true, pageSize: 5 });
  if (txs.items?.[0]) {
    await call('wave_get_transaction', { id: txs.items[0].id });
    await call('wave_update_transaction', { id: txs.items[0].id, description: txs.items[0].description, dryRun: true });
  }
} else {
  console.log('     (no web session: live transaction tools skipped; run wave-mcp login)');
}

const bank = (await call('wave_list_accounts', { subtypes: ['CASH_AND_BANK'], pageSize: 1 }))?.items?.[0];
const expense = (await call('wave_list_accounts', { types: ['EXPENSE'], pageSize: 1 }))?.items?.[0];
if (bank && expense) {
  await call('wave_create_transaction', { date: new Date().toISOString().slice(0, 10), description: 'wave-mcp smoke (dry run)', anchor: { accountId: bank.id, amount: '1.00', direction: 'WITHDRAWAL' }, lineItems: [{ accountId: expense.id, amount: '1.00' }], dryRun: true });
}

if (writes) {
  console.log('\n-- reversible writes in', context.defaultBusinessId);
  const stamp = new Date().toISOString();
  const created = await call('wave_create_customer', { name: `wave-mcp smoke ${stamp}`, email: 'smoke@example.com' });
  const cid = created?.customer?.id;
  if (cid) {
    await call('wave_update_customer', { id: cid, internalNotes: 'updated by smoke test' });
    const product = lists.product?.items?.find((p) => p.isSold);
    if (product) {
      const inv = await call('wave_create_invoice', { customerId: cid, items: [{ productId: product.id, quantity: 1, unitPrice: '1.00', taxIds: [] }], memo: 'wave-mcp smoke test' });
      if (inv?.invoice?.id) await call('wave_delete_invoice', { invoiceId: inv.invoice.id });
    }
    await call('wave_delete_customer', { id: cid });
  }
}

await client.close();
console.log(failures ? `\n${failures} failure(s)` : '\nAll smoke checks passed.');
process.exit(failures ? 1 : 0);
