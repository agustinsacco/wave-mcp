import { cli } from './cli.js';

/**
 * What Wave's public GraphQL API cannot do, verified against live
 * introspection (schema/wave.graphql), and how this server fills the gaps.
 * Surfaced in wave_get_context, the wave://limitations resource and tool
 * descriptions, so the model does not promise data it cannot get.
 */
export const LIMITATIONS = {
  summary: [
    `No transaction reads or edits in the public API: it can only create them. wave_list_transactions, wave_get_transaction, wave_update_transaction and wave_delete_transaction use Wave's web-app API instead (unofficial; needs a browser session stored with ${cli('login')}, which expires). For dated reports, import Wave's Data Export (Settings → Data Export → Accounting) with wave_import_ledger; the ledger reports then work as of the export date.`,
    'No native reports. wave_run_report computes them: from the imported ledger (any date range: P&L, balance sheet, cash flow, trial balance, account transactions, sales tax, aged payables, purchases by vendor), or live from the API (invoices, payments, current account balances).',
    'Without an imported ledger, account balances are current only (no as-of date) and there are no bills or expenses by date.',
    'No payroll data and no tax-line mapping, so Payroll Wage & Tax, Payroll Benefits & Deductions and Tax Line reports are not possible.',
    'Vendors are read-only (no create/update/delete).',
    'No un-archive for accounts, products or sales taxes (web app only), and no file attachment uploads.',
    'Invoice and estimate line items must reference a product.',
  ],
  /** Reports that need the imported ledger. */
  ledgerOnlyReports: {
    cash_flow: 'Needs the transaction journal.',
    account_transactions: 'Needs the transaction journal (general ledger).',
    general_ledger: 'Needs the transaction journal (alias of account_transactions).',
    aged_payables: 'Bills are not exposed by the public API; the journal has them.',
    purchases_by_vendor: 'Expenses by vendor are not exposed by the public API; the journal has them.',
  },
  unsupportedReports: {
    tax_line: 'Tax-line mapping is not in the API or the Data Export.',
    payroll_wage_tax: 'Payroll data is not in the public API or the accounting export.',
    payroll_benefits_deductions: 'Payroll data is not in the public API or the accounting export.',
  },
};

export const LIMITATIONS_MARKDOWN = `# Wave public API: what is and is not possible

${LIMITATIONS.summary.map((s) => `- ${s}`).join('\n')}

## Reports that need an imported ledger (wave_import_ledger)

${Object.entries(LIMITATIONS.ledgerOnlyReports)
  .map(([k, v]) => `- **${k}**: ${v}`)
  .join('\n')}

## Reports this server cannot produce

${Object.entries(LIMITATIONS.unsupportedReports)
  .map(([k, v]) => `- **${k}**: ${v}`)
  .join('\n')}

Use the Wave web app (Reports) for these.
`;
