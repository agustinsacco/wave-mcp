import * as z from 'zod';
import { OPS } from '../wave/operations.js';
import { WaveError, WaveUnsupportedError } from '../wave/errors.js';
import { scanConnection } from '../wave/scan.js';
import { shape, toMinor, windowRows } from '../format.js';
import { LIMITATIONS } from '../limitations.js';
import { READ, businessId, date, defineTool } from './common.js';
import {
  accountBalances,
  agedReceivables,
  balanceSheet,
  customerStatement,
  incomeByCustomer,
  invoiceSummary,
  paymentRows,
  paymentTotals,
  profitAndLoss,
  salesByProduct,
  salesTaxReport,
  todayIn,
  trialBalance,
} from '../reports/compute.js';
import {
  ledgerAccountBalances,
  ledgerAccountTransactions,
  ledgerAgedPayables,
  ledgerBalanceSheet,
  ledgerCashFlow,
  ledgerProfitAndLoss,
  ledgerPurchasesByVendor,
  ledgerSalesTax,
  ledgerTrialBalance,
  unclassifiedWarning,
} from '../ledger/compute.js';
import { ledgerBusinessId, ledgerMeta } from '../ledger/import.js';
import { matchAccounts } from './ledger.js';

const plain = (x) => JSON.parse(JSON.stringify(x));

/** Payments can be backdated a little relative to the invoice change that recorded them. */
function modifiedSince(startDate) {
  if (!startDate) return undefined;
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 3);
  return d.toISOString();
}

async function businessInfo(ctx, bid) {
  return ctx.cache.get(`biz:${bid}`, async () => {
    const data = await ctx.client.request(OPS.GetBusiness, { id: bid });
    if (!data.business) throw new WaveError(`Business ${bid} was not found.`, { code: 'NOT_FOUND' });
    return { id: bid, name: data.business.name, currency: data.business.currency?.code, timezone: data.business.timezone };
  });
}

function scanInvoices(ctx, bid, filters, { outstandingOnly = false } = {}) {
  const key = `scan:invoices:${bid}:${outstandingOnly}:${JSON.stringify(filters)}`;
  // Sorted by amount due, the walk can stop at the first invoice with nothing due.
  const vars = outstandingOnly ? { ...filters, sort: ['AMOUNT_DUE_DESC'] } : filters;
  const stopAfter = outstandingOnly ? (n) => toMinor(n.amountDue?.value) <= 0 : undefined;
  return ctx.cache.get(key, () => scanConnection(ctx.client, OPS.ScanInvoices, { businessId: bid, ...vars }, 'invoices', { limit: ctx.config.scanLimit, stopAfter }));
}

function scanEstimates(ctx, bid, filters) {
  const key = `scan:estimates:${bid}:${JSON.stringify(filters)}`;
  return ctx.cache.get(key, () => scanConnection(ctx.client, OPS.ScanEstimatePayments, { businessId: bid, ...filters }, 'estimates', { limit: ctx.config.scanLimit }));
}

function scanAccounts(ctx, bid, includeArchived) {
  const key = `scan:accounts:${bid}:${includeArchived}`;
  return ctx.cache.get(key, async () => {
    const active = await scanConnection(ctx.client, OPS.ListAccounts, { businessId: bid, isArchived: false }, 'accounts', { limit: ctx.config.scanLimit });
    if (!includeArchived) return active;
    const archived = await scanConnection(ctx.client, OPS.ListAccounts, { businessId: bid, isArchived: true }, 'accounts', { limit: ctx.config.scanLimit });
    return { nodes: [...active.nodes, ...archived.nodes], complete: active.complete && archived.complete, totalCount: (active.totalCount || 0) + (archived.totalCount || 0) };
  });
}

function coverage(...scans) {
  const incomplete = scans.filter((s) => s && !s.complete);
  return incomplete.length
    ? { complete: false, note: `Stopped at WAVE_MCP_SCAN_LIMIT (${incomplete.map((s) => `${s.nodes.length} of ${s.totalCount}`).join(', ')} records). Narrow the date range for exact totals.` }
    : { complete: true };
}

const window = { limit: z.number().int().min(1).max(200).default(25).describe('Rows to return'), offset: z.number().int().min(0).default(0).describe('Rows to skip; use nextOffset') };

const REPORTS = [
  'profit_and_loss',
  'balance_sheet',
  'cash_flow',
  'trial_balance',
  'account_balances',
  'account_transactions',
  'general_ledger',
  'sales_tax',
  'aged_payables',
  'purchases_by_vendor',
  'aged_receivables',
  'income_by_customer',
  'sales_by_product',
  'invoice_summary',
  'customer_statement',
  ...Object.keys(LIMITATIONS.unsupportedReports),
];

/** Reports the imported ledger can produce (dated, complete books). */
const LEDGER_REPORTS = new Set(['profit_and_loss', 'balance_sheet', 'cash_flow', 'trial_balance', 'account_balances', 'account_transactions', 'general_ledger', 'sales_tax', 'aged_payables', 'purchases_by_vendor']);

export function registerReportTools(server, ctx) {
  defineTool(server, ctx, {
    name: 'wave_list_payments',
    title: 'List payments received',
    toolset: 'payments',
    annotations: READ,
    description:
      "List money received: invoice payments and estimate deposits, newest first, with totals. These are the only transaction records Wave's public API can read; bank/card transactions, expenses and money transactions created through the API cannot be listed. Filter by payment date range and customer.",
    input: z.object({
      businessId,
      startDate: date.optional().describe('Earliest payment date (inclusive)'),
      endDate: date.optional().describe('Latest payment date (inclusive)'),
      customerId: z.string().optional(),
      kind: z.enum(['all', 'invoice', 'estimate_deposit']).default('all'),
      sort: z.enum(['date_desc', 'date_asc', 'amount_desc']).default('date_desc'),
      ...window,
    }),
    handler: async ({ businessId: b, startDate, endDate, customerId, kind, sort, limit, offset }) => {
      const bid = await ctx.resolveBusinessId(b);
      const biz = await businessInfo(ctx, bid);
      const filters = { modifiedAtAfter: modifiedSince(startDate), customerId };
      const [inv, est] = await Promise.all([
        kind === 'estimate_deposit' ? null : scanInvoices(ctx, bid, filters),
        kind === 'invoice' ? null : scanEstimates(ctx, bid, filters),
      ]);
      const rows = paymentRows({ invoices: inv?.nodes, estimates: est?.nodes, startDate, endDate, customerId, kind });
      const cmp = { date_desc: (a, b) => (a.date < b.date ? 1 : -1), date_asc: (a, b) => (a.date > b.date ? 1 : -1), amount_desc: (a, b) => Number(b.amount) - Number(a.amount) }[sort];
      rows.sort(cmp);
      const totals = paymentTotals(rows, biz.currency);
      const page = windowRows(rows, { offset, limit });
      return shape(
        plain({
          business: { id: bid, currency: biz.currency },
          period: { startDate, endDate },
          ...(startDate ? { basis: 'payments on invoices/estimates modified since 3 days before startDate' } : {}),
          totals,
          ...page,
          items: page.items.map(({ exchangeRate, ...r }) => r),
          ...coverage(inv, est),
        }),
        'summary',
      );
    },
  });

  defineTool(server, ctx, {
    name: 'wave_run_report',
    title: 'Run a financial report',
    toolset: 'reports',
    annotations: READ,
    description: [
      "Financial reports computed by this server (Wave's API has no report endpoint). Rows are paginated with limit/offset; totals always cover every row.",
      'From the imported ledger (wave_import_ledger; any period, default year to date; balance-sheet style reports as of endDate): profit_and_loss, balance_sheet, cash_flow, trial_balance, account_balances, account_transactions/general_ledger (filter with account or accountId), sales_tax (sales and purchases), aged_payables, purchases_by_vendor.',
      'Without a ledger, profit_and_loss, balance_sheet, trial_balance and account_balances fall back to current account balances from the API (as of now only), and sales_tax to invoices.',
      'Live from invoices (invoice date range): income_by_customer, sales_by_product, invoice_summary; as of today: aged_receivables; customer_statement needs customerId.',
      `Not possible: ${Object.keys(LIMITATIONS.unsupportedReports).join(', ')}.`,
    ].join(' '),
    input: z.object({
      businessId,
      report: z.enum(REPORTS),
      startDate: date.optional(),
      endDate: date.optional().describe('Period end; also the as-of date for balance_sheet, trial_balance, account_balances, aged_payables'),
      source: z.enum(['auto', 'ledger', 'api']).default('auto').describe('auto: imported ledger when available for this report, else the live API'),
      account: z.string().optional().describe('account_transactions: account name (exact, else contains)'),
      accountId: z.string().optional().describe('account_transactions: Wave account ID'),
      fiscalYearStart: z.string().regex(/^\d{2}-\d{2}$/).default('01-01').describe('balance_sheet: fiscal year start MM-DD, splits retained earnings from current-year profit'),
      customerId: z.string().optional().describe('Required for customer_statement; filters invoice-based reports'),
      outstandingOnly: z.boolean().default(true).describe('customer_statement: only invoices with an amount due'),
      includeZeroBalances: z.boolean().default(false).describe('account_balances: include accounts with a zero balance'),
      includeArchivedAccounts: z.boolean().default(false),
      ...window,
    }),
    handler: async (args) => runReport(ctx, args),
  });
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function runLedgerReport(ctx, args, bid, ledger) {
  const { report, limit, offset } = args;
  const endDate = args.endDate || localToday();
  const startDate = args.startDate || `${endDate.slice(0, 4)}-01-01`;
  if (startDate > endDate) throw new WaveError(`startDate ${startDate} is after endDate ${endDate}.`, { code: 'BAD_INPUT' });
  const meta = ledgerMeta(ledger);
  const warnings = [unclassifiedWarning(ledger), endDate > ledger.stats.lastDate ? `The ledger's last transaction is on ${ledger.stats.lastDate}; anything after that is not in this import.` : undefined].filter(Boolean);
  const head = { report, business: ledger.business || (bid ? { id: bid } : undefined), ledger: meta, ...(warnings.length ? { warnings } : {}) };
  const finish = (r, extra = {}) => {
    if (r.error) throw new WaveError(`${report}: ${r.error}`, { code: 'LEDGER_INCOMPLETE' });
    const { rows, ...body } = r;
    return shape(plain({ ...head, ...body, ...(rows ? windowRows(rows, { offset, limit }) : {}), ...extra }), 'full');
  };
  switch (report) {
    case 'profit_and_loss':
      return finish(ledgerProfitAndLoss(ledger, { startDate, endDate }));
    case 'balance_sheet':
      return finish(ledgerBalanceSheet(ledger, { asOf: endDate, fiscalYearStart: args.fiscalYearStart }));
    case 'cash_flow':
      return finish(ledgerCashFlow(ledger, { startDate, endDate }), { basis: 'Direct method from Cash and Bank / Money in Transit accounts; line grouping is this server\'s, by counterpart account type.' });
    case 'trial_balance':
      return finish(ledgerTrialBalance(ledger, { asOf: endDate }));
    case 'account_balances':
      return finish(ledgerAccountBalances(ledger, { asOf: endDate, includeZero: args.includeZeroBalances }));
    case 'sales_tax':
      return finish(ledgerSalesTax(ledger, { startDate, endDate }), { note: 'Taxable amounts are the income/expense lines of transactions that carry tax, so they overstate when a transaction mixes taxable and untaxed lines.' });
    case 'aged_payables':
      return finish(ledgerAgedPayables(ledger, { asOf: endDate }));
    case 'purchases_by_vendor':
      return finish(ledgerPurchasesByVendor(ledger, { startDate, endDate }));
    case 'account_transactions':
    case 'general_ledger': {
      const idx = matchAccounts(ledger, args);
      if (!idx) throw new WaveError(`${report} needs account (name) or accountId; wave_list_ledger_accounts lists them.`, { code: 'BAD_INPUT' });
      if (idx.length > 5) throw new WaveError(`"${args.account}" matches ${idx.length} accounts (${idx.slice(0, 8).map((i) => ledger.accounts[i].name).join(', ')}); be more specific.`, { code: 'BAD_INPUT' });
      const sections = ledgerAccountTransactions(ledger, { accountIdx: idx, startDate, endDate });
      if (sections.length === 1) {
        const { rows, ...summary } = sections[0];
        return finish({ period: { startDate, endDate }, ...summary, rows });
      }
      const rows = sections.flatMap((s) => s.rows.map((r) => ({ account: s.account, ...r })));
      return finish({ period: { startDate, endDate }, accounts: sections.map(({ rows: _r, ...s }) => s), rows });
    }
    default:
      throw new WaveUnsupportedError(`${report} is not computed from the ledger.`);
  }
}

async function runReport(ctx, args) {
  const { report, customerId, limit, offset } = args;
  if (LIMITATIONS.unsupportedReports[report]) throw new WaveUnsupportedError(`${report}: ${LIMITATIONS.unsupportedReports[report]}`);
  if (LEDGER_REPORTS.has(report) && args.source !== 'api') {
    const lbid = await ledgerBusinessId(ctx, args.businessId);
    const ledger = ctx.ledgers.load(lbid);
    if (ledger) return runLedgerReport(ctx, args, lbid, ledger);
    if (args.source === 'ledger' || LIMITATIONS.ledgerOnlyReports[report]) {
      throw new WaveUnsupportedError(
        `${report} needs the transaction ledger, which Wave's public API does not expose. Import Wave's Data Export first: Settings → Data Export → Accounting (CSV), then wave_import_ledger with the downloaded file's path.`,
      );
    }
  } else if (args.source === 'ledger') {
    throw new WaveUnsupportedError(`${report} is computed live from the API, not from the ledger. Use source="auto".`);
  }
  const bid = await ctx.resolveBusinessId(args.businessId);
  const biz = await businessInfo(ctx, bid);
  const asOf = todayIn(biz.timezone);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const startDate = args.startDate || yearStart;
  const endDate = args.endDate || asOf;
  const head = { report, business: { id: bid, name: biz.name, currency: biz.currency } };
  const finish = (body, rows, extra = {}) => {
    const page = rows ? windowRows(plain(rows), { offset, limit }) : {};
    return shape(plain({ ...head, ...body, ...page, ...extra }), 'full');
  };

  if (['profit_and_loss', 'balance_sheet', 'trial_balance', 'account_balances'].includes(report)) {
    const scan = await scanAccounts(ctx, bid, args.includeArchivedAccounts);
    const basis = {
      basis: 'current account balances',
      asOf,
      caveat:
        "Wave's API exposes each account's balance as of now only, so this cannot be run for a past date or a date range. Income and expense figures cover whatever period Wave accumulates in those balances; compare with Wave's own report before relying on them. For dated reports, import the Data Export with wave_import_ledger.",
    };
    if (report === 'account_balances') {
      const r = accountBalances(scan.nodes, { includeZero: args.includeZeroBalances });
      return finish({ ...basis, totalsByType: r.totals }, r.rows, coverage(scan));
    }
    if (report === 'trial_balance') {
      const r = trialBalance(scan.nodes);
      return finish({ ...basis, totals: r.totals }, r.rows, coverage(scan));
    }
    if (report === 'balance_sheet') return finish({ ...basis, ...balanceSheet(scan.nodes) }, null, coverage(scan));
    const pl = profitAndLoss(scan.nodes);
    const out = { ...basis, ...pl };
    if (args.startDate || args.endDate) {
      const inv = await scanInvoices(ctx, bid, { invoiceDateStart: startDate, invoiceDateEnd: endDate });
      const sales = incomeByCustomer({ invoices: inv.nodes, payments: [], businessCurrency: biz.currency });
      out.invoicedSalesInPeriod = { startDate, endDate, invoiced: sales.totals.invoiced, note: 'Invoice totals by invoice date (sales only; expenses by period are not available through the API).', ...coverage(inv) };
    }
    return finish(out, null, coverage(scan));
  }

  if (report === 'aged_receivables') {
    const inv = await scanInvoices(ctx, bid, { customerId }, { outstandingOnly: true });
    const r = agedReceivables(inv.nodes, { asOf, businessCurrency: biz.currency });
    return finish({ asOf, buckets: 'days past due date', openInvoices: r.openInvoices, totals: r.totals }, r.rows, coverage(inv));
  }

  if (report === 'customer_statement') {
    if (!customerId) throw new WaveError('customer_statement needs customerId (see wave_list_customers).', { code: 'BAD_INPUT' });
    const inv = await scanInvoices(ctx, bid, { customerId }, { outstandingOnly: args.outstandingOnly });
    const r = customerStatement(inv.nodes, { asOf, businessCurrency: biz.currency, startDate, endDate, outstandingOnly: args.outstandingOnly });
    const customer = inv.nodes[0]?.customer || { id: customerId };
    return finish({ customer, asOf, ...(args.outstandingOnly ? { scope: 'outstanding invoices' } : { period: { startDate, endDate } }), totals: r.totals }, r.rows, coverage(inv));
  }

  const inv = await scanInvoices(ctx, bid, { invoiceDateStart: startDate, invoiceDateEnd: endDate, customerId });
  const period = { startDate, endDate, basis: 'invoice date; drafts excluded' };
  if (report === 'income_by_customer') {
    const payScan = await scanInvoices(ctx, bid, { modifiedAtAfter: modifiedSince(startDate), customerId });
    const payments = paymentRows({ invoices: payScan.nodes, startDate, endDate, customerId, kind: 'invoice' });
    const r = incomeByCustomer({ invoices: inv.nodes, payments, businessCurrency: biz.currency });
    return finish({ period, columns: { invoiced: 'invoice totals dated in the period', paid: 'invoice payments dated in the period' }, totals: r.totals }, r.rows, coverage(inv, payScan));
  }
  if (report === 'sales_by_product') {
    const r = salesByProduct(inv.nodes, { businessCurrency: biz.currency });
    return finish({ period, note: 'Line subtotals before tax; invoice-level discounts are not allocated to products.', totals: r.totals }, r.rows, coverage(inv));
  }
  if (report === 'sales_tax') {
    const r = salesTaxReport(inv.nodes, { businessCurrency: biz.currency });
    return finish({ period, note: 'Tax collected on invoices only. Tax paid on purchases is not available through the API.', totals: r.totals }, r.rows, coverage(inv));
  }
  if (report === 'invoice_summary') {
    const r = invoiceSummary(inv.nodes, { asOf, businessCurrency: biz.currency });
    return finish({ period, invoiceCount: r.invoiceCount, overdueCount: r.overdueCount, totals: r.totals }, r.rows, coverage(inv));
  }
  throw new WaveUnsupportedError(`Unknown report ${report}.`);
}
