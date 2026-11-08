/**
 * Operations on Wave's web-app API (https://gql.waveapps.com/graphql/internal).
 *
 * Unofficial: these mirror documents the Wave web app (next.waveapps.com)
 * sends, trimmed to the fields this server uses. The endpoint refuses
 * introspection and inline argument values (always pass variables), and
 * accepts only a browser session token. Verified live on 2026-11-08:
 * list/get, create, patch (incl. splits, recategorize, amount, date) and
 * delete. Patches carry the transaction's `sequence` (optimistic lock):
 * a stale one fails with "Stale transaction sequence" (HTTP 412).
 */
export const IOPS = {};

const LINE = /* GraphQL */ `
fragment TxLineF on ClientTransactionLineItem {
  order itemType amount description taxAction isReconciled
  account { id name subtype { value } }
  vendor { id name }
  customer { id name }
  taxSummary { totalTaxAmount taxLiabilities { accountId amount isTaxAmountManuallySet salesTax { id name abbreviation } } }
  tags { id name }
}`;

const TX = /* GraphQL */ `
fragment TxF on ClientTransaction {
  id sequence date description notes amount direction verificationStatus active missingFields dateCreated
  currency { code }
  origin { type description }
  anchorLineItem { ...TxLineF }
  lineItems { ...TxLineF }
  attachment { id type }
}
${LINE}`;

IOPS.ListTransactions = /* GraphQL */ `
query ListTransactions($businessId: ID!, $filters: TransactionFilter, $first: Int, $after: String, $sort: [TransactionSort!]!) {
  business(id: $businessId) {
    id
    transactions(first: $first, after: $after, filters: $filters, sort: $sort) {
      edges { cursor node { ...TxF } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
${TX}`;

IOPS.GetTransaction = /* GraphQL */ `
query GetTransaction($businessId: ID!, $transactionId: ID!) {
  business(id: $businessId) {
    id
    transaction(id: $transactionId) {
      ...TxF
      detailActions { amount date description account category notes lineItems split canDelete salesTax verificationStatus }
    }
  }
}
${TX}`;

IOPS.UncategorizedAccounts = /* GraphQL */ `
query UncategorizedAccounts($businessId: ID!) {
  business(id: $businessId) {
    id
    accounts(subtypes: [UNCATEGORIZED_INCOME, UNCATEGORIZED_EXPENSE]) { edges { node { id name } } }
  }
}`;

/** Sales tax for one line, as the web app calculates it (amounts are tax-inclusive). */
IOPS.SalesTaxSummary = /* GraphQL */ `
query SalesTaxSummary($businessId: ID!, $input: SalesTaxSummaryInput) {
  business(id: $businessId) {
    id
    salesTaxSummary(input: $input) {
      baseLineItemAmount taxTotalAmount taxCalculationErrored
      appliedTaxes { order amount account { id } salesTax { id name abbreviation rate isArchived } }
    }
  }
}`;

IOPS.TransactionPatch = /* GraphQL */ `
mutation TransactionPatch($input: TransactionPatchInput!) {
  transactionPatch(input: $input) {
    didSucceed
    inputErrors { code message path }
    transaction { ...TxF }
    sideEffects { id }
  }
}
${TX}`;

IOPS.TransactionDelete = /* GraphQL */ `
mutation TransactionDelete($input: TransactionDeleteInput!) {
  transactionDelete(input: $input) {
    didSucceed
    deletedTransactionIds
    sideEffects { id }
  }
}`;

IOPS.Viewer = /* GraphQL */ `query Viewer { user { id firstName lastName defaultEmail } }`;
