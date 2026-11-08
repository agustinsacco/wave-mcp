import { WaveError } from './errors.js';

/**
 * Walk every page of a business-scoped connection (customers, invoices...)
 * at Wave's maximum page size, up to `limit` records. Returns whether the walk
 * was complete so callers can tell the model when a result is partial.
 */
export const WAVE_MAX_PAGE_SIZE = 200;

/**
 * `stopAfter(node)`: when the connection is sorted so that once one node
 * matches every later node matches too (e.g. AMOUNT_DUE_DESC and "nothing
 * due"), the walk ends after the page containing the first match. The result
 * still counts as complete for the caller's purpose.
 */
export async function scanConnection(client, doc, variables, field, { limit = 5000, pageSize = WAVE_MAX_PAGE_SIZE, stopAfter } = {}) {
  const nodes = [];
  let totalCount;
  let pages = 0;
  for (let page = 1; ; page++) {
    const data = await client.request(doc, { ...variables, page, pageSize });
    if (!data.business) {
      throw new WaveError(`Business ${variables.businessId} was not found or is not accessible with this credential.`, { code: 'NOT_FOUND' });
    }
    const conn = data.business[field];
    pages++;
    totalCount = conn?.pageInfo?.totalCount ?? totalCount;
    const batch = (conn?.edges || []).map((e) => e.node);
    nodes.push(...batch);
    const totalPages = conn?.pageInfo?.totalPages;
    const done = (totalPages ? page >= totalPages : batch.length < pageSize) || (stopAfter && batch.some(stopAfter));
    if (done) return { nodes, complete: true, totalCount: totalCount ?? nodes.length, pages };
    if (nodes.length >= limit) return { nodes: nodes.slice(0, limit), complete: false, totalCount, pages };
  }
}
