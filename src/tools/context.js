import * as z from 'zod';
import { OPS } from '../wave/operations.js';
import { listEnvelope, paginateArray, shape } from '../format.js';
import { READ, businessId, defineTool, page, pageSize, requireFound } from './common.js';
import { LIMITATIONS } from '../limitations.js';
import { WaveError } from '../wave/errors.js';

function ledgerStatus(l) {
  return { importedAt: l.importedAt, covers: { firstDate: l.stats.firstDate, lastDate: l.stats.lastDate }, transactions: l.stats.transactions, ...(l.business?.id ? { businessId: l.business.id } : {}) };
}

export function registerContextTools(server, ctx) {
  defineTool(server, ctx, {
    name: 'wave_get_context',
    title: 'Get Wave connection context',
    toolset: 'context',
    annotations: READ,
    description:
      'Start here. Returns the signed-in Wave user, how credentials are configured, the businesses this credential reaches, which one is the default, whether writes are enabled, and what the public API cannot do. Works without credentials and then explains how to set them up.',
    handler: async () => {
      const auth = ctx.tokens.describe();
      const out = {
        server: { readOnly: ctx.config.readOnly, toolsets: ctx.config.toolsets },
        auth,
        guide:
          'Read the wave://guide resource (the wave-accounting skill) before writing. Key rules: read a transaction before editing it and pass expectedSequence; use dryRun first; line amounts include sales tax and must add up to the total; confirm amounts, accounts and email recipients with the user; never ask for tokens in the chat.',
        limitations: LIMITATIONS.summary,
      };
      const NO_LEDGER = 'none imported: transactions and dated reports need wave_import_ledger';
      if (auth.mode === 'none') {
        const l = ctx.ledgers.load(ctx.config.businessId || null);
        return { ...out, ledger: l ? ledgerStatus(l) : NO_LEDGER, setup: ctx.tokens.setupHint() };
      }
      const [user, businesses] = await Promise.all([
        ctx.client.request(OPS.Viewer).then((d) => d.user),
        ctx.listAllBusinesses(),
      ]);
      out.user = shape(user);
      out.businesses = businesses.slice(0, 25).map((b) => shape({ id: b.id, name: b.name, currency: b.currency, isPersonal: b.isPersonal, isArchived: b.isArchived }));
      if (businesses.length > 25) out.businessesNote = `${businesses.length} businesses; use wave_list_businesses to page through all.`;
      try {
        out.defaultBusinessId = await ctx.resolveBusinessId();
      } catch (error) {
        out.defaultBusinessId = null;
        out.defaultBusinessNote = error.message;
      }
      const l = ctx.ledgers.load(out.defaultBusinessId || null);
      out.ledger = l ? ledgerStatus(l) : NO_LEDGER;
      return out;
    },
  });

  defineTool(server, ctx, {
    name: 'wave_list_businesses',
    title: 'List businesses',
    toolset: 'context',
    annotations: READ,
    description: 'List the Wave businesses this credential can access (paginated).',
    input: z.object({
      isArchived: z.boolean().optional().describe('true = only archived, false = only active, omit = both'),
      page,
      pageSize: pageSize(50, 20),
    }),
    handler: async ({ isArchived, page, pageSize }) => {
      const data = await ctx.client.request(OPS.ListBusinesses, { page, pageSize, isArchived });
      return listEnvelope(data.businesses, { page, pageSize });
    },
  });

  defineTool(server, ctx, {
    name: 'wave_get_business',
    title: 'Get business',
    toolset: 'context',
    annotations: READ,
    description: 'Full details of one business: address, contact info, currency, timezone, whether Wave can email invoices for it, and invoice/estimate branding.',
    input: z.object({ businessId }),
    handler: async (args) => {
      const id = await ctx.resolveBusinessId(args.businessId);
      const data = await ctx.client.request(OPS.GetBusiness, { id });
      return shape(requireFound(data.business, 'Business', id), 'full');
    },
  });

  defineTool(server, ctx, {
    name: 'wave_get_reference',
    title: 'Get reference data',
    toolset: 'context',
    annotations: READ,
    description:
      'Reference data needed to fill other tools\' inputs: currencies, countries, one country with its provinces/states (kind=country, code=CA), a province by code, account types, and account subtypes (needed by wave_create_account). Lists are paginated.',
    input: z.object({
      kind: z.enum(['currencies', 'countries', 'country', 'province', 'account_types', 'account_subtypes']),
      code: z.string().optional().describe('Required for kind=country (e.g. CA) and kind=province (e.g. CA-ON)'),
      search: z.string().optional().describe('Case-insensitive filter on code or name'),
      page,
      pageSize: pageSize(250, 50),
    }),
    handler: async ({ kind, code, search, page, pageSize }) => {
      if (kind === 'country' || kind === 'province') {
        if (!code) throw new WaveError(`kind=${kind} needs code (e.g. ${kind === 'country' ? 'CA' : 'CA-ON'}).`, { code: 'BAD_INPUT' });
        const data = kind === 'country' ? await ctx.client.request(OPS.Country, { code: code.toUpperCase() }) : await ctx.client.request(OPS.Province, { code });
        return shape(requireFound(data[kind], kind === 'country' ? 'Country' : 'Province', code), 'full');
      }
      const map = {
        currencies: [OPS.Currencies, 'currencies'],
        countries: [OPS.Countries, 'countries'],
        account_types: [OPS.AccountTypes, 'accountTypes'],
        account_subtypes: [OPS.AccountSubtypes, 'accountSubtypes'],
      };
      const [doc, field] = map[kind];
      let rows = await ctx.cache.get(`ref:${kind}`, async () => (await ctx.client.request(doc))[field]);
      if (search) {
        const q = search.toLowerCase();
        rows = rows.filter((r) => [r.code, r.value, r.name].some((v) => v && String(v).toLowerCase().includes(q)));
      }
      const out = paginateArray(rows.map((r) => shape(r, 'full')), { page, pageSize });
      return out;
    },
  });

  defineTool(server, ctx, {
    name: 'wave_graphql_query',
    title: 'Run a read-only GraphQL query',
    toolset: 'graphql',
    annotations: READ,
    description:
      'Escape hatch for reads the other tools do not shape the way you need: run one GraphQL query (never a mutation) against Wave\'s public API and get the raw data. Select only the fields you need, and always pass page/pageSize on connections. Schema: the wave://schema resource. Example: query($id: ID!){ business(id:$id){ customers(page:1,pageSize:5){ edges{ node{ id name } } } } }',
    input: z.object({
      query: z.string().min(1).max(20_000).describe('A single GraphQL query document'),
      variables: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async ({ query, variables }) => {
      assertQueryOnly(query);
      return ctx.client.request(query, variables || {});
    },
  });
}

/** Reject mutations and subscriptions, including ones hidden after a query. */
export function assertQueryOnly(query) {
  const stripped = query.replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#[^\n]*/g, '');
  if (/(^|[\s}])(mutation|subscription)\b/.test(stripped)) {
    throw new WaveError('wave_graphql_query only runs queries. Use the dedicated wave_* write tools for changes.', { code: 'BAD_INPUT' });
  }
}

