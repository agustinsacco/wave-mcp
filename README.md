# Wave MCP

A Model Context Protocol server for [Wave](https://www.waveapps.com) accounting.
It covers the whole public Wave GraphQL API (every query and every
non-deprecated mutation), reads and edits transactions through the API Wave's
own web app uses, adds payment listings and derived financial reports, and
keeps responses small enough that a model can page through real books without
flooding its context.

> Not affiliated with Wave Financial. Writes change real books and some tools
> email real customers. Transaction reads and edits use Wave's unofficial
> web-app API, which Wave can change at any time.

## What it can do

| Area | Read | Write |
|---|---|---|
| Businesses, user, reference data | context, list/get businesses, currencies, countries/provinces, account types/subtypes | — |
| Customers | list (filters + search), get | create, update, delete |
| Vendors | list (filters + search), get | *Wave API has no vendor writes* |
| Products & services | list, get | create, update, archive |
| Chart of accounts | list with balances, get | create, update (auto sequence), archive |
| Sales taxes | list, get with rate history | create, update rates, archive |
| Invoices | list (all Wave filters), get with items/payments | create, update, clone, approve, mark sent, **email**, delete |
| Invoice payments | get, list (see below) | record, update, delete, **email receipt** |
| Estimates | list, get with deposits/history | create, update, clone, approve, mark sent/accepted, reset acceptance, convert to invoice, PDF, **email**, delete |
| Estimate deposits | get, list | record, update, delete, **email receipt** |
| Transactions (live) | list/search (date, text, bank account, categories, uncategorized, source; cursor pages), get with every line, tax and sequence | create (public API, single or 50 in bulk); edit date, description, notes, reviewed, account, amount, category, vendor/customer, split lines, sales tax; delete. Web-app API, see [Transactions](#transactions-web-app-api) |
| Transactions (snapshot) | `wave_import_ledger` a Data Export, then `wave_list_ledger_transactions`, ledger accounts and dated reports | — |
| Payments received | `wave_list_payments`: invoice payments + estimate deposits by date/customer, with totals | — |
| Reports | `wave_run_report` (below) | — |
| Anything else | `wave_graphql_query` (read-only escape hatch) | — |

73 tools, 3 resources (`wave://guide`, `wave://limitations`, `wave://schema`)
and 3 prompts (`month_end_review`, `chase_overdue_invoices`, `record_expense`).
Every tool, parameter and default is listed in **[docs/TOOLS.md](docs/TOOLS.md)**,
which is generated from the server.

### Reports

Wave's public API has no report endpoints, so `wave_run_report` derives them
and every result states its basis:

| Report | Source | Period |
|---|---|---|
| `profit_and_loss`, `balance_sheet`, `trial_balance`, `account_balances` | current account balances | as of now only |
| `income_by_customer` | invoices (invoiced) + invoice payments (paid) | any date range |
| `sales_by_product` | invoice line items | any date range |
| `sales_tax` | tax on invoice lines (collected only) | any date range |
| `invoice_summary` | invoices by status, overdue | any date range |
| `aged_receivables` | open invoices, bucketed by days past due | as of today |
| `customer_statement` | a customer's outstanding (or dated) invoices and payments | as of today / range |

Multi-currency totals are converted with each invoice's exchange rate and also
reported per original currency.

### Transactions (web-app API)

Wave's public API can create transactions but not read, edit or delete them.
`wave_list_transactions`, `wave_summarize_transactions`, `wave_get_transaction`,
`wave_update_transaction` and `wave_delete_transaction` use `gql.waveapps.com/graphql/internal`, the API
behind next.waveapps.com, with the same operations the web app sends. It is
**unofficial**: Wave can change it without notice, and it only accepts a
browser session token (see `wave-mcp login` below), not API tokens.

- Edits read the transaction first and send its `sequence` (Wave's optimistic
  lock), so a change made meanwhile in the web app is never overwritten; pass
  `expectedSequence` to pin the version you showed the user.
- Fields Wave marks as not editable (bank-feed, reconciled, payment or payroll
  transactions) are refused before anything is sent.
- Line amounts include sales tax and must add up to the total; this is checked
  locally. `salesTax` on a line recalculates tax through Wave's own calculator
  (omit `amount`), sets it, or removes it (`[]`). Wave recalculates taxes it
  computed itself when an amount changes and keeps manually set ones; the tool
  warns when that happens.
- Delete is Wave's soft delete (the web app's Delete). `dryRun` shows the exact
  patch without saving.
- Journal entries (`journalEntry: true`) have no bank side: edit their lines,
  with `side` on new lines; debits must equal credits.
- Verified live on 2026-11-08:
  - Walked every transaction of two real businesses (over 1,300 in all),
    cursor page by cursor page. Each one came back exactly once, in order, and every bank
    balance rebuilt from them matched Wave's to the cent.
  - Every filter agreed with the full walk.
  - Edits were tested on throwaway transactions: header fields, review status,
    recategorize, amount, split/merge lines, journal lines, tax
    recalculation/manual/removal, stale sequence and delete.

Wave quirks found while testing, and how the tools handle them:

| Quirk | Handling |
|---|---|
| Wave's cursors repeat rows when sorting by creation date | Only date sorts are offered |
| A page can exceed the response cap | The tool returns fewer rows and points `nextCursor` at the last row it returned, so nothing is skipped |
| `accountId` matches any line on the account, including journal entries | Described in the tool |
| Search also matches line descriptions | Described in the tool |
| One invalid transaction in a bulk create crashes Wave's server, unnamed | Sides are checked against each account's normal balance before sending |
| Customer delete is soft: the record stays readable by ID | `wave_get_customer` marks it `deleted: true` |

### What Wave's public API cannot do

Verified against live introspection (see `wave://limitations`):

- **No transaction reads or edits** (only creates). The tools above fill the
  gap through the web-app API; the Data Export import is the offline route.
- **No native reports**; account balances have no as-of date. Cash flow, general
  ledger, aged payables and purchases by vendor cannot be produced.
- No bills, bill payments, journal entries, receipts, payroll or bank feeds.
- Vendors are read-only; no un-archive; no attachment uploads.
- Invoice/estimate lines must reference a product.

## Install

Node.js 20 or later. Agents get two things on top of the server:
- the **`wave-accounting` skill** (`skills/wave-accounting/SKILL.md`), which
  covers first steps, sign-in, the tools and the safety rules;
- the **sign-in command**, which the server puts into its connector
  description, `wave_get_context` (`auth.signIn`) and every auth error, with
  this machine's real path and host name.

### pi / Phosphor: one command

```bash
pi install npm:@saccolabs/wave-mcp          # from npm
pi install git:github.com/agustinsacco/wave-mcp   # or straight from GitHub
```

pi installs the npm dependencies. The package's extension registers the
`wave` MCP server for every session (codemode exposure, which keeps the 73
tool schemas out of the context until a script uses them), and the skill joins
every session's skill index. Phosphor can also install it from Settings →
Skills & extensions. Until someone signs in, each new session shows:

```
Wave is not signed in on <host>. In a terminal there, run: node <package>/bin/wave-mcp.js login
```

A `wave` entry in `mcp.json` takes precedence over the package's registration.

### Claude Code, Claude Desktop, Cursor: no clone needed

The package is on npm as
[`@saccolabs/wave-mcp`](https://www.npmjs.com/package/@saccolabs/wave-mcp).
`npx` downloads and runs it:

```bash
claude mcp add --scope user wave -- npx -y @saccolabs/wave-mcp
```

Other clients take the same command in their config:

```json
{ "mcpServers": { "wave": { "command": "npx", "args": ["-y", "@saccolabs/wave-mcp"] } } }
```

Then sign in, in a terminal on the same machine:

```bash
npx -y @saccolabs/wave-mcp login
```

Every other command works the same way (`npx -y @saccolabs/wave-mcp check`,
`… setup`). When the server runs through npx, its sign-in messages show the
npx command too. These clients don't install the `wave-accounting` skill. They get the
same guide from the `wave://guide` resource, and the start-here tool points
to it. `npx -y @saccolabs/wave-mcp setup` adds the server and a copy of the
skill to Claude Code in one step.

### From a clone: `setup`

```bash
git clone https://github.com/agustinsacco/wave-mcp && cd wave-mcp && npm install
node bin/wave-mcp.js setup
```

`setup` looks for pi and Claude Code, shows each change and asks first:
- **pi:** `pi install <this folder>`.
- **Claude Code:** `claude mcp add --scope user wave …`, plus a link at
  `~/.claude/skills/wave-accounting`.

It then runs `login` and `check`. Re-running it skips whatever is already set
up, and `--yes` accepts every step without asking. For other clients (Claude
Desktop, Cursor, …) it prints the config entry to add:

```json
{ "mcpServers": { "wave": { "command": "node", "args": ["/path/to/wave-mcp/bin/wave-mcp.js"] } } }
```

Clients without skills can read the same guide from the `wave://guide`
resource. Credentials and imported ledgers stay on the machine that runs the
server (`~/.config/wave-mcp`, `~/.local/share/wave-mcp`), so sign in on each
machine where it runs.

## Sign in

Credentials live outside the repository in
`~/.config/wave-mcp/credentials.env` (override with `WAVE_CREDENTIALS_FILE`),
mode `600`. Never put them in MCP config arguments, source or chat. See
[`credentials.env.example`](credentials.env.example).

**Easiest: `wave-mcp login` (one paste, enables every tool).**

```bash
node bin/wave-mcp.js login
```

1. Open https://next.waveapps.com and sign in.
2. DevTools (F12) → Network → type `graphql` in the filter (reload if empty).
3. Right-click a `gql.waveapps.com` request (named `internal`) → Copy →
   Copy as cURL (bash, cmd, fetch and PowerShell copies all work).
4. Paste at the hidden prompt.

Only the `authorization: Bearer` token is kept (cookies and everything else
are discarded) and it is never printed. `login` asks Wave what kind of token
it is: a web session is saved as `WAVE_SESSION_TOKEN` (live transactions, and
the public API too when no API token is stored); a full access token pasted
the same way is saved as `WAVE_ACCESS_TOKEN`. A web session ends when you sign
out of Wave or it times out; tools then say to run `login` again. `logout`
forgets it. Piped input works too: `wave-mcp login < request.txt`.

**Option A: full access token (does not expire; works without Wave Pro).**
In the [developer portal](https://developer.waveapps.com) → Manage
applications → your app → Full access tokens → Create token:

```dotenv
WAVE_ACCESS_TOKEN=...
```

It reaches every business in your Wave account. Use it for personal use and
development only.

**Option B: OAuth 2 (auto-refreshing, scoped; needs Wave Pro on the business).**
Register `http://localhost:8765/callback` as a redirect URI on the app, then:

```dotenv
WAVE_CLIENT_ID=...
WAVE_CLIENT_SECRET=...
WAVE_REDIRECT_URI=http://localhost:8765/callback
```

```bash
node bin/wave-mcp.js auth            # full scopes
node bin/wave-mcp.js auth --read-only
node bin/wave-mcp.js check           # verify, list businesses
```

`auth` prints the authorization URL. If your browser is on another machine,
approve there and paste the URL the browser was redirected to (the page itself
may not load). Tokens are written back to the credentials file.

Token lifecycle: the access token refreshes two minutes before expiry and
once more if Wave rejects it. Wave rotates refresh tokens, so refreshes run
under a cross-process file lock with a re-read. Several MCP processes (one per
agent lane) can therefore share one file without invalidating each other.
Writes are atomic (temp file, fsync, rename, chmod 600).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WAVE_BUSINESS_ID` | auto | Default business. Otherwise the token's business, or the only non-personal one |
| `WAVE_MCP_READ_ONLY` | off | Register only read tools |
| `WAVE_MCP_TOOLSETS` | all | Comma list: `context,customers,vendors,products,accounts,sales_taxes,invoices,estimates,payments,transactions,reports,ledger,graphql` |
| `WAVE_MCP_DATA_DIR` | `~/.local/share/wave-mcp` | Where imported ledgers are stored (mode 600) |
| `WAVE_MCP_MAX_RESPONSE_CHARS` | 60000 | Hard cap per tool result (trailing list items are dropped, with a note) |
| `WAVE_MCP_SCAN_LIMIT` | 5000 | Max records a report or search walks |
| `WAVE_MCP_CACHE_TTL_MS` | 120000 | Cache for scans and reference data; any write clears it |
| `WAVE_MCP_MAX_CONCURRENCY` | 2 | Concurrent Wave requests (Wave's limits are tight) |
| `WAVE_MCP_TIMEOUT_MS` / `WAVE_MCP_MAX_RETRIES` | 30000 / 3 | Per request |
| `WAVE_MCP_LOG_LEVEL` | info | `debug`, `info`, `warn`, `error`, `silent` (stderr only) |
| `WAVE_MCP_HTTP_HOST` / `_PORT` / `_PATH` | 127.0.0.1 / 8787 / /mcp | HTTP transport |
| `WAVE_MCP_ALLOWED_HOSTS` | loopback | Host/Origin allow-list for HTTP |
| `WAVE_MCP_HTTP_TOKEN` | — | Bearer token for HTTP (credentials file); required off loopback |

## Use it

Ask things like "which invoices are overdue?", "recategorize last month's
Uber rides to Travel", "what did I sell by product this quarter?" or "split
this transaction between Meals and Office". The prompts give ready-made
versions: `month_end_review` (month), `chase_overdue_invoices` and
`record_expense`.

### Streamable HTTP (one server for several clients)

```bash
node bin/wave-mcp.js serve --http                      # http://127.0.0.1:8787/mcp
WAVE_MCP_HTTP_HOST=100.x.y.z WAVE_MCP_ALLOWED_HOSTS=myhost,100.x.y.z node bin/wave-mcp.js serve --http
```

Off loopback the server refuses to start without `WAVE_MCP_HTTP_TOKEN`, and
clients send `Authorization: Bearer <token>`
(`pi mcp add wave --url http://myhost:8787/mcp --bearer-token-env-var WAVE_MCP_HTTP_TOKEN`).
Host and Origin headers are validated against DNS rebinding. `GET /healthz`
reports liveness.

## Response design

- **Pagination everywhere.** Wave lists use `page`/`pageSize` (default 20,
  max 100; 25 for `detail: "full"` invoices/estimates). Reports and payments
  use `offset`/`limit`. Every response says `hasMore` and gives
  `nextPage`/`nextOffset`.
- **Summary by default.** `detail: "summary"` returns key fields and clips long
  text; `get_*` tools return everything.
- **Compact JSON.** Nulls, empty strings and empty lists are dropped, and
  `{code}`/`{value}` wrappers are collapsed (`"currency": "CAD"`).
  Money is a decimal string.
- **A hard budget.** Results above `WAVE_MCP_MAX_RESPONSE_CHARS` are trimmed,
  never silently.
- **Totals cover all rows** even when only a page of rows is returned.
- **Errors are tool results** (`isError: true`) whose text names the fix:
  Wave's `inputErrors` with paths, missing IDs, unbalanced transactions with
  both figures, auth problems with the command to run.

## MCP practices followed

- Official TypeScript SDK v2 (`@modelcontextprotocol/server`), spec 2026-07-28,
  serving 2025-era clients from the same factory over stdio and Streamable HTTP.
- Zod input schemas with per-field descriptions and bounds; arguments are
  validated before handlers run.
- Tool annotations on every tool: `readOnlyHint`, `destructiveHint`
  (update/delete/archive/send), `idempotentHint`, and `openWorldHint` (email sends).
- Server `instructions`, resources for the guide, schema and limitations, and
  user-invoked prompts.
- stdout carries only JSON-RPC; logs go to stderr with secrets redacted.
- Read-only mode and toolsets for least privilege; no tool accepts or reveals
  credentials.
- Mutations are never retried after an ambiguous network failure (no duplicate
  writes); rate limits and 5xx on reads back off and retry.

## Security

- Writes change real books, and `wave_send_*` tools email real customers.
  The skill tells agents to confirm recipients and amounts first.
  `WAVE_MCP_READ_ONLY=1` registers only read tools.
- Credentials live only in the mode-600 credentials file on the machine that
  runs the server. They are never in MCP arguments, logs or tool results.
  `login` and `secrets set` read them with echo off.
- Agents are told never to ask for a token, cookie or curl command in the
  chat, and never to run `login` themselves.
- The web-app API is unofficial and needs your browser session, so treat that
  token like your Wave password. Signing out of Wave ends it.
- HTTP binds to loopback unless a bearer token is set.

## Development

```bash
npm test                 # unit + end-to-end over both transports (no network)
npm run test:contract    # live: every query/mutation document and the inputs the
                         # write tools build are sent to Wave with an invalid
                         # token. Wave validates before it authenticates, so
                         # this proves they are accepted, with nothing read or written
npm run smoke            # live, with your credentials: every read tool and report
npm run smoke -- --writes  # plus a reversible create/update/delete round trip (test business!)
npm run docs             # regenerate docs/TOOLS.md (a test fails when it is out of date)
npm run schema:update    # detect upstream schema drift (exit 1 on breaking changes)
npm run inspect          # MCP Inspector
```

The end-to-end tests run a fake Wave built from the real schema snapshot
(`schema/wave.graphql`), so every document is parsed, validated and executed
exactly as Wave would. The web-app API refuses introspection, so its tests use
a stateful fake (`test/helpers/fake-internal.js`) that reproduces the
behaviours observed live: sequence locking, JSON-encoded input errors, soft
delete and calculated vs manual sales tax.

## Related

[questrade-mcp](https://github.com/agustinsacco/questrade-mcp), a read-only
MCP server for Questrade, works the same way: it installs the same way, signs
in the same way, and has the same CLI and response design.

## License

MIT
