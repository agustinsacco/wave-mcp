import * as z from 'zod';
import { OPS } from '../wave/operations.js';
import { CREATE, DELETE, UPDATE, businessId, currencyCode, date, dateTime, decimal, defineTool, defined, id, requireFound } from './common.js';
import { mutationResult, registerGet, registerList } from './entity.js';

const PRODUCT_SORT = z.enum(['CREATED_AT_ASC', 'CREATED_AT_DESC', 'MODIFIED_AT_ASC', 'MODIFIED_AT_DESC', 'NAME_ASC', 'NAME_DESC']);
const ACCOUNT_TYPES = z.enum(['ASSET', 'EQUITY', 'EXPENSE', 'INCOME', 'LIABILITY']);
const ACCOUNT_SUBTYPES = z.enum([
  'CASH_AND_BANK', 'COST_OF_GOODS_SOLD', 'CREDIT_CARD', 'CUSTOMER_PREPAYMENTS_AND_CREDITS', 'DEPRECIATION_AND_AMORTIZATION',
  'DISCOUNTS', 'DUE_FOR_PAYROLL', 'DUE_TO_YOU_AND_OTHER_OWNERS', 'EXPENSE', 'GAIN_ON_FOREIGN_EXCHANGE', 'INCOME', 'INVENTORY',
  'LOANS', 'LOSS_ON_FOREIGN_EXCHANGE', 'MONEY_IN_TRANSIT', 'NON_RETAINED_EARNINGS', 'OTHER_CURRENT_ASSETS', 'OTHER_CURRENT_LIABILITY',
  'OTHER_INCOME', 'OTHER_LONG_TERM_ASSETS', 'OTHER_LONG_TERM_LIABILITY', 'PAYABLE', 'PAYABLE_BILLS', 'PAYABLE_OTHER',
  'PAYMENT_PROCESSING_FEES', 'PAYROLL_EXPENSES', 'PROPERTY_PLANT_EQUIPMENT', 'RECEIVABLE', 'RECEIVABLE_INVOICES', 'RECEIVABLE_OTHER',
  'RETAINED_EARNINGS', 'SALES_TAX', 'SYSTEM_CUSTOMER_CREDITS', 'TRANSFERS', 'UNCATEGORIZED_EXPENSE', 'UNCATEGORIZED_INCOME',
  'UNKNOWN_ACCOUNT', 'VENDOR_PREPAYMENTS_AND_CREDITS',
]);
const CREATABLE_SUBTYPES = z.enum([
  'CASH_AND_BANK', 'COST_OF_GOODS_SOLD', 'CREDIT_CARD', 'CUSTOMER_PREPAYMENTS_AND_CREDITS', 'DEPRECIATION_AND_AMORTIZATION',
  'DISCOUNTS', 'DUE_FOR_PAYROLL', 'DUE_TO_YOU_AND_OTHER_OWNERS', 'EXPENSE', 'INCOME', 'INVENTORY', 'LOANS', 'MONEY_IN_TRANSIT',
  'NON_RETAINED_EARNINGS', 'OTHER_CURRENT_ASSETS', 'OTHER_CURRENT_LIABILITY', 'OTHER_INCOME', 'OTHER_LONG_TERM_ASSETS',
  'OTHER_LONG_TERM_LIABILITY', 'PAYABLE', 'PAYMENT_PROCESSING_FEES', 'PAYROLL_EXPENSES', 'PROPERTY_PLANT_EQUIPMENT', 'RECEIVABLE',
  'RETAINED_EARNINGS', 'VENDOR_PREPAYMENTS_AND_CREDITS',
]);

/** Wave takes tax rates as fractions; catch "13" meant as 13%. */
const taxRate = z
  .union([z.number(), z.string().regex(/^\d+(\.\d+)?$/)])
  .refine((v) => Number(v) >= 0 && Number(v) < 1, 'Rates are fractions: 13% is 0.13')
  .describe('Rate as a fraction: 0.13 means 13%');

const modifiedFilters = {
  modifiedAtAfter: dateTime.optional().describe('Only records modified after this time'),
  modifiedAtBefore: dateTime.optional().describe('Only records modified before this time'),
};

export function registerCatalogTools(server, ctx) {
  // ------------------------------------------------------------ products & services
  registerList(server, ctx, {
    name: 'wave_list_products',
    title: 'List products and services',
    toolset: 'products',
    field: 'products',
    ops: { summary: OPS.ListProducts, full: OPS.ListProductsFull },
    description: 'List products/services (the items invoice and estimate lines must reference), with price, income/expense accounts and default sales taxes. Active only unless isArchived=true.',
    filters: {
      isSold: z.boolean().optional().describe('Only items sold (have an income account)'),
      isBought: z.boolean().optional().describe('Only items bought (have an expense account)'),
      isArchived: z.boolean().optional().describe('Default false (active only)'),
      sort: z.array(PRODUCT_SORT).min(1).optional().describe('Default CREATED_AT_DESC'),
      ...modifiedFilters,
    },
    searchFields: ['name', 'description'],
  });
  registerGet(server, ctx, {
    name: 'wave_get_product',
    title: 'Get product or service',
    toolset: 'products',
    field: 'product',
    op: OPS.GetProduct,
    what: 'Product',
    description: 'One product/service with its accounts and default sales taxes.',
  });
  const productFields = {
    description: z.string().optional(),
    defaultSalesTaxIds: z.array(z.string()).optional().describe('Sales taxes applied by default on invoice lines'),
    incomeAccountId: z.string().optional().describe('Makes it sellable. Account subtype must be INCOME, DISCOUNTS or OTHER_INCOME'),
    expenseAccountId: z.string().optional().describe('Makes it buyable. Account subtype must be EXPENSE, COST_OF_GOODS_SOLD, PAYMENT_PROCESSING_FEES or PAYROLL_EXPENSES'),
  };
  defineTool(server, ctx, {
    name: 'wave_create_product',
    title: 'Create product or service',
    toolset: 'products',
    annotations: CREATE,
    description: 'Create a product or service. Give it an incomeAccountId to sell it on invoices, an expenseAccountId to buy it, or both.',
    input: z.object({ businessId, name: z.string().min(1), unitPrice: decimal.describe('Price per unit, major currency units'), ...productFields }),
    handler: async ({ businessId: b, ...fields }) => {
      const input = { businessId: await ctx.resolveBusinessId(b), ...defined(fields) };
      return mutationResult(await ctx.client.mutate(OPS.ProductCreate, { input }, 'productCreate'), 'product');
    },
  });
  defineTool(server, ctx, {
    name: 'wave_update_product',
    title: 'Update product or service',
    toolset: 'products',
    annotations: UPDATE,
    description: 'Change a product/service. defaultSalesTaxIds replaces the whole list.',
    input: z.object({ id: id('Product'), name: z.string().min(1).optional(), unitPrice: decimal.optional(), ...productFields }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.ProductPatch, { input: defined(fields) }, 'productPatch'), 'product'),
  });
  defineTool(server, ctx, {
    name: 'wave_archive_product',
    title: 'Archive product or service',
    toolset: 'products',
    annotations: DELETE,
    description: 'Archive a product/service so it can no longer be added to new invoices. Past invoices keep it. The API cannot un-archive (web app only).',
    input: z.object({ id: id('Product') }),
    handler: async ({ id }) => mutationResult(await ctx.client.mutate(OPS.ProductArchive, { input: { id } }, 'productArchive'), 'product'),
  });

  // ------------------------------------------------------------ chart of accounts
  registerList(server, ctx, {
    name: 'wave_list_accounts',
    title: 'List chart of accounts',
    toolset: 'accounts',
    field: 'accounts',
    ops: { summary: OPS.ListAccounts, full: OPS.ListAccountsFull },
    description:
      'List the chart of accounts with current balances. Find transaction accounts with filters: bank accounts are types=[ASSET] subtypes=[CASH_AND_BANK]; credit cards subtypes=[CREDIT_CARD]; expense categories types=[EXPENSE]; income categories types=[INCOME].',
    filters: {
      types: z.array(ACCOUNT_TYPES).min(1).optional(),
      subtypes: z.array(ACCOUNT_SUBTYPES).min(1).optional(),
      excludedSubtypes: z.array(ACCOUNT_SUBTYPES).min(1).optional(),
      isArchived: z.boolean().optional().describe('Default false (active only)'),
    },
    searchFields: ['name', 'displayId', 'description'],
  });
  registerGet(server, ctx, {
    name: 'wave_get_account',
    title: 'Get account',
    toolset: 'accounts',
    field: 'account',
    op: OPS.GetAccount,
    what: 'Account',
    description: 'One account with type, subtype, normal balance, current balance (account and business currency) and its sequence number.',
  });
  defineTool(server, ctx, {
    name: 'wave_create_account',
    title: 'Create account',
    toolset: 'accounts',
    annotations: CREATE,
    description: 'Add an account to the chart of accounts. The subtype decides its type (see wave_get_reference kind=account_subtypes).',
    input: z.object({
      businessId,
      name: z.string().min(1),
      subtype: CREATABLE_SUBTYPES,
      currency: currencyCode.optional().describe('Defaults to the business currency'),
      description: z.string().optional(),
      displayId: z.string().optional().describe('Your account number/code'),
    }),
    handler: async ({ businessId: b, ...fields }) => {
      const input = { businessId: await ctx.resolveBusinessId(b), ...defined(fields) };
      return mutationResult(await ctx.client.mutate(OPS.AccountCreate, { input }, 'accountCreate'), 'account');
    },
  });
  defineTool(server, ctx, {
    name: 'wave_update_account',
    title: 'Update account',
    toolset: 'accounts',
    annotations: UPDATE,
    description:
      'Rename an account or change its description/number. Wave requires the account\'s current sequence (optimistic locking); it is read automatically when omitted. Pass null for description/displayId to clear them.',
    input: z.object({
      businessId,
      id: id('Account'),
      sequence: z.number().int().optional().describe('Current sequence from wave_get_account; fetched when omitted'),
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      displayId: z.string().nullable().optional(),
    }),
    handler: async ({ businessId: b, id, sequence, name, description, displayId }) => {
      let seq = sequence;
      if (seq === undefined) {
        const bid = await ctx.resolveBusinessId(b);
        const data = await ctx.client.request(OPS.GetAccount, { businessId: bid, id });
        seq = requireFound(data.business?.account, 'Account', id).sequence;
      }
      // null is meaningful here (clears the value), so it is sent explicitly.
      const input = { id, sequence: seq, ...defined({ name }) };
      if (description !== undefined) input.description = description;
      if (displayId !== undefined) input.displayId = displayId;
      const payload = await ctx.client.mutate(OPS.AccountPatch, { input }, 'accountPatch', { keepNulls: true });
      return mutationResult(payload, 'account');
    },
  });
  defineTool(server, ctx, {
    name: 'wave_archive_account',
    title: 'Archive account',
    toolset: 'accounts',
    annotations: DELETE,
    description: 'Archive an account (hide it while keeping its history). Wave refuses for system accounts and accounts with a balance. No un-archive through the API.',
    input: z.object({ id: id('Account') }),
    handler: async ({ id }) => mutationResult(await ctx.client.mutate(OPS.AccountArchive, { input: { id } }, 'accountArchive'), null, { archivedId: id }),
  });

  // ------------------------------------------------------------ sales taxes
  registerList(server, ctx, {
    name: 'wave_list_sales_taxes',
    title: 'List sales taxes',
    toolset: 'sales_taxes',
    field: 'salesTaxes',
    ops: { summary: OPS.ListSalesTaxes, full: OPS.ListSalesTaxesFull },
    description: 'List sales taxes with current rate (as a fraction: 0.13 = 13%). detail="full" adds the dated rate history.',
    filters: { isArchived: z.boolean().optional().describe('Default false (active only)'), ...modifiedFilters },
    searchFields: ['name', 'abbreviation'],
  });
  registerGet(server, ctx, {
    name: 'wave_get_sales_tax',
    title: 'Get sales tax',
    toolset: 'sales_taxes',
    field: 'salesTax',
    op: OPS.GetSalesTax,
    what: 'Sales tax',
    description: 'One sales tax with its full dated rate history.',
  });
  defineTool(server, ctx, {
    name: 'wave_create_sales_tax',
    title: 'Create sales tax',
    toolset: 'sales_taxes',
    annotations: CREATE,
    description: 'Create a sales tax. abbreviation must be unique in the business (max 10 characters).',
    input: z.object({
      businessId,
      name: z.string().min(1),
      abbreviation: z.string().min(1).max(10),
      rate: taxRate,
      description: z.string().optional(),
      taxNumber: z.string().optional().describe('Registration number from the tax authority'),
      showTaxNumberOnInvoices: z.boolean().optional(),
      isCompound: z.boolean().optional().describe('Calculated on top of other taxes'),
      isRecoverable: z.boolean().optional().describe('Tax paid on purchases can be deducted'),
    }),
    handler: async ({ businessId: b, ...fields }) => {
      const input = { businessId: await ctx.resolveBusinessId(b), ...defined(fields) };
      return mutationResult(await ctx.client.mutate(OPS.SalesTaxCreate, { input }, 'salesTaxCreate'), 'salesTax');
    },
  });
  defineTool(server, ctx, {
    name: 'wave_update_sales_tax',
    title: 'Update sales tax',
    toolset: 'sales_taxes',
    annotations: UPDATE,
    description: 'Change a sales tax. To change the rate, pass rates with an effective date; rates replaces the dated rate list, so include existing entries you want to keep (see wave_get_sales_tax).',
    input: z.object({
      id: id('Sales tax'),
      name: z.string().min(1).optional(),
      abbreviation: z.string().min(1).max(10).optional(),
      description: z.string().optional(),
      taxNumber: z.string().optional(),
      showTaxNumberOnInvoices: z.boolean().optional(),
      rates: z.array(z.object({ effective: date, rate: taxRate })).min(1).optional(),
    }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.SalesTaxPatch, { input: defined(fields) }, 'salesTaxPatch'), 'salesTax'),
  });
  defineTool(server, ctx, {
    name: 'wave_archive_sales_tax',
    title: 'Archive sales tax',
    toolset: 'sales_taxes',
    annotations: DELETE,
    description: 'Archive a sales tax so it can no longer be applied. No un-archive through the API.',
    input: z.object({ id: id('Sales tax') }),
    handler: async ({ id }) => mutationResult(await ctx.client.mutate(OPS.SalesTaxArchive, { input: { id } }, 'salesTaxArchive'), 'salesTax'),
  });
}

