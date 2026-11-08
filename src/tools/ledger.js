import * as z from 'zod';
import { WaveError } from '../wave/errors.js';
import { paginateArray } from '../format.js';
import { READ, businessId, date, defineTool, page, pageSize } from './common.js';
import { importLedger, ledgerMeta, requireLedger } from '../ledger/import.js';
import { describeTransaction, filterTransactions, groupTransactions } from '../ledger/compute.js';

/** Imports only write a local file; Wave is untouched, so read-only mode keeps this. */
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** Resolve account filters (IDs or names, case-insensitive substring) to ledger indexes. */
export function matchAccounts(ledger, { accountId, account }) {
  if (!accountId && !account) return null;
  const want = (account || '').toLowerCase();
  const idx = [];
  ledger.accounts.forEach((a, i) => {
    if (accountId && a.id === accountId) idx.push(i);
    else if (want && a.name.toLowerCase() === want) idx.push(i);
  });
  if (!idx.length && want) ledger.accounts.forEach((a, i) => a.name.toLowerCase().includes(want) && idx.push(i));
  if (!idx.length) {
    const names = ledger.accounts.map((a) => a.name).slice(0, 30).join(', ');
    throw new WaveError(`No account in the imported ledger matches ${accountId || `"${account}"`}. Accounts include: ${names}.`, { code: 'NOT_FOUND' });
  }
  return idx;
}

export function registerLedgerTools(server, ctx) {
  defineTool(server, ctx, {
    name: 'wave_import_ledger',
    title: 'Import transactions from a Wave Data Export',
    toolset: 'ledger',
    annotations: LOCAL_WRITE,
    local: true,
    description: [
      "Load the full transaction journal from Wave's Data Export so transactions can be listed and date-range reports run. Wave's public API cannot read transactions; this is the supported way to get them.",
      'Get the file: Wave → Settings → Data Export → Accounting (CSV) → Export; Wave emails a download link (valid 24 hours).',
      'Pass the path of the downloaded .zip (or the accounting .csv inside it) on the machine running this server. Replaces any earlier import for the business. Nothing is sent to Wave; the ledger is stored locally (mode 600).',
    ].join(' '),
    input: z.object({
      path: z.string().min(1).describe('Absolute path to the Data Export .zip or its accounting .csv'),
      businessId,
    }),
    handler: async ({ path, businessId: b }) => importLedger(ctx, path, { businessId: b }),
  });

  defineTool(server, ctx, {
    name: 'wave_list_ledger_transactions',
    title: 'List ledger transactions',
    toolset: 'ledger',
    annotations: READ,
    description: [
      'List and search transactions from an imported Data Export snapshot (wave_import_ledger). For live data use wave_list_transactions; this works offline and includes invoices, bills and journal entries: bank and card transactions, expenses, invoices, bills, payments, transfers and journal entries.',
      'Filter by date range, account (ID or name), text, customer, vendor, amount, direction or uncategorized only. Newest first by default.',
      'Each row has the amount on the bank/card account (or the journal total), the categories used, and the transaction ID for wave_get_ledger_transaction.',
    ].join(' '),
    input: z.object({
      businessId,
      startDate: date.optional(),
      endDate: date.optional(),
      accountId: z.string().optional().describe('Only transactions touching this account (Wave account ID)'),
      account: z.string().optional().describe('Only transactions touching this account, by name (exact, else contains)'),
      query: z.string().optional().describe('Text in descriptions, notes, customer, vendor, invoice/bill number or account name'),
      customer: z.string().optional(),
      vendor: z.string().optional(),
      direction: z.enum(['any', 'deposit', 'withdrawal', 'transfer', 'journal']).default('any'),
      minAmount: z.number().nonnegative().optional(),
      maxAmount: z.number().nonnegative().optional(),
      uncategorizedOnly: z.boolean().default(false).describe('Only transactions using Uncategorized Income/Expense'),
      sort: z.enum(['date_desc', 'date_asc', 'amount_desc']).default('date_desc'),
      page,
      pageSize: pageSize(100, 20),
    }),
    handler: async (args) => {
      const { ledger } = await requireLedger(ctx, args.businessId);
      const accountIdx = matchAccounts(ledger, args);
      const txs = filterTransactions(ledger, groupTransactions(ledger), { ...args, accountIdx });
      const rows = txs.map((t) => describeTransaction(ledger, t));
      const cmp = {
        date_desc: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0),
        date_asc: (a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0),
        amount_desc: (a, b) => Number(b.amount) - Number(a.amount),
      }[args.sort];
      rows.sort(cmp);
      const totals = rows.reduce(
        (s, r) => {
          const c = Math.round(Number(r.amount) * 100);
          if (r.direction === 'deposit') s.deposits += c;
          else if (r.direction === 'withdrawal') s.withdrawals += c;
          return s;
        },
        { deposits: 0, withdrawals: 0 },
      );
      return {
        ledger: ledgerMeta(ledger),
        filters: Object.fromEntries(Object.entries({ startDate: args.startDate, endDate: args.endDate, account: args.account || args.accountId, query: args.query }).filter(([, v]) => v)),
        totals: { transactions: rows.length, deposits: (totals.deposits / 100).toFixed(2), withdrawals: (totals.withdrawals / 100).toFixed(2) },
        ...paginateArray(rows, { page: args.page, pageSize: args.pageSize }),
      };
    },
  });

  defineTool(server, ctx, {
    name: 'wave_get_ledger_transaction',
    title: 'Get ledger transaction',
    toolset: 'ledger',
    annotations: READ,
    description: 'One transaction from the imported ledger with every journal line (account, debit, credit, line description, sales tax). IDs come from wave_list_ledger_transactions.',
    input: z.object({ businessId, transactionId: z.string().min(1) }),
    handler: async ({ businessId: b, transactionId }) => {
      const { ledger } = await requireLedger(ctx, b);
      const lines = ledger.lines.filter((l) => l.t === transactionId);
      if (!lines.length) throw new WaveError(`Transaction ${transactionId} is not in the imported ledger (covers ${ledger.stats.firstDate} to ${ledger.stats.lastDate}).`, { code: 'NOT_FOUND' });
      const [tx] = groupTransactions({ ...ledger, lines });
      return { ledger: ledgerMeta(ledger), transaction: describeTransaction(ledger, tx, { full: true }) };
    },
  });

  defineTool(server, ctx, {
    name: 'wave_list_ledger_accounts',
    title: 'List ledger accounts',
    toolset: 'ledger',
    annotations: READ,
    description: 'Accounts that appear in the imported ledger, with their type, where the type came from (Wave chart of accounts or export labels) and line counts. Use the names or IDs to filter wave_list_ledger_transactions and account_transactions reports.',
    input: z.object({ businessId, page, pageSize: pageSize(200, 50) }),
    handler: async ({ businessId: b, page, pageSize }) => {
      const { ledger } = await requireLedger(ctx, b);
      const counts = new Map();
      for (const l of ledger.lines) counts.set(l.a, (counts.get(l.a) || 0) + 1);
      const rows = ledger.accounts.map((a, i) => ({ name: a.name, ...(a.id ? { id: a.id } : {}), type: a.type || 'UNCLASSIFIED', subtype: a.subtypeName, typeSource: a.source || 'unknown', lines: counts.get(i) || 0 }));
      return { ledger: { ...ledgerMeta(ledger), stats: ledger.stats, warnings: ledger.warnings }, ...paginateArray(rows, { page, pageSize }) };
    },
  });
}
