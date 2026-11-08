/**
 * Live contract test against gql.waveapps.com, with NO valid credentials.
 *
 * Wave parses, validates and coerces variables before it checks
 * authentication, so a document or input that is wrong in any way comes back
 * as GRAPHQL_VALIDATION_FAILED / VARIABLE_VALUE, while a correct one comes back
 * UNAUTHENTICATED. Nothing can be read or written. Run with:
 *   npm run test:contract
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSchema, parse, typeFromAST, isNonNullType, isListType, isInputObjectType, isEnumType, isScalarType } from 'graphql';
import { OPS } from '../src/wave/operations.js';
import { connect, tempCredentials } from './helpers/harness.js';

const LIVE = process.env.WAVE_CONTRACT === '1';
const URL_ = process.env.WAVE_API_URL || 'https://gql.waveapps.com/graphql/public';
const schema = buildSchema(fs.readFileSync(new URL('../schema/wave.graphql', import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCALARS = { ID: 'QnVzaW5lc3M6MA==', String: 'contract-test', Int: 1, Float: 1.5, Boolean: true, Date: '2026-01-15', DateTime: '2026-01-15T00:00:00Z', Decimal: '12.50', URL: 'https://example.com', HexColorCode: '#336699', JSON: {} };

function sample(type, depth = 0) {
  if (isNonNullType(type)) return sample(type.ofType, depth);
  if (isListType(type)) return [sample(type.ofType, depth)];
  if (isEnumType(type)) {
    const values = type.getValues().filter((v) => !v.deprecationReason);
    return (values.find((v) => ['CAD', 'CA', 'INCREASE'].includes(v.name)) || values[0]).name;
  }
  if (isScalarType(type)) return SCALARS[type.name] ?? 'x';
  if (isInputObjectType(type)) {
    const out = {};
    for (const f of Object.values(type.getFields())) {
      if (f.deprecationReason) continue;
      if (isNonNullType(f.type) || depth < 1) out[f.name] = sample(f.type, depth + 1);
    }
    return out;
  }
  return null;
}

function sampleVariables(doc) {
  const ast = parse(doc);
  const vars = {};
  for (const def of ast.definitions[0].variableDefinitions || []) {
    if (def.defaultValue) continue;
    vars[def.variable.name.value] = sample(typeFromAST(schema, def.type));
  }
  return vars;
}

async function post(query, variables) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer contract-test-invalid' }, body: JSON.stringify({ query, variables }) });
    if (res.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    return res.json();
  }
  throw new Error('rate limited');
}

test('every document and sample input passes Wave\'s own validation', { skip: !LIVE && 'set WAVE_CONTRACT=1' }, async () => {
  const failures = [];
  for (const [name, doc] of Object.entries(OPS)) {
    const body = await post(doc, sampleVariables(doc));
    const codes = (body.errors || []).map((e) => e.extensions?.code);
    if (!codes.length || codes.some((c) => c !== 'UNAUTHENTICATED')) failures.push(`${name}: ${JSON.stringify(body.errors?.map((e) => e.message) || body).slice(0, 300)}`);
    await sleep(120);
  }
  assert.deepEqual(failures, []);
});

test('inputs built by the write tools pass Wave\'s validation', { skip: !LIVE && 'set WAVE_CONTRACT=1' }, async (t) => {
  const h = await connect({ fetchImpl: globalThis.fetch }, { credentials: tempCredentials('WAVE_ACCESS_TOKEN=contract-test-invalid\n'), env: { WAVE_API_URL: URL_, WAVE_MCP_MAX_RETRIES: '3' } });
  t.after(h.close);
  const b = 'QnVzaW5lc3M6MA==';
  const addr = { addressLine1: '1 Main St', city: 'Toronto', provinceCode: 'CA-ON', countryCode: 'CA', postalCode: 'M5V 1A1' };
  const item = { productId: 'UHJvZHVjdDox', quantity: 2, unitPrice: '50.00', taxIds: ['U2FsZXNUYXg6MQ=='], description: 'x' };
  const calls = [
    ['wave_create_customer', { businessId: b, name: 'C', email: 'a@b.co', currency: 'CAD', address: addr, shippingDetails: { name: 'S', address: addr, phone: '1', instructions: 'x' } }],
    ['wave_update_customer', { id: 'x', name: 'C2', address: addr }],
    ['wave_delete_customer', { id: 'x' }],
    ['wave_create_product', { businessId: b, name: 'P', unitPrice: 10.5, incomeAccountId: 'x', defaultSalesTaxIds: ['y'] }],
    ['wave_update_product', { id: 'x', unitPrice: '11' }],
    ['wave_archive_product', { id: 'x' }],
    ['wave_create_account', { businessId: b, name: 'A', subtype: 'EXPENSE', currency: 'CAD', displayId: '5000' }],
    ['wave_update_account', { id: 'x', sequence: 3, name: 'A2', description: null }],
    ['wave_archive_account', { id: 'x' }],
    ['wave_create_sales_tax', { businessId: b, name: 'HST', abbreviation: 'HST', rate: 0.13, isRecoverable: true }],
    ['wave_update_sales_tax', { id: 'x', rates: [{ effective: '2026-01-01', rate: '0.15' }] }],
    ['wave_archive_sales_tax', { id: 'x' }],
    ['wave_create_invoice', { businessId: b, customerId: 'x', items: [item], status: 'DRAFT', invoiceDate: '2026-01-01', dueDate: '2026-01-31', currency: 'CAD', discounts: [{ discountType: 'PERCENTAGE', percentage: 10, name: 'D' }], memo: 'm', hideUnit: true }],
    ['wave_update_invoice', { id: 'x', items: [{ productId: 'p', taxIds: [] }], dueDate: '2026-02-01' }],
    ['wave_clone_invoice', { invoiceId: 'x' }],
    ['wave_approve_invoice', { invoiceId: 'x' }],
    ['wave_send_invoice', { invoiceId: 'x', to: ['a@b.co'], subject: 's', message: 'm', ccMyself: true }],
    ['wave_mark_invoice_sent', { invoiceId: 'x', sentAt: '2026-01-02T10:00:00Z' }],
    ['wave_delete_invoice', { invoiceId: 'x' }],
    ['wave_record_invoice_payment', { invoiceId: 'x', paymentAccountId: 'y', amount: '25.00', paymentDate: '2026-01-05', paymentMethod: 'CHEQUE', memo: 'm' }],
    ['wave_update_invoice_payment', { id: 'x', amount: 30, paymentMethod: 'CASH' }],
    ['wave_delete_invoice_payment', { id: 'x' }],
    ['wave_send_invoice_payment_receipt', { invoiceId: 'x', invoicePaymentId: 'y', to: ['a@b.co'], attachPdf: true }],
    ['wave_create_estimate', { businessId: b, customerId: 'x', items: [item], depositStatus: 'ENABLED_OPTIONAL', depositUnit: 'PERCENTAGE', depositValue: 25, dueDate: '2026-02-01' }],
    ['wave_clone_estimate', { estimateId: 'x' }],
    ['wave_approve_estimate', { estimateId: 'x' }],
    ['wave_send_estimate', { estimateId: 'x', to: ['a@b.co'], hideGrandTotal: true }],
    ['wave_mark_estimate_sent', { estimateId: 'x' }],
    ['wave_mark_estimate_accepted', { estimateId: 'x' }],
    ['wave_reset_estimate_acceptance', { estimateId: 'x' }],
    ['wave_convert_estimate_to_invoice', { estimateId: 'x' }],
    ['wave_generate_estimate_pdf', { estimateId: 'x' }],
    ['wave_send_estimate_acceptance_email', { estimateId: 'x' }],
    ['wave_delete_estimate', { estimateId: 'x' }],
    ['wave_record_estimate_deposit', { estimateId: 'x', amount: '100.00', paymentDate: '2026-01-05', paymentMethod: 'BANK_TRANSFER', paymentAccountId: 'y' }],
    ['wave_update_estimate_deposit', { id: 'x', estimateId: 'y', amount: '90.00' }],
    ['wave_delete_estimate_payment', { id: 'x' }],
    ['wave_send_estimate_deposit_receipt', { estimateId: 'x', estimatePaymentId: 'y', to: ['a@b.co'] }],
    ['wave_create_transaction', { businessId: b, date: '2026-01-05', description: 'Sale', anchor: { accountId: 'bank', amount: '113.00', direction: 'DEPOSIT' }, lineItems: [{ accountId: 'income', amount: '100.00', customerId: 'c', taxes: [{ salesTaxId: 't', amount: '13.00' }] }] }],
    ['wave_create_transactions', { businessId: b, transactions: [{ date: '2026-01-05', description: 'Fuel', externalId: 'e1', anchor: { accountId: 'card', amount: 60, direction: 'WITHDRAWAL' }, lineItems: [{ accountId: 'fuel', amount: 60, balance: 'DEBIT' }] }] }],
    ['wave_list_invoices', { businessId: b, status: 'OVERDUE', invoiceDateStart: '2026-01-01', sort: ['DUE_AT_ASC'], detail: 'full', amountDue: '10.00' }],
    ['wave_list_estimates', { businessId: b, status: 'ACTIVE', sort: 'TOTAL_DESC' }],
    ['wave_list_accounts', { businessId: b, types: ['ASSET'], subtypes: ['CASH_AND_BANK'] }],
    ['wave_list_products', { businessId: b, isSold: true, sort: ['NAME_ASC'], modifiedAtAfter: '2026-01-01T00:00:00Z' }],
    ['wave_get_estimate', { businessId: b, id: 'x' }],
  ];
  const failures = [];
  for (const [name, args] of calls) {
    const r = await h.call(name, args);
    if (!r.isError || !/rejected the configured access token/.test(r.text)) failures.push(`${name}: ${r.text.slice(0, 300)}`);
    await sleep(120);
  }
  assert.deepEqual(failures, []);
});
