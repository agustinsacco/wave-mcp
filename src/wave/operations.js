/**
 * Every GraphQL document this server sends. Kept in one module so the test
 * suite can validate each one against the schema snapshot (schema/wave.graphql)
 * and, with WAVE_CONTRACT=1, against the live endpoint.
 *
 * Field choices:
 *  - Money inside invoices/estimates selects only `value`; the record's own
 *    `currency` applies. Elsewhere Money carries its currency code.
 *  - Deprecated fields (internalId, Money.raw, InvoiceItem.price, ...) are never
 *    selected.
 *  - AccountSubtype.archivable/systemCreated are not selected: Wave has
 *    returned null for them although the schema declares them non-null, which
 *    nulls the whole response.
 */

const F = {};

F.Address = /* GraphQL */ `
fragment AddressF on Address {
  addressLine1 addressLine2 city postalCode
  province { code name }
  country { code name }
}`;

F.Business = /* GraphQL */ `
fragment BusinessF on Business {
  id name isPersonal isArchived timezone organizationalType
  currency { code }
  type { name value }
  subtype { name value }
  createdAt modifiedAt
}`;

F.BusinessFull = /* GraphQL */ `
fragment BusinessFullF on Business {
  ...BusinessF
  phone fax mobile tollFree website emailSendEnabled
  address { ...AddressF }
  invoiceEstimateSettings { generalSettings { accentColor logoUrl } }
}`;

F.Customer = /* GraphQL */ `
fragment CustomerF on Customer {
  id name displayId firstName lastName email phone mobile isArchived
  currency { code }
  outstandingAmount { value currency { code } }
  overdueAmount { value currency { code } }
  modifiedAt
}`;

F.CustomerFull = /* GraphQL */ `
fragment CustomerFullF on Customer {
  ...CustomerF
  fax tollFree website internalNotes isActive createdAt
  address { ...AddressF }
  shippingDetails { name phone instructions address { ...AddressF } }
}`;

F.Vendor = /* GraphQL */ `
fragment VendorF on Vendor {
  id name displayId firstName lastName email phone mobile isArchived
  currency { code }
  modifiedAt
}`;

F.VendorFull = /* GraphQL */ `
fragment VendorFullF on Vendor {
  ...VendorF
  fax tollFree website internalNotes createdAt
  address { ...AddressF }
  shippingDetails { name phone instructions address { ...AddressF } }
}`;

F.Product = /* GraphQL */ `
fragment ProductF on Product {
  id name description unitPrice isSold isBought isArchived
  incomeAccount { id name }
  expenseAccount { id name }
  defaultSalesTaxes { id name abbreviation }
  modifiedAt
}`;

F.ProductFull = /* GraphQL */ `
fragment ProductFullF on Product {
  ...ProductF
  createdAt
}`;

F.Account = /* GraphQL */ `
fragment AccountF on Account {
  id name displayId description isArchived normalBalanceType sequence
  balance balanceInBusinessCurrency
  currency { code }
  type { name value }
  subtype { name value }
}`;

F.AccountFull = /* GraphQL */ `
fragment AccountFullF on Account {
  ...AccountF
  classicId
  subtype { description }
}`;

F.SalesTax = /* GraphQL */ `
fragment SalesTaxF on SalesTax {
  id name abbreviation description taxNumber showTaxNumberOnInvoices
  rate isCompound isRecoverable isArchived
  modifiedAt
}`;

F.SalesTaxFull = /* GraphQL */ `
fragment SalesTaxFullF on SalesTax {
  ...SalesTaxF
  rates { effective rate }
  createdAt
}`;

F.InvoicePayment = /* GraphQL */ `
fragment InvoicePaymentF on InvoicePayment {
  id paymentDate amount paymentMethod memo state active origin
  transactionType paymentProvider exchangeRate
  paymentCurrency { code }
  invoiceCurrency { code }
  account { id name }
  customer { id name }
  createdAt modifiedAt
}`;

F.InvoicePaymentFull = /* GraphQL */ `
fragment InvoicePaymentFullF on InvoicePayment {
  ...InvoicePaymentF
  displayExchangeRate readonlyUrl paymentMethodId transactionId confirmationCode
  institutionName authorizerName accountNumberLast3 accountingTransactionId
  businessCurrency { code }
  paymentDetails { cardType lastFour cardSource }
  invoice { id invoiceNumber }
  originInvoicePayment { id }
}`;

F.Invoice = /* GraphQL */ `
fragment InvoiceF on Invoice {
  id invoiceNumber status title invoiceDate dueDate poNumber
  currency { code }
  customer { id name }
  total { value }
  amountDue { value }
  amountPaid { value }
  lastSentAt lastViewedAt viewUrl
  createdAt modifiedAt
}`;

F.InvoiceItem = /* GraphQL */ `
fragment InvoiceItemF on InvoiceItem {
  id description quantity unitPrice
  subtotal { value }
  total { value }
  product { id name }
  account { id name }
  taxes { amount { value } salesTax { id name abbreviation } }
}`;

F.InvoiceFull = /* GraphQL */ `
fragment InvoiceFullF on Invoice {
  ...InvoiceF
  subhead exchangeRate pdfUrl memo footer
  subtotal { value }
  taxTotal { value }
  discountTotal { value }
  discounts {
    __typename name
    ... on FixedInvoiceDiscount { amount }
    ... on PercentageInvoiceDiscount { percentage }
  }
  items { ...InvoiceItemF }
  payments { ...InvoicePaymentF }
  source {
    __typename
    ... on Estimate { id }
    ... on NewEstimate { id }
    ... on RecurringInvoice { id }
  }
  lastSentVia requireTermsOfServiceAgreement
  disableCreditCardPayments disableBankPayments disableAmexPayments
  itemTitle unitTitle priceTitle amountTitle
  hideName hideDescription hideUnit hidePrice hideAmount
  invoiceReminders { id daysDelta sent sentManually issueDate }
  attachments { id fileName fileSize downloadUrl }
}`;

F.EstimatePayment = /* GraphQL */ `
fragment EstimatePaymentF on EstimatePayment {
  id paymentDate amount paymentMethod memo state active origin
  transactionType paymentProvider paymentAccountId
  currency { code }
  createdAt modifiedAt
}`;

F.EstimatePaymentFull = /* GraphQL */ `
fragment EstimatePaymentFullF on EstimatePayment {
  ...EstimatePaymentF
  readonlyUrl paymentMethodId transactionId confirmationCode originPaymentId
  paymentDetails { cardType lastFour cardSource }
  estimate { id estimateNumber customer { id name } }
}`;

F.Estimate = /* GraphQL */ `
fragment EstimateF on AREstimate {
  id estimateNumber status title estimateDate dueDate poNumber
  currency { code }
  customer { id name }
  total { value }
  amountDue { value }
  amountPaid { value }
  depositTotal { value }
  depositStatus depositPaymentStatus
  lastSentAt lastViewedAt viewUrl
  createdAt modifiedAt
}`;

F.EstimateFull = /* GraphQL */ `
fragment EstimateFullF on AREstimate {
  ...EstimateF
  subhead exchangeRate pdfUrl memo footer dontCarryOverNotesToInvoice
  depositUnit depositValue
  subtotal { value }
  taxTotal { value }
  discountTotal { value }
  discounts {
    __typename name
    ... on FixedEstimateDiscount { amount }
    ... on PercentageEstimateDiscount { percentage }
  }
  items {
    id description quantity unitPrice
    subtotal { value }
    total { value }
    product { id name }
    account { id name }
    taxes { amount { value } salesTax { id name abbreviation } }
  }
  payments { ...EstimatePaymentF }
  history { entityType state name email timestamp }
  attachments { id fileName fileSize downloadUrl }
  lastSentVia requireTermsOfServiceAgreement
  disableCreditCardPayments disableBankPayments disableAmexPayments
  itemTitle unitTitle priceTitle amountTitle
  hideName hideDescription hideUnit hidePrice hideAmount
}`;

// Fragment dependency graph, so each document carries exactly what it uses.
const DEPS = {
  BusinessFull: ['Business', 'Address'],
  CustomerFull: ['Customer', 'Address'],
  VendorFull: ['Vendor', 'Address'],
  ProductFull: ['Product'],
  AccountFull: ['Account'],
  SalesTaxFull: ['SalesTax'],
  InvoicePaymentFull: ['InvoicePayment'],
  InvoiceFull: ['Invoice', 'InvoiceItem', 'InvoicePayment'],
  EstimatePaymentFull: ['EstimatePayment'],
  EstimateFull: ['Estimate', 'EstimatePayment'],
};

function withFragments(body, ...names) {
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of DEPS[n] || []) visit(d);
  };
  names.forEach(visit);
  return [body.trim(), ...[...seen].map((n) => F[n].trim())].join('\n');
}

const PAGE = 'pageInfo { currentPage totalPages totalCount }';

export const OPS = {};
const op = (name, doc) => (OPS[name] = doc);

// ---------------------------------------------------------------- context
op('Viewer', `query Viewer { user { id defaultEmail firstName lastName createdAt } }`);
op('OAuthApp', `query OAuthApp { oAuthApplication { id name description clientId createdAt } }`);
op(
  'ListBusinesses',
  withFragments(
    `query ListBusinesses($page: Int!, $pageSize: Int!, $isArchived: Boolean) {
      businesses(page: $page, pageSize: $pageSize, isArchived: $isArchived) { ${PAGE} edges { node { ...BusinessF } } }
    }`,
    'Business',
  ),
);
op('GetBusiness', withFragments(`query GetBusiness($id: ID!) { business(id: $id) { ...BusinessFullF } }`, 'BusinessFull'));

// ---------------------------------------------------------------- reference
op('Currencies', `query Currencies { currencies { code symbol name plural exponent } }`);
op('Countries', `query Countries { countries { code name currency { code } } }`);
op('Country', `query Country($code: CountryCode!) { country(code: $code) { code name nameWithArticle currency { code } provinces { code name } } }`);
op('Province', `query Province($code: String!) { province(code: $code) { code name } }`);
op('AccountTypes', `query AccountTypes { accountTypes { name value normalBalanceType } }`);
op('AccountSubtypes', `query AccountSubtypes { accountSubtypes { name value description type { value } } }`);

// ---------------------------------------------------------------- customers
const customerList = (frag) => `query ListCustomers${frag === 'CustomerFull' ? 'Full' : ''}($businessId: ID!, $page: Int!, $pageSize: Int!, $sort: [CustomerSort!]! = [CREATED_AT_DESC], $email: String, $isArchived: Boolean, $modifiedAtAfter: DateTime, $modifiedAtBefore: DateTime) {
  business(id: $businessId) { id customers(page: $page, pageSize: $pageSize, sort: $sort, email: $email, isArchived: $isArchived, modifiedAtAfter: $modifiedAtAfter, modifiedAtBefore: $modifiedAtBefore) {
    ${PAGE} edges { node { ...${frag}F } } } }
}`;
op('ListCustomers', withFragments(customerList('Customer'), 'Customer'));
op('ListCustomersFull', withFragments(customerList('CustomerFull'), 'CustomerFull'));
op('GetCustomer', withFragments(`query GetCustomer($businessId: ID!, $id: ID!) { business(id: $businessId) { id customer(id: $id) { ...CustomerFullF } } }`, 'CustomerFull'));
op('CustomerCreate', withFragments(`mutation CustomerCreate($input: CustomerCreateInput!) { customerCreate(input: $input) { didSucceed inputErrors { path message code } customer { ...CustomerFullF } } }`, 'CustomerFull'));
op('CustomerPatch', withFragments(`mutation CustomerPatch($input: CustomerPatchInput!) { customerPatch(input: $input) { didSucceed inputErrors { path message code } customer { ...CustomerFullF } } }`, 'CustomerFull'));
op('CustomerDelete', `mutation CustomerDelete($input: CustomerDeleteInput!) { customerDelete(input: $input) { didSucceed inputErrors { path message code } } }`);

// ---------------------------------------------------------------- vendors (read-only in Wave's API)
const vendorList = (frag) => `query ListVendors${frag === 'VendorFull' ? 'Full' : ''}($businessId: ID!, $page: Int!, $pageSize: Int!, $email: String, $modifiedAtAfter: DateTime, $modifiedAtBefore: DateTime) {
  business(id: $businessId) { id vendors(page: $page, pageSize: $pageSize, email: $email, modifiedAtAfter: $modifiedAtAfter, modifiedAtBefore: $modifiedAtBefore) {
    ${PAGE} edges { node { ...${frag}F } } } }
}`;
op('ListVendors', withFragments(vendorList('Vendor'), 'Vendor'));
op('ListVendorsFull', withFragments(vendorList('VendorFull'), 'VendorFull'));
op('GetVendor', withFragments(`query GetVendor($businessId: ID!, $id: ID!) { business(id: $businessId) { id vendor(id: $id) { ...VendorFullF } } }`, 'VendorFull'));

// ---------------------------------------------------------------- products
const productList = (frag) => `query ListProducts${frag === 'ProductFull' ? 'Full' : ''}($businessId: ID!, $page: Int!, $pageSize: Int!, $sort: [ProductSort!]! = [CREATED_AT_DESC], $isSold: Boolean, $isBought: Boolean, $isArchived: Boolean = false, $modifiedAtAfter: DateTime, $modifiedAtBefore: DateTime) {
  business(id: $businessId) { id products(page: $page, pageSize: $pageSize, sort: $sort, isSold: $isSold, isBought: $isBought, isArchived: $isArchived, modifiedAtAfter: $modifiedAtAfter, modifiedAtBefore: $modifiedAtBefore) {
    ${PAGE} edges { node { ...${frag}F } } } }
}`;
op('ListProducts', withFragments(productList('Product'), 'Product'));
op('ListProductsFull', withFragments(productList('ProductFull'), 'ProductFull'));
op('GetProduct', withFragments(`query GetProduct($businessId: ID!, $id: ID!) { business(id: $businessId) { id product(id: $id) { ...ProductFullF } } }`, 'ProductFull'));
op('ProductCreate', withFragments(`mutation ProductCreate($input: ProductCreateInput!) { productCreate(input: $input) { didSucceed inputErrors { path message code } product { ...ProductFullF } } }`, 'ProductFull'));
op('ProductPatch', withFragments(`mutation ProductPatch($input: ProductPatchInput!) { productPatch(input: $input) { didSucceed inputErrors { path message code } product { ...ProductFullF } } }`, 'ProductFull'));
op('ProductArchive', withFragments(`mutation ProductArchive($input: ProductArchiveInput!) { productArchive(input: $input) { didSucceed inputErrors { path message code } product { ...ProductF } } }`, 'Product'));

// ---------------------------------------------------------------- accounts
const accountList = (frag) => `query ListAccounts${frag === 'AccountFull' ? 'Full' : ''}($businessId: ID!, $page: Int!, $pageSize: Int!, $types: [AccountTypeValue!], $subtypes: [AccountSubtypeValue!], $excludedSubtypes: [AccountSubtypeValue!], $isArchived: Boolean = false) {
  business(id: $businessId) { id accounts(page: $page, pageSize: $pageSize, types: $types, subtypes: $subtypes, excludedSubtypes: $excludedSubtypes, isArchived: $isArchived) {
    ${PAGE} edges { node { ...${frag}F } } } }
}`;
op('ListAccounts', withFragments(accountList('Account'), 'Account'));
op('ListAccountsFull', withFragments(accountList('AccountFull'), 'AccountFull'));
op('GetAccount', withFragments(`query GetAccount($businessId: ID!, $id: ID!) { business(id: $businessId) { id account(id: $id) { ...AccountFullF } } }`, 'AccountFull'));
op('AccountCreate', withFragments(`mutation AccountCreate($input: AccountCreateInput!) { accountCreate(input: $input) { didSucceed inputErrors { path message code } account { ...AccountFullF } } }`, 'AccountFull'));
op('AccountPatch', withFragments(`mutation AccountPatch($input: AccountPatchInput!) { accountPatch(input: $input) { didSucceed inputErrors { path message code } account { ...AccountFullF } } }`, 'AccountFull'));
op('AccountArchive', `mutation AccountArchive($input: AccountArchiveInput!) { accountArchive(input: $input) { didSucceed inputErrors { path message code } } }`);

// ---------------------------------------------------------------- sales taxes
const salesTaxList = (frag) => `query ListSalesTaxes${frag === 'SalesTaxFull' ? 'Full' : ''}($businessId: ID!, $page: Int!, $pageSize: Int!, $isArchived: Boolean = false, $modifiedAtAfter: DateTime, $modifiedAtBefore: DateTime) {
  business(id: $businessId) { id salesTaxes(page: $page, pageSize: $pageSize, isArchived: $isArchived, modifiedAtAfter: $modifiedAtAfter, modifiedAtBefore: $modifiedAtBefore) {
    ${PAGE} edges { node { ...${frag}F } } } }
}`;
op('ListSalesTaxes', withFragments(salesTaxList('SalesTax'), 'SalesTax'));
op('ListSalesTaxesFull', withFragments(salesTaxList('SalesTaxFull'), 'SalesTaxFull'));
op('GetSalesTax', withFragments(`query GetSalesTax($businessId: ID!, $id: ID!) { business(id: $businessId) { id salesTax(id: $id) { ...SalesTaxFullF } } }`, 'SalesTaxFull'));
op('SalesTaxCreate', withFragments(`mutation SalesTaxCreate($input: SalesTaxCreateInput!) { salesTaxCreate(input: $input) { didSucceed inputErrors { path message code } salesTax { ...SalesTaxFullF } } }`, 'SalesTaxFull'));
op('SalesTaxPatch', withFragments(`mutation SalesTaxPatch($input: SalesTaxPatchInput!) { salesTaxPatch(input: $input) { didSucceed inputErrors { path message code } salesTax { ...SalesTaxFullF } } }`, 'SalesTaxFull'));
op('SalesTaxArchive', withFragments(`mutation SalesTaxArchive($input: SalesTaxArchiveInput!) { salesTaxArchive(input: $input) { didSucceed inputErrors { path message code } salesTax { ...SalesTaxF } } }`, 'SalesTax'));

// ---------------------------------------------------------------- invoices
const invoiceArgs = `$businessId: ID!, $page: Int!, $pageSize: Int!, $sort: [InvoiceSort!]! = [CREATED_AT_DESC], $status: InvoiceStatus, $customerId: ID, $currency: CurrencyCode, $sourceId: ID, $invoiceDateStart: Date, $invoiceDateEnd: Date, $modifiedAtAfter: DateTime, $modifiedAtBefore: DateTime, $invoiceNumber: String, $amountDue: Decimal`;
const invoiceCall = `invoices(page: $page, pageSize: $pageSize, sort: $sort, status: $status, customerId: $customerId, currency: $currency, sourceId: $sourceId, invoiceDateStart: $invoiceDateStart, invoiceDateEnd: $invoiceDateEnd, modifiedAtAfter: $modifiedAtAfter, modifiedAtBefore: $modifiedAtBefore, invoiceNumber: $invoiceNumber, amountDue: $amountDue)`;
op('ListInvoices', withFragments(`query ListInvoices(${invoiceArgs}) { business(id: $businessId) { id ${invoiceCall} { ${PAGE} edges { node { ...InvoiceF } } } } }`, 'Invoice'));
op('ListInvoicesFull', withFragments(`query ListInvoicesFull(${invoiceArgs}) { business(id: $businessId) { id ${invoiceCall} { ${PAGE} edges { node { ...InvoiceFullF } } } } }`, 'InvoiceFull'));
// Used by reports and payment listings: items, taxes and payments, nothing else.
op(
  'ScanInvoices',
  withFragments(
    `query ScanInvoices(${invoiceArgs}) { business(id: $businessId) { id ${invoiceCall} { ${PAGE} edges { node {
      ...InvoiceF exchangeRate
      subtotal { value } taxTotal { value } discountTotal { value }
      items { ...InvoiceItemF }
      payments { ...InvoicePaymentF }
    } } } } }`,
    'Invoice',
    'InvoiceItem',
    'InvoicePayment',
  ),
);
op('GetInvoice', withFragments(`query GetInvoice($businessId: ID!, $id: ID!) { business(id: $businessId) { id invoice(id: $id) { ...InvoiceFullF } } }`, 'InvoiceFull'));
const invoiceMutation = (name, field, input) =>
  op(name, withFragments(`mutation ${name}($input: ${input}!) { ${field}(input: $input) { didSucceed inputErrors { path message code } invoice { ...InvoiceFullF } } }`, 'InvoiceFull'));
invoiceMutation('InvoiceCreate', 'invoiceCreate', 'InvoiceCreateInput');
invoiceMutation('InvoicePatch', 'invoicePatch', 'InvoicePatchInput');
invoiceMutation('InvoiceClone', 'invoiceClone', 'InvoiceCloneInput');
invoiceMutation('InvoiceApprove', 'invoiceApprove', 'InvoiceApproveInput');
invoiceMutation('InvoiceMarkSent', 'invoiceMarkSent', 'InvoiceMarkSentInput');
op('InvoiceSend', withFragments(`mutation InvoiceSend($input: InvoiceSendInput!) { invoiceSend(input: $input) { didSucceed inputErrors { path message code } invoice { ...InvoiceF lastSentVia } } }`, 'Invoice'));
op('InvoiceDelete', `mutation InvoiceDelete($input: InvoiceDeleteInput!) { invoiceDelete(input: $input) { didSucceed inputErrors { path message code } } }`);

// ---------------------------------------------------------------- invoice payments
op('GetInvoicePayment', withFragments(`query GetInvoicePayment($businessId: ID!, $id: ID!) { business(id: $businessId) { id invoicePayment(id: $id) { ...InvoicePaymentFullF } } }`, 'InvoicePaymentFull'));
op('InvoicePaymentCreateManual', withFragments(`mutation InvoicePaymentCreateManual($input: InvoicePaymentCreateManualInput!) { invoicePaymentCreateManual(input: $input) { didSucceed inputErrors { path message code } invoicePayment { ...InvoicePaymentFullF } } }`, 'InvoicePaymentFull'));
op('InvoicePaymentPatch', withFragments(`mutation InvoicePaymentPatch($input: InvoicePaymentPatchInput!) { invoicePaymentPatch(input: $input) { didSucceed inputErrors { path message code } invoicePayment { ...InvoicePaymentFullF } } }`, 'InvoicePaymentFull'));
op('InvoicePaymentDelete', `mutation InvoicePaymentDelete($input: InvoicePaymentDeleteInput!) { invoicePaymentDelete(input: $input) { didSucceed inputErrors { path message code } } }`);
op('InvoicePaymentReceiptSend', `mutation InvoicePaymentReceiptSend($input: InvoicePaymentReceiptSendInput!) { invoicePaymentReceiptSend(input: $input) { didSucceed inputErrors { path message code } } }`);

// ---------------------------------------------------------------- estimates
const estimateArgs = `$businessId: ID!, $page: Int!, $pageSize: Int!, $sort: EstimateSort! = CREATED_AT_DESC, $status: EstimateListStatusFilter, $customerId: ID, $currency: CurrencyCode, $estimateDateStart: Date, $estimateDateEnd: Date, $modifiedAtAfter: DateTime, $modifiedAtBefore: DateTime, $estimateNumber: String, $amountDue: Decimal`;
const estimateCall = `estimates(page: $page, pageSize: $pageSize, sort: $sort, status: $status, customerId: $customerId, currency: $currency, estimateDateStart: $estimateDateStart, estimateDateEnd: $estimateDateEnd, modifiedAtAfter: $modifiedAtAfter, modifiedAtBefore: $modifiedAtBefore, estimateNumber: $estimateNumber, amountDue: $amountDue)`;
op('ListEstimates', withFragments(`query ListEstimates(${estimateArgs}) { business(id: $businessId) { id ${estimateCall} { ${PAGE} edges { node { ...EstimateF } } } } }`, 'Estimate'));
op('ListEstimatesFull', withFragments(`query ListEstimatesFull(${estimateArgs}) { business(id: $businessId) { id ${estimateCall} { ${PAGE} edges { node { ...EstimateFullF } } } } }`, 'EstimateFull'));
op('ScanEstimatePayments', withFragments(`query ScanEstimatePayments(${estimateArgs}) { business(id: $businessId) { id ${estimateCall} { ${PAGE} edges { node { ...EstimateF payments { ...EstimatePaymentF } } } } } }`, 'Estimate', 'EstimatePayment'));
op(
  'GetEstimate',
  withFragments(
    `query GetEstimate($businessId: ID!, $id: ID!, $embedAttachments: Boolean = true, $embedHistory: Boolean = true, $embedDepositPayments: Boolean = true) {
      business(id: $businessId) { id estimate(id: $id, embedAttachments: $embedAttachments, embedHistory: $embedHistory, embedDepositPayments: $embedDepositPayments) { ...EstimateFullF } }
    }`,
    'EstimateFull',
  ),
);
const estimateMutation = (name, field, input) =>
  op(name, withFragments(`mutation ${name}($input: ${input}!) { ${field}(input: $input) { didSucceed inputErrors { path message code } estimate { ...EstimateFullF } } }`, 'EstimateFull'));
estimateMutation('EstimateCreate', 'estimateCreate', 'EstimateCreateInput');
estimateMutation('EstimatePatch', 'estimatePatch', 'EstimatePatchInput');
estimateMutation('EstimateClone', 'estimateClone', 'EstimateCloneInput');
estimateMutation('EstimateApprove', 'estimateApprove', 'EstimateApproveInput');
estimateMutation('EstimateMarkSent', 'estimateMarkSent', 'EstimateMarkSentInput');
estimateMutation('EstimateMarkAccepted', 'estimateMarkAccepted', 'EstimateMarkAcceptedInput');
estimateMutation('EstimateResetAcceptance', 'estimateResetAcceptance', 'EstimateResetAcceptanceInput');
op('EstimateSend', withFragments(`mutation EstimateSend($input: EstimateSendInput!) { estimateSend(input: $input) { didSucceed inputErrors { path message code } estimate { ...EstimateF lastSentVia } } }`, 'Estimate'));
op('EstimateSendAcceptanceCustomerEmail', withFragments(`mutation EstimateSendAcceptanceCustomerEmail($input: EstimateSendAcceptanceCustomerEmailInput!) { estimateSendAcceptanceCustomerEmail(input: $input) { didSucceed inputErrors { path message code } estimate { ...EstimateF } } }`, 'Estimate'));
op('EstimateDelete', `mutation EstimateDelete($input: EstimateDeleteInput!) { estimateDelete(input: $input) { didSucceed inputErrors { path message code } } }`);
op('EstimateGeneratePdf', `mutation EstimateGeneratePdf($input: EstimateGeneratePdfInput!) { estimateGeneratePdf(input: $input) { didSucceed inputErrors { path message code } pdfUrl } }`);
op('ConvertEstimateToInvoice', `mutation ConvertEstimateToInvoice($input: ConvertEstimateToInvoiceInput!) { convertEstimateToInvoice(input: $input) { didSucceed inputErrors { path message code } invoiceId } }`);

// ---------------------------------------------------------------- estimate deposit payments
op('GetEstimatePayment', withFragments(`query GetEstimatePayment($businessId: ID!, $id: ID!) { business(id: $businessId) { id estimatePayment(id: $id) { ...EstimatePaymentFullF } } }`, 'EstimatePaymentFull'));
op('EstimateDepositPaymentCreateManual', withFragments(`mutation EstimateDepositPaymentCreateManual($input: EstimateDepositPaymentCreateManualInput!) { estimateDepositPaymentCreateManual(input: $input) { didSucceed inputErrors { path message code } estimatePayment { ...EstimatePaymentFullF } } }`, 'EstimatePaymentFull'));
op('EstimateDepositPaymentUpdateManual', withFragments(`mutation EstimateDepositPaymentUpdateManual($input: EstimateDepositPaymentUpdateManualInput!) { estimateDepositPaymentUpdateManual(input: $input) { didSucceed inputErrors { path message code } estimatePayment { ...EstimatePaymentFullF } } }`, 'EstimatePaymentFull'));
op('EstimatePaymentDelete', `mutation EstimatePaymentDelete($input: EstimatePaymentDeleteInput!) { estimatePaymentDelete(input: $input) { didSucceed inputErrors { path message code } } }`);
op('EstimateDepositPaymentReceiptSend', `mutation EstimateDepositPaymentReceiptSend($input: EstimateDepositPaymentReceiptSendInput!) { estimateDepositPaymentReceiptSend(input: $input) { didSucceed inputErrors { path message code } } }`);

// ---------------------------------------------------------------- money transactions (write-only in Wave's API)
op('MoneyTransactionCreate', `mutation MoneyTransactionCreate($input: MoneyTransactionCreateInput!) { moneyTransactionCreate(input: $input) { didSucceed inputErrors { path message code } transaction { id } } }`);
op('MoneyTransactionsCreate', `mutation MoneyTransactionsCreate($input: MoneyTransactionsCreateInput!) { moneyTransactionsCreate(input: $input) { didSucceed inputErrors { path message code } transactions { id } } }`);
