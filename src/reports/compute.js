/**
 * Pure report computations over data already fetched from Wave. No I/O, so
 * every number here is unit-tested. All money is accumulated in integer
 * minor units (cents) to avoid float drift.
 *
 * Currency: invoices carry their own currency and an exchange rate to the
 * business currency. Totals are reported in the business currency
 * (amount × exchangeRate) and, when more than one currency is present, also
 * per original currency.
 */
import { fromMinor, toMinor } from '../format.js';

const POSTED = (inv) => inv.status !== 'DRAFT';
const code = (c) => (typeof c === 'string' ? c : c?.code);
const val = (m) => (m && typeof m === 'object' ? m.value : m);

export class MoneyTotals {
  constructor(businessCurrency) {
    this.businessCurrency = businessCurrency;
    this.business = 0;
    this.byCurrency = new Map();
  }
  add(amount, currency, exchangeRate = 1) {
    const minor = toMinor(amount);
    const cur = currency || this.businessCurrency;
    this.byCurrency.set(cur, (this.byCurrency.get(cur) || 0) + minor);
    const rate = cur === this.businessCurrency ? 1 : Number(exchangeRate) || 1;
    this.business += Math.round(minor * rate);
    return this;
  }
  get value() {
    return fromMinor(this.business);
  }
  toJSON() {
    if (this.byCurrency.size <= 1 && (this.byCurrency.size === 0 || this.byCurrency.has(this.businessCurrency))) return this.value;
    return { [this.businessCurrency]: this.value, byOriginalCurrency: Object.fromEntries([...this.byCurrency].map(([k, v]) => [k, fromMinor(v)])) };
  }
}

const inRange = (d, start, end) => d && (!start || d >= start) && (!end || d <= end);

export function daysBetween(fromDate, toDate) {
  return Math.floor((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

export function todayIn(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Sign of a payment record: refunds subtract, voids are dropped. */
function paymentSign(p) {
  const t = String(p.transactionType || '').toUpperCase();
  if (p.active === false || t === 'VOID') return 0;
  return t === 'REFUND' ? -1 : 1;
}

// ------------------------------------------------------------ payments ("transactions" Wave lets us read)

export function paymentRows({ invoices = [], estimates = [], startDate, endDate, customerId, kind = 'all' }) {
  const rows = [];
  if (kind !== 'estimate_deposit') {
    for (const inv of invoices) {
      for (const p of inv.payments || []) {
        if (!p || !inRange(p.paymentDate, startDate, endDate)) continue;
        const cust = p.customer || inv.customer;
        if (customerId && cust?.id !== customerId) continue;
        rows.push({
          kind: 'invoice_payment',
          id: p.id,
          date: p.paymentDate,
          amount: p.amount,
          currency: code(inv.currency) || code(p.invoiceCurrency),
          method: p.paymentMethod,
          account: p.account,
          customer: cust,
          invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber },
          memo: p.memo,
          provider: p.paymentProvider,
          transactionType: p.transactionType,
          state: p.state,
          active: p.active,
          exchangeRate: inv.exchangeRate,
        });
      }
    }
  }
  if (kind !== 'invoice') {
    for (const est of estimates) {
      for (const p of est.payments || []) {
        if (!p || !inRange(p.paymentDate, startDate, endDate)) continue;
        if (customerId && est.customer?.id !== customerId) continue;
        rows.push({
          kind: 'estimate_deposit',
          id: p.id,
          date: p.paymentDate,
          amount: p.amount,
          currency: code(p.currency) || code(est.currency),
          method: p.paymentMethod,
          account: p.paymentAccountId ? { id: p.paymentAccountId } : undefined,
          customer: est.customer,
          estimate: { id: est.id, estimateNumber: est.estimateNumber },
          memo: p.memo,
          provider: p.paymentProvider,
          transactionType: p.transactionType,
          state: p.state,
          active: p.active,
        });
      }
    }
  }
  return rows;
}

export function paymentTotals(rows, businessCurrency) {
  const received = new MoneyTotals(businessCurrency);
  const refunded = new MoneyTotals(businessCurrency);
  for (const r of rows) {
    const sign = paymentSign(r);
    if (sign > 0) received.add(r.amount, r.currency, r.exchangeRate);
    else if (sign < 0) refunded.add(r.amount, r.currency, r.exchangeRate);
  }
  return { received, refunded, count: rows.length };
}

// ------------------------------------------------------------ receivables

export const AGING_BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'];

function bucketFor(daysOverdue) {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'days1to30';
  if (daysOverdue <= 60) return 'days31to60';
  if (daysOverdue <= 90) return 'days61to90';
  return 'over90';
}

export function agedReceivables(invoices, { asOf, businessCurrency }) {
  const byCustomer = new Map();
  const totals = Object.fromEntries([...AGING_BUCKETS, 'total'].map((b) => [b, new MoneyTotals(businessCurrency)]));
  let count = 0;
  for (const inv of invoices) {
    if (!POSTED(inv) || toMinor(val(inv.amountDue)) <= 0) continue;
    count++;
    const due = val(inv.amountDue);
    const cur = code(inv.currency);
    const bucket = bucketFor(daysBetween(inv.dueDate, asOf));
    const key = inv.customer?.id || 'unknown';
    if (!byCustomer.has(key)) {
      byCustomer.set(key, { customer: inv.customer, invoices: 0, ...Object.fromEntries([...AGING_BUCKETS, 'total'].map((b) => [b, new MoneyTotals(businessCurrency)])) });
    }
    const row = byCustomer.get(key);
    row.invoices++;
    row[bucket].add(due, cur, inv.exchangeRate);
    row.total.add(due, cur, inv.exchangeRate);
    totals[bucket].add(due, cur, inv.exchangeRate);
    totals.total.add(due, cur, inv.exchangeRate);
  }
  const rows = [...byCustomer.values()].sort((a, b) => b.total.business - a.total.business);
  return { rows, totals, openInvoices: count };
}

// ------------------------------------------------------------ sales

export function incomeByCustomer({ invoices, payments, businessCurrency }) {
  const map = new Map();
  const get = (customer) => {
    const key = customer?.id || 'unknown';
    if (!map.has(key)) map.set(key, { customer, invoiced: new MoneyTotals(businessCurrency), paid: new MoneyTotals(businessCurrency), invoices: 0 });
    return map.get(key);
  };
  const totals = { invoiced: new MoneyTotals(businessCurrency), paid: new MoneyTotals(businessCurrency) };
  for (const inv of invoices) {
    if (!POSTED(inv)) continue;
    const row = get(inv.customer);
    row.invoices++;
    row.invoiced.add(val(inv.total), code(inv.currency), inv.exchangeRate);
    totals.invoiced.add(val(inv.total), code(inv.currency), inv.exchangeRate);
  }
  for (const p of payments) {
    const sign = paymentSign(p);
    if (!sign) continue;
    const amount = sign < 0 ? `-${p.amount}` : p.amount;
    get(p.customer).paid.add(amount, p.currency, p.exchangeRate);
    totals.paid.add(amount, p.currency, p.exchangeRate);
  }
  const rows = [...map.values()].sort((a, b) => b.invoiced.business - a.invoiced.business || b.paid.business - a.paid.business);
  return { rows, totals };
}

export function salesByProduct(invoices, { businessCurrency }) {
  const map = new Map();
  const total = new MoneyTotals(businessCurrency);
  for (const inv of invoices) {
    if (!POSTED(inv)) continue;
    for (const item of inv.items || []) {
      const key = item.product?.id || 'unknown';
      if (!map.has(key)) map.set(key, { product: item.product, quantity: 0, lines: 0, amount: new MoneyTotals(businessCurrency), incomeAccount: item.account });
      const row = map.get(key);
      row.quantity += Number(item.quantity) || 0;
      row.lines++;
      row.amount.add(val(item.subtotal), code(inv.currency), inv.exchangeRate);
      total.add(val(item.subtotal), code(inv.currency), inv.exchangeRate);
    }
  }
  const rows = [...map.values()].sort((a, b) => b.amount.business - a.amount.business).map((r) => ({ ...r, quantity: Number(r.quantity.toFixed(8)) }));
  return { rows, totals: { amount: total } };
}

export function salesTaxReport(invoices, { businessCurrency }) {
  const map = new Map();
  for (const inv of invoices) {
    if (!POSTED(inv)) continue;
    for (const item of inv.items || []) {
      for (const tax of item.taxes || []) {
        const key = tax.salesTax?.id || 'unknown';
        if (!map.has(key)) map.set(key, { salesTax: tax.salesTax, taxableSales: new MoneyTotals(businessCurrency), taxCollected: new MoneyTotals(businessCurrency), lines: 0 });
        const row = map.get(key);
        row.lines++;
        row.taxableSales.add(val(item.subtotal), code(inv.currency), inv.exchangeRate);
        row.taxCollected.add(val(tax.amount), code(inv.currency), inv.exchangeRate);
      }
    }
  }
  const rows = [...map.values()].sort((a, b) => b.taxCollected.business - a.taxCollected.business);
  const totals = { taxCollected: new MoneyTotals(businessCurrency) };
  for (const r of rows) totals.taxCollected.business += r.taxCollected.business;
  return { rows, totals };
}

export function invoiceSummary(invoices, { asOf, businessCurrency }) {
  const byStatus = new Map();
  const totals = { invoiced: new MoneyTotals(businessCurrency), paid: new MoneyTotals(businessCurrency), due: new MoneyTotals(businessCurrency), overdue: new MoneyTotals(businessCurrency) };
  let overdueCount = 0;
  for (const inv of invoices) {
    const s = inv.status;
    if (!byStatus.has(s)) byStatus.set(s, { status: s, count: 0, total: new MoneyTotals(businessCurrency), due: new MoneyTotals(businessCurrency) });
    const row = byStatus.get(s);
    row.count++;
    row.total.add(val(inv.total), code(inv.currency), inv.exchangeRate);
    row.due.add(val(inv.amountDue), code(inv.currency), inv.exchangeRate);
    if (!POSTED(inv)) continue;
    totals.invoiced.add(val(inv.total), code(inv.currency), inv.exchangeRate);
    totals.paid.add(val(inv.amountPaid), code(inv.currency), inv.exchangeRate);
    totals.due.add(val(inv.amountDue), code(inv.currency), inv.exchangeRate);
    if (toMinor(val(inv.amountDue)) > 0 && daysBetween(inv.dueDate, asOf) > 0) {
      overdueCount++;
      totals.overdue.add(val(inv.amountDue), code(inv.currency), inv.exchangeRate);
    }
  }
  return { rows: [...byStatus.values()].sort((a, b) => b.count - a.count), totals, overdueCount, invoiceCount: invoices.length };
}

export function customerStatement(invoices, { asOf, businessCurrency, startDate, endDate, outstandingOnly }) {
  const rows = [];
  const totals = { invoiced: new MoneyTotals(businessCurrency), paid: new MoneyTotals(businessCurrency), due: new MoneyTotals(businessCurrency) };
  for (const inv of invoices) {
    if (!POSTED(inv)) continue;
    const due = toMinor(val(inv.amountDue));
    if (outstandingOnly ? due <= 0 : !inRange(inv.invoiceDate, startDate, endDate)) continue;
    rows.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      status: inv.status,
      currency: code(inv.currency),
      total: val(inv.total),
      paid: val(inv.amountPaid),
      due: val(inv.amountDue),
      daysOverdue: due > 0 ? Math.max(0, daysBetween(inv.dueDate, asOf)) : 0,
      payments: (inv.payments || []).filter((p) => paymentSign(p)).map((p) => ({ date: p.paymentDate, amount: p.amount, method: p.paymentMethod })),
    });
    totals.invoiced.add(val(inv.total), code(inv.currency), inv.exchangeRate);
    totals.paid.add(val(inv.amountPaid), code(inv.currency), inv.exchangeRate);
    totals.due.add(val(inv.amountDue), code(inv.currency), inv.exchangeRate);
  }
  rows.sort((a, b) => (a.invoiceDate < b.invoiceDate ? -1 : 1));
  return { rows, totals };
}

// ------------------------------------------------------------ account-balance reports (as of now)

function accountRow(a) {
  return {
    id: a.id,
    name: a.name,
    displayId: a.displayId,
    type: a.type?.value || a.type,
    subtype: a.subtype?.value || a.subtype,
    currency: code(a.currency),
    normalBalanceType: a.normalBalanceType,
    balance: a.balance ?? undefined,
    balanceInBusinessCurrency: a.balanceInBusinessCurrency ?? a.balance ?? '0.00',
  };
}

const biz = (a) => toMinor(a.balanceInBusinessCurrency ?? a.balance);

export function accountBalances(accounts, { includeZero = false } = {}) {
  const rows = accounts.map(accountRow).filter((r) => includeZero || toMinor(r.balanceInBusinessCurrency) !== 0);
  const byType = {};
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + toMinor(r.balanceInBusinessCurrency);
  rows.sort((a, b) => a.type.localeCompare(b.type) || a.subtype.localeCompare(b.subtype) || a.name.localeCompare(b.name));
  return { rows, totals: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, fromMinor(v)])) };
}

/**
 * Wave reports balances signed so a positive figure sits on the account's
 * normal side (a debit for assets/expenses, a credit for liabilities,
 * equity and income). A negative balance therefore lands in the other column.
 */
export function trialBalance(accounts) {
  let debit = 0;
  let credit = 0;
  const rows = [];
  for (const a of accounts) {
    const m = biz(a);
    if (m === 0) continue;
    const normalDebit = a.normalBalanceType === 'DEBIT';
    const side = (m > 0) === normalDebit ? 'debit' : 'credit';
    if (side === 'debit') debit += Math.abs(m);
    else credit += Math.abs(m);
    rows.push({ ...accountRow(a), debit: side === 'debit' ? fromMinor(Math.abs(m)) : undefined, credit: side === 'credit' ? fromMinor(Math.abs(m)) : undefined });
  }
  rows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { rows, totals: { debit: fromMinor(debit), credit: fromMinor(credit), difference: fromMinor(debit - credit), balanced: debit === credit } };
}

function section(accounts, type) {
  const subtypes = new Map();
  let total = 0;
  for (const a of accounts) {
    if ((a.type?.value || a.type) !== type) continue;
    const m = biz(a);
    if (m === 0) continue;
    const st = a.subtype?.name || a.subtype?.value || 'Other';
    if (!subtypes.has(st)) subtypes.set(st, { subtype: st, total: 0, accounts: [] });
    const g = subtypes.get(st);
    g.total += m;
    g.accounts.push({ id: a.id, name: a.name, balance: fromMinor(m) });
    total += m;
  }
  return { total, groups: [...subtypes.values()].map((g) => ({ ...g, total: fromMinor(g.total) })) };
}

export function profitAndLoss(accounts) {
  const income = section(accounts, 'INCOME');
  const expense = section(accounts, 'EXPENSE');
  const cogsGroup = expense.groups.find((g) => /cost of goods/i.test(g.subtype));
  const cogs = cogsGroup ? toMinor(cogsGroup.total) : 0;
  return {
    income: { total: fromMinor(income.total), groups: income.groups },
    costOfGoodsSold: fromMinor(cogs),
    grossProfit: fromMinor(income.total - cogs),
    operatingExpenses: { total: fromMinor(expense.total - cogs), groups: expense.groups.filter((g) => g !== cogsGroup) },
    netProfit: fromMinor(income.total - expense.total),
  };
}

export function balanceSheet(accounts) {
  const assets = section(accounts, 'ASSET');
  const liabilities = section(accounts, 'LIABILITY');
  const equity = section(accounts, 'EQUITY');
  const pl = profitAndLoss(accounts);
  const unclosed = toMinor(pl.netProfit);
  const equityWithEarnings = equity.total + unclosed;
  return {
    assets: { total: fromMinor(assets.total), groups: assets.groups },
    liabilities: { total: fromMinor(liabilities.total), groups: liabilities.groups },
    equity: { total: fromMinor(equity.total), groups: equity.groups, netIncomeFromIncomeAndExpenseAccounts: pl.netProfit, totalWithNetIncome: fromMinor(equityWithEarnings) },
    liabilitiesAndEquity: fromMinor(liabilities.total + equityWithEarnings),
    difference: fromMinor(assets.total - liabilities.total - equityWithEarnings),
  };
}
