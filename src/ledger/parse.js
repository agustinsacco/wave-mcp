/**
 * Parse Wave's Data Export "accounting" CSV (the full journal: one row per
 * transaction line) into normalized ledger lines.
 *
 * Wave does not publish the export's headers, so columns are matched by name
 * with aliases (exact first, then prefix). Known headers include:
 *   Transaction ID, Transaction Date, Account Name, Transaction Description,
 *   Transaction Line Description, Amount (One column), Debit Amount (Two
 *   Column Approach), Credit Amount (Two Column Approach), Other Accounts for
 *   this Transaction, Customer, Vendor, Invoice Number, Bill Number,
 *   Notes / Memo, Amount Before Sales Tax, Sales Tax Amount, Sales Tax Name,
 *   Transaction Date Added, Transaction Date Last Modified, Account Group,
 *   Account Type, Account ID.
 */
import { parseCsv } from './files.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const COLUMNS = {
  txId: ['Transaction ID', 'Transaction Id', 'Transaction Number', 'Journal ID'],
  date: ['Transaction Date', 'Date'],
  account: ['Account Name', 'Account'],
  accountId: ['Account ID', 'Account Id', 'Account Number'],
  accountGroup: ['Account Group', 'Account Category'],
  accountType: ['Account Type', 'Account Subtype', 'Account Sub Type'],
  description: ['Transaction Description', 'Description'],
  lineDescription: ['Transaction Line Description', 'Line Description'],
  debit: ['Debit Amount (Two Column Approach)', 'Debit Amount', 'Debit', 'Debits'],
  credit: ['Credit Amount (Two Column Approach)', 'Credit Amount', 'Credit', 'Credits'],
  amount: ['Amount (One column)', 'Amount (One Column Approach)', 'Amount'],
  customer: ['Customer', 'Customer Name'],
  vendor: ['Vendor', 'Vendor Name', 'Supplier'],
  invoiceNumber: ['Invoice Number', 'Invoice #', 'Invoice No'],
  billNumber: ['Bill Number', 'Bill #', 'Bill No'],
  notes: ['Notes / Memo', 'Notes', 'Memo'],
  otherAccounts: ['Other Accounts for this Transaction'],
  taxName: ['Sales Tax Name'],
  taxAmount: ['Sales Tax Amount'],
  amountBeforeTax: ['Amount Before Sales Tax'],
  dateAdded: ['Transaction Date Added'],
  dateModified: ['Transaction Date Last Modified'],
  currency: ['Currency', 'Currency Code'],
};

export function mapHeaders(headers, columns = COLUMNS) {
  const normalized = headers.map(norm);
  const map = {};
  const used = new Set();
  // Pass 1: exact matches, so "Amount" never steals "Amount Before Sales Tax".
  for (const [key, aliases] of Object.entries(columns)) {
    for (const alias of aliases) {
      const i = normalized.findIndex((h, idx) => !used.has(idx) && h === norm(alias));
      if (i >= 0) {
        map[key] = i;
        used.add(i);
        break;
      }
    }
  }
  // Pass 2: prefix matches for anything still unmapped ("Debit Amount (...)").
  for (const [key, aliases] of Object.entries(columns)) {
    if (key in map || key === 'amount') continue;
    for (const alias of aliases) {
      const a = norm(alias);
      if (a.length < 5) continue;
      const i = normalized.findIndex((h, idx) => !used.has(idx) && h.startsWith(a));
      if (i >= 0) {
        map[key] = i;
        used.add(i);
        break;
      }
    }
  }
  return map;
}

/** Parse an amount like "1,234.56", "$12", "(12.50)", "-3" into integer cents. NaN if unreadable. */
export function parseAmountMinor(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s$€£¥,']/g, '').replace(/^[A-Z]{3}/i, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  const m = s.match(/^(\d*)(?:\.(\d+))?$/);
  if (!m || (!m[1] && !m[2])) return NaN;
  const frac = (m[2] || '') + '000';
  let minor = Number(m[1] || '0') * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) minor += 1;
  return neg ? -minor : minor;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

/**
 * Build a date parser for a whole column, so ambiguous numeric dates
 * (03/04/2026) are resolved consistently: day-first only if some value
 * proves it (a first part above 12).
 */
export function dateParserFor(samples) {
  const dayFirst = samples.some((s) => {
    const m = String(s).trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    return m && Number(m[1]) > 12;
  });
  return (raw) => {
    const s = String(raw ?? '').trim();
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return iso(m[1], Number(m[2]), Number(m[3]));
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (m) return dayFirst ? iso(m[3], Number(m[2]), Number(m[1])) : iso(m[3], Number(m[1]), Number(m[2]));
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return iso(m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]));
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
    m = s.match(/^(\d{4})[/-]([A-Za-z]{3,9})[/-](\d{1,2})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(m[1], MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[3]));
    return null;
  };
}

export class LedgerParseError extends Error {}

/**
 * @returns {{ lines, accounts, stats, warnings, convention, columns }}
 *   lines: { t, d, a, dr, cr, desc, ldesc, cu, ve, inv, bill, notes, tax, taxAmt, cur }
 *   accounts: { name, id, group, type } (index = line.a)
 */
export function parseAccountingCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new LedgerParseError('The accounting CSV is empty.');
  const headerIdx = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 3);
  const headers = rows[headerIdx].map((h) => h.trim());
  const col = mapHeaders(headers);
  const show = () => headers.slice(0, 40).map((h) => h.slice(0, 40)).join(' | ');
  const hasTwo = 'debit' in col && 'credit' in col;
  if (!('date' in col) || !('account' in col) || (!hasTwo && !('amount' in col))) {
    const looksLikeReport = rows.slice(0, 8).some((r) => r.some((c) => /starting balance|account transactions|general ledger/i.test(c)));
    throw new LedgerParseError(
      looksLikeReport
        ? 'This looks like a report export (Account Transactions report), not the journal. Use Settings → Data Export → Accounting (CSV) and import the zip or its accounting CSV.'
        : `Unrecognized columns. Need a date, an account and debit/credit (or amount) columns. Found: ${show()}`,
    );
  }
  if (!('txId' in col)) throw new LedgerParseError(`No transaction ID column, so lines cannot be grouped into transactions. Found: ${show()}`);

  const dataRows = rows.slice(headerIdx + 1).filter((r) => r.some((c) => c.trim()));
  const get = (r, k) => (k in col ? (r[col[k]] ?? '').trim() : '');
  const parseDate = dateParserFor(dataRows.slice(0, 500).map((r) => get(r, 'date')));

  const accounts = [];
  const accountIndex = new Map();
  const lines = [];
  const warnings = [];
  let badDates = 0;
  let badAmounts = 0;

  for (const r of dataRows) {
    const accountName = get(r, 'account');
    if (!accountName) continue;
    const d = parseDate(get(r, 'date'));
    if (!d) {
      badDates++;
      continue;
    }
    let dr;
    let cr;
    if (hasTwo) {
      dr = parseAmountMinor(get(r, 'debit'));
      cr = parseAmountMinor(get(r, 'credit'));
      // A negative in one column is the opposite side.
      if (dr < 0) [dr, cr] = [0, (cr || 0) - dr];
      if (cr < 0) [cr, dr] = [0, (dr || 0) - cr];
    } else {
      const amt = parseAmountMinor(get(r, 'amount'));
      dr = amt > 0 ? amt : 0;
      cr = amt < 0 ? -amt : 0;
    }
    if (!Number.isFinite(dr) || !Number.isFinite(cr)) {
      badAmounts++;
      continue;
    }
    const key = `${get(r, 'accountId')}|${accountName}`;
    if (!accountIndex.has(key)) {
      accountIndex.set(key, accounts.length);
      accounts.push({ name: accountName, id: get(r, 'accountId') || undefined, group: get(r, 'accountGroup') || undefined, type: get(r, 'accountType') || undefined });
    }
    const line = {
      t: get(r, 'txId') || `row-${lines.length}`,
      d,
      a: accountIndex.get(key),
      dr,
      cr,
    };
    const opt = { desc: 'description', ldesc: 'lineDescription', cu: 'customer', ve: 'vendor', inv: 'invoiceNumber', bill: 'billNumber', notes: 'notes', tax: 'taxName', cur: 'currency' };
    for (const [short, long] of Object.entries(opt)) {
      const v = get(r, long);
      if (v) line[short] = v;
    }
    const taxAmt = get(r, 'taxAmount');
    if (taxAmt && Number.isFinite(parseAmountMinor(taxAmt))) line.taxAmt = parseAmountMinor(taxAmt);
    lines.push(line);
  }

  if (!lines.length) throw new LedgerParseError(`No usable rows (${badDates} with unreadable dates, ${badAmounts} with unreadable amounts).`);
  if (badDates) warnings.push(`${badDates} rows skipped: unreadable date.`);
  if (badAmounts) warnings.push(`${badAmounts} rows skipped: unreadable amount.`);

  // Every transaction's debits must equal its credits.
  const net = new Map();
  for (const l of lines) net.set(l.t, (net.get(l.t) || 0) + l.dr - l.cr);
  const unbalanced = [...net].filter(([, v]) => v !== 0).map(([t, v]) => ({ transactionId: t, off: (v / 100).toFixed(2) }));
  if (unbalanced.length) warnings.push(`${unbalanced.length} transactions do not balance (debits ≠ credits); first: ${unbalanced.slice(0, 5).map((u) => `${u.transactionId} by ${u.off}`).join(', ')}.`);

  lines.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return {
    lines,
    accounts,
    warnings,
    convention: hasTwo ? 'debit/credit columns' : 'single amount column (positive = debit)',
    columns: Object.fromEntries(Object.entries(col).map(([k, i]) => [k, headers[i]])),
    stats: { lines: lines.length, transactions: net.size, accounts: accounts.length, firstDate: lines[0].d, lastDate: lines.at(-1).d, unbalanced: unbalanced.length },
  };
}

/** Bill items CSV (from the same export): bill number → { vendor, date, dueDate }. Best effort. */
export function parseBillItemsCsv(text) {
  if (!text) return [];
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  const col = mapHeaders(headers, {
    billNumber: ['Bill Number', 'Bill #', 'Bill No', 'Bill ID'],
    vendor: ['Vendor', 'Vendor Name'],
    date: ['Bill Date', 'Date'],
    dueDate: ['Due Date', 'Payment Due Date', 'Payment Due'],
    total: ['Bill Total', 'Total', 'Amount Due', 'Amount'],
  });
  if (!('billNumber' in col)) return [];
  const get = (r, k) => (k in col ? (r[col[k]] ?? '').trim() : '');
  const parseDate = dateParserFor(rows.slice(1, 500).flatMap((r) => [get(r, 'date'), get(r, 'dueDate')]));
  const bills = new Map();
  for (const r of rows.slice(1)) {
    const n = get(r, 'billNumber');
    if (!n || bills.has(n)) continue;
    bills.set(n, { billNumber: n, vendor: get(r, 'vendor') || undefined, date: parseDate(get(r, 'date')) || undefined, dueDate: parseDate(get(r, 'dueDate')) || undefined });
  }
  return [...bills.values()];
}
