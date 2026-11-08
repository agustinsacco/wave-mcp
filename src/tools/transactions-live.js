import * as z from 'zod';
import { IOPS } from '../wave/internal-operations.js';
import { WaveApiError, WaveError, WaveInputError, describeInternalInputErrors } from '../wave/errors.js';
import { fromMinor, shape, toMinor } from '../format.js';
import { HOST, cli } from '../cli.js';
import { DELETE, READ, UPDATE, businessId, date, defineTool, defined, detail, positiveAmount } from './common.js';
import { accountSides } from './transactions.js';

/**
 * Transactions through Wave's web-app API (unofficial, needs "wave-mcp
 * login"). The public API can only create transactions; listing, reading,
 * editing and deleting them use the same calls as next.waveapps.com.
 */
const VIA = `Uses Wave's web-app API (unofficial), which needs a web session: if it is missing or expired, the user runs ${cli('login')} in a terminal on ${HOST}.`;
// Wave also has DATE_CREATED_ASC/DESC, but its cursors repeat rows under those
// sorts (verified live: 106 unique rows in 1500), so only date sorts are offered.
const SORT = { date_desc: 'DATE_DESC', date_asc: 'DATE_ASC' };
const money = (v) => (v === null || v === undefined || v === '' ? undefined : fromMinor(toMinor(v)));

function lineDetail(l) {
  if (!l) return undefined;
  const taxes = (l.taxSummary?.taxLiabilities || []).map((t) => ({
    tax: t.salesTax?.abbreviation || t.salesTax?.name,
    salesTaxId: t.salesTax?.id,
    amount: money(t.amount),
    ...(t.isTaxAmountManuallySet ? { manual: true } : {}),
  }));
  return {
    order: l.order,
    account: l.account?.name,
    accountId: l.account?.id,
    side: l.itemType?.toLowerCase(),
    amount: money(l.amount),
    description: l.description || undefined,
    salesTax: taxes.length ? taxes : undefined,
    vendor: l.vendor || undefined,
    customer: l.customer || undefined,
    tags: l.tags?.length ? l.tags.map((t) => t.name) : undefined,
    reconciled: l.isReconciled || undefined,
  };
}

export function summarizeTransaction(tx, { full = false } = {}) {
  const lines = tx.lineItems || [];
  const taxMinor = lines.reduce((s, l) => s + toMinor(l.taxSummary?.totalTaxAmount), 0);
  const out = {
    id: tx.id,
    date: tx.date,
    description: tx.description,
    amount: money(tx.amount),
    direction: tx.direction?.toLowerCase(),
    ...(tx.anchorLineItem ? {} : { journalEntry: true }),
    account: tx.anchorLineItem?.account?.name,
    ...(lines.length === 1 ? { category: lines[0].account?.name } : { categories: lines.map((l) => ({ account: l.account?.name, amount: money(l.amount) })) }),
    vendor: lines.find((l) => l.vendor)?.vendor?.name,
    customer: lines.find((l) => l.customer)?.customer?.name,
    salesTax: taxMinor ? fromMinor(taxMinor) : undefined,
    verified: tx.verificationStatus === 'VERIFIED',
    notes: tx.notes || undefined,
    source: tx.origin?.type,
    ...(tx.active === false ? { deleted: true } : {}),
  };
  if (!full) return out;
  return {
    ...out,
    sequence: tx.sequence,
    currency: tx.currency?.code,
    dateCreated: tx.dateCreated,
    missingFields: tx.missingFields?.length ? tx.missingFields : undefined,
    attachment: tx.attachment || undefined,
    anchor: lineDetail(tx.anchorLineItem),
    lines: lines.map(lineDetail),
    ...(tx.detailActions ? { editable: Object.entries(tx.detailActions).filter(([, v]) => v === true).map(([k]) => k) } : {}),
  };
}

async function fetchTransaction(ctx, bid, id) {
  const data = await ctx.internal.request(IOPS.GetTransaction, { businessId: bid, transactionId: id });
  if (!data.business) throw new WaveError(`Business ${bid} was not found.`, { code: 'NOT_FOUND' });
  const tx = data.business.transaction;
  if (!tx) throw new WaveError(`Transaction ${id} was not found in this business. wave_list_transactions returns valid IDs.`, { code: 'NOT_FOUND' });
  if (tx.active === false) throw new WaveError(`Transaction ${id} ("${tx.description}") has been deleted.`, { code: 'NOT_FOUND' });
  return tx;
}

async function uncategorizedIds(ctx, bid) {
  return ctx.cache.get(`uncat:${bid}`, async () => {
    const data = await ctx.internal.request(IOPS.UncategorizedAccounts, { businessId: bid });
    return (data.business?.accounts?.edges || []).map((e) => e.node.id);
  });
}

/** Run a patch/delete and translate the web-app API's failure shapes. */
async function write(ctx, query, input, field) {
  let data;
  try {
    data = await ctx.internal.request(query, { input }, { keepNulls: true });
  } catch (error) {
    if (error instanceof WaveApiError && /stale transaction sequence/i.test(error.message)) {
      throw new WaveError('The transaction changed since it was read (probably edited in Wave). Read it again with wave_get_transaction and retry.', { code: 'STALE' });
    }
    throw error;
  }
  const payload = data[field];
  if (!payload) throw new WaveError(`Wave returned no result for ${field}.`, { code: 'BAD_RESPONSE' });
  if (!payload.didSucceed) {
    throw new WaveInputError(`Wave rejected the change: ${describeInternalInputErrors(payload.inputErrors)}`, { inputErrors: payload.inputErrors || [] });
  }
  return payload;
}

const category = (accountId) => ({ type: 'ACCOUNT_ID', accountId });
const hasTax = (l) => (l?.taxSummary?.taxLiabilities || []).length > 0;
const hasManualTax = (l) => (l?.taxSummary?.taxLiabilities || []).some((t) => t.isTaxAmountManuallySet);

/**
 * Turn requested taxes [{ salesTaxId, amount? }] into the web app's
 * taxLiabilities [{ accountId, amount? }] by asking Wave for the sales tax
 * summary of the line, exactly as the web app does. An omitted amount lets
 * Wave calculate it (line amounts include tax). Returns { input, preview }.
 */
export async function resolveSalesTax(ctx, bid, { date: txDate, currency, lineAmount, requested }) {
  if (!requested.length) return { input: [], preview: [] };
  const fixed = (t) => (t.amount !== undefined ? fromMinor(toMinor(t.amount)) : undefined);
  const data = await ctx.internal.request(IOPS.SalesTaxSummary, {
    businessId: bid,
    input: {
      transactionDate: txDate,
      lineItemAmount: fromMinor(toMinor(lineAmount)),
      lineItemCurrencyCode: currency,
      appliedTaxes: requested.map((t, i) => defined({ order: i, salesTaxId: t.salesTaxId, amount: fixed(t) })),
    },
  });
  const summary = data.business?.salesTaxSummary;
  if (!summary || summary.taxCalculationErrored) {
    throw new WaveError('Wave could not calculate sales tax for this line. Check the salesTaxId values (wave_list_sales_taxes) and that the tax is not archived.', { code: 'BAD_INPUT' });
  }
  const byOrder = new Map((summary.appliedTaxes || []).map((a) => [a.order, a]));
  const input = [];
  const preview = [];
  requested.forEach((t, i) => {
    const applied = byOrder.get(i);
    if (!applied?.account?.id) throw new WaveError(`Sales tax ${t.salesTaxId} is not available in this business (wave_list_sales_taxes lists valid IDs).`, { code: 'BAD_INPUT' });
    input.push(defined({ accountId: applied.account.id, amount: fixed(t) }));
    preview.push({ tax: applied.salesTax?.abbreviation || applied.salesTax?.name, amount: money(applied.amount), ...(t.amount !== undefined ? { manual: true } : {}) });
  });
  return { input, preview };
}

/**
 * Build a TransactionPatchInput from the current transaction and the
 * requested changes, the way the web app does. Returns { input, changed,
 * warnings }. Throws WaveError on requests Wave would reject or refuse.
 */
export function buildPatch(tx, args, taxes = {}) {
  const anchor = tx.anchorLineItem;
  const current = tx.lineItems || [];
  const can = tx.detailActions || {};
  const changed = [];
  const warnings = [];
  const input = { id: tx.id, sequence: tx.sequence };
  const refuse = (what, flag) => {
    if (can[flag] === false) throw new WaveError(`Wave does not allow changing the ${what} of this transaction (for example it came from a bank feed, a payment or payroll, or is reconciled).`, { code: 'NOT_EDITABLE' });
  };

  if (args.date !== undefined) (refuse('date', 'date'), (input.date = args.date), changed.push('date'));
  if (args.description !== undefined) (refuse('description', 'description'), (input.description = args.description), changed.push('description'));
  if (args.notes !== undefined) (refuse('notes', 'notes'), (input.notes = args.notes), changed.push('notes'));
  if (args.verified !== undefined) (refuse('review status', 'verificationStatus'), (input.verificationStatus = args.verified ? 'VERIFIED' : 'NOT_VERIFIED'), changed.push('verified'));

  const newTotal = args.amount !== undefined ? toMinor(args.amount) : undefined;
  if (!anchor && (args.accountId !== undefined || newTotal !== undefined)) {
    throw new WaveError(
      'This is a journal entry: it has no bank/card side, so there is no accountId or amount to set. Change its lines instead (lines with side debit/credit; debits must equal credits).',
      { code: 'BAD_INPUT' },
    );
  }
  if (args.accountId !== undefined || newTotal !== undefined) {
    if (args.accountId !== undefined) refuse('bank/card account', 'account');
    if (newTotal !== undefined) refuse('amount', 'amount');
    input.anchorLineItem = { order: anchor.order, itemType: anchor.itemType, amount: fromMinor(newTotal ?? toMinor(anchor.amount)), category: category(args.accountId ?? anchor.account.id) };
    if (args.accountId !== undefined) changed.push('account');
    if (newTotal !== undefined) changed.push('amount');
  }

  const singleLineEdit =
    args.categoryId !== undefined || args.vendorId !== undefined || args.customerId !== undefined || args.lineDescription !== undefined || args.salesTax !== undefined;
  let lines;
  if (args.lines && singleLineEdit) {
    throw new WaveError('Pass either lines or the single-line fields (categoryId, vendorId, customerId, lineDescription, salesTax), not both: put those values on the entries in lines.', { code: 'BAD_INPUT' });
  }
  if (args.lines) {
    refuse('category lines', 'lineItems');
    const byOrder = new Map(current.map((l) => [l.order, l]));
    const seen = new Set();
    const newSide = anchor ? (anchor.itemType === 'CREDIT' ? 'DEBIT' : 'CREDIT') : undefined;
    const defaultTaxAction = anchor ? current[0]?.taxAction || (tx.direction === 'DEPOSIT' ? 'COLLECTION' : 'PAYMENT') : (current[0]?.taxAction ?? null);
    lines = args.lines.map((l, i) => {
      if (l.order !== undefined) {
        const old = byOrder.get(l.order);
        if (!old) throw new WaveError(`lines[${i}].order ${l.order} is not a line of this transaction (lines: ${[...byOrder.keys()].join(', ')}). Omit order to add a new line.`, { code: 'BAD_INPUT' });
        if (seen.has(l.order)) throw new WaveError(`Line order ${l.order} is listed twice.`, { code: 'BAD_INPUT' });
        seen.add(l.order);
        if (l.salesTax === undefined && hasManualTax(old) && toMinor(l.amount) !== toMinor(old.amount)) {
          warnings.push(`Line ${l.order} (${old.account?.name}) keeps its manually set sales tax; pass salesTax on that line to recalculate it.`);
        }
        return defined({ order: l.order, itemType: l.side ? l.side.toUpperCase() : old.itemType, taxAction: old.taxAction, amount: fromMinor(toMinor(l.amount)), description: l.description, category: category(l.accountId), vendorId: l.vendorId, customerId: l.customerId, taxLiabilities: taxes.lines?.[i] });
      }
      if (!l.side && !newSide) throw new WaveError(`lines[${i}] is a new line on a journal entry: give it a side (debit or credit).`, { code: 'BAD_INPUT' });
      return defined({ itemType: l.side ? l.side.toUpperCase() : newSide, taxAction: defaultTaxAction, amount: fromMinor(toMinor(l.amount)), description: l.description, category: category(l.accountId), vendorId: l.vendorId, customerId: l.customerId, taxLiabilities: taxes.lines?.[i] });
    });
    const removed = current.filter((l) => !seen.has(l.order));
    if (removed.length) warnings.push(`Removed ${removed.length} line(s): ${removed.map((l) => `${l.order} ${l.account?.name} ${money(l.amount)}`).join('; ')}.`);
    changed.push('lines');
  } else if (singleLineEdit || (newTotal !== undefined && current.length)) {
    if (current.length !== 1) {
      throw new WaveError(
        `This ${anchor ? 'transaction' : 'journal entry'} has ${current.length} ${anchor ? 'category ' : ''}lines. Pass "lines" with every line you want to keep (use the order numbers from wave_get_transaction${anchor ? '' : ', and keep debits equal to credits'}).`,
        { code: 'BAD_INPUT' },
      );
    }
    const only = current[0];
    if (args.categoryId !== undefined) refuse('category', 'category');
    if (args.salesTax !== undefined) refuse('sales tax', 'salesTax');
    if (newTotal !== undefined && args.salesTax === undefined && hasTax(only)) {
      warnings.push(
        hasManualTax(only)
          ? `The line's sales tax (${money(only.taxSummary.totalTaxAmount)}) was set manually, so Wave keeps it as is; pass salesTax (without amounts) to recalculate it for the new amount.`
          : 'Wave recalculates the sales tax for the new amount.',
      );
    }
    lines = [
      defined({
        order: only.order,
        itemType: only.itemType,
        taxAction: only.taxAction,
        amount: newTotal !== undefined ? fromMinor(newTotal) : undefined,
        description: args.lineDescription,
        category: args.categoryId !== undefined ? category(args.categoryId) : undefined,
        vendorId: args.vendorId,
        customerId: args.customerId,
        taxLiabilities: taxes.single,
      }),
    ];
    if (args.categoryId !== undefined) changed.push('category');
    if (args.vendorId !== undefined) changed.push('vendor');
    if (args.customerId !== undefined) changed.push('customer');
    if (args.lineDescription !== undefined) changed.push('lineDescription');
    if (args.salesTax !== undefined) changed.push('salesTax');
  }

  if (lines && !anchor) {
    input.lineItems = lines;
    const side = (s) => lines.filter((l) => l.itemType === s).reduce((t, l) => t + toMinor(l.amount), 0);
    if (side('DEBIT') !== side('CREDIT')) {
      throw new WaveError(`Debits total ${fromMinor(side('DEBIT'))} but credits total ${fromMinor(side('CREDIT'))} (difference ${fromMinor(side('DEBIT') - side('CREDIT'))}); a journal entry must balance.`, { code: 'UNBALANCED' });
    }
  } else if (lines) {
    input.lineItems = lines;
    const total = newTotal ?? toMinor(anchor.amount);
    const amountOf = (l) => (l.amount !== undefined ? toMinor(l.amount) : toMinor(current.find((c) => c.order === l.order)?.amount));
    const sum = lines.reduce((s, l) => s + (l.itemType !== anchor.itemType ? 1 : -1) * amountOf(l), 0);
    if (sum !== total) {
      throw new WaveError(
        `The lines total ${fromMinor(sum)} but the transaction amount is ${fromMinor(total)} (difference ${fromMinor(sum - total)}). Line amounts include their sales tax. Pass amount=${fromMinor(sum)} to change the total, or adjust the lines.`,
        { code: 'UNBALANCED' },
      );
    }
  }
  if (!changed.length) throw new WaveError('Nothing to change: pass at least one of date, description, notes, verified, accountId, amount, categoryId, vendorId, customerId, lineDescription, salesTax or lines.', { code: 'BAD_INPUT' });
  return { input, changed, warnings };
}

const optionalId = (what) => z.string().min(1).nullable().optional().describe(`${what} ID; null clears it`);
const salesTaxInput = z
  .array(z.object({ salesTaxId: z.string().min(1).describe('From wave_list_sales_taxes'), amount: positiveAmount.optional().describe('Omit to let Wave calculate it from the rate') }))
  .max(5)
  .optional()
  .describe('Replace the sales taxes on this line ([] removes them). Line amounts include tax. Omitted: unchanged; Wave recalculates taxes it calculated itself when the amount changes, but keeps manually set ones');


/**
 * Wave filters from tool arguments. accountId matches only the bank/card side
 * of a transaction, so an income or expense category passed as accountId is
 * moved to categoryIds (with a note) instead of silently matching nothing.
 */
async function buildFilters(ctx, bid, args) {
  const notes = [];
  const categoryIds = [...(args.categoryIds || [])];
  let anchorId = args.accountId;
  if (anchorId) {
    const info = (await accountSides(ctx, bid)).get(anchorId);
    if (info && (info.type === 'INCOME' || info.type === 'EXPENSE')) {
      categoryIds.push(anchorId);
      anchorId = undefined;
      notes.push(`accountId ${info.name} is a${info.type === 'INCOME' ? 'n income' : 'n expense'} category, so it was used as categoryIds (accountId is for bank and card accounts).`);
    }
  }
  const filters = defined({ startDate: args.startDate, endDate: args.endDate, description: args.search, anchorId, originType: args.source, transactionIds: args.transactionIds });
  if (args.uncategorizedOnly) categoryIds.push(...(await uncategorizedIds(ctx, bid)));
  if (categoryIds.length) filters.categoryIds = [...new Set(categoryIds)];
  return { filters, notes };
}

async function listPage(ctx, bid, filters, { first, after, sort }) {
  const data = await ctx.internal.request(IOPS.ListTransactions, { businessId: bid, filters, first, after, sort: [SORT[sort]] });
  if (!data.business) throw new WaveError(`Business ${bid} was not found.`, { code: 'NOT_FOUND' });
  return data.business.transactions;
}

/** Shared filter arguments of wave_list_transactions and wave_summarize_transactions. */
const FILTERS = {
  startDate: date.optional().describe('Earliest transaction date (inclusive)'),
  endDate: date.optional().describe('Latest transaction date (inclusive)'),
  search: z.string().min(1).optional().describe('Text in the transaction description or a line description (case-insensitive)'),
  accountId: z.string().min(1).optional().describe('Bank or card account (wave_list_accounts): transactions paid from or into it. An income/expense category given here is treated as categoryIds'),
  categoryIds: z.array(z.string().min(1)).max(50).optional().describe('Category accounts (income/expense, wave_list_accounts with search): transactions with a line in any of them'),
  uncategorizedOnly: z.boolean().default(false).describe('Only transactions still in Uncategorized Income/Expense'),
  source: z
    .enum(['MANUAL', 'PLAID', 'YODLEE', 'CASHEDGE', 'GENERIC_EXTERNAL_API', 'RECEIPT', 'RECEIPT_CAPTURE', 'SHOPIFY', 'STRIPE', 'PAYPAL', 'ETSY', 'SHOEBOXED', 'ZAPIER', 'DIRECT_PAYMENT', 'WAVE_CHECKOUT', 'WAVE_PAYMENTS', 'WAVE_PAYROLL'])
    .optional()
    .describe('Where it came from: MANUAL = statement upload; PLAID/YODLEE/CASHEDGE = bank connection; GENERIC_EXTERNAL_API = API (wave_create_transaction); RECEIPT/RECEIPT_CAPTURE = receipts. Entries typed into Wave have no source'),
};

export function registerLiveTransactionTools(server, ctx) {
  defineTool(server, ctx, {
    name: 'wave_list_transactions',
    title: 'List transactions',
    toolset: 'transactions',
    annotations: { ...READ, openWorldHint: true },
    description: [
      "List and search the business's transactions as Wave's Transactions page shows them: bank and card transactions, expenses, deposits, transfers, bill and invoice payments. Live data.",
      'Filter by date range, text in the description, bank/card account (accountId), category accounts (categoryIds) or uncategorizedOnly. Cursor pagination: pass nextCursor back as cursor. For totals (spend per category, month, vendor or account) use wave_summarize_transactions instead of paging through rows.',
      'Each row has the amount, direction, bank/card account, category (or categories when split), vendor, sales tax and review status. IDs work with wave_get_transaction, wave_update_transaction and wave_delete_transaction.',
      VIA,
    ].join(' '),
    input: z.object({
      businessId,
      ...FILTERS,
      transactionIds: z.array(z.string().min(1)).max(100).optional(),
      sort: z.enum(['date_desc', 'date_asc']).default('date_desc').describe('By transaction date'),
      pageSize: z.number().int().min(1).max(100).default(25).describe('Rows per page (max 100)'),
      cursor: z.string().min(1).optional().describe('nextCursor from the previous page'),
      detail,
    }),
    handler: async (args) => {
      const bid = await ctx.resolveBusinessId(args.businessId);
      const { filters, notes } = await buildFilters(ctx, bid, args);
      const conn = await listPage(ctx, bid, filters, { first: args.pageSize, after: args.cursor, sort: args.sort });
      const edges = conn.edges;
      // Build the page from its first n rows. When the whole page would pass
      // the response cap, return fewer rows and point nextCursor at the last
      // row returned (every edge has a cursor), so following it skips nothing.
      const build = (n) => {
        const nodes = edges.slice(0, n).map((e) => e.node);
        const sum = (dir) => fromMinor(nodes.filter((t) => t.direction === dir).reduce((s, t) => s + toMinor(t.amount), 0));
        const cut = n < edges.length;
        const hasMore = cut || Boolean(conn.pageInfo?.hasNextPage);
        return {
          filters,
          ...(notes.length ? { notes } : {}),
          items: nodes.map((t) => shape(summarizeTransaction(t, { full: args.detail === 'full' }), args.detail)),
          count: nodes.length,
          pageTotals: { deposits: sum('DEPOSIT'), withdrawals: sum('WITHDRAWAL') },
          hasMore,
          ...(hasMore ? { nextCursor: cut ? edges[n - 1].cursor : conn.pageInfo.endCursor } : {}),
          ...(cut ? { shortened: `Returned ${n} of ${edges.length} rows to stay under the response size limit; nextCursor continues right after the last row, so nothing is skipped.` } : {}),
        };
      };
      const budget = ctx.config.maxResponseChars - 100;
      let n = edges.length;
      let out = build(n);
      for (let size = JSON.stringify(out).length; n > 1 && size > budget; size = JSON.stringify(out).length) {
        n = Math.max(1, Math.min(n - 1, Math.floor((n * budget) / size)));
        out = build(n);
      }
      return out;
    },
  });

  defineTool(server, ctx, {
    name: 'wave_summarize_transactions',
    title: 'Summarize transactions',
    toolset: 'transactions',
    annotations: { ...READ, openWorldHint: true },
    description: [
      'Totals over every matching transaction, grouped by category, month, vendor, customer or bank/card account: how much was spent on Marketing this year, spend per month, top vendors. Pages through Wave itself and returns only the totals, so use it instead of paging wave_list_transactions to add things up.',
      'Same filters as wave_list_transactions. Sums line amounts (which include sales tax): money-out lines (debits) are withdrawals, money-in lines (credits) are deposits; journal entries count by the same debit/credit rule. With categoryIds, only the lines in those categories count, so split transactions are not double counted.',
      VIA,
    ].join(' '),
    input: z.object({
      businessId,
      ...FILTERS,
      groupBy: z.enum(['category', 'month', 'vendor', 'customer', 'account', 'none']).default('category').describe('account = the bank/card account; none = totals only'),
      maxGroups: z.number().int().min(1).max(200).default(50).describe('Largest groups to return; the rest are added up in otherGroups'),
    }),
    handler: async (args) => {
      const bid = await ctx.resolveBusinessId(args.businessId);
      const { filters, notes } = await buildFilters(ctx, bid, args);
      const only = filters.categoryIds ? new Set(filters.categoryIds) : undefined;
      const keyOf = {
        category: (tx, l) => l.account?.name || '(no category)',
        month: (tx) => tx.date.slice(0, 7),
        vendor: (tx, l) => (l.vendor || tx.lineItems.find((x) => x.vendor)?.vendor)?.name || '(no vendor)',
        customer: (tx, l) => (l.customer || tx.lineItems.find((x) => x.customer)?.customer)?.name || '(no customer)',
        account: (tx) => tx.anchorLineItem?.account?.name || '(journal entry)',
        none: () => 'all',
      }[args.groupBy];
      const groups = new Map();
      const totals = new Map();
      const blank = () => ({ ids: new Set(), out: 0, in: 0, taxOut: 0, taxIn: 0 });
      const add = (g, tx, l) => {
        const minor = toMinor(l.amount);
        const tax = toMinor(l.taxSummary?.totalTaxAmount);
        g.ids.add(tx.id);
        if (l.itemType === 'CREDIT') (g.in += minor), (g.taxIn += tax);
        else (g.out += minor), (g.taxOut += tax);
      };
      let seen = 0, first, last, cursor, truncated = false;
      for (;;) {
        const conn = await listPage(ctx, bid, filters, { first: 100, after: cursor, sort: 'date_desc' });
        for (const { node: tx } of conn.edges) {
          seen++;
          first = first === undefined || tx.date < first ? tx.date : first;
          last = last === undefined || tx.date > last ? tx.date : last;
          const currency = tx.currency?.code || '';
          for (const l of tx.lineItems || []) {
            if (only && !only.has(l.account?.id)) continue;
            const key = `${currency}\u0000${keyOf(tx, l)}`;
            if (!groups.has(key)) groups.set(key, blank());
            if (!totals.has(currency)) totals.set(currency, blank());
            add(groups.get(key), tx, l);
            add(totals.get(currency), tx, l);
          }
        }
        if (!conn.pageInfo?.hasNextPage || !conn.edges.length) break;
        if (seen >= ctx.config.scanLimit) {
          truncated = true;
          break;
        }
        cursor = conn.pageInfo.endCursor;
      }
      const multi = totals.size > 1;
      const row = (g, extra) =>
        defined({
          ...extra,
          transactions: g.ids.size,
          withdrawals: fromMinor(g.out),
          deposits: fromMinor(g.in),
          net: fromMinor(g.in - g.out),
          salesTaxPaid: g.taxOut ? fromMinor(g.taxOut) : undefined,
          salesTaxCollected: g.taxIn ? fromMinor(g.taxIn) : undefined,
        });
      let rows = [...groups].map(([k, g]) => {
        const [currency, key] = k.split('\u0000');
        return { key, currency, g };
      });
      if (args.groupBy === 'month') rows.sort((a, b) => a.key.localeCompare(b.key));
      else rows.sort((a, b) => b.g.out + b.g.in - (a.g.out + a.g.in) || a.key.localeCompare(b.key));
      const kept = rows.slice(0, args.maxGroups);
      const rest = rows.slice(args.maxGroups);
      const other = rest.length ? rest.reduce((acc, r) => {
        r.g.ids.forEach((id) => acc.ids.add(id));
        acc.out += r.g.out; acc.in += r.g.in; acc.taxOut += r.g.taxOut; acc.taxIn += r.g.taxIn;
        return acc;
      }, blank()) : undefined;
      const totalRows = [...totals].map(([currency, g]) => row(g, { currency: currency || undefined }));
      if (multi) notes.push('Transactions are in more than one currency: totals are per currency and not converted.');
      if (!seen) notes.push('No transactions matched these filters.');
      return {
        filters,
        groupBy: args.groupBy,
        basis: 'Line amounts, which include sales tax: withdrawals are money-out (debit) lines, deposits money-in (credit) lines. salesTaxPaid / salesTaxCollected is the tax inside them, so the amount before tax is withdrawals minus salesTaxPaid.',
        matched: seen,
        ...(seen ? { dates: { from: first, to: last } } : {}),
        totals: multi ? totalRows : totalRows[0] || { transactions: 0, withdrawals: '0.00', deposits: '0.00', net: '0.00' },
        ...(args.groupBy === 'none' ? {} : { groups: kept.map((r) => row(r.g, { [args.groupBy]: r.key, ...(multi ? { currency: r.currency } : {}) })) }),
        ...(other ? { otherGroups: row(other, { groups: rest.length }) } : {}),
        ...(notes.length ? { notes } : {}),
        ...(truncated ? { truncated: `Stopped after ${seen} transactions (WAVE_MCP_SCAN_LIMIT). Narrow the dates or filters for complete totals.` } : {}),
      };
    },
  });

  defineTool(server, ctx, {
    name: 'wave_get_transaction',
    title: 'Get transaction',
    toolset: 'transactions',
    annotations: { ...READ, openWorldHint: true },
    description: `One transaction with every line: bank/card side (anchor), category lines with order numbers, amounts, sales tax, vendor/customer, tags, review status, its current sequence, and which fields Wave allows editing. ${VIA}`,
    input: z.object({ businessId, id: z.string().min(1).describe('Transaction ID from wave_list_transactions') }),
    handler: async ({ businessId: b, id }) => {
      const bid = await ctx.resolveBusinessId(b);
      return shape(summarizeTransaction(await fetchTransaction(ctx, bid, id), { full: true }), 'full');
    },
  });

  defineTool(server, ctx, {
    name: 'wave_update_transaction',
    title: 'Edit transaction',
    toolset: 'transactions',
    annotations: { ...UPDATE, openWorldHint: true },
    description: [
      'Edit a transaction as in the Wave web app: date, description, notes, reviewed (verified), bank/card account, total amount, category, vendor or customer, or the full set of split lines. Journal entries (journalEntry: true) have no bank side: edit their lines, keeping debits equal to credits.',
      'Single-category transactions: use categoryId / vendorId / customerId / amount / salesTax directly. Split transactions: pass lines (every line to keep, with order from wave_get_transaction; omit order to add a line; lines left out are removed). Line amounts include sales tax and must add up to the amount.',
      'Reads the transaction first and sends its current sequence, so it never overwrites a newer edit. dryRun=true shows the change without saving. Confirm with the user before changing amounts or accounts.',
      VIA,
    ].join(' '),
    input: z.object({
      businessId,
      id: z.string().min(1).describe('Transaction ID'),
      date: date.optional(),
      description: z.string().min(1).max(255).optional(),
      notes: z.string().max(2000).optional().describe('Notes; empty string clears them'),
      verified: z.boolean().optional().describe('Mark as reviewed (true) or not reviewed (false)'),
      accountId: z.string().min(1).optional().describe('Move it to another bank/card account'),
      amount: positiveAmount.optional().describe('New total; for split transactions also pass lines'),
      categoryId: z.string().min(1).optional().describe('New category account (single-category transactions)'),
      vendorId: optionalId('Vendor'),
      customerId: optionalId('Customer'),
      lineDescription: z.string().max(255).optional().describe('Description on the category line (single-category transactions)'),
      salesTax: salesTaxInput,
      lines: z
        .array(
          z.object({
            order: z.number().int().min(0).optional().describe('Existing line to keep or change; omit for a new line'),
            accountId: z.string().min(1).describe('Category account'),
            amount: positiveAmount.describe('Line amount including its sales tax'),
            description: z.string().max(255).optional(),
            vendorId: optionalId('Vendor'),
            customerId: optionalId('Customer'),
            salesTax: salesTaxInput,
            side: z.enum(['debit', 'credit']).optional().describe('Required for new lines on journal entries. Otherwise only for unusual lines such as a refund inside an expense; defaults to the usual side'),
          }),
        )
        .min(1)
        .max(50)
        .optional(),
      expectedSequence: z.number().int().optional().describe('Fail instead of editing if the transaction changed since you read it (sequence from wave_get_transaction)'),
      dryRun: z.boolean().default(false),
    }),
    handler: async (args) => {
      const bid = await ctx.resolveBusinessId(args.businessId);
      const tx = await fetchTransaction(ctx, bid, args.id);
      if (args.expectedSequence !== undefined && args.expectedSequence !== tx.sequence) {
        throw new WaveError(`The transaction is at sequence ${tx.sequence}, not ${args.expectedSequence}: it changed since you read it. Read it again before editing.`, { code: 'STALE' });
      }
      const taxes = {};
      const taxPreview = [];
      const taxDate = args.date ?? tx.date;
      const currency = tx.currency?.code;
      if (args.salesTax !== undefined && !args.lines) {
        const lineAmount = args.amount ?? tx.lineItems?.[0]?.amount ?? tx.amount;
        const r = await resolveSalesTax(ctx, bid, { date: taxDate, currency, lineAmount, requested: args.salesTax });
        taxes.single = r.input;
        taxPreview.push({ line: tx.lineItems?.[0]?.order, salesTax: r.preview });
      }
      if (args.lines) {
        taxes.lines = [];
        for (const [i, l] of args.lines.entries()) {
          if (l.salesTax === undefined) continue;
          const r = await resolveSalesTax(ctx, bid, { date: taxDate, currency, lineAmount: l.amount, requested: l.salesTax });
          taxes.lines[i] = r.input;
          taxPreview.push({ line: l.order ?? `new ${i}`, salesTax: r.preview });
        }
      }
      const { input, changed, warnings } = buildPatch(tx, args, taxes);
      if (args.dryRun) {
        return shape(
          { dryRun: true, changed, warnings: warnings.length ? warnings : undefined, salesTax: taxPreview.length ? taxPreview : undefined, current: summarizeTransaction(tx, { full: true }), input },
          'full',
        );
      }
      const payload = await write(ctx, IOPS.TransactionPatch, input, 'transactionPatch');
      return shape(
        {
          ok: true,
          changed,
          warnings: warnings.length ? warnings : undefined,
          transaction: summarizeTransaction(payload.transaction, { full: true }),
          ...(payload.sideEffects?.length ? { otherTransactionsAffected: payload.sideEffects.map((s) => s.id) } : {}),
        },
        'full',
      );
    },
  });

  defineTool(server, ctx, {
    name: 'wave_delete_transaction',
    title: 'Delete transaction',
    toolset: 'transactions',
    annotations: { ...DELETE, openWorldHint: true },
    description: `Delete a transaction, as the web app's Delete does. Changes the books and account balances: confirm with the user first. Wave refuses for transactions that must be removed at their source (e.g. invoice payments, payroll). ${VIA}`,
    input: z.object({ businessId, id: z.string().min(1), expectedSequence: z.number().int().optional().describe('Fail if the transaction changed since you read it') }),
    handler: async ({ businessId: b, id, expectedSequence }) => {
      const bid = await ctx.resolveBusinessId(b);
      const tx = await fetchTransaction(ctx, bid, id);
      if (expectedSequence !== undefined && expectedSequence !== tx.sequence) {
        throw new WaveError(`The transaction is at sequence ${tx.sequence}, not ${expectedSequence}: it changed since you read it.`, { code: 'STALE' });
      }
      if (tx.detailActions?.canDelete === false) throw new WaveError('Wave does not allow deleting this transaction here; remove it at its source (the invoice, bill, payment or payroll run).', { code: 'NOT_DELETABLE' });
      const payload = await write(ctx, IOPS.TransactionDelete, { id: tx.id, sequence: tx.sequence }, 'transactionDelete');
      return shape(
        {
          ok: true,
          deleted: summarizeTransaction(tx),
          deletedTransactionIds: payload.deletedTransactionIds,
          ...(payload.sideEffects?.length ? { otherTransactionsAffected: payload.sideEffects.map((s) => s.id) } : {}),
        },
        'full',
      );
    },
  });
}
