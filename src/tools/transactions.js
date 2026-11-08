import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { OPS } from '../wave/operations.js';
import { WaveApiError, WaveError } from '../wave/errors.js';
import { scanConnection } from '../wave/scan.js';
import { fromMinor, toMinor } from '../format.js';
import { CREATE, businessId, date, defineTool, defined, positiveAmount } from './common.js';

const lineItemSchema = z.object({
  accountId: z.string().min(1).describe('Category account (income, expense, liability...). Never another bank/card account: transfers are not supported by the API'),
  amount: positiveAmount,
  balance: z
    .enum(['INCREASE', 'DECREASE', 'DEBIT', 'CREDIT'])
    .default('INCREASE')
    .describe('INCREASE (default) grows the category: more income for a sale, more expense for a purchase. DECREASE for refunds. DEBIT/CREDIT for accountants'),
  customerId: z.string().optional(),
  description: z.string().optional(),
  taxes: z
    .array(z.object({ salesTaxId: z.string().min(1), amount: positiveAmount }))
    .optional()
    .describe('Sales tax amounts on this line'),
});

const transactionSchema = {
  externalId: z.string().min(1).max(255).optional().describe('Your reference for idempotent imports; a UUID is generated when omitted'),
  date,
  description: z.string().min(1).describe('Shown in Wave\'s transaction list, e.g. the payee'),
  notes: z.string().optional(),
  anchor: z
    .object({
      accountId: z.string().min(1).describe('The real-world account the money moved through: a CASH_AND_BANK asset, CREDIT_CARD or LOANS liability'),
      amount: positiveAmount,
      direction: z.enum(['DEPOSIT', 'WITHDRAWAL']).describe('DEPOSIT = money in, WITHDRAWAL = money out'),
    })
    .describe('Bank/card side of the transaction'),
  lineItems: z.array(lineItemSchema).min(1).max(50).describe('How the amount is categorized; must add up to the anchor amount'),
};

/**
 * Wave rejects unbalanced transactions with an error that names neither
 * figure. Check locally, in integer cents. Wave's docs only say the line
 * items must total the anchor; with taxes present the anchor may equal the
 * line amounts alone or lines plus taxes, so both are accepted.
 */
export function checkBalanced(tx, label = 'Transaction') {
  const anchor = toMinor(tx.anchor.amount);
  const lines = tx.lineItems.reduce((sum, li) => sum + toMinor(li.amount), 0);
  const taxes = tx.lineItems.reduce((sum, li) => sum + (li.taxes || []).reduce((s, t) => s + toMinor(t.amount), 0), 0);
  if (anchor === lines || (taxes > 0 && anchor === lines + taxes)) return { anchor: fromMinor(anchor), lines: fromMinor(lines), taxes: fromMinor(taxes) };
  const detail = taxes > 0 ? ` (or ${fromMinor(lines + taxes)} including ${fromMinor(taxes)} of taxes)` : '';
  throw new WaveError(
    `${label} does not balance: the anchor is ${fromMinor(anchor)} but the line items total ${fromMinor(lines)}${detail}. Adjust line amounts so they add up to the anchor.`,
    { code: 'UNBALANCED' },
  );
}

const flip = (side) => (side === 'DEBIT' ? 'CREDIT' : 'DEBIT');

/**
 * Wave needs at least one debit and one credit. A DEPOSIT debits the anchor
 * and a WITHDRAWAL credits it; INCREASE puts a line on its account's normal
 * side and DECREASE on the other. When every line lands on the anchor's side
 * Wave refuses the transaction alone, and inside a bulk request its server
 * crashes without naming the culprit (verified live), so catch it here.
 * Lines on unknown accounts are left to Wave.
 */
export function checkSides(tx, accountsById, label = 'Transaction') {
  const anchorSide = tx.anchor.direction === 'DEPOSIT' ? 'DEBIT' : 'CREDIT';
  for (const li of tx.lineItems) {
    const balance = li.balance || 'INCREASE';
    if (balance === 'DEBIT' || balance === 'CREDIT') {
      if (balance !== anchorSide) return;
      continue;
    }
    const normal = accountsById.get(li.accountId)?.normalBalanceType;
    if (!normal) return;
    if ((balance === 'INCREASE' ? normal : flip(normal)) !== anchorSide) return;
  }
  const anchorName = accountsById.get(tx.anchor.accountId)?.name || 'the anchor account';
  const names = [...new Set(tx.lineItems.map((li) => accountsById.get(li.accountId)?.name).filter(Boolean))].join(', ');
  const fix =
    tx.anchor.direction === 'DEPOSIT'
      ? 'Money in needs credit lines: INCREASE an income, liability or equity account, or DECREASE an expense or asset (for example a refund of an expense).'
      : 'Money out needs debit lines: INCREASE an expense or asset account, or DECREASE an income, liability or equity account (for example a refund to a customer).';
  throw new WaveError(
    `${label}: the ${tx.anchor.direction.toLowerCase()} on ${anchorName} and every line (${names}) are all on the ${anchorSide.toLowerCase()} side, so Wave would reject it. ${fix}`,
    { code: 'BAD_INPUT' },
  );
}

/** Account id → { name, normalBalanceType }, cached; null if it cannot be read (the check is then skipped). */
async function accountSides(ctx, bid) {
  try {
    return await ctx.cache.get(`acct-sides:${bid}`, async () => {
      const map = new Map();
      for (const isArchived of [false, true]) {
        const scan = await scanConnection(ctx.client, OPS.ListAccounts, { businessId: bid, isArchived }, 'accounts', { limit: ctx.config.scanLimit });
        for (const a of scan.nodes) map.set(a.id, { name: a.name, normalBalanceType: a.normalBalanceType });
      }
      return map;
    });
  } catch (error) {
    ctx.logger.debug(`account sides unavailable: ${error.message}`);
    return new Map();
  }
}

function toInput(tx) {
  return {
    ...defined({ notes: tx.notes }),
    externalId: tx.externalId || `wave-mcp-${randomUUID()}`,
    date: tx.date,
    description: tx.description,
    anchor: { accountId: tx.anchor.accountId, amount: String(tx.anchor.amount), direction: tx.anchor.direction },
    lineItems: tx.lineItems.map((li) =>
      defined({
        accountId: li.accountId,
        amount: String(li.amount),
        balance: li.balance || 'INCREASE',
        customerId: li.customerId,
        description: li.description,
        taxes: li.taxes?.map((t) => ({ salesTaxId: t.salesTaxId, amount: String(t.amount) })),
      }),
    ),
  };
}

export function registerTransactionTools(server, ctx) {
  defineTool(server, ctx, {
    name: 'wave_create_transaction',
    title: 'Create money transaction',
    toolset: 'transactions',
    annotations: CREATE,
    description:
      'Record a bank/credit-card transaction and categorize it, as if entered in Wave\'s Transactions page. ' +
      'Expense paid by card: anchor {accountId: card, direction: WITHDRAWAL}, line {accountId: expense category, balance: INCREASE}. ' +
      'Sale deposited to bank: anchor {bank, DEPOSIT}, line {income account, INCREASE}. Split across several lines; they must total the anchor. ' +
      'Keep the returned id: wave_get_transaction / wave_list_transactions read it back. Use dryRun=true to validate without writing. Wave does not document de-duplication by externalId: if a call timed out, check the Wave web app before retrying.',
    input: z.object({ businessId, ...transactionSchema, dryRun: z.boolean().default(false) }),
    handler: async ({ businessId: b, dryRun, ...tx }) => {
      const totals = checkBalanced(tx);
      const bid = await ctx.resolveBusinessId(b);
      checkSides(tx, await accountSides(ctx, bid));
      const input = { businessId: bid, ...toInput(tx) };
      if (dryRun) return { dryRun: true, valid: true, totals, input };
      const payload = await ctx.client.mutate(OPS.MoneyTransactionCreate, { input }, 'moneyTransactionCreate');
      return { ok: true, transactionId: payload.transaction?.id, externalId: input.externalId, totals };
    },
  });

  defineTool(server, ctx, {
    name: 'wave_create_transactions',
    title: 'Create money transactions in bulk',
    toolset: 'transactions',
    annotations: CREATE,
    description:
      'Create up to 50 money transactions in one request (same shape as wave_create_transaction). Every transaction is checked first (amounts balance; debit and credit sides make sense for the accounts); nothing is sent if any fails. Wave applies the batch as one request and reports input errors by path (transactions.N...).',
    input: z.object({ businessId, transactions: z.array(z.object(transactionSchema)).min(1).max(50), dryRun: z.boolean().default(false) }),
    handler: async ({ businessId: b, transactions, dryRun }) => {
      transactions.forEach((tx, i) => checkBalanced(tx, `Transaction ${i} (${tx.description})`));
      const bid = await ctx.resolveBusinessId(b);
      const sides = await accountSides(ctx, bid);
      transactions.forEach((tx, i) => checkSides(tx, sides, `Transaction ${i} (${tx.description})`));
      const inputs = transactions.map(toInput);
      if (dryRun) return { dryRun: true, valid: true, count: inputs.length, input: { businessId: bid, transactions: inputs } };
      let payload;
      try {
        payload = await ctx.client.mutate(OPS.MoneyTransactionsCreate, { input: { businessId: bid, transactions: inputs } }, 'moneyTransactionsCreate');
      } catch (error) {
        if (error instanceof WaveApiError && error.code === 'INTERNAL_SERVER_ERROR') {
          throw new WaveError(
            `Wave's bulk endpoint failed internally (${error.message.replace(/^Wave API error in \w+: /, '').slice(0, 160)}). It does this when one transaction in the batch is invalid, instead of saying which. ` +
              'In testing it then created none of them; check with wave_list_transactions (search) before retrying, and create the transactions one at a time with wave_create_transaction to find the invalid one.',
            { code: 'BULK_FAILED', cause: error },
          );
        }
        throw error;
      }
      return {
        ok: true,
        created: inputs.map((tx, i) => ({ externalId: tx.externalId, transactionId: payload.transactions?.[i]?.id, date: tx.date, description: tx.description })),
      };
    },
  });
}
