import * as z from 'zod';
import { OPS } from '../wave/operations.js';
import { CREATE, DELETE, SEND, TRANSITION, UPDATE, businessId, currencyCode, date, dateTime, decimal, defineTool, defined, emailList, id, positiveAmount } from './common.js';
import { mutationResult, registerGet, registerList } from './entity.js';

export const INVOICE_STATUS = z.enum(['DRAFT', 'OVERDUE', 'OVERPAID', 'PAID', 'PARTIAL', 'SAVED', 'SENT', 'UNPAID', 'VIEWED']);
const INVOICE_SORT = z.enum([
  'AMOUNT_DUE_ASC', 'AMOUNT_DUE_DESC', 'AMOUNT_PAID_ASC', 'AMOUNT_PAID_DESC', 'CREATED_AT_ASC', 'CREATED_AT_DESC',
  'CUSTOMER_NAME_ASC', 'CUSTOMER_NAME_DESC', 'DUE_AT_ASC', 'DUE_AT_DESC', 'INVOICE_DATE_ASC', 'INVOICE_DATE_DESC',
  'INVOICE_NUMBER_ASC', 'INVOICE_NUMBER_DESC', 'MODIFIED_AT_ASC', 'MODIFIED_AT_DESC', 'STATUS_ASC', 'STATUS_DESC', 'TOTAL_ASC', 'TOTAL_DESC',
]);
export const SEND_METHOD = z.enum(['EXPORT_PDF', 'GMAIL', 'MARKED_SENT', 'NOT_SENT', 'OUTLOOK', 'SHARED_LINK', 'SKIPPED', 'WAVE', 'YAHOO']);
export const PAYMENT_METHOD = z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE', 'CREDIT_CARD', 'OTHER', 'PAYPAL', 'UNSPECIFIED']);

export const lineItem = (priceRequired = false) =>
  z.object({
    productId: z.string().min(1).describe('Product/service ID (lines must reference a product; see wave_list_products)'),
    description: z.string().optional().describe("Overrides the product's description"),
    quantity: decimal.optional().describe('Default 1'),
    unitPrice: priceRequired ? decimal.describe('Price per unit') : decimal.optional().describe("Overrides the product's price"),
    taxIds: z.array(z.string()).optional().describe("Sales tax IDs. Omit to apply the product's default taxes; [] for no tax"),
  });

export const toItemInput = (items) =>
  items?.map(({ taxIds, ...rest }) => ({ ...defined(rest), ...(taxIds ? { taxes: taxIds.map((salesTaxId) => ({ salesTaxId })) } : {}) }));

export const discount = z
  .object({
    discountType: z.enum(['FIXED', 'PERCENTAGE']),
    amount: decimal.optional().describe('For FIXED'),
    percentage: decimal.optional().describe('For PERCENTAGE discounts. Check the resulting discountTotal on the draft to confirm the scale'),
    name: z.string().optional(),
  })
  .describe('Wave allows at most one discount');

export const layoutFields = {
  title: z.string().optional(),
  subhead: z.string().optional(),
  poNumber: z.string().optional(),
  memo: z.string().optional().describe('Notes shown to the customer'),
  footer: z.string().optional(),
  exchangeRate: decimal.optional().describe('Business currency per document currency (foreign-currency documents only)'),
  disableCreditCardPayments: z.boolean().optional(),
  disableBankPayments: z.boolean().optional(),
  disableAmexPayments: z.boolean().optional(),
  requireTermsOfServiceAgreement: z.boolean().optional(),
  itemTitle: z.string().optional(),
  unitTitle: z.string().optional(),
  priceTitle: z.string().optional(),
  amountTitle: z.string().optional(),
  hideName: z.boolean().optional(),
  hideDescription: z.boolean().optional(),
  hideUnit: z.boolean().optional(),
  hidePrice: z.boolean().optional(),
  hideAmount: z.boolean().optional(),
};

export const emailFields = {
  to: emailList.describe('Recipient email addresses'),
  subject: z.string().optional(),
  message: z.string().optional(),
  ccMyself: z.boolean().optional(),
  fromAddress: z.string().email().optional(),
};

export function registerInvoiceTools(server, ctx) {
  registerList(server, ctx, {
    name: 'wave_list_invoices',
    title: 'List invoices',
    toolset: 'invoices',
    field: 'invoices',
    ops: { summary: OPS.ListInvoices, full: OPS.ListInvoicesFull },
    fullPageSize: 25,
    description:
      'List invoices with totals, amount due and status. Filter by status, customer, invoice date range, modification time, number, currency or the estimate they came from (sourceId). detail="full" adds line items and payments (pages of at most 25).',
    filters: {
      status: INVOICE_STATUS.optional(),
      customerId: z.string().optional(),
      invoiceDateStart: date.optional(),
      invoiceDateEnd: date.optional(),
      modifiedAtAfter: dateTime.optional(),
      modifiedAtBefore: dateTime.optional(),
      invoiceNumber: z.string().optional(),
      currency: currencyCode.optional(),
      amountDue: decimal.optional().describe('Exact amount due'),
      sourceId: z.string().optional().describe('Estimate or recurring invoice the invoice was created from'),
      sort: z.array(INVOICE_SORT).min(1).optional().describe('Default CREATED_AT_DESC'),
    },
  });
  registerGet(server, ctx, {
    name: 'wave_get_invoice',
    title: 'Get invoice',
    toolset: 'invoices',
    field: 'invoice',
    op: OPS.GetInvoice,
    what: 'Invoice',
    description: 'One invoice with line items, taxes, discounts, payments, reminders, PDF and customer view links.',
  });
  defineTool(server, ctx, {
    name: 'wave_create_invoice',
    title: 'Create invoice',
    toolset: 'invoices',
    annotations: CREATE,
    description:
      "Create an invoice for a customer. Created as DRAFT unless status=SAVED (approved). Number, dates, title and notes default to the business's invoice settings. Taxes default per product; pass taxIds:[] for none. Nothing is emailed.",
    input: z.object({
      businessId,
      customerId: z.string().min(1),
      items: z.array(lineItem()).min(1).max(100),
      status: z.enum(['DRAFT', 'SAVED']).optional(),
      invoiceDate: date.optional(),
      dueDate: date.optional(),
      invoiceNumber: z.string().optional(),
      currency: currencyCode.optional(),
      discounts: z.array(discount).max(1).optional(),
      ...layoutFields,
    }),
    handler: async ({ businessId: b, items, ...fields }) => {
      const input = { businessId: await ctx.resolveBusinessId(b), ...defined(fields), items: toItemInput(items) };
      return mutationResult(await ctx.client.mutate(OPS.InvoiceCreate, { input }, 'invoiceCreate'), 'invoice');
    },
  });
  defineTool(server, ctx, {
    name: 'wave_update_invoice',
    title: 'Update invoice',
    toolset: 'invoices',
    annotations: UPDATE,
    description: 'Change an invoice. Passing items replaces every line; omit items to keep them. Wave may refuse changes to paid invoices.',
    input: z.object({
      id: id('Invoice'),
      customerId: z.string().optional(),
      items: z.array(lineItem()).min(1).max(100).optional(),
      status: z.enum(['DRAFT', 'SAVED']).optional(),
      invoiceDate: date.optional(),
      dueDate: date.optional(),
      invoiceNumber: z.string().optional(),
      currency: currencyCode.optional(),
      discounts: z.array(discount).max(1).optional(),
      ...layoutFields,
    }),
    handler: async ({ items, ...fields }) => {
      const input = { ...defined(fields), ...(items ? { items: toItemInput(items) } : {}) };
      return mutationResult(await ctx.client.mutate(OPS.InvoicePatch, { input }, 'invoicePatch'), 'invoice');
    },
  });
  defineTool(server, ctx, {
    name: 'wave_clone_invoice',
    title: 'Clone invoice',
    toolset: 'invoices',
    annotations: CREATE,
    description: 'Copy an invoice into a new draft.',
    input: z.object({ invoiceId: id('Invoice') }),
    handler: async ({ invoiceId }) => mutationResult(await ctx.client.mutate(OPS.InvoiceClone, { input: { invoiceId } }, 'invoiceClone'), 'invoice'),
  });
  defineTool(server, ctx, {
    name: 'wave_approve_invoice',
    title: 'Approve invoice',
    toolset: 'invoices',
    annotations: TRANSITION,
    description: 'Approve a draft invoice, which posts it to the books (status SAVED). Does not email it.',
    input: z.object({ invoiceId: id('Invoice') }),
    handler: async ({ invoiceId }) => mutationResult(await ctx.client.mutate(OPS.InvoiceApprove, { input: { invoiceId } }, 'invoiceApprove'), 'invoice'),
  });
  defineTool(server, ctx, {
    name: 'wave_send_invoice',
    title: 'Email invoice',
    toolset: 'invoices',
    annotations: SEND,
    description: 'Email an invoice through Wave to real recipients. Irreversible: confirm recipients first. Requires email sending enabled for the business (wave_get_business emailSendEnabled).',
    input: z.object({ invoiceId: id('Invoice'), ...emailFields, attachPDF: z.boolean().default(true) }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.InvoiceSend, { input: defined(fields) }, 'invoiceSend'), 'invoice'),
  });
  defineTool(server, ctx, {
    name: 'wave_mark_invoice_sent',
    title: 'Mark invoice as sent',
    toolset: 'invoices',
    annotations: TRANSITION,
    description: 'Record that an invoice was sent outside Wave (no email goes out).',
    input: z.object({ invoiceId: id('Invoice'), sendMethod: SEND_METHOD.default('MARKED_SENT'), sentAt: dateTime.optional() }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.InvoiceMarkSent, { input: defined(fields) }, 'invoiceMarkSent'), 'invoice'),
  });
  defineTool(server, ctx, {
    name: 'wave_delete_invoice',
    title: 'Delete invoice',
    toolset: 'invoices',
    annotations: DELETE,
    description: 'Permanently delete an invoice.',
    input: z.object({ invoiceId: id('Invoice') }),
    handler: async ({ invoiceId }) => mutationResult(await ctx.client.mutate(OPS.InvoiceDelete, { input: { invoiceId } }, 'invoiceDelete'), null, { deletedId: invoiceId }),
  });

  // ------------------------------------------------------------ invoice payments
  registerGet(server, ctx, {
    name: 'wave_get_invoice_payment',
    title: 'Get invoice payment',
    toolset: 'payments',
    field: 'invoicePayment',
    op: OPS.GetInvoicePayment,
    what: 'Invoice payment',
    description: 'One invoice payment with account, method, currency details and processor info.',
  });
  defineTool(server, ctx, {
    name: 'wave_record_invoice_payment',
    title: 'Record invoice payment',
    toolset: 'payments',
    annotations: CREATE,
    description:
      'Record a payment received outside Wave against an invoice (cash, cheque, bank transfer...). paymentAccountId is the account the money went into (usually types=[ASSET] subtypes=[CASH_AND_BANK]). The invoice must be approved, not a draft.',
    input: z.object({
      invoiceId: id('Invoice'),
      paymentAccountId: z.string().min(1),
      amount: positiveAmount,
      paymentDate: date,
      paymentMethod: PAYMENT_METHOD,
      exchangeRate: decimal.default(1).describe('Payment-account currency per invoice currency; 1 when they match'),
      memo: z.string().optional(),
    }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.InvoicePaymentCreateManual, { input: defined(fields) }, 'invoicePaymentCreateManual'), 'invoicePayment'),
  });
  defineTool(server, ctx, {
    name: 'wave_update_invoice_payment',
    title: 'Update invoice payment',
    toolset: 'payments',
    annotations: UPDATE,
    description: 'Change a manually recorded invoice payment.',
    input: z.object({
      id: id('Invoice payment'),
      paymentAccountId: z.string().optional(),
      amount: positiveAmount.optional(),
      paymentDate: date.optional(),
      paymentMethod: PAYMENT_METHOD.optional(),
      exchangeRate: decimal.optional(),
      memo: z.string().optional(),
    }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.InvoicePaymentPatch, { input: defined(fields) }, 'invoicePaymentPatch'), 'invoicePayment'),
  });
  defineTool(server, ctx, {
    name: 'wave_delete_invoice_payment',
    title: 'Delete invoice payment',
    toolset: 'payments',
    annotations: DELETE,
    description: 'Delete a recorded invoice payment; the invoice becomes unpaid by that amount.',
    input: z.object({ id: id('Invoice payment') }),
    handler: async ({ id }) => mutationResult(await ctx.client.mutate(OPS.InvoicePaymentDelete, { input: { id } }, 'invoicePaymentDelete'), null, { deletedId: id }),
  });
  defineTool(server, ctx, {
    name: 'wave_send_invoice_payment_receipt',
    title: 'Email payment receipt',
    toolset: 'payments',
    annotations: SEND,
    description: 'Email a receipt for an invoice payment to real recipients. Irreversible.',
    input: z.object({ invoiceId: id('Invoice'), invoicePaymentId: id('Invoice payment'), ...emailFields, attachPdf: z.boolean().optional() }),
    handler: async (fields) =>
      mutationResult(await ctx.client.mutate(OPS.InvoicePaymentReceiptSend, { input: defined(fields) }, 'invoicePaymentReceiptSend'), null, { sentTo: fields.to }),
  });
}
