---
name: wave-accounting
description: Wave accounting (waveapps.com) through the `wave` MCP server. Covers transactions (list, search, edit, recategorize, split, delete), invoices, estimates, customers, vendors, chart of accounts, sales tax and reports. Use when the user mentions Wave, waveapps or their Wave books, or when a wave tool says its credentials or web session are missing or expired. It explains the sign-in command the user runs in a terminal.
---

# Wave accounting

The `wave` MCP server comes from the wave-mcp package. Its CLI is `bin/wave-mcp.js` in the package
root, two directories above this skill's folder. For example, if this file is
`/opt/wave-mcp/skills/wave-accounting/SKILL.md`, the CLI is
`node /opt/wave-mcp/bin/wave-mcp.js`.

**Calling the tools from pi's codemode.** Each tool is
`tools.mcp__wave__<tool name>`. A bare `tools.wave_get_context` does not exist.
A call resolves to an MCP result whose JSON is in `content[0].text`:

```js
const call = async (name, args = {}) => {
  const r = await tools[`mcp__wave__${name}`](args);
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const ctx = await call('wave_get_context');
```

`ALL_TOOLS` is a list of `{ name, description }` objects, not strings. In
clients that list MCP tools directly (Claude Code, Claude Desktop, Cursor),
call `wave_get_context` and the rest by name as usual.

## Start here

1. Call `wave_get_context`. It works even before sign-in, and shows:
   - `auth.mode` (`none` means nobody has signed in yet);
   - `auth.webSession`;
   - `auth.signIn`, the exact sign-in command for this machine, with its host;
   - the businesses, and which one is the default.
2. If the account has several businesses and no default, pass `businessId` on
   every call. IDs come from `wave_get_context`.

## Signing in (the user does this, never the chat)

Credentials are stored in `~/.config/wave-mcp/credentials.env`, mode 600, on
the machine that runs the server:

| Key | Used by | Expires |
|---|---|---|
| `WAVE_ACCESS_TOKEN` | the public-API tools (all except the live transaction tools) | no |
| `WAVE_SESSION_TOKEN` | the live transaction tools (`wave_list_transactions`, `wave_summarize_transactions`, `wave_get/update/delete_transaction`); also the public API when no access token is stored | when the user signs out of Wave, or the session times out |

When `auth.mode` is `none`, or a tool says "needs a Wave web session" or
"rejected the stored web session", ask the user to run the `auth.signIn`
command **in a terminal on that host**:

```bash
node <package>/bin/wave-mcp.js login
```

The command prints the steps:
1. Open next.waveapps.com.
2. Open DevTools (F12) → Network, and filter by `graphql`.
3. Right-click an `internal` request → Copy → Copy as cURL.
4. Paste it at the hidden prompt.

It keeps only the bearer token, checks it with Wave, and stores it. Then retry
the tool. You don't need to restart or reconnect anything, because the server
re-reads the credentials file. One paste enables every tool. For public-API
tools that keep working after the browser session ends, the user can also
store a full access token: `node <package>/bin/wave-mcp.js secrets set WAVE_ACCESS_TOKEN`.

Rules:
- Never ask for tokens, cookies or curl commands in the chat.
- Never run `login` or `secrets set` yourself. They read the secret from the
  user's own terminal.
- If the user pastes a token in the chat anyway:
  - don't repeat it;
  - suggest signing out of Wave, which invalidates it;
  - then have them sign in again with the command.
- You may run these yourself, because they print no secrets:
  - `node <package>/bin/wave-mcp.js check` shows the credential mode, whether
    the web session is valid, and the businesses.
  - `node <package>/bin/wave-mcp.js secrets list` shows which keys are set,
    never their values.
- First-time setup on a new machine, run by the user:
  `node <package>/bin/wave-mcp.js setup`. It registers the server with pi or
  Claude Code, installs this skill and signs in.

## Tools

**Live transactions.** These use Wave's web-app API, which is unofficial.
- `wave_summarize_transactions` answers "how much" questions in one call. It
  adds up every matching transaction and returns only the totals, grouped by
  `category`, `month`, `vendor`, `customer`, `account` or `none`. Use it
  instead of paging through rows and adding them up yourself.
- `wave_list_transactions` returns the rows:
  - filters: `startDate`, `endDate`, `search` (descriptions and line
    descriptions), `accountId`, `categoryIds`, `uncategorizedOnly` and
    `source`;
  - `pageSize` (max 100) and cursor paging with `nextCursor`;
  - journal entries show `journalEntry: true`.
- Both take the same filters. `accountId` is the bank or card account the
  money moved through. `categoryIds` are income or expense categories, such as
  Marketing. Find either ID with `wave_list_accounts` and its `search`
  argument, rather than paging through the whole chart of accounts.
- `wave_get_transaction` shows every line, the tax, the `sequence` and which
  fields Wave lets you edit.
- `wave_update_transaction` can change:
  - `date`, `description`, `notes` and `verified` (reviewed);
  - `accountId` and `amount`;
  - `categoryId`, `vendorId`, `customerId` and `salesTax`;
  - `lines`, for split transactions and journal entries.

  It also takes `dryRun` and `expectedSequence`.
- `wave_delete_transaction`.

**Creating transactions.** `wave_create_transaction` and
`wave_create_transactions` use the public API and support `dryRun`. Debit and
credit sides are checked first: money in needs income (INCREASE), or DECREASE
of an expense.

**Reports.** `wave_run_report`:
- Dated reports need an imported Data Export (`wave_import_ledger`).
- Without one, it falls back to current balances or invoices.
- Every result states its basis.

**Everything else:**
- Invoices, estimates (and their payments), customers, products, accounts and
  sales taxes: list, get, create and update tools.
- Vendors are read-only. Deleted customers stay readable by ID, marked
  `deleted: true`.
- `wave_graphql_query` is a read-only escape hatch to the public API.

**Not available.** Bills, bill payments, reconciliation, receipts and tags
can't be read or written. When asked about these, say so straight away, rather
than searching other tools. `wave://limitations` has the full list.

Two ways around it:
- In the Wave web app, bills are under Purchases → Bills.
- The `aged_payables` report works once a Data Export is imported. The user
  downloads it in Wave (Settings → Data Export → Accounting), then you run
  `wave_import_ledger` with the file's path.

| Question | Call |
|---|---|
| Latest transactions | `wave_list_transactions` with `pageSize` |
| Spend on a category this year | `wave_list_accounts` (`search`), then `wave_summarize_transactions` with `categoryIds`, `startDate` and `groupBy` |
| Uncategorized transactions | `wave_list_transactions` with `uncategorizedOnly: true` |
| Cash, balances, do the books balance | `wave_run_report` (`balance_sheet`, `trial_balance`) |
| Who owes me, overdue invoices | `wave_run_report` (`aged_receivables`) or `wave_list_invoices` |

## Before writing

- Writes change real books, and `wave_send_*` tools email real customers.
  Confirm amounts, accounts and recipients with the user first, and use
  `dryRun` where it is offered.
- **Editing:**
  1. Read the transaction first.
  2. Show the user the change.
  3. Pass `expectedSequence` from that read.

  A "changed since it was read" error means: read it again.
- Line amounts include sales tax and must add up to the total. Journal entries
  have no bank side: edit their `lines`, and give new lines a `side`, so that
  debits equal credits.
- Wave won't mark a transaction reviewed while a line is uncategorized.
- Changing an amount keeps sales tax that was set by hand, and anything created
  through the API counts as set by hand. To recalculate, pass
  `salesTax: [{ salesTaxId }]` without an amount.
- To try out edits, create your own transaction (for example "Test by agent")
  and delete it afterwards. Don't experiment on real entries.

## Editing transactions: examples

Read the transaction first with `wave_get_transaction({ id })`. Pass its
`sequence` as `expectedSequence`, and run with `dryRun: true` before saving.
The dry run returns `changed` and the request it would send.

- **Recategorize** a single-category transaction:
  `{ id, categoryId, expectedSequence, dryRun: true }`. Get the category ID
  from `wave_list_accounts` with `search`. The amount and sales tax stay as
  they are.
- **New total, recalculating the tax:**
  `{ id, amount: "45.00", salesTax: [{ salesTaxId }], expectedSequence }`.
  Leave out `amount` inside `salesTax`, and Wave calculates the tax.
- **Split** one transaction into two categories: pass every line to keep.
  `{ id, lines: [{ order: 1, accountId: A, amount: "30.00" }, { accountId: B, amount: "15.00" }], expectedSequence }`.
  The lines must add up to the total.
- **Journal entry** (`journalEntry: true`): edit `lines` only, and give a new
  line a `side`. For example,
  `{ id, lines: [{ order: 1, accountId: A, amount: "100.00" }, { order: 2, accountId: B, amount: "100.00" }], expectedSequence }`
  keeps debits equal to credits.
