import { cli } from '../cli.js';
import { WaveApiError, WaveAuthError, WaveError, WaveInputError, WaveRateLimitError, describeGraphqlErrors, describeInputErrors } from './errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counting semaphore: Wave tolerates only a couple of concurrent requests. */
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.max) await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

// Network failures where the request certainly never reached Wave, so even a
// mutation can be retried without risking a duplicate write.
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

function networkCode(error) {
  return error?.cause?.code || error?.code;
}

function retryAfterMs(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  }
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

const isMutation = (query) => /^\s*(?:#[^\n]*\n\s*)*mutation\b/.test(query);
const operationName = (query) => query.match(/^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1] || 'anonymous';

/** Drop undefined/null so omitted GraphQL arguments fall back to Wave's defaults. */
export function cleanVariables(value) {
  if (Array.isArray(value)) return value.map(cleanVariables);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      out[k] = cleanVariables(v);
    }
    return out;
  }
  return value;
}

export class WaveClient {
  /**
   * @param endpoint   GraphQL URL; defaults to the public API (config.apiUrl)
   * @param semaphore  share one concurrency limit across clients of the same host
   */
  constructor({ config, tokens, logger, fetchImpl = globalThis.fetch, endpoint, semaphore }) {
    this.config = config;
    this.tokens = tokens;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.endpoint = endpoint || config.apiUrl;
    this.semaphore = semaphore || new Semaphore(config.maxConcurrency);
    this.stats = { requests: 0, retries: 0, rateLimited: 0 };
  }

  /**
   * Run one GraphQL operation and return `data`. Throws WaveError subclasses
   * whose messages are safe and actionable to show the model.
   */
  async request(query, variables = {}, { auth = true, keepNulls = false } = {}) {
    const mutation = isMutation(query);
    const name = operationName(query);
    const body = JSON.stringify({ query, variables: keepNulls ? variables : cleanVariables(variables) });
    let rejectedToken;
    let refreshedOnce = false;

    for (let attempt = 1; ; attempt++) {
      const token = auth ? await this.tokens.getAccessToken({ rejectedToken }) : undefined;
      rejectedToken = undefined;
      const started = Date.now();
      let response;
      try {
        response = await this.semaphore.run(() =>
          this.fetch(this.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': 'wave-mcp',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body,
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
          }),
        );
      } catch (error) {
        const code = networkCode(error);
        const timedOut = error?.name === 'TimeoutError';
        const retryable = mutation ? PRE_SEND_CODES.has(code) : true;
        if (retryable && attempt <= this.config.maxRetries) {
          this.stats.retries++;
          this.logger?.warn(`${name}: ${timedOut ? 'timeout' : code || error.message}; retry ${attempt}`);
          await sleep(retryAfterMs(null, attempt));
          continue;
        }
        if (timedOut) {
          throw new WaveError(
            `Wave did not answer ${name} within ${this.config.requestTimeoutMs} ms.${mutation ? ' The write may or may not have been applied: read the record back before retrying.' : ''}`,
            { code: 'TIMEOUT' },
          );
        }
        throw new WaveError(`Could not reach Wave (${code || error.message}).`, { code: 'NETWORK_ERROR', cause: error });
      }
      this.stats.requests++;

      if (response.status === 429) {
        this.stats.rateLimited++;
        if (attempt <= this.config.maxRetries) {
          const wait = retryAfterMs(response, attempt);
          this.logger?.warn(`${name}: rate limited; waiting ${wait} ms`);
          await sleep(wait);
          continue;
        }
        throw new WaveRateLimitError('Wave rate limit reached. Wait a few seconds and retry with fewer parallel calls.');
      }
      if (response.status >= 500 && !mutation && attempt <= this.config.maxRetries) {
        this.stats.retries++;
        await sleep(retryAfterMs(response, attempt));
        continue;
      }

      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.status === 401 || response.status === 403) payload = { errors: [{ message: `HTTP ${response.status}`, extensions: { code: 'UNAUTHENTICATED' } }] };
        else throw new WaveError(`Wave returned HTTP ${response.status} with a non-JSON body for ${name}.`, { code: 'BAD_RESPONSE' });
      }
      this.logger?.debug(`${name} ${response.status} in ${Date.now() - started} ms`);

      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const unauthenticated = response.status === 401 || errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED');
      if (unauthenticated && auth) {
        // A rejected token is refused before Wave runs anything, so retrying a
        // mutation here cannot duplicate it.
        if (!refreshedOnce) {
          refreshedOnce = true;
          rejectedToken = token;
          continue;
        }
        throw new WaveAuthError(`Wave still rejects the credentials after a token refresh. Run ${cli('auth')} (OAuth) or replace the full access token with ${cli('secrets set WAVE_ACCESS_TOKEN')}.`);
      }
      if (errors.length) {
        throw new WaveApiError(`Wave API error in ${name}: ${describeGraphqlErrors(errors)}`, { errors });
      }
      if (!payload.data) throw new WaveError(`Wave returned no data for ${name}.`, { code: 'BAD_RESPONSE' });
      return payload.data;
    }
  }

  /**
   * Run a mutation and unwrap its `{ didSucceed, inputErrors, ... }` payload.
   * Throws WaveInputError (with Wave's reasons) when didSucceed is false.
   */
  async mutate(query, variables, field, opts = {}) {
    const data = await this.request(query, variables, opts);
    const payload = data[field];
    if (!payload) throw new WaveError(`Wave returned no result for ${field}.`, { code: 'BAD_RESPONSE' });
    if (!payload.didSucceed) {
      throw new WaveInputError(`Wave rejected ${field}: ${describeInputErrors(payload.inputErrors)}`, { inputErrors: payload.inputErrors || [] });
    }
    return payload;
  }
}
