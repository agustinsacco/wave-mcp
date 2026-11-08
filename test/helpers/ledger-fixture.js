import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * A small set of books in the layout of Wave's Data Export accounting CSV
 * (two-column approach). Account names match the fake Wave chart of
 * accounts, plus two accounts Wave's API does not list (classified from the
 * export labels).
 */
export const HEADERS = [
  'Transaction ID', 'Transaction Date', 'Account Name', 'Transaction Description', 'Transaction Line Description',
  'Amount (One column)', 'Debit Amount (Two Column Approach)', 'Credit Amount (Two Column Approach)',
  'Other Accounts for this Transaction', 'Customer', 'Vendor', 'Invoice Number', 'Bill Number', 'Notes / Memo',
  'Amount Before Sales Tax', 'Sales Tax Amount', 'Sales Tax Name', 'Transaction Date Added', 'Transaction Date Last Modified',
  'Account Group', 'Account Type', 'Account ID',
];

const LABELS = {
  Chequing: ['Asset', 'Cash and Bank'],
  'Accounts Receivable': ['Asset', 'Expected Payments from Customers'],
  Visa: ['Liability', 'Credit Card'],
  'HST Payable': ['Liability', 'Sales Tax on Sales and Purchases'],
  'Accounts Payable': ['Liability', 'Expected Payments to Vendors'],
  'Owner Investment': ['Equity', 'Business Owner Contribution and Drawing'],
  Sales: ['Income', 'Income'],
  Materials: ['Expense', 'Cost of Goods Sold'],
  Rent: ['Expense', 'Operating Expense'],
  'Uncategorized Expense': ['Expense', 'Uncategorized Expense'],
};

// [id, date, description, extra, lines: [account, debit, credit, lineDescription?]]
export const TRANSACTIONS = [
  ['1001', '2025-12-15', 'Owner investment', {}, [['Chequing', '3,000.00', ''], ['Owner Investment', '', '3,000.00']]],
  ['1002', '2025-12-20', 'Cash sale', {}, [['Chequing', '1,130.00', ''], ['Sales', '', '1,000.00'], ['HST Payable', '', '130.00']]],
  ['1003', '2026-01-10', 'Invoice 1', { customer: 'Globex', invoice: '1' }, [['Accounts Receivable', '2,260.00', ''], ['Sales', '', '2,000.00', 'Design work'], ['HST Payable', '', '260.00']]],
  ['1004', '2026-01-25', 'Invoice Payment', { customer: 'Globex', invoice: '1' }, [['Chequing', '2,260.00', ''], ['Accounts Receivable', '', '2,260.00']]],
  ['1005', '2026-02-01', 'February rent', { vendor: 'Landlord Inc' }, [['Rent', '900.00', ''], ['Chequing', '', '900.00']]],
  ['1006', '2026-02-05', 'Lumber', { vendor: 'Supply Co' }, [['Materials', '500.00', ''], ['HST Payable', '65.00', ''], ['Visa', '', '565.00']]],
  ['1007', '2026-02-10', 'Bill B-7', { vendor: 'Supply Co', bill: 'B-7' }, [['Materials', '300.00', ''], ['Accounts Payable', '', '300.00']]],
  ['1008', '2026-03-01', 'AMAZON MKTP CA', {}, [['Uncategorized Expense', '45.50', ''], ['Chequing', '', '45.50']]],
  ['1009', '2026-03-15', 'HST remittance', { notes: 'Q4 filing' }, [['HST Payable', '130.00', ''], ['Chequing', '', '130.00']]],
  ['1010', '2026-03-20', 'Visa payment', {}, [['Visa', '565.00', ''], ['Chequing', '', '565.00']]],
];

const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);

export function accountingCsv({ transactions = TRANSACTIONS, labels = true } = {}) {
  const rows = [HEADERS];
  for (const [id, d, desc, extra, lines] of transactions) {
    const others = (self) => lines.filter((l) => l[0] !== self).map((l) => l[0]).join(', ');
    for (const [account, dr, cr, ldesc] of lines) {
      const num = (s) => Number(String(s).replace(/,/g, '')) || 0;
      const one = (num(dr) - num(cr)).toFixed(2);
      rows.push([
        id, d, account, desc, ldesc || '', one, dr, cr, others(account), extra.customer || '', extra.vendor || '', extra.invoice || '', extra.bill || '', extra.notes || '',
        '', '', '', d, d, labels ? LABELS[account][0] : '', labels ? LABELS[account][1] : '', '',
      ]);
    }
  }
  return '\ufeff' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

/** Minimal zip writer (deflate) for tests. */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const raw = Buffer.from(data);
    const comp = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Write a Data Export zip (accounting + customers + bill items) to a temp dir. */
export function writeExportZip(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-export-'));
  const file = path.join(dir, 'Acme_Studio_export.zip');
  const bills = 'Bill Number,Vendor,Bill Date,Due Date,Product,Amount\r\nB-7,Supply Co,2026-02-10,2026-03-12,Lumber,300.00\r\n';
  fs.writeFileSync(
    file,
    makeZip([
      { name: 'accounting.csv', data: accountingCsv(opts) },
      { name: 'customers.csv', data: 'Customer,Email\r\nGlobex,ap@globex.test\r\n' },
      { name: 'bill_items.csv', data: bills },
    ]),
  );
  return { dir, file };
}

export function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wave-data-'));
}
