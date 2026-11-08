# Wave Accounting: tools, resources and prompts

Generated from @saccolabs/wave-mcp 1.0.1 by `npm run docs`; do not edit by hand.

72 tools in 13 toolsets (28 read, 44 write), 3 resources and 3 prompts.
Limit the toolsets with `WAVE_MCP_TOOLSETS` (comma-separated).

## Tools

### context

| Tool | Kind | What it does |
|---|---|---|
| [`wave_get_context`](#wave_get_context) | read | Start here. Returns the signed-in Wave user, how credentials are configured, the businesses this credential reaches, which one is the default, whether writes are enabled, and what the public API cannot do. |
| [`wave_list_businesses`](#wave_list_businesses) | read | List the Wave businesses this credential can access (paginated). |
| [`wave_get_business`](#wave_get_business) | read | Full details of one business: address, contact info, currency, timezone, whether Wave can email invoices for it, and invoice/estimate branding. |
| [`wave_get_reference`](#wave_get_reference) | read | Reference data needed to fill other tools' inputs: currencies, countries, one country with its provinces/states (kind=country, code=CA), a province by code, account types, and account subtypes (needed by wave_create_account). |

### customers

| Tool | Kind | What it does |
|---|---|---|
| [`wave_list_customers`](#wave_list_customers) | read | List customers with their outstanding and overdue balances. |
| [`wave_get_customer`](#wave_get_customer) | read | One customer with address, shipping details, notes and outstanding/overdue amounts. |
| [`wave_create_customer`](#wave_create_customer) | write | Create a customer. Only name is required. |
| [`wave_update_customer`](#wave_update_customer) | write (changes or deletes) | Change fields on a customer. Only the fields you pass are changed; nested address/shipping objects replace the existing ones. |
| [`wave_delete_customer`](#wave_delete_customer) | write (changes or deletes) | Delete a customer. Wave removes it from lists, but the record stays readable by ID (wave_get_customer shows deleted: true); there is no undelete through the API. |

### vendors

| Tool | Kind | What it does |
|---|---|---|
| [`wave_list_vendors`](#wave_list_vendors) | read | List vendors (suppliers). Wave's API cannot create, change or delete vendors, and bills are not exposed. |
| [`wave_get_vendor`](#wave_get_vendor) | read | One vendor with address and contact details. |

### products

| Tool | Kind | What it does |
|---|---|---|
| [`wave_list_products`](#wave_list_products) | read | List products/services (the items invoice and estimate lines must reference), with price, income/expense accounts and default sales taxes. |
| [`wave_get_product`](#wave_get_product) | read | One product/service with its accounts and default sales taxes. |
| [`wave_create_product`](#wave_create_product) | write | Create a product or service. Give it an incomeAccountId to sell it on invoices, an expenseAccountId to buy it, or both. |
| [`wave_update_product`](#wave_update_product) | write (changes or deletes) | Change a product/service. defaultSalesTaxIds replaces the whole list. |
| [`wave_archive_product`](#wave_archive_product) | write (changes or deletes) | Archive a product/service so it can no longer be added to new invoices. |

### accounts

| Tool | Kind | What it does |
|---|---|---|
| [`wave_list_accounts`](#wave_list_accounts) | read | List the chart of accounts with current balances. |
| [`wave_get_account`](#wave_get_account) | read | One account with type, subtype, normal balance, current balance (account and business currency) and its sequence number. |
| [`wave_create_account`](#wave_create_account) | write | Add an account to the chart of accounts. |
| [`wave_update_account`](#wave_update_account) | write (changes or deletes) | Rename an account or change its description/number. |
| [`wave_archive_account`](#wave_archive_account) | write (changes or deletes) | Archive an account (hide it while keeping its history). |

### sales_taxes

| Tool | Kind | What it does |
|---|---|---|
| [`wave_list_sales_taxes`](#wave_list_sales_taxes) | read | List sales taxes with current rate (as a fraction: 0.13 = 13%). detail="full" adds the dated rate history. |
| [`wave_get_sales_tax`](#wave_get_sales_tax) | read | One sales tax with its full dated rate history. |
| [`wave_create_sales_tax`](#wave_create_sales_tax) | write | Create a sales tax. abbreviation must be unique in the business (max 10 characters). |
| [`wave_update_sales_tax`](#wave_update_sales_tax) | write (changes or deletes) | Change a sales tax. To change the rate, pass rates with an effective date; rates replaces the dated rate list, so include existing entries you want to keep (see wave_get_sales_tax). |
| [`wave_archive_sales_tax`](#wave_archive_sales_tax) | write (changes or deletes) | Archive a sales tax so it can no longer be applied. |

### invoices

| Tool | Kind | What it does |
|---|---|---|
| [`wave_list_invoices`](#wave_list_invoices) | read | List invoices with totals, amount due and status. |
| [`wave_get_invoice`](#wave_get_invoice) | read | One invoice with line items, taxes, discounts, payments, reminders, PDF and customer view links. |
| [`wave_create_invoice`](#wave_create_invoice) | write | Create an invoice for a customer. Created as DRAFT unless status=SAVED (approved). |
| [`wave_update_invoice`](#wave_update_invoice) | write (changes or deletes) | Change an invoice. Passing items replaces every line; omit items to keep them. |
| [`wave_clone_invoice`](#wave_clone_invoice) | write | Copy an invoice into a new draft. |
| [`wave_approve_invoice`](#wave_approve_invoice) | write | Approve a draft invoice, which posts it to the books (status SAVED). |
| [`wave_send_invoice`](#wave_send_invoice) | sends (irreversible) | Email an invoice through Wave to real recipients. |
| [`wave_mark_invoice_sent`](#wave_mark_invoice_sent) | write | Record that an invoice was sent outside Wave (no email goes out). |
| [`wave_delete_invoice`](#wave_delete_invoice) | write (changes or deletes) | Permanently delete an invoice. |

### estimates

| Tool | Kind | What it does |
|---|---|---|
| [`wave_list_estimates`](#wave_list_estimates) | read | List estimates (quotes) with totals, deposit state and status. detail="full" adds line items, deposit payments and acceptance history (pages of at most 25). |
| [`wave_get_estimate`](#wave_get_estimate) | read | One estimate with items, taxes, discounts, deposit settings and payments, acceptance history and attachments. |
| [`wave_create_estimate`](#wave_create_estimate) | write | Create a draft estimate (quote). Each line needs a product and a unitPrice. |
| [`wave_update_estimate`](#wave_update_estimate) | write (changes or deletes) | Change an estimate. Wave's patch requires customer, status, title, dates, currency and exchange rate; any you omit are copied from the current estimate. |
| [`wave_clone_estimate`](#wave_clone_estimate) | write | Copy an estimate into a new draft. |
| [`wave_approve_estimate`](#wave_approve_estimate) | write | Approve a draft estimate so it can be sent. |
| [`wave_mark_estimate_accepted`](#wave_mark_estimate_accepted) | write | Record that the customer accepted the estimate. |
| [`wave_reset_estimate_acceptance`](#wave_reset_estimate_acceptance) | write | Undo the customer's acceptance so the estimate can be changed or re-accepted. |
| [`wave_convert_estimate_to_invoice`](#wave_convert_estimate_to_invoice) | write | Create an invoice from an estimate (deposits paid carry over). |
| [`wave_generate_estimate_pdf`](#wave_generate_estimate_pdf) | write | Generate (or regenerate) the estimate PDF and return its URL. |
| [`wave_send_estimate_acceptance_email`](#wave_send_estimate_acceptance_email) | sends (irreversible) | Email the customer the confirmation that their estimate acceptance was recorded. |
| [`wave_delete_estimate`](#wave_delete_estimate) | write (changes or deletes) | Permanently delete an estimate. |
| [`wave_send_estimate`](#wave_send_estimate) | sends (irreversible) | Email an estimate through Wave to real recipients. |
| [`wave_mark_estimate_sent`](#wave_mark_estimate_sent) | write | Record that an estimate was sent outside Wave (no email goes out). |

### payments

| Tool | Kind | What it does |
|---|---|---|
| [`wave_get_invoice_payment`](#wave_get_invoice_payment) | read | One invoice payment with account, method, currency details and processor info. |
| [`wave_record_invoice_payment`](#wave_record_invoice_payment) | write | Record a payment received outside Wave against an invoice (cash, cheque, bank transfer...). paymentAccountId is the account the money went into (usually types=[ASSET] subtypes=[CASH_AND_BANK]). |
| [`wave_update_invoice_payment`](#wave_update_invoice_payment) | write (changes or deletes) | Change a manually recorded invoice payment. |
| [`wave_delete_invoice_payment`](#wave_delete_invoice_payment) | write (changes or deletes) | Delete a recorded invoice payment; the invoice becomes unpaid by that amount. |
| [`wave_send_invoice_payment_receipt`](#wave_send_invoice_payment_receipt) | sends (irreversible) | Email a receipt for an invoice payment to real recipients. |
| [`wave_get_estimate_payment`](#wave_get_estimate_payment) | read | One estimate deposit payment (or refund/void) with its estimate. |
| [`wave_record_estimate_deposit`](#wave_record_estimate_deposit) | write | Record a deposit received outside Wave against an estimate. paymentAccountId is where the money went (a CASH_AND_BANK account). |
| [`wave_update_estimate_deposit`](#wave_update_estimate_deposit) | write (changes or deletes) | Change a manually recorded estimate deposit. |
| [`wave_delete_estimate_payment`](#wave_delete_estimate_payment) | write (changes or deletes) | Delete a recorded estimate deposit payment. |
| [`wave_send_estimate_deposit_receipt`](#wave_send_estimate_deposit_receipt) | sends (irreversible) | Email a receipt for an estimate deposit to real recipients. |
| [`wave_list_payments`](#wave_list_payments) | read | List money received: invoice payments and estimate deposits, newest first, with totals. |

### transactions

| Tool | Kind | What it does |
|---|---|---|
| [`wave_create_transaction`](#wave_create_transaction) | write | Record a bank/credit-card transaction and categorize it, as if entered in Wave's Transactions page. |
| [`wave_create_transactions`](#wave_create_transactions) | write | Create up to 50 money transactions in one request (same shape as wave_create_transaction). |
| [`wave_list_transactions`](#wave_list_transactions) | read | List and search the business's transactions as Wave's Transactions page shows them: bank and card transactions, expenses, deposits, transfers, bill and invoice payments. |
| [`wave_get_transaction`](#wave_get_transaction) | read | One transaction with every line: bank/card side (anchor), category lines with order numbers, amounts, sales tax, vendor/customer, tags, review status, its current sequence, and which fields Wave allows editing. |
| [`wave_update_transaction`](#wave_update_transaction) | sends (irreversible) | Edit a transaction as in the Wave web app: date, description, notes, reviewed (verified), bank/card account, total amount, category, vendor or customer, or the full set of split lines. |
| [`wave_delete_transaction`](#wave_delete_transaction) | sends (irreversible) | Delete a transaction, as the web app's Delete does. |

### ledger

| Tool | Kind | What it does |
|---|---|---|
| [`wave_import_ledger`](#wave_import_ledger) | write (changes or deletes) | Load the full transaction journal from Wave's Data Export so transactions can be listed and date-range reports run. |
| [`wave_list_ledger_transactions`](#wave_list_ledger_transactions) | read | List and search transactions from an imported Data Export snapshot (wave_import_ledger). |
| [`wave_get_ledger_transaction`](#wave_get_ledger_transaction) | read | One transaction from the imported ledger with every journal line (account, debit, credit, line description, sales tax). |
| [`wave_list_ledger_accounts`](#wave_list_ledger_accounts) | read | Accounts that appear in the imported ledger, with their type, where the type came from (Wave chart of accounts or export labels) and line counts. |

### reports

| Tool | Kind | What it does |
|---|---|---|
| [`wave_run_report`](#wave_run_report) | read | Financial reports computed by this server (Wave's API has no report endpoint). |

### graphql

| Tool | Kind | What it does |
|---|---|---|
| [`wave_graphql_query`](#wave_graphql_query) | read | Escape hatch for reads the other tools do not shape the way you need: run one GraphQL query (never a mutation) against Wave's public API and get the raw data. |

## Tool reference

### wave_get_context

**Get Wave connection context** · toolset `context` · read

Start here. Returns the signed-in Wave user, how credentials are configured, the businesses this credential reaches, which one is the default, whether writes are enabled, and what the public API cannot do. Works without credentials and then explains how to set them up.

No parameters.

### wave_list_businesses

**List businesses** · toolset `context` · read

List the Wave businesses this credential can access (paginated).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `isArchived` | boolean |  |  | true = only archived, false = only active, omit = both |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 50). min 1, max 50 |

### wave_get_business

**Get business** · toolset `context` · read

Full details of one business: address, contact info, currency, timezone, whether Wave can email invoices for it, and invoice/estimate branding.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |

### wave_get_reference

**Get reference data** · toolset `context` · read

Reference data needed to fill other tools' inputs: currencies, countries, one country with its provinces/states (kind=country, code=CA), a province by code, account types, and account subtypes (needed by wave_create_account). Lists are paginated.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `kind` | "currencies" \| "countries" \| "country" \| "province" \| "account_types" \| "account_subtypes" | yes |  |  |
| `code` | string |  |  | Required for kind=country (e.g. CA) and kind=province (e.g. CA-ON) |
| `search` | string |  |  | Case-insensitive filter on code or name |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 50 | Items per page (max 250). min 1, max 250 |

### wave_list_customers

**List customers** · toolset `customers` · read

List customers with their outstanding and overdue balances. Filter by exact email, archive state or modification time; use search for a name substring.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `email` | string |  |  | Exact email match |
| `isArchived` | boolean |  |  |  |
| `sort` | "CREATED_AT_ASC" \| "CREATED_AT_DESC" \| "MODIFIED_AT_ASC" \| "MODIFIED_AT_DESC" \| "NAME_ASC" \| "NAME_DESC"[] |  |  | Default CREATED_AT_DESC. 1+ items |
| `modifiedAtAfter` | string |  |  | Only records modified after this time (ISO 8601) |
| `modifiedAtBefore` | string |  |  | Only records modified before this time (ISO 8601) |
| `search` | string |  |  | Case-insensitive substring match on name, email, displayId, firstName, lastName (scans the full list; use filters when you can) |
| `detail` | "summary" \| "full" |  | "summary" | summary: key fields, long text clipped. full: every field and line items |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 100). min 1, max 100 |

### wave_get_customer

**Get customer** · toolset `customers` · read

One customer with address, shipping details, notes and outstanding/overdue amounts. Deleted customers are still returned by ID, marked deleted: true.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Customer ID |

### wave_create_customer

**Create customer** · toolset `customers` · write

Create a customer. Only name is required.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `name` | string | yes |  | Customer or company name |
| `firstName` | string |  |  |  |
| `lastName` | string |  |  |  |
| `displayId` | string |  |  | Your own account number for the customer |
| `email` | string |  |  | email |
| `mobile` | string |  |  |  |
| `phone` | string |  |  |  |
| `fax` | string |  |  |  |
| `tollFree` | string |  |  |  |
| `website` | string |  |  |  |
| `internalNotes` | string |  |  |  |
| `currency` | string |  |  | Default invoicing currency for this customer |
| `address` | object {addressLine1, addressLine2, city, provinceCode, countryCode, postalCode} |  |  | Postal address |
| `shippingDetails` | object {name, address, phone, instructions} |  |  | Shipping contact and address |

### wave_update_customer

**Update customer** · toolset `customers` · write (changes or deletes)

Change fields on a customer. Only the fields you pass are changed; nested address/shipping objects replace the existing ones.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Customer ID |
| `name` | string |  |  |  |
| `firstName` | string |  |  |  |
| `lastName` | string |  |  |  |
| `displayId` | string |  |  | Your own account number for the customer |
| `email` | string |  |  | email |
| `mobile` | string |  |  |  |
| `phone` | string |  |  |  |
| `fax` | string |  |  |  |
| `tollFree` | string |  |  |  |
| `website` | string |  |  |  |
| `internalNotes` | string |  |  |  |
| `currency` | string |  |  | Default invoicing currency for this customer |
| `address` | object {addressLine1, addressLine2, city, provinceCode, countryCode, postalCode} |  |  | Postal address |
| `shippingDetails` | object {name, address, phone, instructions} |  |  | Shipping contact and address |

### wave_delete_customer

**Delete customer** · toolset `customers` · write (changes or deletes)

Delete a customer. Wave removes it from lists, but the record stays readable by ID (wave_get_customer shows deleted: true); there is no undelete through the API.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Customer ID |

### wave_list_vendors

**List vendors** · toolset `vendors` · read

List vendors (suppliers). Wave's API cannot create, change or delete vendors, and bills are not exposed.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `email` | string |  |  | Exact email match |
| `modifiedAtAfter` | string |  |  | Only records modified after this time (ISO 8601) |
| `modifiedAtBefore` | string |  |  | Only records modified before this time (ISO 8601) |
| `search` | string |  |  | Case-insensitive substring match on name, email, displayId, firstName, lastName (scans the full list; use filters when you can) |
| `detail` | "summary" \| "full" |  | "summary" | summary: key fields, long text clipped. full: every field and line items |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 100). min 1, max 100 |

### wave_get_vendor

**Get vendor** · toolset `vendors` · read

One vendor with address and contact details.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Vendor ID |

### wave_list_products

**List products and services** · toolset `products` · read

List products/services (the items invoice and estimate lines must reference), with price, income/expense accounts and default sales taxes. Active only unless isArchived=true.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `isSold` | boolean |  |  | Only items sold (have an income account) |
| `isBought` | boolean |  |  | Only items bought (have an expense account) |
| `isArchived` | boolean |  |  | Default false (active only) |
| `sort` | "CREATED_AT_ASC" \| "CREATED_AT_DESC" \| "MODIFIED_AT_ASC" \| "MODIFIED_AT_DESC" \| "NAME_ASC" \| "NAME_DESC"[] |  |  | Default CREATED_AT_DESC. 1+ items |
| `modifiedAtAfter` | string |  |  | Only records modified after this time |
| `modifiedAtBefore` | string |  |  | Only records modified before this time |
| `search` | string |  |  | Case-insensitive substring match on name, description (scans the full list; use filters when you can) |
| `detail` | "summary" \| "full" |  | "summary" | summary: key fields, long text clipped. full: every field and line items |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 100). min 1, max 100 |

### wave_get_product

**Get product or service** · toolset `products` · read

One product/service with its accounts and default sales taxes.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Product ID |

### wave_create_product

**Create product or service** · toolset `products` · write

Create a product or service. Give it an incomeAccountId to sell it on invoices, an expenseAccountId to buy it, or both.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `name` | string | yes |  |  |
| `unitPrice` | number or string | yes |  | Price per unit, major currency units |
| `description` | string |  |  |  |
| `defaultSalesTaxIds` | string[] |  |  | Sales taxes applied by default on invoice lines |
| `incomeAccountId` | string |  |  | Makes it sellable. Account subtype must be INCOME, DISCOUNTS or OTHER_INCOME |
| `expenseAccountId` | string |  |  | Makes it buyable. Account subtype must be EXPENSE, COST_OF_GOODS_SOLD, PAYMENT_PROCESSING_FEES or PAYROLL_EXPENSES |

### wave_update_product

**Update product or service** · toolset `products` · write (changes or deletes)

Change a product/service. defaultSalesTaxIds replaces the whole list.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Product ID |
| `name` | string |  |  |  |
| `unitPrice` | number or string |  |  |  |
| `description` | string |  |  |  |
| `defaultSalesTaxIds` | string[] |  |  | Sales taxes applied by default on invoice lines |
| `incomeAccountId` | string |  |  | Makes it sellable. Account subtype must be INCOME, DISCOUNTS or OTHER_INCOME |
| `expenseAccountId` | string |  |  | Makes it buyable. Account subtype must be EXPENSE, COST_OF_GOODS_SOLD, PAYMENT_PROCESSING_FEES or PAYROLL_EXPENSES |

### wave_archive_product

**Archive product or service** · toolset `products` · write (changes or deletes)

Archive a product/service so it can no longer be added to new invoices. Past invoices keep it. The API cannot un-archive (web app only).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Product ID |

### wave_list_accounts

**List chart of accounts** · toolset `accounts` · read

List the chart of accounts with current balances. Find transaction accounts with filters: bank accounts are types=[ASSET] subtypes=[CASH_AND_BANK]; credit cards subtypes=[CREDIT_CARD]; expense categories types=[EXPENSE]; income categories types=[INCOME].

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `types` | "ASSET" \| "EQUITY" \| "EXPENSE" \| "INCOME" \| "LIABILITY"[] |  |  | 1+ items |
| `subtypes` | "CASH_AND_BANK" \| "COST_OF_GOODS_SOLD" \| "CREDIT_CARD" \| "CUSTOMER_PREPAYMENTS_AND_CREDITS" \| "DEPRECIATION_AND_AMORTIZATION" \| "DISCOUNTS" \| "DUE_FOR_PAYROLL" \| "DUE_TO_YOU_AND_OTHER_OWNERS" \| …[] |  |  | 1+ items |
| `excludedSubtypes` | "CASH_AND_BANK" \| "COST_OF_GOODS_SOLD" \| "CREDIT_CARD" \| "CUSTOMER_PREPAYMENTS_AND_CREDITS" \| "DEPRECIATION_AND_AMORTIZATION" \| "DISCOUNTS" \| "DUE_FOR_PAYROLL" \| "DUE_TO_YOU_AND_OTHER_OWNERS" \| …[] |  |  | 1+ items |
| `isArchived` | boolean |  |  | Default false (active only) |
| `search` | string |  |  | Case-insensitive substring match on name, displayId, description (scans the full list; use filters when you can) |
| `detail` | "summary" \| "full" |  | "summary" | summary: key fields, long text clipped. full: every field and line items |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 100). min 1, max 100 |

### wave_get_account

**Get account** · toolset `accounts` · read

One account with type, subtype, normal balance, current balance (account and business currency) and its sequence number.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Account ID |

### wave_create_account

**Create account** · toolset `accounts` · write

Add an account to the chart of accounts. The subtype decides its type (see wave_get_reference kind=account_subtypes).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `name` | string | yes |  |  |
| `subtype` | "CASH_AND_BANK" \| "COST_OF_GOODS_SOLD" \| "CREDIT_CARD" \| "CUSTOMER_PREPAYMENTS_AND_CREDITS" \| "DEPRECIATION_AND_AMORTIZATION" \| "DISCOUNTS" \| "DUE_FOR_PAYROLL" \| "DUE_TO_YOU_AND_OTHER_OWNERS" \| … | yes |  |  |
| `currency` | string |  |  | Defaults to the business currency |
| `description` | string |  |  |  |
| `displayId` | string |  |  | Your account number/code |

### wave_update_account

**Update account** · toolset `accounts` · write (changes or deletes)

Rename an account or change its description/number. Wave requires the account's current sequence (optimistic locking); it is read automatically when omitted. Pass null for description/displayId to clear them.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Account ID |
| `sequence` | integer |  |  | Current sequence from wave_get_account; fetched when omitted. min -9007199254740991 |
| `name` | string |  |  |  |
| `description` | string |  |  |  |
| `displayId` | string |  |  |  |

### wave_archive_account

**Archive account** · toolset `accounts` · write (changes or deletes)

Archive an account (hide it while keeping its history). Wave refuses for system accounts and accounts with a balance. No un-archive through the API.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Account ID |

### wave_list_sales_taxes

**List sales taxes** · toolset `sales_taxes` · read

List sales taxes with current rate (as a fraction: 0.13 = 13%). detail="full" adds the dated rate history.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `isArchived` | boolean |  |  | Default false (active only) |
| `modifiedAtAfter` | string |  |  | Only records modified after this time |
| `modifiedAtBefore` | string |  |  | Only records modified before this time |
| `search` | string |  |  | Case-insensitive substring match on name, abbreviation (scans the full list; use filters when you can) |
| `detail` | "summary" \| "full" |  | "summary" | summary: key fields, long text clipped. full: every field and line items |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 100). min 1, max 100 |

### wave_get_sales_tax

**Get sales tax** · toolset `sales_taxes` · read

One sales tax with its full dated rate history.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Sales tax ID |

### wave_create_sales_tax

**Create sales tax** · toolset `sales_taxes` · write

Create a sales tax. abbreviation must be unique in the business (max 10 characters).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `name` | string | yes |  |  |
| `abbreviation` | string | yes |  |  |
| `rate` | number or string | yes |  | Rate as a fraction: 0.13 means 13% |
| `description` | string |  |  |  |
| `taxNumber` | string |  |  | Registration number from the tax authority |
| `showTaxNumberOnInvoices` | boolean |  |  |  |
| `isCompound` | boolean |  |  | Calculated on top of other taxes |
| `isRecoverable` | boolean |  |  | Tax paid on purchases can be deducted |

### wave_update_sales_tax

**Update sales tax** · toolset `sales_taxes` · write (changes or deletes)

Change a sales tax. To change the rate, pass rates with an effective date; rates replaces the dated rate list, so include existing entries you want to keep (see wave_get_sales_tax).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Sales tax ID |
| `name` | string |  |  |  |
| `abbreviation` | string |  |  |  |
| `description` | string |  |  |  |
| `taxNumber` | string |  |  |  |
| `showTaxNumberOnInvoices` | boolean |  |  |  |
| `rates` | object {effective, rate}[] |  |  | 1+ items |

### wave_archive_sales_tax

**Archive sales tax** · toolset `sales_taxes` · write (changes or deletes)

Archive a sales tax so it can no longer be applied. No un-archive through the API.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Sales tax ID |

### wave_list_invoices

**List invoices** · toolset `invoices` · read

List invoices with totals, amount due and status. Filter by status, customer, invoice date range, modification time, number, currency or the estimate they came from (sourceId). detail="full" adds line items and payments (pages of at most 25).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `status` | "DRAFT" \| "OVERDUE" \| "OVERPAID" \| "PAID" \| "PARTIAL" \| "SAVED" \| "SENT" \| "UNPAID" \| … |  |  |  |
| `customerId` | string |  |  |  |
| `invoiceDateStart` | string |  |  | Date, YYYY-MM-DD |
| `invoiceDateEnd` | string |  |  | Date, YYYY-MM-DD |
| `modifiedAtAfter` | string |  |  | ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z |
| `modifiedAtBefore` | string |  |  | ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z |
| `invoiceNumber` | string |  |  |  |
| `currency` | string |  |  | ISO 4217 currency code, e.g. CAD or USD |
| `amountDue` | number or string |  |  | Exact amount due |
| `sourceId` | string |  |  | Estimate or recurring invoice the invoice was created from |
| `sort` | "AMOUNT_DUE_ASC" \| "AMOUNT_DUE_DESC" \| "AMOUNT_PAID_ASC" \| "AMOUNT_PAID_DESC" \| "CREATED_AT_ASC" \| "CREATED_AT_DESC" \| "CUSTOMER_NAME_ASC" \| "CUSTOMER_NAME_DESC" \| …[] |  |  | Default CREATED_AT_DESC. 1+ items |
| `detail` | "summary" \| "full" |  | "summary" | summary: key fields, long text clipped. full: every field and line items |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 100). min 1, max 100 |

### wave_get_invoice

**Get invoice** · toolset `invoices` · read

One invoice with line items, taxes, discounts, payments, reminders, PDF and customer view links.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Invoice ID |

### wave_create_invoice

**Create invoice** · toolset `invoices` · write

Create an invoice for a customer. Created as DRAFT unless status=SAVED (approved). Number, dates, title and notes default to the business's invoice settings. Taxes default per product; pass taxIds:[] for none. Nothing is emailed.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `customerId` | string | yes |  |  |
| `items` | object {productId, description, quantity, unitPrice, taxIds}[] | yes |  | 1+ items, up to 100 items |
| `status` | "DRAFT" \| "SAVED" |  |  |  |
| `invoiceDate` | string |  |  | Date, YYYY-MM-DD |
| `dueDate` | string |  |  | Date, YYYY-MM-DD |
| `invoiceNumber` | string |  |  |  |
| `currency` | string |  |  | ISO 4217 currency code, e.g. CAD or USD |
| `discounts` | object {discountType, amount, percentage, name}[] |  |  | up to 1 items |
| `title` | string |  |  |  |
| `subhead` | string |  |  |  |
| `poNumber` | string |  |  |  |
| `memo` | string |  |  | Notes shown to the customer |
| `footer` | string |  |  |  |
| `exchangeRate` | number or string |  |  | Business currency per document currency (foreign-currency documents only) |
| `disableCreditCardPayments` | boolean |  |  |  |
| `disableBankPayments` | boolean |  |  |  |
| `disableAmexPayments` | boolean |  |  |  |
| `requireTermsOfServiceAgreement` | boolean |  |  |  |
| `itemTitle` | string |  |  |  |
| `unitTitle` | string |  |  |  |
| `priceTitle` | string |  |  |  |
| `amountTitle` | string |  |  |  |
| `hideName` | boolean |  |  |  |
| `hideDescription` | boolean |  |  |  |
| `hideUnit` | boolean |  |  |  |
| `hidePrice` | boolean |  |  |  |
| `hideAmount` | boolean |  |  |  |

### wave_update_invoice

**Update invoice** · toolset `invoices` · write (changes or deletes)

Change an invoice. Passing items replaces every line; omit items to keep them. Wave may refuse changes to paid invoices.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Invoice ID |
| `customerId` | string |  |  |  |
| `items` | object {productId, description, quantity, unitPrice, taxIds}[] |  |  | 1+ items, up to 100 items |
| `status` | "DRAFT" \| "SAVED" |  |  |  |
| `invoiceDate` | string |  |  | Date, YYYY-MM-DD |
| `dueDate` | string |  |  | Date, YYYY-MM-DD |
| `invoiceNumber` | string |  |  |  |
| `currency` | string |  |  | ISO 4217 currency code, e.g. CAD or USD |
| `discounts` | object {discountType, amount, percentage, name}[] |  |  | up to 1 items |
| `title` | string |  |  |  |
| `subhead` | string |  |  |  |
| `poNumber` | string |  |  |  |
| `memo` | string |  |  | Notes shown to the customer |
| `footer` | string |  |  |  |
| `exchangeRate` | number or string |  |  | Business currency per document currency (foreign-currency documents only) |
| `disableCreditCardPayments` | boolean |  |  |  |
| `disableBankPayments` | boolean |  |  |  |
| `disableAmexPayments` | boolean |  |  |  |
| `requireTermsOfServiceAgreement` | boolean |  |  |  |
| `itemTitle` | string |  |  |  |
| `unitTitle` | string |  |  |  |
| `priceTitle` | string |  |  |  |
| `amountTitle` | string |  |  |  |
| `hideName` | boolean |  |  |  |
| `hideDescription` | boolean |  |  |  |
| `hideUnit` | boolean |  |  |  |
| `hidePrice` | boolean |  |  |  |
| `hideAmount` | boolean |  |  |  |

### wave_clone_invoice

**Clone invoice** · toolset `invoices` · write

Copy an invoice into a new draft.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `invoiceId` | string | yes |  | Invoice ID |

### wave_approve_invoice

**Approve invoice** · toolset `invoices` · write

Approve a draft invoice, which posts it to the books (status SAVED). Does not email it.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `invoiceId` | string | yes |  | Invoice ID |

### wave_send_invoice

**Email invoice** · toolset `invoices` · sends (irreversible)

Email an invoice through Wave to real recipients. Irreversible: confirm recipients first. Requires email sending enabled for the business (wave_get_business emailSendEnabled).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `invoiceId` | string | yes |  | Invoice ID |
| `to` | string[] | yes |  | Recipient email addresses. 1+ items, up to 20 items |
| `subject` | string |  |  |  |
| `message` | string |  |  |  |
| `ccMyself` | boolean |  |  |  |
| `fromAddress` | string |  |  | email |
| `attachPDF` | boolean |  | true |  |

### wave_mark_invoice_sent

**Mark invoice as sent** · toolset `invoices` · write

Record that an invoice was sent outside Wave (no email goes out).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `invoiceId` | string | yes |  | Invoice ID |
| `sendMethod` | "EXPORT_PDF" \| "GMAIL" \| "MARKED_SENT" \| "NOT_SENT" \| "OUTLOOK" \| "SHARED_LINK" \| "SKIPPED" \| "WAVE" \| … |  | "MARKED_SENT" |  |
| `sentAt` | string |  |  | ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z |

### wave_delete_invoice

**Delete invoice** · toolset `invoices` · write (changes or deletes)

Permanently delete an invoice.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `invoiceId` | string | yes |  | Invoice ID |

### wave_list_estimates

**List estimates** · toolset `estimates` · read

List estimates (quotes) with totals, deposit state and status. detail="full" adds line items, deposit payments and acceptance history (pages of at most 25).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `status` | "ACCEPTED" \| "ACTIVE" \| "APPROVED" \| "CONVERTED" \| "DRAFT" \| "EXPIRED" \| "PAID" \| "PARTIAL" \| … |  |  |  |
| `customerId` | string |  |  |  |
| `estimateDateStart` | string |  |  | Date, YYYY-MM-DD |
| `estimateDateEnd` | string |  |  | Date, YYYY-MM-DD |
| `modifiedAtAfter` | string |  |  | ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z |
| `modifiedAtBefore` | string |  |  | ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z |
| `estimateNumber` | string |  |  |  |
| `currency` | string |  |  | ISO 4217 currency code, e.g. CAD or USD |
| `amountDue` | number or string |  |  |  |
| `sort` | "AMOUNT_DUE_ASC" \| "AMOUNT_DUE_DESC" \| "AMOUNT_PAID_ASC" \| "AMOUNT_PAID_DESC" \| "CREATED_AT_ASC" \| "CREATED_AT_DESC" \| "CUSTOMER_NAME_ASC" \| "CUSTOMER_NAME_DESC" \| … |  |  | Default CREATED_AT_DESC |
| `detail` | "summary" \| "full" |  | "summary" | summary: key fields, long text clipped. full: every field and line items |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 100). min 1, max 100 |

### wave_get_estimate

**Get estimate** · toolset `estimates` · read

One estimate with items, taxes, discounts, deposit settings and payments, acceptance history and attachments.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Estimate ID |

### wave_create_estimate

**Create estimate** · toolset `estimates` · write

Create a draft estimate (quote). Each line needs a product and a unitPrice. Optionally ask for a deposit. Nothing is emailed.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `customerId` | string | yes |  |  |
| `items` | object {productId, description, quantity, unitPrice, taxIds}[] | yes |  | 1+ items, up to 100 items |
| `estimateDate` | string |  |  | Date, YYYY-MM-DD |
| `dueDate` | string |  |  | Expiry date |
| `estimateNumber` | string |  |  |  |
| `currency` | string |  |  | ISO 4217 currency code, e.g. CAD or USD |
| `discounts` | object {discountType, amount, percentage, name}[] |  |  | up to 1 items |
| `title` | string |  |  |  |
| `subhead` | string |  |  |  |
| `poNumber` | string |  |  |  |
| `memo` | string |  |  | Notes shown to the customer |
| `footer` | string |  |  |  |
| `exchangeRate` | number or string |  |  | Business currency per document currency (foreign-currency documents only) |
| `disableCreditCardPayments` | boolean |  |  |  |
| `disableBankPayments` | boolean |  |  |  |
| `disableAmexPayments` | boolean |  |  |  |
| `requireTermsOfServiceAgreement` | boolean |  |  |  |
| `itemTitle` | string |  |  |  |
| `unitTitle` | string |  |  |  |
| `priceTitle` | string |  |  |  |
| `amountTitle` | string |  |  |  |
| `hideName` | boolean |  |  |  |
| `hideDescription` | boolean |  |  |  |
| `hideUnit` | boolean |  |  |  |
| `hidePrice` | boolean |  |  |  |
| `hideAmount` | boolean |  |  |  |
| `depositStatus` | "DISABLED" \| "ENABLED_MANDATORY" \| "ENABLED_OPTIONAL" |  |  | Whether the customer can or must pay a deposit |
| `depositUnit` | "AMOUNT" \| "PERCENTAGE" |  |  |  |
| `depositValue` | number or string |  |  | Deposit size in depositUnit. Wave documents AMOUNT values in cents |
| `dontCarryOverNotesToInvoice` | boolean |  |  |  |

### wave_update_estimate

**Update estimate** · toolset `estimates` · write (changes or deletes)

Change an estimate. Wave's patch requires customer, status, title, dates, currency and exchange rate; any you omit are copied from the current estimate. Passing items replaces every line.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Estimate ID |
| `customerId` | string |  |  |  |
| `status` | "ACCEPTED" \| "APPROVED" \| "CONVERTED" \| "DELETED" \| "DRAFT" \| "EXPIRED" \| "REJECTED" \| "SENT" \| … |  |  |  |
| `estimateDate` | string |  |  | Date, YYYY-MM-DD |
| `dueDate` | string |  |  | Date, YYYY-MM-DD |
| `estimateNumber` | string |  |  |  |
| `currency` | string |  |  | ISO 4217 currency code, e.g. CAD or USD |
| `items` | object {productId, description, quantity, unitPrice, taxIds}[] |  |  | 1+ items, up to 100 items |
| `discounts` | object {discountType, amount, percentage, name}[] |  |  | up to 1 items |
| `title` | string |  |  |  |
| `subhead` | string |  |  |  |
| `poNumber` | string |  |  |  |
| `memo` | string |  |  | Notes shown to the customer |
| `footer` | string |  |  |  |
| `exchangeRate` | number or string |  |  | Business currency per document currency (foreign-currency documents only) |
| `disableCreditCardPayments` | boolean |  |  |  |
| `disableBankPayments` | boolean |  |  |  |
| `disableAmexPayments` | boolean |  |  |  |
| `requireTermsOfServiceAgreement` | boolean |  |  |  |
| `itemTitle` | string |  |  |  |
| `unitTitle` | string |  |  |  |
| `priceTitle` | string |  |  |  |
| `amountTitle` | string |  |  |  |
| `hideName` | boolean |  |  |  |
| `hideDescription` | boolean |  |  |  |
| `hideUnit` | boolean |  |  |  |
| `hidePrice` | boolean |  |  |  |
| `hideAmount` | boolean |  |  |  |
| `depositStatus` | "DISABLED" \| "ENABLED_MANDATORY" \| "ENABLED_OPTIONAL" |  |  | Whether the customer can or must pay a deposit |
| `depositUnit` | "AMOUNT" \| "PERCENTAGE" |  |  |  |
| `depositValue` | number or string |  |  | Deposit size in depositUnit. Wave documents AMOUNT values in cents |
| `dontCarryOverNotesToInvoice` | boolean |  |  |  |

### wave_clone_estimate

**Clone estimate** · toolset `estimates` · write

Copy an estimate into a new draft.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |

### wave_approve_estimate

**Approve estimate** · toolset `estimates` · write

Approve a draft estimate so it can be sent. Does not email it.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |

### wave_mark_estimate_accepted

**Mark estimate accepted** · toolset `estimates` · write

Record that the customer accepted the estimate.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |

### wave_reset_estimate_acceptance

**Reset estimate acceptance** · toolset `estimates` · write

Undo the customer's acceptance so the estimate can be changed or re-accepted.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |

### wave_convert_estimate_to_invoice

**Convert estimate to invoice** · toolset `estimates` · write

Create an invoice from an estimate (deposits paid carry over). Returns the new invoiceId.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |

### wave_generate_estimate_pdf

**Generate estimate PDF** · toolset `estimates` · write

Generate (or regenerate) the estimate PDF and return its URL.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |

### wave_send_estimate_acceptance_email

**Email estimate acceptance confirmation** · toolset `estimates` · sends (irreversible)

Email the customer the confirmation that their estimate acceptance was recorded. Irreversible.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |

### wave_delete_estimate

**Delete estimate** · toolset `estimates` · write (changes or deletes)

Permanently delete an estimate.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |

### wave_send_estimate

**Email estimate** · toolset `estimates` · sends (irreversible)

Email an estimate through Wave to real recipients. Irreversible: confirm recipients first. The estimate must be approved.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |
| `to` | string[] | yes |  | Recipient email addresses. 1+ items, up to 20 items |
| `subject` | string |  |  |  |
| `message` | string |  |  |  |
| `ccMyself` | boolean |  |  |  |
| `fromAddress` | string |  |  | email |
| `attachPDF` | boolean |  | true |  |
| `hideGrandTotal` | boolean |  |  |  |
| `includeAttachments` | boolean |  |  |  |

### wave_mark_estimate_sent

**Mark estimate as sent** · toolset `estimates` · write

Record that an estimate was sent outside Wave (no email goes out).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |
| `sendMethod` | "EXPORT_PDF" \| "GMAIL" \| "MARKED_SENT" \| "NOT_SENT" \| "OUTLOOK" \| "SHARED_LINK" \| "SKIPPED" \| "WAVE" \| … |  | "MARKED_SENT" |  |
| `sentAt` | string |  |  | ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z |

### wave_get_invoice_payment

**Get invoice payment** · toolset `payments` · read

One invoice payment with account, method, currency details and processor info.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Invoice payment ID |

### wave_record_invoice_payment

**Record invoice payment** · toolset `payments` · write

Record a payment received outside Wave against an invoice (cash, cheque, bank transfer...). paymentAccountId is the account the money went into (usually types=[ASSET] subtypes=[CASH_AND_BANK]). The invoice must be approved, not a draft.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `invoiceId` | string | yes |  | Invoice ID |
| `paymentAccountId` | string | yes |  |  |
| `amount` | number or string | yes |  | Positive amount, at most 2 decimals |
| `paymentDate` | string | yes |  | Date, YYYY-MM-DD |
| `paymentMethod` | "BANK_TRANSFER" \| "CASH" \| "CHEQUE" \| "CREDIT_CARD" \| "OTHER" \| "PAYPAL" \| "UNSPECIFIED" | yes |  |  |
| `exchangeRate` | number or string |  | 1 | Payment-account currency per invoice currency; 1 when they match |
| `memo` | string |  |  |  |

### wave_update_invoice_payment

**Update invoice payment** · toolset `payments` · write (changes or deletes)

Change a manually recorded invoice payment.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Invoice payment ID |
| `paymentAccountId` | string |  |  |  |
| `amount` | number or string |  |  | Positive amount, at most 2 decimals |
| `paymentDate` | string |  |  | Date, YYYY-MM-DD |
| `paymentMethod` | "BANK_TRANSFER" \| "CASH" \| "CHEQUE" \| "CREDIT_CARD" \| "OTHER" \| "PAYPAL" \| "UNSPECIFIED" |  |  |  |
| `exchangeRate` | number or string |  |  |  |
| `memo` | string |  |  |  |

### wave_delete_invoice_payment

**Delete invoice payment** · toolset `payments` · write (changes or deletes)

Delete a recorded invoice payment; the invoice becomes unpaid by that amount.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Invoice payment ID |

### wave_send_invoice_payment_receipt

**Email payment receipt** · toolset `payments` · sends (irreversible)

Email a receipt for an invoice payment to real recipients. Irreversible.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `invoiceId` | string | yes |  | Invoice ID |
| `invoicePaymentId` | string | yes |  | Invoice payment ID |
| `to` | string[] | yes |  | Recipient email addresses. 1+ items, up to 20 items |
| `subject` | string |  |  |  |
| `message` | string |  |  |  |
| `ccMyself` | boolean |  |  |  |
| `fromAddress` | string |  |  | email |
| `attachPdf` | boolean |  |  |  |

### wave_get_estimate_payment

**Get estimate deposit payment** · toolset `payments` · read

One estimate deposit payment (or refund/void) with its estimate.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Estimate payment ID |

### wave_record_estimate_deposit

**Record estimate deposit** · toolset `payments` · write

Record a deposit received outside Wave against an estimate. paymentAccountId is where the money went (a CASH_AND_BANK account).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |
| `amount` | number or string | yes |  | Positive amount, at most 2 decimals |
| `paymentDate` | string | yes |  | Date, YYYY-MM-DD |
| `paymentMethod` | "BANK_TRANSFER" \| "CASH" \| "CHEQUE" \| "CREDIT_CARD" \| "OTHER" \| "PAYPAL" | yes |  |  |
| `paymentAccountId` | string |  |  |  |
| `memo` | string |  |  |  |

### wave_update_estimate_deposit

**Update estimate deposit** · toolset `payments` · write (changes or deletes)

Change a manually recorded estimate deposit.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Estimate payment ID |
| `estimateId` | string | yes |  | Estimate ID |
| `amount` | number or string |  |  | Positive amount, at most 2 decimals |
| `paymentDate` | string |  |  | Date, YYYY-MM-DD |
| `paymentMethod` | "BANK_TRANSFER" \| "CASH" \| "CHEQUE" \| "CREDIT_CARD" \| "OTHER" \| "PAYPAL" |  |  |  |
| `paymentAccountId` | string |  |  |  |
| `memo` | string |  |  |  |

### wave_delete_estimate_payment

**Delete estimate deposit** · toolset `payments` · write (changes or deletes)

Delete a recorded estimate deposit payment.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes |  | Estimate payment ID |

### wave_send_estimate_deposit_receipt

**Email deposit receipt** · toolset `payments` · sends (irreversible)

Email a receipt for an estimate deposit to real recipients. Irreversible.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `estimateId` | string | yes |  | Estimate ID |
| `estimatePaymentId` | string | yes |  | Estimate payment ID |
| `to` | string[] | yes |  | Recipient email addresses. 1+ items, up to 20 items |
| `subject` | string |  |  |  |
| `message` | string |  |  |  |
| `ccMyself` | boolean |  |  |  |
| `fromAddress` | string |  |  | email |
| `attachPdf` | boolean |  |  |  |

### wave_list_payments

**List payments received** · toolset `payments` · read

List money received: invoice payments and estimate deposits, newest first, with totals. These are the only transaction records Wave's public API can read; bank/card transactions, expenses and money transactions created through the API cannot be listed. Filter by payment date range and customer.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `startDate` | string |  |  | Earliest payment date (inclusive) |
| `endDate` | string |  |  | Latest payment date (inclusive) |
| `customerId` | string |  |  |  |
| `kind` | "all" \| "invoice" \| "estimate_deposit" |  | "all" |  |
| `sort` | "date_desc" \| "date_asc" \| "amount_desc" |  | "date_desc" |  |
| `limit` | integer |  | 25 | Rows to return. min 1, max 200 |
| `offset` | integer |  | 0 | Rows to skip; use nextOffset. min 0 |

### wave_create_transaction

**Create money transaction** · toolset `transactions` · write

Record a bank/credit-card transaction and categorize it, as if entered in Wave's Transactions page. Expense paid by card: anchor {accountId: card, direction: WITHDRAWAL}, line {accountId: expense category, balance: INCREASE}. Sale deposited to bank: anchor {bank, DEPOSIT}, line {income account, INCREASE}. Split across several lines; they must total the anchor. Keep the returned id: wave_get_transaction / wave_list_transactions read it back. Use dryRun=true to validate without writing. Wave does not document de-duplication by externalId: if a call timed out, check the Wave web app before retrying.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `externalId` | string |  |  | Your reference for idempotent imports; a UUID is generated when omitted |
| `date` | string | yes |  | Date, YYYY-MM-DD |
| `description` | string | yes |  | Shown in Wave's transaction list, e.g. the payee |
| `notes` | string |  |  |  |
| `anchor` | object {accountId, amount, direction} | yes |  | Bank/card side of the transaction |
| `lineItems` | object {accountId, amount, balance, customerId, description, taxes}[] | yes |  | How the amount is categorized; must add up to the anchor amount. 1+ items, up to 50 items |
| `dryRun` | boolean |  | false |  |

### wave_create_transactions

**Create money transactions in bulk** · toolset `transactions` · write

Create up to 50 money transactions in one request (same shape as wave_create_transaction). Every transaction is checked first (amounts balance; debit and credit sides make sense for the accounts); nothing is sent if any fails. Wave applies the batch as one request and reports input errors by path (transactions.N...).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `transactions` | object {externalId, date, description, notes, anchor, lineItems}[] | yes |  | 1+ items, up to 50 items |
| `dryRun` | boolean |  | false |  |

### wave_list_transactions

**List transactions** · toolset `transactions` · read

List and search the business's transactions as Wave's Transactions page shows them: bank and card transactions, expenses, deposits, transfers, bill and invoice payments. Live data. Filter by date range, text in the description, bank/card account (accountId), category accounts (categoryIds) or uncategorizedOnly. Cursor pagination: pass nextCursor back as cursor. Each row has the amount, direction, bank/card account, category (or categories when split), vendor, sales tax and review status. IDs work with wave_get_transaction, wave_update_transaction and wave_delete_transaction. Uses Wave's web-app API (unofficial), which needs a web session: if it is missing or expired, the user runs node <package>/bin/wave-mcp.js login in a terminal on <host>.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `startDate` | string |  |  | Earliest transaction date (inclusive) |
| `endDate` | string |  |  | Latest transaction date (inclusive) |
| `search` | string |  |  | Text in the transaction description or a line description (case-insensitive) |
| `accountId` | string |  |  | Account register: transactions with any line on this account, usually a bank or card account; includes journal entries that touch it (wave_list_accounts) |
| `categoryIds` | string[] |  |  | Only transactions with a line in one of these category accounts. up to 50 items |
| `uncategorizedOnly` | boolean |  | false | Only transactions still in Uncategorized Income/Expense |
| `source` | "MANUAL" \| "PLAID" \| "YODLEE" \| "CASHEDGE" \| "GENERIC_EXTERNAL_API" \| "RECEIPT" \| "RECEIPT_CAPTURE" \| "SHOPIFY" \| … |  |  | Where it came from: MANUAL = statement upload; PLAID/YODLEE/CASHEDGE = bank connection; GENERIC_EXTERNAL_API = API (wave_create_transaction); RECEIPT/RECEIPT_CAPTURE = receipts. Entries typed into Wave have no source |
| `transactionIds` | string[] |  |  | up to 100 items |
| `sort` | "date_desc" \| "date_asc" |  | "date_desc" | By transaction date |
| `pageSize` | integer |  | 25 | Rows per page (max 100). min 1, max 100 |
| `cursor` | string |  |  | nextCursor from the previous page |
| `detail` | "summary" \| "full" |  | "summary" | summary: key fields, long text clipped. full: every field and line items |

### wave_get_transaction

**Get transaction** · toolset `transactions` · read

One transaction with every line: bank/card side (anchor), category lines with order numbers, amounts, sales tax, vendor/customer, tags, review status, its current sequence, and which fields Wave allows editing. Uses Wave's web-app API (unofficial), which needs a web session: if it is missing or expired, the user runs node <package>/bin/wave-mcp.js login in a terminal on <host>.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Transaction ID from wave_list_transactions |

### wave_update_transaction

**Edit transaction** · toolset `transactions` · sends (irreversible)

Edit a transaction as in the Wave web app: date, description, notes, reviewed (verified), bank/card account, total amount, category, vendor or customer, or the full set of split lines. Journal entries (journalEntry: true) have no bank side: edit their lines, keeping debits equal to credits. Single-category transactions: use categoryId / vendorId / customerId / amount / salesTax directly. Split transactions: pass lines (every line to keep, with order from wave_get_transaction; omit order to add a line; lines left out are removed). Line amounts include sales tax and must add up to the amount. Reads the transaction first and sends its current sequence, so it never overwrites a newer edit. dryRun=true shows the change without saving. Confirm with the user before changing amounts or accounts. Uses Wave's web-app API (unofficial), which needs a web session: if it is missing or expired, the user runs node <package>/bin/wave-mcp.js login in a terminal on <host>.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  | Transaction ID |
| `date` | string |  |  | Date, YYYY-MM-DD |
| `description` | string |  |  |  |
| `notes` | string |  |  | Notes; empty string clears them |
| `verified` | boolean |  |  | Mark as reviewed (true) or not reviewed (false) |
| `accountId` | string |  |  | Move it to another bank/card account |
| `amount` | number or string |  |  | New total; for split transactions also pass lines |
| `categoryId` | string |  |  | New category account (single-category transactions) |
| `vendorId` | string or null |  |  | Vendor ID; null clears it |
| `customerId` | string or null |  |  | Customer ID; null clears it |
| `lineDescription` | string |  |  | Description on the category line (single-category transactions) |
| `salesTax` | object {salesTaxId, amount}[] |  |  | Replace the sales taxes on this line ([] removes them). Line amounts include tax. Omitted: unchanged; Wave recalculates taxes it calculated itself when the amount changes, but keeps manually set ones. up to 5 items |
| `lines` | object {order, accountId, amount, description, vendorId, customerId, salesTax, side}[] |  |  | 1+ items, up to 50 items |
| `expectedSequence` | integer |  |  | Fail instead of editing if the transaction changed since you read it (sequence from wave_get_transaction). min -9007199254740991 |
| `dryRun` | boolean |  | false |  |

### wave_delete_transaction

**Delete transaction** · toolset `transactions` · sends (irreversible)

Delete a transaction, as the web app's Delete does. Changes the books and account balances: confirm with the user first. Wave refuses for transactions that must be removed at their source (e.g. invoice payments, payroll). Uses Wave's web-app API (unofficial), which needs a web session: if it is missing or expired, the user runs node <package>/bin/wave-mcp.js login in a terminal on <host>.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `id` | string | yes |  |  |
| `expectedSequence` | integer |  |  | Fail if the transaction changed since you read it. min -9007199254740991 |

### wave_import_ledger

**Import transactions from a Wave Data Export** · toolset `ledger` · write (changes or deletes)

Load the full transaction journal from Wave's Data Export so transactions can be listed and date-range reports run. Wave's public API cannot read transactions; this is the supported way to get them. Get the file: Wave → Settings → Data Export → Accounting (CSV) → Export; Wave emails a download link (valid 24 hours). Pass the path of the downloaded .zip (or the accounting .csv inside it) on the machine running this server. Replaces any earlier import for the business. Nothing is sent to Wave; the ledger is stored locally (mode 600).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `path` | string | yes |  | Absolute path to the Data Export .zip or its accounting .csv |
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |

### wave_list_ledger_transactions

**List ledger transactions** · toolset `ledger` · read

List and search transactions from an imported Data Export snapshot (wave_import_ledger). For live data use wave_list_transactions; this works offline and includes invoices, bills and journal entries: bank and card transactions, expenses, invoices, bills, payments, transfers and journal entries. Filter by date range, account (ID or name), text, customer, vendor, amount, direction or uncategorized only. Newest first by default. Each row has the amount on the bank/card account (or the journal total), the categories used, and the transaction ID for wave_get_ledger_transaction.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `startDate` | string |  |  | Date, YYYY-MM-DD |
| `endDate` | string |  |  | Date, YYYY-MM-DD |
| `accountId` | string |  |  | Only transactions touching this account (Wave account ID) |
| `account` | string |  |  | Only transactions touching this account, by name (exact, else contains) |
| `query` | string |  |  | Text in descriptions, notes, customer, vendor, invoice/bill number or account name |
| `customer` | string |  |  |  |
| `vendor` | string |  |  |  |
| `direction` | "any" \| "deposit" \| "withdrawal" \| "transfer" \| "journal" |  | "any" |  |
| `minAmount` | number |  |  | min 0 |
| `maxAmount` | number |  |  | min 0 |
| `uncategorizedOnly` | boolean |  | false | Only transactions using Uncategorized Income/Expense |
| `sort` | "date_desc" \| "date_asc" \| "amount_desc" |  | "date_desc" |  |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 20 | Items per page (max 100). min 1, max 100 |

### wave_get_ledger_transaction

**Get ledger transaction** · toolset `ledger` · read

One transaction from the imported ledger with every journal line (account, debit, credit, line description, sales tax). IDs come from wave_list_ledger_transactions.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `transactionId` | string | yes |  |  |

### wave_list_ledger_accounts

**List ledger accounts** · toolset `ledger` · read

Accounts that appear in the imported ledger, with their type, where the type came from (Wave chart of accounts or export labels) and line counts. Use the names or IDs to filter wave_list_ledger_transactions and account_transactions reports.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `page` | integer |  | 1 | 1-based; use nextPage. min 1 |
| `pageSize` | integer |  | 50 | Items per page (max 200). min 1, max 200 |

### wave_run_report

**Run a financial report** · toolset `reports` · read

Financial reports computed by this server (Wave's API has no report endpoint). Rows are paginated with limit/offset; totals always cover every row. From the imported ledger (wave_import_ledger; any period, default year to date; balance-sheet style reports as of endDate): profit_and_loss, balance_sheet, cash_flow, trial_balance, account_balances, account_transactions/general_ledger (filter with account or accountId), sales_tax (sales and purchases), aged_payables, purchases_by_vendor. Without a ledger, profit_and_loss, balance_sheet, trial_balance and account_balances fall back to current account balances from the API (as of now only), and sales_tax to invoices. Live from invoices (invoice date range): income_by_customer, sales_by_product, invoice_summary; as of today: aged_receivables; customer_statement needs customerId. Not possible: tax_line, payroll_wage_tax, payroll_benefits_deductions.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `businessId` | string |  |  | Business ID; defaults to the one wave_get_context reports |
| `report` | "profit_and_loss" \| "balance_sheet" \| "cash_flow" \| "trial_balance" \| "account_balances" \| "account_transactions" \| "general_ledger" \| "sales_tax" \| … | yes |  |  |
| `startDate` | string |  |  | Date, YYYY-MM-DD |
| `endDate` | string |  |  | Period end; also the as-of date for balance_sheet, trial_balance, account_balances, aged_payables |
| `source` | "auto" \| "ledger" \| "api" |  | "auto" | auto: imported ledger when available for this report, else the live API |
| `account` | string |  |  | account_transactions: account name (exact, else contains) |
| `accountId` | string |  |  | account_transactions: Wave account ID |
| `fiscalYearStart` | string |  | "01-01" | balance_sheet: fiscal year start MM-DD, splits retained earnings from current-year profit |
| `customerId` | string |  |  | Required for customer_statement; filters invoice-based reports |
| `outstandingOnly` | boolean |  | true | customer_statement: only invoices with an amount due |
| `includeZeroBalances` | boolean |  | false | account_balances: include accounts with a zero balance |
| `includeArchivedAccounts` | boolean |  | false |  |
| `limit` | integer |  | 25 | Rows to return. min 1, max 200 |
| `offset` | integer |  | 0 | Rows to skip; use nextOffset. min 0 |

### wave_graphql_query

**Run a read-only GraphQL query** · toolset `graphql` · read

Escape hatch for reads the other tools do not shape the way you need: run one GraphQL query (never a mutation) against Wave's public API and get the raw data. Select only the fields you need, and always pass page/pageSize on connections. Schema: the wave://schema resource. Example: query($id: ID!){ business(id:$id){ customers(page:1,pageSize:5){ edges{ node{ id name } } } } }

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `query` | string | yes |  | A single GraphQL query document |
| `variables` | object |  |  |  |

## Resources

| URI | What it is |
|---|---|
| `wave://limitations` | Gaps in Wave's public API and the reports this server cannot produce |
| `wave://guide` | Usage guide for agents: first steps, the sign-in command the user runs, tool map and safety rules (the wave-accounting skill) |
| `wave://schema` | Full public schema snapshot, for wave_graphql_query (about 135 KB) |

## Prompts

| Prompt | Arguments | What it does |
|---|---|---|
| `month_end_review` | month | Review a month: sales, payments received, receivables and tax collected |
| `chase_overdue_invoices` |  | Find overdue invoices and plan follow-ups |
| `record_expense` | description, amount, date, paidFrom? | Record a purchase as a categorized money transaction |
