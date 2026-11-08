import * as z from 'zod';
import { OPS } from '../wave/operations.js';
import { CREATE, DELETE, SEND, TRANSITION, UPDATE, businessId, currencyCode, date, dateTime, decimal, defineTool, defined, id, positiveAmount, requireFound } from './common.js';
import { mutationResult, registerGet, registerList } from './entity.js';
import { SEND_METHOD, discount, emailFields, layoutFields, lineItem, toItemInput } from './invoices.js';

const ESTIMATE_STATUS = z.enum(['ACCEPTED', 'APPROVED', 'CONVERTED', 'DELETED', 'DRAFT', 'EXPIRED', 'REJECTED', 'SENT', 'VIEWED']);
const ESTIMATE_FILTER = z.enum(['ACCEPTED', 'ACTIVE', 'APPROVED', 'CONVERTED', 'DRAFT', 'EXPIRED', 'PAID', 'PARTIAL', 'REJECTED', 'SENT', 'UNPAID', 'VIEWED']);
const ESTIMATE_SORT = z.enum([
  'AMOUNT_DUE_ASC', 'AMOUNT_DUE_DESC', 'AMOUNT_PAID_ASC', 'AMOUNT_PAID_DESC', 'CREATED_AT_ASC', 'CREATED_AT_DESC',
  'CUSTOMER_NAME_ASC', 'CUSTOMER_NAME_DESC', 'DUE_AT_ASC', 'DUE_AT_DESC', 'ESTIMATE_DATE_ASC', 'ESTIMATE_DATE_DESC',
  'ESTIMATE_NUMBER_ASC', 'ESTIMATE_NUMBER_DESC', 'MODIFIED_AT_ASC', 'MODIFIED_AT_DESC', 'STATUS_ASC', 'STATUS_DESC', 'TOTAL_ASC', 'TOTAL_DESC',
]);
const DEPOSIT_METHOD = z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE', 'CREDIT_CARD', 'OTHER', 'PAYPAL']);

const depositFields = {
  depositStatus: z.enum(['DISABLED', 'ENABLED_MANDATORY', 'ENABLED_OPTIONAL']).optional().describe('Whether the customer can or must pay a deposit'),
  depositUnit: z.enum(['AMOUNT', 'PERCENTAGE']).optional(),
  depositValue: decimal.optional().describe('Deposit size in depositUnit. Wave documents AMOUNT values in cents'),
  dontCarryOverNotesToInvoice: z.boolean().optional(),
};

export function registerEstimateTools(server, ctx) {
  registerList(server, ctx, {
    name: 'wave_list_estimates',
    title: 'List estimates',
    toolset: 'estimates',
    field: 'estimates',
    ops: { summary: OPS.ListEstimates, full: OPS.ListEstimatesFull },
    fullPageSize: 25,
    description: 'List estimates (quotes) with totals, deposit state and status. detail="full" adds line items, deposit payments and acceptance history (pages of at most 25).',
    filters: {
      status: ESTIMATE_FILTER.optional(),
      customerId: z.string().optional(),
      estimateDateStart: date.optional(),
      estimateDateEnd: date.optional(),
      modifiedAtAfter: dateTime.optional(),
      modifiedAtBefore: dateTime.optional(),
      estimateNumber: z.string().optional(),
      currency: currencyCode.optional(),
      amountDue: decimal.optional(),
      sort: ESTIMATE_SORT.optional().describe('Default CREATED_AT_DESC'),
    },
  });
  registerGet(server, ctx, {
    name: 'wave_get_estimate',
    title: 'Get estimate',
    toolset: 'estimates',
    field: 'estimate',
    op: OPS.GetEstimate,
    what: 'Estimate',
    description: 'One estimate with items, taxes, discounts, deposit settings and payments, acceptance history and attachments.',
  });
  defineTool(server, ctx, {
    name: 'wave_create_estimate',
    title: 'Create estimate',
    toolset: 'estimates',
    annotations: CREATE,
    description: 'Create a draft estimate (quote). Each line needs a product and a unitPrice. Optionally ask for a deposit. Nothing is emailed.',
    input: z.object({
      businessId,
      customerId: z.string().min(1),
      items: z.array(lineItem(true)).min(1).max(100),
      estimateDate: date.optional(),
      dueDate: date.optional().describe('Expiry date'),
      estimateNumber: z.string().optional(),
      currency: currencyCode.optional(),
      discounts: z.array(discount).max(1).optional(),
      ...layoutFields,
      ...depositFields,
    }),
    handler: async ({ businessId: b, items, ...fields }) => {
      const input = { businessId: await ctx.resolveBusinessId(b), status: 'DRAFT', ...defined(fields), items: toItemInput(items) };
      return mutationResult(await ctx.client.mutate(OPS.EstimateCreate, { input }, 'estimateCreate'), 'estimate');
    },
  });
  defineTool(server, ctx, {
    name: 'wave_update_estimate',
    title: 'Update estimate',
    toolset: 'estimates',
    annotations: UPDATE,
    description:
      "Change an estimate. Wave's patch requires customer, status, title, dates, currency and exchange rate; any you omit are copied from the current estimate. Passing items replaces every line.",
    input: z.object({
      businessId,
      id: id('Estimate'),
      customerId: z.string().optional(),
      status: ESTIMATE_STATUS.optional(),
      estimateDate: date.optional(),
      dueDate: date.optional(),
      estimateNumber: z.string().optional(),
      currency: currencyCode.optional(),
      items: z.array(lineItem(true)).min(1).max(100).optional(),
      discounts: z.array(discount).max(1).optional(),
      ...layoutFields,
      ...depositFields,
    }),
    handler: async ({ businessId: b, id, items, ...fields }) => {
      const bid = await ctx.resolveBusinessId(b);
      const current = requireFound((await ctx.client.request(OPS.GetEstimate, { businessId: bid, id, embedAttachments: false, embedHistory: false, embedDepositPayments: false })).business?.estimate, 'Estimate', id);
      const input = {
        id,
        customerId: current.customer.id,
        status: current.status,
        title: current.title,
        estimateDate: current.estimateDate,
        dueDate: current.dueDate,
        currency: current.currency.code,
        exchangeRate: current.exchangeRate,
        ...defined(fields),
        ...(items ? { items: toItemInput(items) } : {}),
      };
      return mutationResult(await ctx.client.mutate(OPS.EstimatePatch, { input }, 'estimatePatch'), 'estimate');
    },
  });

  const simple = (name, title, annotations, description, doc, field, resultKey = 'estimate') =>
    defineTool(server, ctx, {
      name,
      title,
      toolset: 'estimates',
      annotations,
      description,
      input: z.object({ estimateId: id('Estimate') }),
      handler: async ({ estimateId }) => {
        const payload = await ctx.client.mutate(doc, { input: { estimateId } }, field);
        if (resultKey === 'invoiceId') return { ok: true, invoiceId: payload.invoiceId, next: 'wave_get_invoice with this invoiceId shows the new invoice' };
        if (resultKey === 'pdfUrl') return { ok: true, pdfUrl: payload.pdfUrl };
        return mutationResult(payload, resultKey, resultKey ? {} : { estimateId });
      },
    });

  simple('wave_clone_estimate', 'Clone estimate', CREATE, 'Copy an estimate into a new draft.', OPS.EstimateClone, 'estimateClone');
  simple('wave_approve_estimate', 'Approve estimate', TRANSITION, 'Approve a draft estimate so it can be sent. Does not email it.', OPS.EstimateApprove, 'estimateApprove');
  simple('wave_mark_estimate_accepted', 'Mark estimate accepted', TRANSITION, 'Record that the customer accepted the estimate.', OPS.EstimateMarkAccepted, 'estimateMarkAccepted');
  simple('wave_reset_estimate_acceptance', 'Reset estimate acceptance', TRANSITION, "Undo the customer's acceptance so the estimate can be changed or re-accepted.", OPS.EstimateResetAcceptance, 'estimateResetAcceptance');
  simple('wave_convert_estimate_to_invoice', 'Convert estimate to invoice', CREATE, 'Create an invoice from an estimate (deposits paid carry over). Returns the new invoiceId.', OPS.ConvertEstimateToInvoice, 'convertEstimateToInvoice', 'invoiceId');
  simple('wave_generate_estimate_pdf', 'Generate estimate PDF', { ...TRANSITION, idempotentHint: true }, 'Generate (or regenerate) the estimate PDF and return its URL.', OPS.EstimateGeneratePdf, 'estimateGeneratePdf', 'pdfUrl');
  simple('wave_send_estimate_acceptance_email', 'Email estimate acceptance confirmation', SEND, 'Email the customer the confirmation that their estimate acceptance was recorded. Irreversible.', OPS.EstimateSendAcceptanceCustomerEmail, 'estimateSendAcceptanceCustomerEmail');
  simple('wave_delete_estimate', 'Delete estimate', DELETE, 'Permanently delete an estimate.', OPS.EstimateDelete, 'estimateDelete', null);

  defineTool(server, ctx, {
    name: 'wave_send_estimate',
    title: 'Email estimate',
    toolset: 'estimates',
    annotations: SEND,
    description: 'Email an estimate through Wave to real recipients. Irreversible: confirm recipients first. The estimate must be approved.',
    input: z.object({
      estimateId: id('Estimate'),
      ...emailFields,
      attachPDF: z.boolean().default(true),
      hideGrandTotal: z.boolean().optional(),
      includeAttachments: z.boolean().optional(),
    }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.EstimateSend, { input: defined(fields) }, 'estimateSend'), 'estimate'),
  });
  defineTool(server, ctx, {
    name: 'wave_mark_estimate_sent',
    title: 'Mark estimate as sent',
    toolset: 'estimates',
    annotations: TRANSITION,
    description: 'Record that an estimate was sent outside Wave (no email goes out).',
    input: z.object({ estimateId: id('Estimate'), sendMethod: SEND_METHOD.default('MARKED_SENT'), sentAt: dateTime.optional() }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.EstimateMarkSent, { input: defined(fields) }, 'estimateMarkSent'), 'estimate'),
  });

  // ------------------------------------------------------------ estimate deposits
  registerGet(server, ctx, {
    name: 'wave_get_estimate_payment',
    title: 'Get estimate deposit payment',
    toolset: 'payments',
    field: 'estimatePayment',
    op: OPS.GetEstimatePayment,
    what: 'Estimate payment',
    description: 'One estimate deposit payment (or refund/void) with its estimate.',
  });
  defineTool(server, ctx, {
    name: 'wave_record_estimate_deposit',
    title: 'Record estimate deposit',
    toolset: 'payments',
    annotations: CREATE,
    description: 'Record a deposit received outside Wave against an estimate. paymentAccountId is where the money went (a CASH_AND_BANK account).',
    input: z.object({
      estimateId: id('Estimate'),
      amount: positiveAmount,
      paymentDate: date,
      paymentMethod: DEPOSIT_METHOD,
      paymentAccountId: z.string().optional(),
      memo: z.string().optional(),
    }),
    handler: async (fields) =>
      mutationResult(await ctx.client.mutate(OPS.EstimateDepositPaymentCreateManual, { input: defined(fields) }, 'estimateDepositPaymentCreateManual'), 'estimatePayment'),
  });
  defineTool(server, ctx, {
    name: 'wave_update_estimate_deposit',
    title: 'Update estimate deposit',
    toolset: 'payments',
    annotations: UPDATE,
    description: 'Change a manually recorded estimate deposit.',
    input: z.object({
      id: id('Estimate payment'),
      estimateId: id('Estimate'),
      amount: positiveAmount.optional(),
      paymentDate: date.optional(),
      paymentMethod: DEPOSIT_METHOD.optional(),
      paymentAccountId: z.string().optional(),
      memo: z.string().optional(),
    }),
    handler: async (fields) =>
      mutationResult(await ctx.client.mutate(OPS.EstimateDepositPaymentUpdateManual, { input: defined(fields) }, 'estimateDepositPaymentUpdateManual'), 'estimatePayment'),
  });
  defineTool(server, ctx, {
    name: 'wave_delete_estimate_payment',
    title: 'Delete estimate deposit',
    toolset: 'payments',
    annotations: DELETE,
    description: 'Delete a recorded estimate deposit payment.',
    input: z.object({ id: id('Estimate payment') }),
    handler: async ({ id }) => mutationResult(await ctx.client.mutate(OPS.EstimatePaymentDelete, { input: { id } }, 'estimatePaymentDelete'), null, { deletedId: id }),
  });
  defineTool(server, ctx, {
    name: 'wave_send_estimate_deposit_receipt',
    title: 'Email deposit receipt',
    toolset: 'payments',
    annotations: SEND,
    description: 'Email a receipt for an estimate deposit to real recipients. Irreversible.',
    input: z.object({ estimateId: id('Estimate'), estimatePaymentId: id('Estimate payment'), ...emailFields, attachPdf: z.boolean().optional() }),
    handler: async (fields) =>
      mutationResult(await ctx.client.mutate(OPS.EstimateDepositPaymentReceiptSend, { input: defined(fields) }, 'estimateDepositPaymentReceiptSend'), null, { sentTo: fields.to }),
  });
}
