/**
 * Decide each ledger account's type (ASSET, LIABILITY, EQUITY, INCOME,
 * EXPENSE) and Wave subtype. Wave's own chart of accounts (public API) is
 * authoritative; the export's "Account Group"/"Account Type" labels are the
 * fallback. Account names are never used to guess: a wrong guess would put
 * money in the wrong report section silently.
 */
export const SUBTYPE_TYPE = {
  CASH_AND_BANK: 'ASSET', MONEY_IN_TRANSIT: 'ASSET', RECEIVABLE: 'ASSET', RECEIVABLE_INVOICES: 'ASSET', RECEIVABLE_OTHER: 'ASSET',
  INVENTORY: 'ASSET', PROPERTY_PLANT_EQUIPMENT: 'ASSET', DEPRECIATION_AND_AMORTIZATION: 'ASSET', VENDOR_PREPAYMENTS_AND_CREDITS: 'ASSET',
  OTHER_CURRENT_ASSETS: 'ASSET', OTHER_LONG_TERM_ASSETS: 'ASSET',
  CREDIT_CARD: 'LIABILITY', LOANS: 'LIABILITY', PAYABLE: 'LIABILITY', PAYABLE_BILLS: 'LIABILITY', PAYABLE_OTHER: 'LIABILITY',
  SALES_TAX: 'LIABILITY', DUE_FOR_PAYROLL: 'LIABILITY', DUE_TO_YOU_AND_OTHER_OWNERS: 'LIABILITY', CUSTOMER_PREPAYMENTS_AND_CREDITS: 'LIABILITY',
  SYSTEM_CUSTOMER_CREDITS: 'LIABILITY', OTHER_CURRENT_LIABILITY: 'LIABILITY', OTHER_LONG_TERM_LIABILITY: 'LIABILITY',
  NON_RETAINED_EARNINGS: 'EQUITY', RETAINED_EARNINGS: 'EQUITY',
  INCOME: 'INCOME', DISCOUNTS: 'INCOME', OTHER_INCOME: 'INCOME', UNCATEGORIZED_INCOME: 'INCOME', GAIN_ON_FOREIGN_EXCHANGE: 'INCOME',
  EXPENSE: 'EXPENSE', COST_OF_GOODS_SOLD: 'EXPENSE', PAYMENT_PROCESSING_FEES: 'EXPENSE', PAYROLL_EXPENSES: 'EXPENSE',
  UNCATEGORIZED_EXPENSE: 'EXPENSE', LOSS_ON_FOREIGN_EXCHANGE: 'EXPENSE',
};

// Wave's display labels for subtypes, most specific first.
const LABEL_RULES = [
  [/cash (and|&) bank/, 'CASH_AND_BANK'],
  [/money in transit/, 'MONEY_IN_TRANSIT'],
  [/expected payments from customers|accounts receivable|^receivable/, 'RECEIVABLE'],
  [/inventory/, 'INVENTORY'],
  [/property,? plant/, 'PROPERTY_PLANT_EQUIPMENT'],
  [/depreciation/, 'DEPRECIATION_AND_AMORTIZATION'],
  [/vendor prepayments|vendor credits/, 'VENDOR_PREPAYMENTS_AND_CREDITS'],
  [/other short.?term asset|other current asset/, 'OTHER_CURRENT_ASSETS'],
  [/other long.?term asset/, 'OTHER_LONG_TERM_ASSETS'],
  [/credit card/, 'CREDIT_CARD'],
  [/loan|line of credit/, 'LOANS'],
  [/expected payments to vendors|accounts payable|^payable/, 'PAYABLE'],
  [/sales tax/, 'SALES_TAX'],
  [/due for payroll|payroll liabilit/, 'DUE_FOR_PAYROLL'],
  [/due to you and other/, 'DUE_TO_YOU_AND_OTHER_OWNERS'],
  [/customer prepayments|customer credits/, 'CUSTOMER_PREPAYMENTS_AND_CREDITS'],
  [/other short.?term liabilit|other current liabilit/, 'OTHER_CURRENT_LIABILITY'],
  [/other long.?term liabilit/, 'OTHER_LONG_TERM_LIABILITY'],
  [/owner contribution|owner investment|drawing/, 'NON_RETAINED_EARNINGS'],
  [/retained earnings/, 'RETAINED_EARNINGS'],
  [/gain on foreign exchange/, 'GAIN_ON_FOREIGN_EXCHANGE'],
  [/loss on foreign exchange/, 'LOSS_ON_FOREIGN_EXCHANGE'],
  [/uncategori[sz]ed income/, 'UNCATEGORIZED_INCOME'],
  [/uncategori[sz]ed expense/, 'UNCATEGORIZED_EXPENSE'],
  [/other income/, 'OTHER_INCOME'],
  [/discount/, 'DISCOUNTS'],
  [/cost of goods sold/, 'COST_OF_GOODS_SOLD'],
  [/payment processing fee/, 'PAYMENT_PROCESSING_FEES'],
  [/payroll expense/, 'PAYROLL_EXPENSES'],
  [/operating expense/, 'EXPENSE'],
  [/^income$/, 'INCOME'],
  [/^expenses?$/, 'EXPENSE'],
];

const GROUP_RULES = [
  [/asset/, 'ASSET'],
  [/liabilit|credit card/, 'LIABILITY'],
  [/equity/, 'EQUITY'],
  [/income|revenue/, 'INCOME'],
  [/expense/, 'EXPENSE'],
];

export function classifyLabels(group, typeLabel) {
  const t = String(typeLabel || '').toLowerCase().trim();
  const g = String(group || '').toLowerCase().trim();
  const upper = String(typeLabel || '').trim().toUpperCase().replace(/[^A-Z]+/g, '_');
  let subtype = SUBTYPE_TYPE[upper] ? upper : null;
  if (!subtype) for (const [re, st] of LABEL_RULES) if (t && re.test(t)) {
    subtype = st;
    break;
  }
  let type = subtype ? SUBTYPE_TYPE[subtype] : null;
  if (!type) for (const [re, ty] of GROUP_RULES) if (re.test(g) || re.test(t)) {
    type = ty;
    break;
  }
  return { type, subtype };
}

const key = (s) => String(s || '').trim().toLowerCase();

/**
 * @param ledgerAccounts [{ name, id, group, type }] from the export
 * @param apiAccounts    Wave Account nodes (may be null when there are no credentials)
 */
export function classifyAccounts(ledgerAccounts, apiAccounts) {
  const byClassic = new Map();
  const byName = new Map();
  for (const a of apiAccounts || []) {
    if (a.classicId) byClassic.set(String(a.classicId), a);
    const k = key(a.name);
    if (!byName.has(k)) byName.set(k, a);
    else byName.set(k, 'ambiguous');
  }
  return ledgerAccounts.map((la) => {
    let api = (la.id && byClassic.get(String(la.id))) || byName.get(key(la.name));
    if (api === 'ambiguous') api = undefined;
    if (api) {
      return {
        name: la.name,
        id: api.id,
        displayId: api.displayId || undefined,
        type: api.type?.value,
        subtype: api.subtype?.value,
        subtypeName: api.subtype?.name,
        currency: api.currency?.code,
        source: 'wave',
      };
    }
    const fromLabels = classifyLabels(la.group, la.type);
    return {
      name: la.name,
      type: fromLabels.type,
      subtype: fromLabels.subtype,
      subtypeName: la.type || la.group,
      source: fromLabels.type ? 'export' : null,
    };
  });
}

export const MONEY_SUBTYPES = new Set(['CASH_AND_BANK', 'MONEY_IN_TRANSIT', 'CREDIT_CARD', 'LOANS']);
export const CASH_SUBTYPES = new Set(['CASH_AND_BANK', 'MONEY_IN_TRANSIT']);
export const DEBIT_NORMAL = new Set(['ASSET', 'EXPENSE']);
export const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
