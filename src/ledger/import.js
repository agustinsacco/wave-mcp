import path from 'node:path';
import { OPS } from '../wave/operations.js';
import { scanConnection } from '../wave/scan.js';
import { WaveError } from '../wave/errors.js';
import { loadExportFiles } from './files.js';
import { LedgerParseError, parseAccountingCsv, parseBillItemsCsv } from './parse.js';
import { classifyAccounts } from './classify.js';
import { unclassifiedWarning } from './compute.js';

const hasCredentials = (ctx) => ctx.tokens.describe().mode !== 'none';

/**
 * Which business a ledger belongs to. Works without credentials: then the
 * explicit or configured ID, or the single "default" slot.
 */
export async function ledgerBusinessId(ctx, explicit) {
  if (explicit) return explicit;
  if (ctx.config.businessId) return ctx.config.businessId;
  if (!hasCredentials(ctx)) return null;
  try {
    return await ctx.resolveBusinessId();
  } catch {
    return null;
  }
}

async function chartOfAccounts(ctx, bid) {
  const scan = async (isArchived) => (await scanConnection(ctx.client, OPS.ListAccountsFull, { businessId: bid, isArchived }, 'accounts', { limit: ctx.config.scanLimit })).nodes;
  return [...(await scan(false)), ...(await scan(true))];
}

/** Parse a Data Export file, classify its accounts and store it. Returns a summary. */
export async function importLedger(ctx, filePath, { businessId } = {}) {
  let files;
  let parsed;
  try {
    files = loadExportFiles(filePath);
    parsed = parseAccountingCsv(files.accounting);
  } catch (error) {
    if (error instanceof LedgerParseError || /^(Expected|File|Not a|No accounting|The zip|Zip|Corrupt)/.test(error.message)) {
      throw new WaveError(error.message, { code: 'BAD_INPUT' });
    }
    throw error;
  }
  const bid = await ledgerBusinessId(ctx, businessId);
  const warnings = [...parsed.warnings];
  let apiAccounts = null;
  let business;
  if (bid && hasCredentials(ctx)) {
    try {
      apiAccounts = await chartOfAccounts(ctx, bid);
      const data = await ctx.client.request(OPS.GetBusiness, { id: bid });
      business = data.business ? { id: bid, name: data.business.name, currency: data.business.currency?.code } : { id: bid };
    } catch (error) {
      warnings.push(`Could not read the chart of accounts from Wave (${error.message}); account types come from the export's labels.`);
    }
  } else if (!hasCredentials(ctx)) {
    warnings.push("No Wave credentials configured: account types come from the export's Account Group/Type columns.");
  }
  const accounts = classifyAccounts(parsed.accounts, apiAccounts);
  const ledger = {
    importedAt: new Date().toISOString(),
    source: { file: path.basename(filePath), files: files.files, convention: parsed.convention, columns: parsed.columns },
    business: business || (bid ? { id: bid } : null),
    currency: business?.currency || parsed.lines.find((l) => l.cur)?.cur || null,
    stats: parsed.stats,
    accounts,
    lines: parsed.lines,
    bills: parseBillItemsCsv(files.billItems),
  };
  const unclassified = unclassifiedWarning(ledger);
  if (unclassified) warnings.push(unclassified);
  ledger.warnings = warnings;
  const stored = ctx.ledgers.save(bid, ledger);
  return {
    stored,
    business: ledger.business,
    ...ledger.stats,
    accountsFromWave: accounts.filter((a) => a.source === 'wave').length,
    accountsFromExportLabels: accounts.filter((a) => a.source === 'export').length,
    accountsUnclassified: accounts.filter((a) => !a.source).length,
    bills: ledger.bills.length,
    columnsUsed: parsed.columns,
    warnings,
  };
}

/** The stored ledger for a business, or an actionable error. */
export async function requireLedger(ctx, explicit) {
  const bid = await ledgerBusinessId(ctx, explicit);
  const ledger = ctx.ledgers.load(bid);
  if (!ledger) {
    throw new WaveError(
      "No transaction ledger has been imported. Wave's public API cannot read transactions, so they come from Wave's Data Export: in Wave go to Settings → Data Export → Accounting (CSV), download the zip from the email, then run wave_import_ledger with its path (or `wave-mcp import <file>` in a terminal).",
      { code: 'NO_LEDGER' },
    );
  }
  return { bid, ledger };
}

export function ledgerMeta(ledger) {
  const ageDays = Math.floor((Date.now() - Date.parse(ledger.importedAt)) / 86_400_000);
  return {
    source: 'imported Wave Data Export (snapshot)',
    importedAt: ledger.importedAt,
    covers: { firstDate: ledger.stats.firstDate, lastDate: ledger.stats.lastDate },
    ...(ledger.currency ? { currency: ledger.currency } : {}),
    ...(ageDays >= 7 ? { stale: `Imported ${ageDays} days ago; changes in Wave since then are missing. Export and import again for current figures.` } : {}),
  };
}
