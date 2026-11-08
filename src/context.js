import { TokenProvider } from './auth/tokens.js';
import { WaveClient } from './wave/client.js';
import { WaveError } from './wave/errors.js';
import { OPS } from './wave/operations.js';
import { createLogger } from './log.js';
import { loadConfig } from './config.js';
import { LedgerStore } from './ledger/store.js';
import { SessionTokens } from './auth/session.js';

/** Small TTL cache with in-flight de-duplication. */
export class TtlCache {
  constructor(ttlMs, { maxEntries = 50 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }
  async get(key, load) {
    const hit = this.map.get(key);
    if (hit && (hit.pending || Date.now() - hit.at < this.ttlMs)) return hit.pending || hit.value;
    const pending = load();
    this.map.set(key, { pending, at: Date.now() });
    try {
      const value = await pending;
      if (this.ttlMs > 0) this.map.set(key, { value, at: Date.now() });
      else this.map.delete(key);
      while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
      return value;
    } catch (error) {
      this.map.delete(key);
      throw error;
    }
  }
  clear() {
    this.map.clear();
  }
}

/**
 * Shared, long-lived state for one process: config, credentials, the Wave
 * client and caches. MCP server instances (one per stdio connection, or one
 * per HTTP request) are cheap and close over this.
 */
export class WaveContext {
  constructor({ config = loadConfig(), env = process.env, fetchImpl = globalThis.fetch, logger } = {}) {
    this.config = config;
    this.logger = logger || createLogger(config.logLevel);
    this.tokens = new TokenProvider(config, { env, fetchImpl, logger: this.logger });
    this.client = new WaveClient({ config, tokens: this.tokens, logger: this.logger, fetchImpl });
    // Wave's web-app API (unofficial): transactions read/edit/delete. Shares
    // the public client's concurrency limit, since both hit the same host.
    this.session = new SessionTokens(this.tokens);
    this.internal = new WaveClient({ config, tokens: this.session, logger: this.logger, fetchImpl, endpoint: config.internalApiUrl, semaphore: this.client.semaphore });
    this.cache = new TtlCache(config.cacheTtlMs);
    this.businessCache = new TtlCache(10 * 60 * 1000);
    this.ledgers = new LedgerStore(config.dataDir);
  }

  /** Writes invalidate every cached read, so reports never show stale data. */
  invalidate() {
    this.cache.clear();
  }

  async listAllBusinesses() {
    return this.businessCache.get('businesses', async () => {
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const data = await this.client.request(OPS.ListBusinesses, { page, pageSize: 50 });
        const conn = data.businesses;
        out.push(...conn.edges.map((e) => e.node));
        if (!conn.pageInfo.totalPages || page >= conn.pageInfo.totalPages) break;
      }
      return out;
    });
  }

  /**
   * Resolve which business a call targets: explicit argument, then
   * WAVE_BUSINESS_ID (env or credentials file), then the OAuth token's
   * business restriction, then the only active non-personal business.
   */
  async resolveBusinessId(explicit) {
    if (explicit) return explicit;
    if (this.config.businessId) return this.config.businessId;
    const creds = this.tokens.load();
    if (creds.businessId) return creds.businessId;
    if (creds.tokenBusinessId) return creds.tokenBusinessId;
    const all = await this.listAllBusinesses();
    const active = all.filter((b) => !b.isArchived);
    const candidates = active.filter((b) => !b.isPersonal);
    if (candidates.length === 1) return candidates[0].id;
    if (candidates.length === 0 && active.length === 1) return active[0].id;
    const choices = (candidates.length ? candidates : active)
      .slice(0, 10)
      .map((b) => `${b.name} (${b.id})`)
      .join('; ');
    throw new WaveError(
      `This credential reaches ${active.length} businesses, so pass businessId (or set WAVE_BUSINESS_ID). Choices: ${choices || 'none found'}.`,
      { code: 'BUSINESS_REQUIRED' },
    );
  }

  /** Business currency code, needed to label reports. */
  async businessCurrency(businessId) {
    const all = await this.listAllBusinesses().catch(() => []);
    const hit = all.find((b) => b.id === businessId);
    if (hit) return hit.currency?.code;
    const data = await this.client.request(OPS.GetBusiness, { id: businessId });
    return data.business?.currency?.code;
  }
}
