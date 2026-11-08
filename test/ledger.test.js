import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './helpers/harness.js';
import { BUSINESS, createFakeWave } from './helpers/fake-wave.js';
import { accountingCsv, tempDataDir, writeExportZip } from './helpers/ledger-fixture.js';

/**
 * The fixture books (test/helpers/ledger-fixture.js), worked by hand:
 *   Chequing 3000 + 1130 + 2260 − 900 − 45.50 − 130 − 565 = 4749.50
 *   HST Payable 130 + 260 − 65 − 130 = 195.00 credit; AP 300; Owner 3000; Sales 3000
 *   Trial balance 6495.00 = 6495.00
 *   2026-Q1 P&L: Sales 2000; COGS 800; Rent 900 + Uncategorized 45.50; net 254.50
 */
async function imported(t, env = {}) {
  const dataDir = tempDataDir();
  const h = await connect(createFakeWave(), { env: { WAVE_MCP_DATA_DIR: dataDir, WAVE_BUSINESS_ID: BUSINESS.id, ...env } });
  t.after(h.close);
  const r = await h.call('wave_import_ledger', { path: writeExportZip().file });
  assert.equal(r.isError, false, r.text);
  return { ...h, dataDir, importResult: r.json };
}
const Q1 = { startDate: '2026-01-01', endDate: '2026-03-31' };

test('ledger tools explain the import when nothing is imported', async (t) => {
  const h = await connect(createFakeWave(), { env: { WAVE_MCP_DATA_DIR: tempDataDir(), WAVE_BUSINESS_ID: BUSINESS.id } });
  t.after(h.close);
  const r = await h.call('wave_list_ledger_transactions');
  assert.equal(r.isError, true);
  assert.match(r.text, /Data Export.*wave_import_ledger/);
  const rep = await h.call('wave_run_report', { report: 'cash_flow', ...Q1 });
  assert.equal(rep.isError, true, 'cash flow needs the ledger');
});

test('import: zip parsed, accounts classified from Wave and export labels, stored privately', async (t) => {
  const h = await imported(t);
  const r = h.importResult;
  assert.deepEqual([r.transactions, r.lines, r.accounts, r.unbalanced, r.bills], [10, 23, 10, 0, 1]);
  assert.deepEqual([r.firstDate, r.lastDate], ['2025-12-15', '2026-03-20']);
  assert.deepEqual([r.accountsFromWave, r.accountsFromExportLabels, r.accountsUnclassified], [8, 2, 0]);
  assert.ok(r.stored.startsWith(path.join(h.dataDir, 'ledgers')));
  assert.equal(fs.statSync(r.stored).mode & 0o777, 0o600);
});

test('import: a bare accounting.csv works too, and a non-export file is refused', async (t) => {
  const h = await imported(t);
  const dir = path.dirname(writeExportZip().file);
  const csv = path.join(dir, 'accounting.csv');
  fs.writeFileSync(csv, accountingCsv());
  const r = await h.call('wave_import_ledger', { path: csv });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.transactions, 10);
  const junk = path.join(dir, 'notes.csv');
  fs.writeFileSync(junk, 'a,b\n1,2\n');
  const bad = await h.call('wave_import_ledger', { path: junk });
  assert.equal(bad.isError, true);
});

test('list ledger transactions: pages, filters and totals', async (t) => {
  const h = await imported(t);
  const p1 = await h.call('wave_list_ledger_transactions', { pageSize: 3 });
  assert.equal(p1.json.totals.transactions, 10);
  assert.equal(p1.json.items[0].id, '1010', 'newest first');
  assert.equal(p1.json.nextPage, 2);
  assert.ok(p1.json.ledger.importedAt, 'every result says when the snapshot was taken');

  const transfer = p1.json.items[0];
  assert.deepEqual([transfer.direction, transfer.amount, transfer.account, transfer.toAccount], ['transfer', '565.00', 'Chequing', 'Visa']);

  const ids = async (args) => (await h.call('wave_list_ledger_transactions', { pageSize: 100, ...args })).json.items.map((x) => x.id).sort();
  assert.deepEqual(await ids({ uncategorizedOnly: true }), ['1008']);
  assert.deepEqual(await ids({ account: 'Visa' }), ['1006', '1010']);
  assert.deepEqual(await ids({ vendor: 'supply' }), ['1006', '1007']);
  assert.deepEqual(await ids({ customer: 'Globex' }), ['1003', '1004']);
  assert.deepEqual(await ids({ query: 'Q4 filing' }), ['1009'], 'searches notes');
  assert.deepEqual(await ids({ direction: 'transfer' }), ['1010']);
  assert.deepEqual(await ids({ minAmount: 1000 }), ['1001', '1002', '1003', '1004'].sort());
  assert.deepEqual(await ids(Q1), ['1003', '1004', '1005', '1006', '1007', '1008', '1009', '1010']);
});

test('get ledger transaction: every journal line', async (t) => {
  const h = await imported(t);
  const r = await h.call('wave_get_ledger_transaction', { transactionId: '1006' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.transaction.lines, [
    { account: 'Materials', type: 'EXPENSE', debit: '500.00' },
    { account: 'HST Payable', type: 'LIABILITY', debit: '65.00' },
    { account: 'Visa', type: 'LIABILITY', credit: '565.00' },
  ]);
  assert.equal((await h.call('wave_get_ledger_transaction', { transactionId: 'nope' })).isError, true);
});

test('ledger accounts list types and where they came from', async (t) => {
  const h = await imported(t);
  const r = await h.call('wave_list_ledger_accounts');
  const ap = r.json.items.find((a) => a.name === 'Accounts Payable');
  assert.deepEqual([ap.type, ap.typeSource], ['LIABILITY', 'export']);
  assert.equal(r.json.items.find((a) => a.name === 'Chequing').typeSource, 'wave');
});

test('ledger reports reproduce the hand-worked books', async (t) => {
  const h = await imported(t);
  const report = async (name, args = {}) => {
    const r = await h.call('wave_run_report', { report: name, ...Q1, ...args });
    assert.equal(r.isError, false, `${name}: ${r.text}`);
    assert.match(r.json.ledger.source, /Data Export/);
    return r.json;
  };
  const tb = await report('trial_balance');
  assert.deepEqual(tb.totals, { debit: '6495.00', credit: '6495.00', balanced: true });

  const pl = await report('profit_and_loss');
  assert.deepEqual(pl.summary, { income: '2000.00', costOfGoodsSold: '800.00', grossProfit: '1200.00', operatingExpenses: '945.50', netProfit: '254.50' });
  const dec = await report('profit_and_loss', { startDate: '2025-12-01', endDate: '2025-12-31' });
  assert.equal(dec.summary.netProfit, '1000.00');

  const bs = await report('balance_sheet');
  assert.deepEqual(bs.summary, { assets: '4749.50', liabilities: '495.00', equity: '4254.50', liabilitiesAndEquity: '4749.50', balanced: true });

  const cf = await report('cash_flow');
  assert.deepEqual([cf.summary.cashAtStart, cf.summary.netCashChange, cf.summary.cashAtEnd], ['4130.00', '619.50', '4749.50']);

  const at = await report('account_transactions', { account: 'Chequing' });
  assert.deepEqual([at.startingBalance, at.totalDebits, at.totalCredits, at.endingBalance], ['4130.00', '2260.00', '1640.50', '4749.50']);
  assert.equal(at.items.at(-1).balance, '4749.50', 'running balance ends at the closing balance');
  assert.equal((await h.call('wave_run_report', { report: 'account_transactions', ...Q1 })).isError, true, 'needs an account');

  const tax = await report('sales_tax');
  assert.deepEqual(tax.totals, { taxOnSales: '260.00', taxOnPurchases: '65.00', netTaxOwing: '195.00' });

  const ap = await report('aged_payables');
  assert.deepEqual([ap.totals.total, ap.items[0].vendor], ['300.00', 'Supply Co']);

  const pv = await report('purchases_by_vendor');
  assert.deepEqual(pv.items.map((x) => [x.vendor, x.purchases]), [['Landlord Inc', '900.00'], ['Supply Co', '800.00']]);
  assert.equal(pv.totals.expensesWithoutVendor, '45.50');
});

test('source=api skips the ledger; a re-import replaces the snapshot', async (t) => {
  const h = await imported(t);
  const api = await h.call('wave_run_report', { report: 'trial_balance', source: 'api' });
  assert.equal(api.isError, false, api.text);
  assert.equal(api.json.ledger, undefined, 'live API basis');
  const again = await h.call('wave_import_ledger', { path: writeExportZip().file });
  assert.equal(again.isError, false);
  assert.equal(fs.readdirSync(path.dirname(again.json.stored)).filter((f) => f.endsWith('.json')).length, 1);
});
