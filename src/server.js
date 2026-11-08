import fs from 'node:fs';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { registerContextTools } from './tools/context.js';
import { registerPartyTools } from './tools/parties.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerEstimateTools } from './tools/estimates.js';
import { registerTransactionTools } from './tools/transactions.js';
import { registerLiveTransactionTools } from './tools/transactions-live.js';
import { registerReportTools } from './tools/reports.js';
import { registerLedgerTools } from './tools/ledger.js';
import { HOST, PACKAGE_DIR, cli } from './cli.js';
import { LIMITATIONS_MARKDOWN } from './limitations.js';

export const SERVER_NAME = 'wave-mcp';
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** The wave-accounting skill without its frontmatter, with this machine's CLI path filled in. */
export function guideMarkdown() {
  const text = fs.readFileSync(new URL('../skills/wave-accounting/SKILL.md', import.meta.url), 'utf8').replace(/^---\n[\s\S]*?\n---\n+/, '');
  return text.replaceAll('node <package>/bin/wave-mcp.js', cli()).replaceAll('<package>', PACKAGE_DIR);
}

export const INSTRUCTIONS = `Wave accounting (waveapps.com). Call wave_get_context first; if credentials are missing or expired the user signs in with ${cli('login')} in a terminal on ${HOST}. Full guide: the wave://guide resource.
- Uses Wave's public GraphQL API, plus Wave's web-app API for transactions.
- Call wave_get_context first: it shows the businesses this credential reaches and the default one. Every other tool takes an optional businessId.
- Lists are paginated (page/pageSize, or offset/limit for reports and payments). Ask for small pages, follow nextPage/nextOffset only when needed, and prefer detail="summary".
- Transactions (live): wave_list_transactions, wave_summarize_transactions, wave_get_transaction, wave_update_transaction and wave_delete_transaction use Wave's web-app API, which needs a browser session (wave_get_context shows auth.webSession). Sessions end when the user signs out of Wave or they time out; then ask the user to run ${cli('login')} in a terminal on ${HOST} and paste a request copied from the Wave web app (the command explains how). No restart is needed. For totals (spend per category, month or vendor) call wave_summarize_transactions rather than paging through rows. accountId filters by the bank/card account; categoryIds by income/expense category. Edits send the transaction's sequence, so they never overwrite a newer change.
- Wave's public API has no reports. wave_run_report computes them from an imported Data Export (wave_import_ledger, a snapshot: check ledger.importedAt) or falls back to invoices and current balances; every report states its basis. wave_list_ledger_transactions searches that snapshot.
- Never ask the user to paste access tokens, session tokens or curl commands into the chat. The user sets credentials in a terminal on ${HOST}: ${cli('login')} (pastes a request copied from the browser) or ${cli('secrets set WAVE_ACCESS_TOKEN')}. You may run ${cli('check')} yourself to verify; it prints no secrets.
- Writes change real books. wave_send_* tools email real customers; confirm recipients and amounts with the user first. wave_create_transaction supports dryRun.
- Line items on invoices and estimates must reference a product (wave_list_products).
- Not available at all: bills, bill payments, reconciliation, receipts and tags (see wave://limitations). Say so instead of searching for them; aged_payables needs an imported Data Export.`;

/**
 * Build one MCP server instance over the shared WaveContext. Cheap: under
 * HTTP this runs per request, under stdio once per connection.
 */
export function createServer(ctx) {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION, title: 'Wave Accounting' }, { instructions: INSTRUCTIONS });

  registerContextTools(server, ctx);
  registerPartyTools(server, ctx);
  registerCatalogTools(server, ctx);
  registerInvoiceTools(server, ctx);
  registerEstimateTools(server, ctx);
  registerTransactionTools(server, ctx);
  registerLiveTransactionTools(server, ctx);
  registerReportTools(server, ctx);
  registerLedgerTools(server, ctx);

  server.registerResource(
    'limitations',
    'wave://limitations',
    { title: 'What Wave\'s API cannot do', description: 'Gaps in Wave\'s public API and the reports this server cannot produce', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: LIMITATIONS_MARKDOWN }] }),
  );
  server.registerResource(
    'guide',
    'wave://guide',
    {
      title: 'How to use this server and sign in',
      description: 'Usage guide for agents: first steps, the sign-in command the user runs, tool map and safety rules (the wave-accounting skill)',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guideMarkdown() }] }),
  );
  server.registerResource(
    'schema',
    'wave://schema',
    { title: 'Wave GraphQL schema (SDL)', description: 'Full public schema snapshot, for wave_graphql_query (about 135 KB)', mimeType: 'application/graphql' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/graphql', text: fs.readFileSync(new URL('../schema/wave.graphql', import.meta.url), 'utf8') }] }),
  );

  registerPrompts(server);
  return server;
}

function registerPrompts(server) {
  const user = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

  server.registerPrompt(
    'month_end_review',
    {
      title: 'Month-end review',
      description: 'Review a month: sales, payments received, receivables and tax collected',
      argsSchema: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).describe('Month to review, YYYY-MM') }),
    },
    ({ month }) => {
      const [y, m] = month.split('-').map(Number);
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const start = `${month}-01`;
      return user(
        `Do a month-end review of my Wave books for ${month} (${start} to ${end}). Use wave_run_report with invoice_summary, income_by_customer, sales_by_product and sales_tax for that range, wave_list_payments for payments received, and aged_receivables for what is still owed. Summarize totals, the largest customers, overdue invoices and anything unusual. Keep each report call to limit 10 unless I ask for more.`,
      );
    },
  );

  server.registerPrompt(
    'chase_overdue_invoices',
    { title: 'Chase overdue invoices', description: 'Find overdue invoices and plan follow-ups' },
    () =>
      user(
        'Run wave_run_report aged_receivables and list my overdue invoices by customer, oldest first. For each, suggest a short follow-up message. Do not send anything until I confirm each one.',
      ),
  );

  server.registerPrompt(
    'record_expense',
    {
      title: 'Record an expense',
      description: 'Record a purchase as a categorized money transaction',
      argsSchema: z.object({
        description: z.string().describe('What was bought and from whom'),
        amount: z.string().describe('Total paid, e.g. 45.99'),
        date: z.string().describe('YYYY-MM-DD'),
        paidFrom: z.string().optional().describe('Bank account or card name'),
      }),
    },
    ({ description, amount, date, paidFrom }) =>
      user(
        `Record this expense in Wave: "${description}", ${amount}, on ${date}${paidFrom ? `, paid from ${paidFrom}` : ''}. Find the payment account with wave_list_accounts (CASH_AND_BANK or CREDIT_CARD) and the best expense category (types=[EXPENSE]). Show me the plan, run wave_create_transaction with dryRun=true, and create it only after I confirm.`,
      ),
  );
}
