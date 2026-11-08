#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig, TOOLSETS } from '../src/config.js';
import { WaveContext } from '../src/context.js';
import { createServer, VERSION } from '../src/server.js';
import { serveHttp } from '../src/http.js';
import { OPS } from '../src/wave/operations.js';
import { FULL_SCOPES, READ_SCOPES, runAuthCli } from '../src/auth/oauth-cli.js';
import { runSecretsCli } from '../src/auth/secrets-cli.js';
import { runLoginCli } from '../src/auth/login-cli.js';
import { runSetupCli } from '../src/setup-cli.js';
import { IOPS } from '../src/wave/internal-operations.js';
import { cli } from '../src/cli.js';
import { importLedger, ledgerBusinessId } from '../src/ledger/import.js';

const HELP = `wave-mcp ${VERSION}: MCP server for Wave accounting

Usage:
  wave-mcp [serve]                 Serve MCP over stdio (default)
  wave-mcp serve --http            Serve MCP over Streamable HTTP
        [--host 127.0.0.1] [--port 8787] [--path /mcp]
  wave-mcp auth [--read-only] [--business-id ID] [--no-listen]
                                   OAuth sign-in; stores tokens in the credentials file
  wave-mcp setup [--yes] [--no-login]
                                   First-time setup: register the server and the
                                   wave-accounting skill with pi/Phosphor and Claude Code,
                                   then sign in. Asks before each change
  wave-mcp login                   Paste a request copied from the Wave web app (DevTools →
                                   Network → Copy as cURL); stores its token. Enables live
                                   transactions, and every other tool if no API token is set
  wave-mcp logout                  Forget the stored web session
  wave-mcp check                   Verify credentials and list reachable businesses
  wave-mcp secrets set <KEY>       Save one credential; secrets are read with echo off
                                   (or from stdin), never from arguments
  wave-mcp secrets list            Show which keys are set (never values)
  wave-mcp secrets unset <KEY>     Remove a key
  wave-mcp import <file> [--business-id ID]
                                   Import Wave's Data Export (.zip or accounting .csv)
                                   so transactions and dated reports work
  wave-mcp --version | --help

Credentials file: $WAVE_CREDENTIALS_FILE or ~/.config/wave-mcp/credentials.env (mode 600)
  WAVE_SESSION_TOKEN               Web session from "wave-mcp login" (expires on sign-out)
  WAVE_ACCESS_TOKEN                Full access token (does not expire): wave-mcp secrets set WAVE_ACCESS_TOKEN
  WAVE_CLIENT_ID / WAVE_CLIENT_SECRET / WAVE_REDIRECT_URI, then "wave-mcp auth"

Imported ledgers: $WAVE_MCP_DATA_DIR or ~/.local/share/wave-mcp/ledgers (mode 600)

Settings (env): WAVE_BUSINESS_ID, WAVE_MCP_READ_ONLY=1, WAVE_MCP_TOOLSETS=${TOOLSETS.join(',')},
  WAVE_MCP_MAX_RESPONSE_CHARS, WAVE_MCP_SCAN_LIMIT, WAVE_MCP_MAX_CONCURRENCY, WAVE_MCP_LOG_LEVEL,
  WAVE_MCP_HTTP_HOST/PORT/PATH, WAVE_MCP_ALLOWED_HOSTS, WAVE_MCP_HTTP_TOKEN (credentials file)
`;

// `wave-mcp secrets list | head` closes the pipe early; that is not an error.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      http: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      path: { type: 'string' },
      'read-only': { type: 'boolean' },
      'business-id': { type: 'string' },
      'no-listen': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-login': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  if (values.help) return void process.stdout.write(HELP);
  const command = positionals[0] || 'serve';
  const config = loadConfig();
  const ctx = new WaveContext({ config });

  if (command === 'serve') {
    if (values.http) {
      const handle = await serveHttp(ctx, {
        host: values.host || config.http.host,
        port: values.port ? Number(values.port) : config.http.port,
        path: values.path || config.http.path,
      });
      const stop = async () => {
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    const handle = serveStdio(() => createServer(ctx));
    const stop = () => void handle.close().finally(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    ctx.logger.info(`wave-mcp ${VERSION} on stdio (auth: ${ctx.tokens.describe().mode}${config.readOnly ? ', read-only' : ''})`);
    return;
  }

  if (command === 'auth') {
    const result = await runAuthCli({ ctx, scopes: values['read-only'] ? READ_SCOPES : FULL_SCOPES, businessId: values['business-id'], listen: !values['no-listen'] });
    process.stderr.write(`\nAuthorized. Scope: ${result.scope || 'n/a'}${result.businessId ? `; restricted to business ${result.businessId}` : ''}. Tokens saved to ${config.credentialsFile}.\n`);
    await check(ctx);
    return;
  }

  if (command === 'check') return check(ctx);

  if (command === 'secrets') {
    process.exitCode = await runSecretsCli(positionals.slice(1), { file: config.credentialsFile });
    return;
  }

  if (command === 'login') {
    process.exitCode = await runLoginCli({ file: config.credentialsFile, config });
    if (process.exitCode === 0) await check(new WaveContext({ config }));
    return;
  }

  if (command === 'setup') {
    process.exitCode = await runSetupCli({
      yes: values.yes,
      login: !values['no-login'],
      runLogin: async ({ interactive }) => {
        const auth = new WaveContext({ config }).tokens.describe();
        if (auth.mode !== 'none' && /^configured/.test(auth.webSession)) return 'done';
        if (!interactive) return 'skipped';
        process.stdout.write('\nSign in to Wave\n');
        return (await runLoginCli({ file: config.credentialsFile, config })) === 0 ? 'done' : 'skipped';
      },
      runCheck: async () => {
        const fresh = new WaveContext({ config });
        if (fresh.tokens.describe().mode === 'none') return;
        process.stdout.write('\n');
        await check(fresh).catch((error) => process.stdout.write(`Check failed: ${error.message}\n`));
      },
    });
    return;
  }

  if (command === 'logout') {
    process.exitCode = await runSecretsCli(['unset', 'WAVE_SESSION_TOKEN'], { file: config.credentialsFile });
    process.stdout.write('To end the session on Wave\'s side too, sign out in the web app.\n');
    return;
  }

  if (command === 'import') {
    const file = positionals[1];
    if (!file) {
      process.stderr.write('Usage: wave-mcp import <export.zip|accounting.csv> [--business-id ID]\n');
      process.exitCode = 2;
      return;
    }
    const r = await importLedger(ctx, file, { businessId: values['business-id'] });
    process.stdout.write(
      `Imported ${r.transactions} transactions (${r.lines} lines, ${r.accounts} accounts) from ${r.firstDate} to ${r.lastDate}.\n` +
        `Account types: ${r.accountsFromWave} from Wave, ${r.accountsFromExportLabels} from export labels, ${r.accountsUnclassified} unknown.\n` +
        `Business: ${r.business?.name || r.business?.id || '(none; stored as the default ledger)'}\nStored: ${r.stored}\n`,
    );
    for (const w of r.warnings) process.stdout.write(`Warning: ${w}\n`);
    return;
  }

  process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 2;
}

async function check(ctx) {
  const auth = ctx.tokens.describe();
  process.stdout.write(`Credentials: ${auth.mode} (${auth.credentialsFile})${auth.autoRefresh ? ', auto-refresh on' : ''}\n`);
  const ledger = ctx.ledgers.load(await ledgerBusinessId(ctx).catch(() => null));
  process.stdout.write(
    ledger
      ? `Ledger: ${ledger.stats.transactions} transactions, ${ledger.stats.firstDate} to ${ledger.stats.lastDate}, imported ${ledger.importedAt}\n`
      : 'Ledger: none imported (wave-mcp import <Data Export zip>)\n',
  );
  if (auth.mode === 'none') {
    process.stdout.write(`${ctx.tokens.setupHint()}\n`);
    process.exitCode = 1;
    return;
  }
  if (ctx.session.configured()) {
    try {
      await ctx.internal.request(IOPS.Viewer);
      process.stdout.write('Web session: valid (live transaction tools enabled)\n');
    } catch (error) {
      process.stdout.write(`Web session: ${error.message}\n`);
    }
  } else {
    process.stdout.write(`Web session: none (run ${cli('login')} for live transaction tools)\n`);
  }
  const { user } = await ctx.client.request(OPS.Viewer);
  process.stdout.write(`User: ${[user.firstName, user.lastName].filter(Boolean).join(' ') || '(no name)'} <${user.defaultEmail || 'no email'}>\n`);
  const businesses = await ctx.listAllBusinesses();
  for (const b of businesses) {
    process.stdout.write(`Business: ${b.name} [${b.currency?.code}]${b.isPersonal ? ' (personal)' : ''}${b.isArchived ? ' (archived)' : ''}  ${b.id}\n`);
  }
  try {
    process.stdout.write(`Default business: ${await ctx.resolveBusinessId()}\n`);
  } catch (error) {
    process.stdout.write(`Default business: none (${error.message})\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`wave-mcp: ${error.message}\n`);
  process.exit(1);
});
