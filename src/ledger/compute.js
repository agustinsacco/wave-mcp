/**
 * Reports computed from an imported journal (Wave's Data Export). All money
 * is integer cents; output is decimal strings. Every function takes the
 * stored ledger: { lines, accounts (classified), ... }.
 */
import { CASH_SUBTYPES, DEBIT_NORMAL, TYPE_ORDER } from './classify.js';

const money = (minor) => {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
export { money };

const inRange = (d, start, end) => (!start || d >= start) && (!end || d <= end);
const prevDay = (iso) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

/** Natural balance: debit-normal accounts are dr - cr, the rest cr - dr. */
const natural = (acct, dr, cr) => (DEBIT_NORMAL.has(acct?.type) ? dr - cr : cr - dr);

function accountRef(ledger, i) {
  const a = ledger.accounts[i] || {};
  return { account: a.name, ...(a.id ? { accountId: a.id } : {}), type: a.type || 'UNCLASSIFIED', ...(a.subtypeName ? { subtype: a.subtypeName } : {}) };
}

/** Sum debits/credits per account over lines matching a date predicate. */
function sums(ledger, pred) {
  const out = new Map();
  for (const l of ledger.lines) {
    if (!pred(l.d)) continue;
    const s = out.get(l.a) || { dr: 0, cr: 0, n: 0 };
    s.dr += l.dr;
    s.cr += l.cr;
    s.n++;
    out.set(l.a, s);
  }
  return out;
}

export function unclassifiedWarning(ledger) {
  const names = ledger.accounts.filter((a) => !a.type).map((a) => a.name);
  return names.length
    ? `${names.length} accounts have no known type and are reported under UNCLASSIFIED (${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''}). Re-import with Wave credentials configured so types come from Wave's chart of accounts.`
    : undefined;
}

// ---------------------------------------------------------------- P&L

/** Wave layout: Income, Cost of Goods Sold, Gross Profit, Operating Expenses, Net Profit. */
export function ledgerProfitAndLoss(ledger, { startDate, endDate }) {
  const s = sums(ledger, (d) => inRange(d, startDate, endDate));
  const sections = { income: [], costOfGoodsSold: [], operatingExpenses: [] };
  const totals = { income: 0, costOfGoodsSold: 0, operatingExpenses: 0 };
  for (const [i, v] of s) {
    const a = ledger.accounts[i];
    if (a?.type !== 'INCOME' && a?.type !== 'EXPENSE') continue;
    const amount = natural(a, v.dr, v.cr);
    if (!amount) continue;
    const key = a.type === 'INCOME' ? 'income' : a.subtype === 'COST_OF_GOODS_SOLD' ? 'costOfGoodsSold' : 'operatingExpenses';
    sections[key].push({ ...accountRef(ledger, i), amount, lines: v.n });
    totals[key] += amount;
  }
  const sort = (rows) => rows.sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).map((r) => ({ ...r, amount: money(r.amount) }));
  const grossProfit = totals.income - totals.costOfGoodsSold;
  const netProfit = grossProfit - totals.operatingExpenses;
  return {
    period: { startDate, endDate },
    summary: {
      income: money(totals.income),
      costOfGoodsSold: money(totals.costOfGoodsSold),
      grossProfit: money(grossProfit),
      operatingExpenses: money(totals.operatingExpenses),
      netProfit: money(netProfit),
    },
    rows: [
      ...sort(sections.income).map((r) => ({ section: 'Income', ...r })),
      ...sort(sections.costOfGoodsSold).map((r) => ({ section: 'Cost of Goods Sold', ...r })),
      ...sort(sections.operatingExpenses).map((r) => ({ section: 'Operating Expenses', ...r })),
    ],
  };
}

// ------------------------------------------------------- balance sheet

/**
 * Balances as of a date. Income and expense are not closed in the export,
 * so earnings are computed: profit before the fiscal year start goes to
 * retained earnings, profit since then is current-year profit (as Wave shows).
 */
export function ledgerBalanceSheet(ledger, { asOf, fiscalYearStart }) {
  const fyStart = fiscalYearStartFor(asOf, fiscalYearStart);
  const s = sums(ledger, (d) => d <= asOf);
  const groups = { ASSET: [], LIABILITY: [], EQUITY: [] };
  const totals = { ASSET: 0, LIABILITY: 0, EQUITY: 0 };
  let priorProfit = 0;
  let currentProfit = 0;
  let unclassified = 0;
  for (const l of ledger.lines) {
    if (l.d > asOf) continue;
    const a = ledger.accounts[l.a];
    if (a?.type !== 'INCOME' && a?.type !== 'EXPENSE') continue;
    const p = l.cr - l.dr;
    if (l.d < fyStart) priorProfit += p;
    else currentProfit += p;
  }
  for (const [i, v] of s) {
    const a = ledger.accounts[i];
    if (!a?.type) {
      unclassified += v.dr - v.cr;
      continue;
    }
    if (!groups[a.type]) continue;
    const balance = natural(a, v.dr, v.cr);
    if (!balance) continue;
    groups[a.type].push({ ...accountRef(ledger, i), balance });
    totals[a.type] += balance;
  }
  const equity = totals.EQUITY + priorProfit + currentProfit;
  const rows = [];
  for (const t of ['ASSET', 'LIABILITY', 'EQUITY']) {
    for (const r of groups[t].sort((x, y) => Math.abs(y.balance) - Math.abs(x.balance))) rows.push({ section: t, ...r, balance: money(r.balance) });
  }
  rows.push({ section: 'EQUITY', account: `Profit for all prior years (before ${fyStart})`, computed: true, balance: money(priorProfit) });
  rows.push({ section: 'EQUITY', account: `Profit between ${fyStart} and ${asOf}`, computed: true, balance: money(currentProfit) });
  const difference = totals.ASSET - (totals.LIABILITY + equity);
  return {
    asOf,
    fiscalYearStart: fyStart,
    summary: {
      assets: money(totals.ASSET),
      liabilities: money(totals.LIABILITY),
      equity: money(equity),
      liabilitiesAndEquity: money(totals.LIABILITY + equity),
      balanced: difference === 0,
      ...(difference ? { difference: money(difference) } : {}),
      ...(unclassified ? { unclassifiedNet: money(unclassified) } : {}),
    },
    rows,
  };
}

export function fiscalYearStartFor(asOf, mmdd = '01-01') {
  const md = /^\d{2}-\d{2}$/.test(mmdd || '') ? mmdd : '01-01';
  const year = Number(asOf.slice(0, 4));
  const candidate = `${year}-${md}`;
  return candidate <= asOf ? candidate : `${year - 1}-${md}`;
}

// ------------------------------------------------- trial balance etc.

export function ledgerTrialBalance(ledger, { asOf, startDate }) {
  const s = sums(ledger, (d) => inRange(d, startDate, asOf));
  let dr = 0;
  let cr = 0;
  const rows = [];
  for (const [i, v] of s) {
    const net = v.dr - v.cr;
    if (!net) continue;
    const row = { ...accountRef(ledger, i), debit: net > 0 ? money(net) : '0.00', credit: net < 0 ? money(-net) : '0.00' };
    if (net > 0) dr += net;
    else cr -= net;
    rows.push(row);
  }
  rows.sort((x, y) => TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type) || x.account.localeCompare(y.account));
  return { asOf, ...(startDate ? { startDate } : {}), totals: { debit: money(dr), credit: money(cr), balanced: dr === cr }, rows };
}

export function ledgerAccountBalances(ledger, { asOf, includeZero = false }) {
  const s = sums(ledger, (d) => d <= asOf);
  const totals = {};
  const rows = [];
  ledger.accounts.forEach((a, i) => {
    const v = s.get(i) || { dr: 0, cr: 0, n: 0 };
    const balance = natural(a, v.dr, v.cr);
    if (!balance && !includeZero) return;
    const t = a.type || 'UNCLASSIFIED';
    totals[t] = (totals[t] || 0) + balance;
    rows.push({ ...accountRef(ledger, i), balance: money(balance), lines: v.n });
  });
  rows.sort((x, y) => TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type) || x.account.localeCompare(y.account));
  return { asOf, totalsByType: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v)])), rows };
}

// ------------------------------------------------------------ cash flow

const INVESTING = new Set(['PROPERTY_PLANT_EQUIPMENT', 'DEPRECIATION_AND_AMORTIZATION', 'OTHER_LONG_TERM_ASSETS']);
const FINANCING = new Set(['LOANS', 'DUE_TO_YOU_AND_OTHER_OWNERS', 'NON_RETAINED_EARNINGS', 'RETAINED_EARNINGS', 'OTHER_LONG_TERM_LIABILITY']);

function cashFlowLine(a) {
  if (!a?.type) return ['Operating', 'Other (unclassified accounts)'];
  if (INVESTING.has(a.subtype)) return ['Investing', a.subtype === 'PROPERTY_PLANT_EQUIPMENT' ? 'Property, plant, equipment' : 'Other'];
  if (FINANCING.has(a.subtype)) return ['Financing', a.subtype === 'LOANS' ? 'Loans and lines of credit' : 'Owners and shareholders'];
  if (a.type === 'EQUITY') return ['Financing', 'Owners and shareholders'];
  if (a.type === 'INCOME' || a.subtype === 'RECEIVABLE' || a.subtype === 'CUSTOMER_PREPAYMENTS_AND_CREDITS') return ['Operating', 'Sales'];
  if (a.subtype === 'INVENTORY') return ['Operating', 'Inventory'];
  if (a.subtype === 'SALES_TAX') return ['Operating', 'Sales taxes'];
  if (a.subtype === 'PAYROLL_EXPENSES' || a.subtype === 'DUE_FOR_PAYROLL') return ['Operating', 'Payroll'];
  if (a.type === 'EXPENSE' || a.subtype === 'PAYABLE' || a.subtype === 'CREDIT_CARD' || a.subtype === 'VENDOR_PREPAYMENTS_AND_CREDITS') return ['Operating', 'Purchases'];
  return ['Operating', 'Other'];
}

/**
 * Direct method. Within each transaction that moves cash, every non-cash
 * line's (credit - debit) is the cash it explains, so categories always sum
 * to the net change in cash (for balanced transactions). Transfers between
 * cash accounts net to zero and drop out.
 */
export function ledgerCashFlow(ledger, { startDate, endDate }) {
  const isCash = (i) => CASH_SUBTYPES.has(ledger.accounts[i]?.subtype);
  if (!ledger.accounts.some((a) => CASH_SUBTYPES.has(a.subtype))) {
    return { error: 'No account is classified as Cash and Bank or Money in Transit, so cash cannot be identified. Re-import with Wave credentials configured.' };
  }
  let opening = 0;
  const byTx = new Map();
  for (const l of ledger.lines) {
    if (l.d < startDate) {
      if (isCash(l.a)) opening += l.dr - l.cr;
      continue;
    }
    if (l.d > endDate) continue;
    if (!byTx.has(l.t)) byTx.set(l.t, []);
    byTx.get(l.t).push(l);
  }
  const cats = new Map();
  let inflow = 0;
  let outflow = 0;
  let net = 0;
  let explained = 0;
  for (const lines of byTx.values()) {
    const cash = lines.filter((l) => isCash(l.a)).reduce((s, l) => s + l.dr - l.cr, 0);
    if (!lines.some((l) => isCash(l.a))) continue;
    net += cash;
    if (cash > 0) inflow += cash;
    else outflow -= cash;
    for (const l of lines) {
      if (isCash(l.a)) continue;
      const flow = l.cr - l.dr;
      if (!flow) continue;
      const [activity, line] = cashFlowLine(ledger.accounts[l.a]);
      const k = `${activity}|${line}`;
      const c = cats.get(k) || { activity, line, amount: 0, accounts: new Map() };
      c.amount += flow;
      c.accounts.set(l.a, (c.accounts.get(l.a) || 0) + flow);
      cats.set(k, c);
      explained += flow;
    }
  }
  const order = ['Operating', 'Investing', 'Financing'];
  const activities = Object.fromEntries(order.map((a) => [a, 0]));
  const rows = [...cats.values()]
    .sort((x, y) => order.indexOf(x.activity) - order.indexOf(y.activity) || Math.abs(y.amount) - Math.abs(x.amount))
    .map((c) => {
      activities[c.activity] += c.amount;
      return {
        activity: c.activity,
        line: c.line,
        amount: money(c.amount),
        topAccounts: [...c.accounts]
          .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
          .slice(0, 5)
          .map(([i, v]) => ({ account: ledger.accounts[i]?.name, amount: money(v) })),
      };
    });
  return {
    period: { startDate, endDate },
    summary: {
      cashAtStart: money(opening),
      grossCashInflow: money(inflow),
      grossCashOutflow: money(outflow),
      netCashChange: money(net),
      cashAtEnd: money(opening + net),
      operatingActivities: money(activities.Operating),
      investingActivities: money(activities.Investing),
      financingActivities: money(activities.Financing),
      ...(explained !== net ? { unexplained: money(net - explained), note: 'Some cash transactions do not balance in the export.' } : {}),
    },
    cashAccounts: ledger.accounts.filter((a) => CASH_SUBTYPES.has(a.subtype)).map((a) => a.name),
    rows,
  };
}

// ------------------------------------------------- account transactions

/** General ledger for one or more accounts: opening balance, lines with running balance, closing. */
export function ledgerAccountTransactions(ledger, { accountIdx, startDate, endDate }) {
  const sections = [];
  for (const i of accountIdx) {
    const a = ledger.accounts[i];
    let opening = 0;
    let running;
    const rows = [];
    let dr = 0;
    let cr = 0;
    for (const l of ledger.lines) {
      if (l.a !== i) continue;
      if (startDate && l.d < startDate) {
        opening += natural(a, l.dr, l.cr);
        continue;
      }
      if (endDate && l.d > endDate) continue;
      running = (running ?? opening) + natural(a, l.dr, l.cr);
      dr += l.dr;
      cr += l.cr;
      rows.push({
        date: l.d,
        transactionId: l.t,
        description: l.ldesc || l.desc,
        ...(l.ldesc && l.desc && l.ldesc !== l.desc ? { transaction: l.desc } : {}),
        ...(l.cu ? { customer: l.cu } : {}),
        ...(l.ve ? { vendor: l.ve } : {}),
        debit: l.dr ? money(l.dr) : undefined,
        credit: l.cr ? money(l.cr) : undefined,
        balance: money(running),
      });
    }
    sections.push({ ...accountRef(ledger, i), startingBalance: money(opening), totalDebits: money(dr), totalCredits: money(cr), netMovement: money(natural(a, dr, cr)), endingBalance: money(running ?? opening), rows });
  }
  return sections;
}

// ------------------------------------------------------------ sales tax

/**
 * Per sales-tax account: tax on sales (credits in transactions with income
 * lines), tax on purchases (debits in transactions with expense or asset
 * purchase lines), and payments/refunds (transactions with only cash, tax
 * and liability lines). Taxable amounts are the income/expense lines of the
 * same transactions, so mixed taxable/non-taxable lines inflate them.
 */
export function ledgerSalesTax(ledger, { startDate, endDate }) {
  const taxAccts = new Set(ledger.accounts.map((a, i) => (a.subtype === 'SALES_TAX' ? i : -1)).filter((i) => i >= 0));
  if (!taxAccts.size) return { error: 'No account is classified as Sales Tax in the imported ledger.' };
  const byTx = new Map();
  const opening = new Map();
  for (const l of ledger.lines) {
    if (taxAccts.has(l.a) && l.d < startDate) opening.set(l.a, (opening.get(l.a) || 0) + l.cr - l.dr);
    if (l.d < startDate || l.d > endDate) continue;
    if (!byTx.has(l.t)) byTx.set(l.t, []);
    byTx.get(l.t).push(l);
  }
  const rows = new Map();
  const row = (i) => {
    if (!rows.has(i)) rows.set(i, { salesSubjectToTax: 0, taxOnSales: 0, purchasesSubjectToTax: 0, taxOnPurchases: 0, paymentsAndAdjustments: 0 });
    return rows.get(i);
  };
  for (const lines of byTx.values()) {
    const tax = lines.filter((l) => taxAccts.has(l.a));
    if (!tax.length) continue;
    const others = lines.filter((l) => !taxAccts.has(l.a));
    const typeOf = (l) => ledger.accounts[l.a];
    const income = others.filter((l) => typeOf(l)?.type === 'INCOME').reduce((s, l) => s + l.cr - l.dr, 0);
    const purchases = others
      .filter((l) => typeOf(l)?.type === 'EXPENSE' || (typeOf(l)?.type === 'ASSET' && !CASH_SUBTYPES.has(typeOf(l)?.subtype) && !['RECEIVABLE', 'RECEIVABLE_INVOICES', 'RECEIVABLE_OTHER'].includes(typeOf(l)?.subtype)))
      .reduce((s, l) => s + l.dr - l.cr, 0);
    for (const l of tax) {
      const r = row(l.a);
      const amt = l.cr - l.dr;
      if (income && amt > 0) {
        r.taxOnSales += amt;
        r.salesSubjectToTax += income / tax.length;
      } else if (purchases && amt < 0) {
        r.taxOnPurchases += -amt;
        r.purchasesSubjectToTax += purchases / tax.length;
      } else if (income) {
        r.taxOnSales += amt; // credit note / refund to customer
        r.salesSubjectToTax += income / tax.length;
      } else if (purchases) {
        r.taxOnPurchases -= amt;
        r.purchasesSubjectToTax += purchases / tax.length;
      } else r.paymentsAndAdjustments += amt;
    }
  }
  const out = [];
  const tot = { taxOnSales: 0, taxOnPurchases: 0, netTaxOwing: 0 };
  for (const i of taxAccts) {
    const r = rows.get(i) || row(i);
    const start = opening.get(i) || 0;
    const netOwing = r.taxOnSales - r.taxOnPurchases;
    if (!start && !r.taxOnSales && !r.taxOnPurchases && !r.paymentsAndAdjustments) continue;
    tot.taxOnSales += r.taxOnSales;
    tot.taxOnPurchases += r.taxOnPurchases;
    tot.netTaxOwing += netOwing;
    out.push({
      tax: ledger.accounts[i].name,
      salesSubjectToTax: money(Math.round(r.salesSubjectToTax)),
      taxOnSales: money(r.taxOnSales),
      purchasesSubjectToTax: money(Math.round(r.purchasesSubjectToTax)),
      taxOnPurchases: money(r.taxOnPurchases),
      netTaxOwing: money(netOwing),
      startingBalance: money(start),
      paymentsAndAdjustments: money(r.paymentsAndAdjustments),
      endingBalance: money(start + netOwing + r.paymentsAndAdjustments),
    });
  }
  return { period: { startDate, endDate }, totals: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, money(v)])), rows: out };
}

// ------------------------------------------- payables and vendors

const PAYABLE = new Set(['PAYABLE', 'PAYABLE_BILLS', 'PAYABLE_OTHER']);
const BUCKETS = [
  ['current', -Infinity, 0],
  ['days1to30', 1, 30],
  ['days31to60', 31, 60],
  ['days61to90', 61, 90],
  ['over90', 91, Infinity],
];
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Open payables by bill as of a date, from Accounts Payable lines grouped by
 * bill number (else vendor). Aged by due date from the bill items file when
 * present, else by bill date.
 */
export function ledgerAgedPayables(ledger, { asOf }) {
  const apAccts = new Set(ledger.accounts.map((a, i) => (PAYABLE.has(a.subtype) ? i : -1)).filter((i) => i >= 0));
  if (!apAccts.size) return { error: 'No account is classified as Accounts Payable in the imported ledger.' };
  const dueByBill = new Map((ledger.bills || []).map((b) => [b.billNumber, b]));
  const vendorOfTx = new Map();
  for (const l of ledger.lines) if (l.ve && !vendorOfTx.has(l.t)) vendorOfTx.set(l.t, l.ve);
  const open = new Map();
  for (const l of ledger.lines) {
    if (!apAccts.has(l.a) || l.d > asOf) continue;
    const vendor = l.ve || vendorOfTx.get(l.t) || dueByBill.get(l.bill)?.vendor || '(no vendor)';
    const key = l.bill ? `bill:${l.bill}` : `vendor:${vendor}`;
    const o = open.get(key) || { billNumber: l.bill, vendor, date: l.d, owed: 0 };
    o.owed += l.cr - l.dr;
    if (l.cr > 0 && l.d < o.date) o.date = l.d;
    open.set(key, o);
  }
  const totals = Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));
  let total = 0;
  const byVendor = new Map();
  for (const o of open.values()) {
    if (o.owed <= 0) continue;
    const due = dueByBill.get(o.billNumber)?.dueDate;
    const age = dayDiff(due || o.date, asOf);
    const bucket = BUCKETS.find(([, lo, hi]) => age >= lo && age <= hi)[0];
    const v = byVendor.get(o.vendor) || { vendor: o.vendor, total: 0, bills: 0, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0])) };
    v[bucket] += o.owed;
    v.total += o.owed;
    v.bills++;
    byVendor.set(o.vendor, v);
    totals[bucket] += o.owed;
    total += o.owed;
  }
  const rows = [...byVendor.values()]
    .sort((x, y) => y.total - x.total)
    .map((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'number' && k !== 'bills' ? money(x) : x])));
  return {
    asOf,
    agedBy: ledger.bills?.length ? 'bill due date (bill items file), else bill date' : 'bill date (no due dates in the export)',
    totals: { total: money(total), ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v)])) },
    rows,
  };
}

/** Expense (and inventory/asset purchase) lines by vendor in a period. */
export function ledgerPurchasesByVendor(ledger, { startDate, endDate }) {
  const vendorOfTx = new Map();
  for (const l of ledger.lines) if (l.ve && !vendorOfTx.has(l.t)) vendorOfTx.set(l.t, l.ve);
  const by = new Map();
  let total = 0;
  let unattributed = 0;
  for (const l of ledger.lines) {
    if (!inRange(l.d, startDate, endDate)) continue;
    const a = ledger.accounts[l.a];
    if (a?.type !== 'EXPENSE') continue;
    const amt = l.dr - l.cr;
    if (!amt) continue;
    const vendor = l.ve || vendorOfTx.get(l.t);
    if (!vendor) {
      unattributed += amt;
      continue;
    }
    const v = by.get(vendor) || { vendor, purchases: 0, lines: 0 };
    v.purchases += amt;
    v.lines++;
    by.set(vendor, v);
    total += amt;
  }
  return {
    period: { startDate, endDate },
    totals: { purchasesWithVendor: money(total), expensesWithoutVendor: money(unattributed) },
    rows: [...by.values()].sort((x, y) => y.purchases - x.purchases).map((v) => ({ ...v, purchases: money(v.purchases) })),
  };
}

// --------------------------------------------------------- transactions

/** Group lines into transactions with a one-line summary each. */
export function groupTransactions(ledger) {
  const map = new Map();
  for (const l of ledger.lines) {
    let t = map.get(l.t);
    if (!t) {
      t = { id: l.t, date: l.d, description: l.desc, lines: [] };
      map.set(l.t, t);
    }
    if (l.d < t.date) t.date = l.d;
    if (!t.description && l.desc) t.description = l.desc;
    t.lines.push(l);
  }
  return [...map.values()];
}

const lower = (s) => String(s || '').toLowerCase();

/**
 * Transaction amount as Wave's Transactions page shows it: the movement on
 * money accounts (bank, card, loan) if any, else the total of debits.
 */
export function describeTransaction(ledger, tx, { full = false } = {}) {
  const acct = (l) => ledger.accounts[l.a] || {};
  const money_ = tx.lines.filter((l) => ['CASH_AND_BANK', 'MONEY_IN_TRANSIT', 'CREDIT_CARD', 'LOANS'].includes(acct(l).subtype));
  const debits = tx.lines.reduce((s, l) => s + l.dr, 0);
  const moneyNet = money_.reduce((s, l) => s + l.dr - l.cr, 0);
  const anchor = money_[0];
  const categories = tx.lines.filter((l) => !money_.includes(l));
  // A transfer between two money accounts nets to zero across them: report
  // the amount moved and both sides instead.
  const transfer = money_.length > 1 && moneyNet === 0;
  const from = transfer ? money_.find((l) => l.cr > 0) : undefined;
  const to = transfer ? money_.find((l) => l.dr > 0) : undefined;
  const out = {
    id: tx.id,
    date: tx.date,
    description: tx.description || tx.lines.find((l) => l.ldesc)?.ldesc,
    amount: money(transfer ? money_.reduce((s, l) => s + l.dr, 0) : money_.length ? Math.abs(moneyNet) : debits),
    ...(transfer
      ? { direction: 'transfer', account: acct(from || anchor).name, toAccount: acct(to || anchor).name }
      : money_.length
        ? { direction: moneyNet > 0 ? 'deposit' : moneyNet < 0 ? 'withdrawal' : 'transfer', account: acct(anchor).name }
        : { direction: 'journal' }),
    categories: [...new Set(categories.map((l) => acct(l).name))].slice(0, 4),
  };
  for (const k of ['cu', 've', 'inv', 'bill', 'notes']) {
    const v = tx.lines.find((l) => l[k])?.[k];
    if (v) out[{ cu: 'customer', ve: 'vendor', inv: 'invoiceNumber', bill: 'billNumber', notes: 'notes' }[k]] = v;
  }
  if (full) {
    out.lines = tx.lines.map((l) => ({
      account: acct(l).name,
      type: acct(l).type || 'UNCLASSIFIED',
      ...(l.ldesc ? { description: l.ldesc } : {}),
      debit: l.dr ? money(l.dr) : undefined,
      credit: l.cr ? money(l.cr) : undefined,
      ...(l.tax ? { salesTax: l.tax } : {}),
      ...(l.taxAmt ? { salesTaxAmount: money(l.taxAmt) } : {}),
    }));
    const net = tx.lines.reduce((s, l) => s + l.dr - l.cr, 0);
    if (net) out.unbalancedBy = money(net);
  } else if (categories.length > 4) out.moreCategories = categories.length - 4;
  return out;
}

export function filterTransactions(ledger, txs, f) {
  const accountSet = f.accountIdx ? new Set(f.accountIdx) : null;
  const q = f.query ? lower(f.query) : null;
  const minA = f.minAmount != null ? Math.round(Number(f.minAmount) * 100) : null;
  const maxA = f.maxAmount != null ? Math.round(Number(f.maxAmount) * 100) : null;
  const uncategorized = (l) => ['UNCATEGORIZED_INCOME', 'UNCATEGORIZED_EXPENSE'].includes(ledger.accounts[l.a]?.subtype) || /^uncategori[sz]ed/i.test(ledger.accounts[l.a]?.name || '');
  return txs.filter((t) => {
    if (!inRange(t.date, f.startDate, f.endDate)) return false;
    if (accountSet && !t.lines.some((l) => accountSet.has(l.a))) return false;
    if (f.uncategorizedOnly && !t.lines.some(uncategorized)) return false;
    if (f.customer && !t.lines.some((l) => lower(l.cu).includes(lower(f.customer)))) return false;
    if (f.vendor && !t.lines.some((l) => lower(l.ve).includes(lower(f.vendor)))) return false;
    if (q) {
      const hay = t.lines.map((l) => [l.desc, l.ldesc, l.cu, l.ve, l.inv, l.bill, l.notes, ledger.accounts[l.a]?.name].join(' ')).join(' ');
      if (!lower(hay).includes(q)) return false;
    }
    if (minA != null || maxA != null) {
      const d = describeTransaction(ledger, t);
      const amt = Math.round(Number(d.amount) * 100);
      if (minA != null && amt < minA) return false;
      if (maxA != null && amt > maxA) return false;
    }
    if (f.direction && f.direction !== 'any') {
      const d = describeTransaction(ledger, t);
      if (d.direction !== f.direction) return false;
    }
    return true;
  });
}

export { prevDay };
