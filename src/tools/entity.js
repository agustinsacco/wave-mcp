import * as z from 'zod';
import { listEnvelope, paginateArray, shape } from '../format.js';
import { scanConnection } from '../wave/scan.js';
import { READ, businessId, defineTool, detail, id as idArg, page, pageSize, requireFound } from './common.js';

/**
 * Standard paginated list tool over a Business connection.
 * `search` (optional) scans the whole connection once (cached briefly) and
 * filters client-side, because Wave has no name filter.
 */
export function registerList(server, ctx, spec) {
  const { name, title, toolset, description, field, ops, filters = {}, searchFields, fullPageSize = 50 } = spec;
  const shapeInput = {
    businessId,
    ...filters,
    ...(searchFields
      ? { search: z.string().min(1).optional().describe(`Case-insensitive substring match on ${searchFields.join(', ')} (scans the full list; use filters when you can)`) }
      : {}),
    detail,
    page,
    pageSize: pageSize(100, 20),
  };
  defineTool(server, ctx, {
    name,
    title,
    toolset,
    annotations: READ,
    description,
    input: z.object(shapeInput),
    handler: async (args) => {
      const { businessId: explicit, detail: level, page: p, pageSize: size, search, ...rest } = args;
      const bid = await ctx.resolveBusinessId(explicit);
      if (search) {
        const key = `${name}:scan:${bid}:${JSON.stringify(rest)}`;
        const scan = await ctx.cache.get(key, () => scanConnection(ctx.client, ops.summary, { businessId: bid, ...rest }, field, { limit: ctx.config.scanLimit }));
        const q = search.toLowerCase();
        const hits = scan.nodes.filter((n) => searchFields.some((f) => String(n[f] ?? '').toLowerCase().includes(q)));
        const out = paginateArray(hits.map((n) => shape(n, 'summary')), { page: p, pageSize: size });
        if (!scan.complete) out.note = `Searched the first ${scan.nodes.length} of ${scan.totalCount} records (WAVE_MCP_SCAN_LIMIT). Narrow with filters for the rest.`;
        return out;
      }
      const effectiveSize = level === 'full' ? Math.min(size, fullPageSize) : size;
      const data = await ctx.client.request(level === 'full' ? ops.full : ops.summary, { businessId: bid, page: p, pageSize: effectiveSize, ...rest });
      requireFound(data.business, 'Business', bid);
      const out = listEnvelope(data.business[field], { page: p, pageSize: effectiveSize, detail: level });
      if (effectiveSize !== size) out.note = `detail="full" pages are capped at ${fullPageSize} items.`;
      return out;
    },
  });
}

/** Standard get-by-id tool for a Business-scoped record. */
export function registerGet(server, ctx, { name, title, toolset, description, field, op, what, extraInput = {}, map = (x) => x }) {
  defineTool(server, ctx, {
    name,
    title,
    toolset,
    annotations: READ,
    description,
    input: z.object({ businessId, id: idArg(what), ...extraInput }),
    handler: async ({ businessId: explicit, id, ...extra }) => {
      const bid = await ctx.resolveBusinessId(explicit);
      const data = await ctx.client.request(op, { businessId: bid, id, ...extra });
      requireFound(data.business, 'Business', bid);
      return shape(map(requireFound(data.business[field], what, id)), 'full');
    },
  });
}

/** Wrap a mutation result: `{ ok: true, <entity> }`, shaped. */
export function mutationResult(payload, key, extra = {}) {
  const entity = key ? payload[key] : undefined;
  return { ok: true, ...extra, ...(key ? { [key]: shape(entity, 'full') } : {}) };
}
