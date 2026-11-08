/**
 * An in-process stand-in for gql.waveapps.com built from the real schema
 * snapshot: requests are parsed, validated and executed with graphql-js, so a
 * document that would fail against Wave fails here too. Business data comes
 * from fixtures; everything else is filled by schema-aware mocks.
 */
import fs from 'node:fs';
import { graphql, buildSchema } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { addMocksToSchema } from '@graphql-tools/mock';

const SDL = fs.readFileSync(new URL('../../schema/wave.graphql', import.meta.url), 'utf8');
buildSchema(SDL); // fail fast if the snapshot is broken

export const TOKEN = 'test-token';
export const BUSINESS = { id: 'QnVzaW5lc3M6MQ==', name: 'Acme Studio', currency: { code: 'CAD' }, timezone: 'America/Toronto', isPersonal: false, isArchived: false };

function connection(items, { page = 1, pageSize = 10 } = {}) {
  const start = (page - 1) * pageSize;
  return {
    edges: items.slice(start, start + pageSize).map((node) => ({ node })),
    pageInfo: { currentPage: page, totalPages: Math.max(1, Math.ceil(items.length / pageSize)), totalCount: items.length },
  };
}

const money = (value, code) => ({ value, minorUnitValue: String(Math.round(Number(value) * 100)), currency: { code, symbol: '$', name: code, plural: code, exponent: 2 } });

export function makeInvoice(n, over = {}) {
  const currency = over.currency || 'CAD';
  const total = over.total ?? '113.00';
  const paid = over.paid ?? '0.00';
  const due = over.due ?? (Number(total) - Number(paid)).toFixed(2);
  return {
    id: `inv-${n}`,
    invoiceNumber: String(n),
    status: over.status || (Number(due) === 0 ? 'PAID' : 'SENT'),
    title: 'Invoice',
    invoiceDate: over.invoiceDate || '2026-03-01',
    dueDate: over.dueDate || '2026-03-31',
    currency: { code: currency, symbol: '$', name: currency, plural: currency, exponent: 2 },
    exchangeRate: over.exchangeRate || '1',
    customer: over.customer || { id: 'cust-1', name: 'Globex' },
    total: money(total, currency),
    amountDue: money(due, currency),
    amountPaid: money(paid, currency),
    subtotal: money(over.subtotal ?? '100.00', currency),
    taxTotal: money(over.taxTotal ?? '13.00', currency),
    discountTotal: money('0.00', currency),
    items: over.items || [
      {
        id: `item-${n}`,
        description: 'Design work',
        quantity: '1',
        unitPrice: '100.00',
        subtotal: money('100.00', currency),
        total: money('113.00', currency),
        product: { id: 'prod-1', name: 'Design' },
        account: { id: 'acct-income', name: 'Sales' },
        taxes: [{ amount: money('13.00', currency), salesTax: { id: 'tax-hst', name: 'HST', abbreviation: 'HST' } }],
      },
    ],
    payments: over.payments || [],
    modifiedAt: over.modifiedAt || '2026-03-02T00:00:00Z',
    createdAt: '2026-03-01T00:00:00Z',
  };
}

export const ACCOUNTS = [
  { id: 'acct-bank', name: 'Chequing', type: { name: 'Assets', value: 'ASSET', normalBalanceType: 'DEBIT' }, subtype: { name: 'Cash and Bank', value: 'CASH_AND_BANK' }, normalBalanceType: 'DEBIT', balance: '5000.00', balanceInBusinessCurrency: '5000.00' },
  { id: 'acct-ar', name: 'Accounts Receivable', type: { name: 'Assets', value: 'ASSET', normalBalanceType: 'DEBIT' }, subtype: { name: 'Receivable', value: 'RECEIVABLE' }, normalBalanceType: 'DEBIT', balance: '1130.00', balanceInBusinessCurrency: '1130.00' },
  { id: 'acct-card', name: 'Visa', type: { name: 'Liabilities', value: 'LIABILITY', normalBalanceType: 'CREDIT' }, subtype: { name: 'Credit Card', value: 'CREDIT_CARD' }, normalBalanceType: 'CREDIT', balance: '400.00', balanceInBusinessCurrency: '400.00' },
  { id: 'acct-hst', name: 'HST Payable', type: { name: 'Liabilities', value: 'LIABILITY', normalBalanceType: 'CREDIT' }, subtype: { name: 'Sales Tax', value: 'SALES_TAX' }, normalBalanceType: 'CREDIT', balance: '130.00', balanceInBusinessCurrency: '130.00' },
  { id: 'acct-equity', name: 'Owner Investment', type: { name: 'Equity', value: 'EQUITY', normalBalanceType: 'CREDIT' }, subtype: { name: 'Business Owner Contribution', value: 'DUE_TO_YOU_AND_OTHER_OWNERS' }, normalBalanceType: 'CREDIT', balance: '3000.00', balanceInBusinessCurrency: '3000.00' },
  { id: 'acct-income', name: 'Sales', type: { name: 'Income', value: 'INCOME', normalBalanceType: 'CREDIT' }, subtype: { name: 'Income', value: 'INCOME' }, normalBalanceType: 'CREDIT', balance: '4000.00', balanceInBusinessCurrency: '4000.00' },
  { id: 'acct-cogs', name: 'Materials', type: { name: 'Expenses', value: 'EXPENSE', normalBalanceType: 'DEBIT' }, subtype: { name: 'Cost of Goods Sold', value: 'COST_OF_GOODS_SOLD' }, normalBalanceType: 'DEBIT', balance: '500.00', balanceInBusinessCurrency: '500.00' },
  { id: 'acct-rent', name: 'Rent', type: { name: 'Expenses', value: 'EXPENSE', normalBalanceType: 'DEBIT' }, subtype: { name: 'Operating Expense', value: 'EXPENSE' }, normalBalanceType: 'DEBIT', balance: '900.00', balanceInBusinessCurrency: '900.00' },
  { id: 'acct-empty', name: 'Unused', type: { name: 'Expenses', value: 'EXPENSE', normalBalanceType: 'DEBIT' }, subtype: { name: 'Operating Expense', value: 'EXPENSE' }, normalBalanceType: 'DEBIT', balance: '0.00', balanceInBusinessCurrency: '0.00' },
].map((a) => ({ ...a, currency: { code: 'CAD', symbol: '$', name: 'CAD', plural: 'CAD', exponent: 2 }, isArchived: false, sequence: 1 }));

export function createFakeWave({ invoices = [], customers, estimates = [], accounts = ACCOUNTS, failures = [] } = {}) {
  const calls = [];
  const customerList =
    customers ||
    Array.from({ length: 45 }, (_, i) => ({
      id: `cust-${i + 1}`,
      name: i === 0 ? 'Globex' : `Customer ${String(i + 1).padStart(2, '0')}`,
      email: `c${i + 1}@example.com`,
      isArchived: false,
      currency: { code: 'CAD' },
      outstandingAmount: money('0.00', 'CAD'),
      overdueAmount: money('0.00', 'CAD'),
      internalNotes: 'x'.repeat(600),
      modifiedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    }));
  const mutations = [];

  const filterInvoices = (args) =>
    invoices.filter(
      (inv) =>
        (!args.customerId || inv.customer.id === args.customerId) &&
        (!args.status || inv.status === args.status) &&
        (!args.invoiceDateStart || inv.invoiceDate >= args.invoiceDateStart) &&
        (!args.invoiceDateEnd || inv.invoiceDate <= args.invoiceDateEnd) &&
        (!args.modifiedAtAfter || inv.modifiedAt >= args.modifiedAtAfter),
    );

  const resolvers = {
    Query: {
      user: () => ({ id: 'user-1', defaultEmail: 'owner@example.com', firstName: 'Ada', lastName: 'Owner', createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2020-01-01T00:00:00Z' }),
      businesses: (_, args) => connection([BUSINESS, { ...BUSINESS, id: 'QnVzaW5lc3M6Mg==', name: 'Personal', isPersonal: true }], args),
      business: (_, { id }) => (id === BUSINESS.id ? BUSINESS : null),
      accountTypes: () => [{ name: 'Assets', value: 'ASSET', normalBalanceType: 'DEBIT' }],
    },
    Business: {
      customers: (_, args) => connection(customerList.filter((c) => !args.email || c.email === args.email), args),
      customer: (_, { id }) => customerList.find((c) => c.id === id) || null,
      invoices: (_, args) => {
        let list = filterInvoices(args);
        if (args.sort?.[0] === 'AMOUNT_DUE_DESC') list = [...list].sort((a, b) => Number(b.amountDue.value) - Number(a.amountDue.value));
        return connection(list, args);
      },
      invoice: (_, { id }) => invoices.find((i) => i.id === id) || null,
      estimates: (_, args) => connection(estimates.filter((e) => !args.customerId || e.customer.id === args.customerId), args),
      accounts: (_, args) =>
        connection(
          accounts.filter((a) => (args.isArchived ? a.isArchived : !a.isArchived) && (!args.types || args.types.includes(a.type.value)) && (!args.subtypes || args.subtypes.includes(a.subtype.value))),
          args,
        ),
      account: (_, { id }) => accounts.find((a) => a.id === id) || null,
    },
    Mutation: {
      customerCreate: (_, { input }) => {
        mutations.push(['customerCreate', input]);
        return { didSucceed: true, inputErrors: [], customer: { id: 'cust-new', name: input.name, email: input.email ?? null, internalNotes: null, isArchived: false } };
      },
      moneyTransactionCreate: (_, { input }) => {
        mutations.push(['moneyTransactionCreate', input]);
        return { didSucceed: true, inputErrors: [], transaction: { id: 'txn-1' } };
      },
      moneyTransactionsCreate: (_, { input }) => {
        mutations.push(['moneyTransactionsCreate', input]);
        return { didSucceed: true, inputErrors: [], transactions: input.transactions.map((_, i) => ({ id: `txn-${i + 1}` })) };
      },
      invoiceDelete: (_, { input }) => {
        mutations.push(['invoiceDelete', input]);
        return { didSucceed: false, inputErrors: [{ path: ['invoiceId'], message: 'Invoice has payments', code: 'INVALID' }] };
      },
      accountPatch: (_, { input }) => {
        mutations.push(['accountPatch', input]);
        return { didSucceed: true, inputErrors: [], account: { ...accounts.find((a) => a.id === input.id), name: input.name ?? 'x' } };
      },
    },
  };

  const schema = addMocksToSchema({
    schema: makeExecutableSchema({ typeDefs: SDL, resolvers }),
    preserveResolvers: true,
    mocks: {
      Decimal: () => '1.00',
      Date: () => '2026-01-01',
      DateTime: () => '2026-01-01T00:00:00Z',
      URL: () => 'https://example.com/x',
      HexColorCode: () => '#336699',
      JSON: () => ({}),
      String: () => 'mock',
      Int: () => 1,
    },
  });

  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const failure = failures.shift();
    if (failure === 429) return new Response('{"errors":[{"message":"slow down"}]}', { status: 429, headers: { 'retry-after': '0' } });
    if (failure === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (failure === 'unauth' || init.headers.Authorization !== `Bearer ${TOKEN}`) {
      return Response.json({ errors: [{ message: 'Invalid request, authentication expired.', extensions: { code: 'UNAUTHENTICATED', id: 'e1' } }], data: null });
    }
    const result = await graphql({ schema, source: body.query, variableValues: body.variables });
    const payload = { data: result.data ?? null };
    if (result.errors?.length) payload.errors = result.errors.map((e) => ({ message: e.message, path: e.path, extensions: { code: e.extensions?.code || 'GRAPHQL_VALIDATION_FAILED' } }));
    return Response.json(payload);
  }

  return { fetchImpl, calls, mutations };
}
