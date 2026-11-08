/**
 * A small stateful stand-in for Wave's web-app API (/graphql/internal),
 * answering the operations in src/wave/internal-operations.js by name. It
 * mimics the behaviours verified live: sequence locking (stale → HTTP 412
 * style error), JSON-encoded inputErrors, soft delete, Wave-calculated vs
 * manual sales tax, and session-token auth.
 */
export const SESSION = 'sess-token';
export const ACC = {
  cash: { id: 'acc-cash', name: 'Cash on Hand', subtype: { value: 'CASH_AND_BANK' } },
  uncat: { id: 'acc-uncat', name: 'Uncategorized Expense', subtype: { value: 'UNCATEGORIZED_EXPENSE' } },
  uncatIncome: { id: 'acc-uncat-in', name: 'Uncategorized Income', subtype: { value: 'UNCATEGORIZED_INCOME' } },
  marketing: { id: 'acc-mkt', name: 'Marketing', subtype: { value: 'EXPENSE' } },
  sales: { id: 'acc-sales', name: 'Sales', subtype: { value: 'INCOME' } },
};
export const GST = { id: 'tax-gst', name: 'GST', abbreviation: 'GST', rate: '0.05', accountId: 'acc-gst-liability' };
const ACCOUNTS = Object.values(ACC);

const cents = (v) => Math.round(Number(v) * 100);
const dec = (c) => String(c / 100); // Wave drops trailing zeros ("2.5")
const inclusiveTax = (amount, rate) => Math.round(cents(amount) - cents(amount) / (1 + Number(rate)));

function line(order, account, amount, itemType, extra = {}) {
  return {
    order,
    itemType,
    amount: dec(cents(amount)),
    description: '',
    taxAction: itemType === 'CREDIT' ? null : 'PAYMENT',
    isReconciled: false,
    account,
    vendor: null,
    customer: null,
    taxSummary: { totalTaxAmount: '0', taxLiabilities: [] },
    tags: [],
    ...extra,
  };
}

export function makeTx(n, { date = `2026-10-${String(n).padStart(2, '0')}`, description = `Purchase ${n}`, amount = '10.00', category = ACC.marketing, tax, verified = false } = {}) {
  const l = line(1, category, amount, 'DEBIT');
  if (tax) l.taxSummary = { totalTaxAmount: dec(cents(tax.amount)), taxLiabilities: [{ accountId: GST.accountId, amount: dec(cents(tax.amount)), isTaxAmountManuallySet: Boolean(tax.manual), salesTax: GST }] };
  return {
    id: `tx-${n}`,
    sequence: 1,
    date,
    description,
    notes: '',
    amount: dec(cents(amount)),
    direction: 'WITHDRAWAL',
    verificationStatus: verified ? 'VERIFIED' : 'NOT_VERIFIED',
    active: true,
    missingFields: [],
    dateCreated: date,
    currency: { code: 'CAD' },
    origin: { type: 'GENERIC_EXTERNAL_API', description: null },
    anchorLineItem: line(0, ACC.cash, amount, 'CREDIT'),
    lineItems: [l],
    attachment: null,
    detailActions: { amount: true, date: true, description: true, account: true, category: true, notes: true, lineItems: true, split: true, canDelete: true, salesTax: true, verificationStatus: true },
  };
}

export function createFakeInternal({ transactions = Array.from({ length: 30 }, (_, i) => makeTx(i + 1)) } = {}) {
  const txs = transactions.map((t) => structuredClone(t));
  const calls = [];
  const opName = (query) => query.match(/^\s*(?:query|mutation)\s+([A-Za-z_]\w*)/m)?.[1];
  const find = (id) => txs.find((t) => t.id === id);
  const invalid = (msg) => ({ didSucceed: false, inputErrors: [{ code: 'INVALID', message: '', path: null }, { code: 'INVALID', message: JSON.stringify(msg), path: null }, { code: 'INVALID', message: '400', path: null }] });

  function taxFor(amount, liabilities) {
    if (!liabilities) return undefined;
    const list = liabilities.map((t) => {
      const manual = t.amount !== undefined;
      const c = manual ? cents(t.amount) : inclusiveTax(amount, GST.rate);
      return { accountId: t.accountId, amount: dec(c), isTaxAmountManuallySet: manual, salesTax: GST };
    });
    return { totalTaxAmount: dec(list.reduce((s, t) => s + cents(t.amount), 0)), taxLiabilities: list };
  }

  function applyPatch(input) {
    const tx = find(input.id);
    if (!tx || !tx.active) return { errors: [{ message: 'Not found', extensions: { code: 'NOT_FOUND' } }], data: { transactionPatch: null } };
    if (input.sequence !== tx.sequence) return { errors: [{ message: 'Stale transaction sequence', extensions: { code: 'FAILED_PRECONDITION', status: 412 } }], data: { transactionPatch: null } };
    const next = structuredClone(tx);
    for (const k of ['date', 'description', 'notes', 'verificationStatus']) if (input[k] !== undefined) next[k] = input[k];
    if (input.anchorLineItem) {
      next.anchorLineItem.amount = dec(cents(input.anchorLineItem.amount));
      next.anchorLineItem.account = ACCOUNTS.find((a) => a.id === input.anchorLineItem.category.accountId);
      next.amount = next.anchorLineItem.amount;
    }
    if (input.lineItems) {
      let order = Math.max(0, ...tx.lineItems.map((l) => l.order));
      next.lineItems = input.lineItems.map((li) => {
        const old = li.order !== undefined ? tx.lineItems.find((l) => l.order === li.order) : undefined;
        const base = old ? structuredClone(old) : line(++order, null, li.amount, li.itemType);
        if (li.amount !== undefined) base.amount = dec(cents(li.amount));
        if (li.itemType) base.itemType = li.itemType;
        if (li.category) base.account = ACCOUNTS.find((a) => a.id === li.category.accountId) || { id: li.category.accountId, name: '?', subtype: { value: 'EXPENSE' } };
        if (li.description !== undefined) base.description = li.description;
        if (li.vendorId !== undefined) base.vendor = li.vendorId ? { id: li.vendorId, name: 'Vendor' } : null;
        if (li.taxLiabilities !== undefined) base.taxSummary = taxFor(base.amount, li.taxLiabilities);
        else if (li.amount !== undefined && base.taxSummary.taxLiabilities.length && !base.taxSummary.taxLiabilities.some((t) => t.isTaxAmountManuallySet)) {
          base.taxSummary = taxFor(base.amount, base.taxSummary.taxLiabilities.map((t) => ({ accountId: t.accountId })));
        }
        return base;
      });
    }
    const total = cents(next.anchorLineItem.amount);
    const sum = next.lineItems.reduce((s, l) => s + (l.itemType === next.anchorLineItem.itemType ? -1 : 1) * cents(l.amount), 0);
    if (sum !== total) {
      return { data: { transactionPatch: invalid({ transactions: { 0: { __all__: [{ message: 'Line items are over balanced.', error_type: 'LINE_ITEM_AMOUNT_OVERBALANCED', variables: { difference: ((sum - total) / 100).toFixed(2) } }] } } }) } };
    }
    if (next.verificationStatus === 'VERIFIED' && next.lineItems.some((l) => /^UNCATEGORIZED/.test(l.account?.subtype?.value))) {
      return { data: { transactionPatch: invalid({ transactions: [{ __all__: ['Transaction cannot be reviewed with uncategorized item.'] }] }) } };
    }
    next.sequence = tx.sequence + 1;
    Object.assign(tx, next);
    return { data: { transactionPatch: { didSucceed: true, inputErrors: [], transaction: structuredClone(tx), sideEffects: [] } } };
  }

  const handlers = {
    Viewer: () => ({ data: { user: { id: 'u1', firstName: 'Ada', lastName: 'Owner', defaultEmail: 'owner@example.com' } } }),
    UncategorizedAccounts: () => ({ data: { business: { id: 'b', accounts: { edges: [ACC.uncat, ACC.uncatIncome].map((node) => ({ node: { id: node.id, name: node.name } })) } } } }),
    ListTransactions: (v) => {
      const f = v.filters || {};
      let list = txs.filter(
        (t) =>
          t.active &&
          (!f.description || t.description.toLowerCase().includes(f.description.toLowerCase())) &&
          (!f.startDate || t.date >= f.startDate) &&
          (!f.endDate || t.date <= f.endDate) &&
          (!f.anchorId || t.anchorLineItem.account.id === f.anchorId) &&
          (!f.categoryIds || t.lineItems.some((l) => f.categoryIds.includes(l.account?.id))),
      );
      list.sort((a, b) => (v.sort?.[0] === 'DATE_ASC' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
      const start = v.after ? Number(Buffer.from(v.after, 'base64').toString()) : 0;
      const page = list.slice(start, start + (v.first ?? 100));
      const end = start + page.length;
      const cursor = (i) => Buffer.from(String(i)).toString('base64');
      return { data: { business: { id: v.businessId, transactions: { edges: page.map((node, i) => ({ cursor: cursor(start + i + 1), node })), pageInfo: { hasNextPage: end < list.length, endCursor: cursor(end) } } } } };
    },
    GetTransaction: (v) => ({ data: { business: { id: v.businessId, transaction: find(v.transactionId) || null } } }),
    SalesTaxSummary: (v) => {
      const applied = v.input.appliedTaxes.map((t) => {
        if (t.salesTaxId !== GST.id) return { order: t.order, amount: '0', account: null, salesTax: null };
        const c = t.amount !== undefined ? cents(t.amount) : inclusiveTax(v.input.lineItemAmount, GST.rate);
        return { order: t.order, amount: dec(c), account: { id: GST.accountId }, salesTax: { ...GST, isArchived: false } };
      });
      return { data: { business: { id: v.businessId, salesTaxSummary: { baseLineItemAmount: '0', taxTotalAmount: '0', taxCalculationErrored: false, appliedTaxes: applied } } } };
    },
    TransactionPatch: (v) => applyPatch(v.input),
    TransactionDelete: (v) => {
      const tx = find(v.input.id);
      if (!tx || v.input.sequence !== tx.sequence) return { errors: [{ message: 'Stale transaction sequence', extensions: { code: 'FAILED_PRECONDITION' } }], data: { transactionDelete: null } };
      tx.active = false;
      tx.sequence += 1;
      return { data: { transactionDelete: { didSucceed: true, deletedTransactionIds: [tx.id], sideEffects: [] } } };
    },
  };

  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    const name = opName(body.query);
    calls.push({ name, variables: body.variables, headers: init.headers });
    if (init.headers.Authorization !== `Bearer ${SESSION}`) {
      return Response.json({ errors: [{ message: 'Invalid request, authentication expired.', extensions: { code: 'UNAUTHENTICATED' } }], data: { user: null } });
    }
    const handler = handlers[name];
    if (!handler) return Response.json({ errors: [{ message: `fake-internal: no handler for ${name}` }] });
    return Response.json(handler(body.variables || {}));
  }

  return { fetchImpl, calls, txs };
}

/** Route /graphql/internal to the internal fake and everything else to the public one. */
export function combineFakes(publicFake, internalFake) {
  return {
    ...publicFake,
    internal: internalFake,
    fetchImpl: (url, init) => (String(url).includes('/graphql/internal') ? internalFake.fetchImpl(url, init) : publicFake.fetchImpl(url, init)),
  };
}
