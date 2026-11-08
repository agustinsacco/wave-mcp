import fs from 'node:fs';
import { readCredentialFile, writeCredentialFile, withFileLock, isTooOpen } from './credentials.js';
import { WaveAuthError, WaveError } from '../wave/errors.js';
import { HOST, cli } from '../cli.js';
import { LOGIN_HINT } from './session.js';

const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Supplies a bearer token for every Wave request.
 *
 * Modes:
 *  - "oauth": client id/secret + refresh token. Access tokens are refreshed
 *    before expiry (and once on rejection), under a cross-process file lock,
 *    and the rotated refresh token is written back atomically.
 *  - "token": a static token (a Wave "Full access" token or a pasted OAuth
 *    access token). Nothing to refresh; a rejection means regenerate it.
 *  - "none": no credentials. Tools still list; calls explain how to set up.
 */
export class TokenProvider {
  constructor(config, { env = process.env, fetchImpl = globalThis.fetch, logger, now = () => Date.now() } = {}) {
    this.config = config;
    this.env = env;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.file = config.credentialsFile;
    this.lockPath = `${this.file}.lock`;
    this.cache = null; // { mtimeMs, creds }
    this.refreshing = null;
    this.warnedPermissions = false;
  }

  /** Merge file and env; the file wins for rotated values once it holds them. */
  load() {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      /* no file: env only */
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs && mtimeMs !== 0) return this.cache.creds;
    const file = readCredentialFile(this.file);
    if (file.exists && isTooOpen(file.mode) && !this.warnedPermissions) {
      this.warnedPermissions = true;
      this.logger?.warn(`Credential file ${this.file} is readable by other users; run: chmod 600 "${this.file}"`);
    }
    const f = file.values;
    const e = this.env;
    const pick = (key) => (f[key] || e[key] || undefined);
    const fileManagesOAuth = Boolean(f.WAVE_REFRESH_TOKEN);
    const creds = {
      clientId: pick('WAVE_CLIENT_ID'),
      clientSecret: pick('WAVE_CLIENT_SECRET'),
      redirectUri: pick('WAVE_REDIRECT_URI'),
      refreshToken: fileManagesOAuth ? f.WAVE_REFRESH_TOKEN : e.WAVE_REFRESH_TOKEN,
      accessToken: fileManagesOAuth ? f.WAVE_ACCESS_TOKEN : pick('WAVE_ACCESS_TOKEN'),
      expiresAt: fileManagesOAuth ? f.WAVE_ACCESS_TOKEN_EXPIRES_AT : pick('WAVE_ACCESS_TOKEN_EXPIRES_AT'),
      scope: pick('WAVE_TOKEN_SCOPE'),
      tokenBusinessId: pick('WAVE_TOKEN_BUSINESS_ID'),
      businessId: e.WAVE_BUSINESS_ID || f.WAVE_BUSINESS_ID,
      httpToken: e.WAVE_MCP_HTTP_TOKEN || f.WAVE_MCP_HTTP_TOKEN,
      sessionToken: f.WAVE_SESSION_TOKEN || e.WAVE_SESSION_TOKEN || undefined,
      source: file.exists ? 'file' : 'env',
    };
    // A web session (from "wave-mcp login") also works on the public API, so
    // it is the fallback when no API token is configured.
    creds.mode =
      creds.refreshToken && creds.clientId && creds.clientSecret ? 'oauth' : creds.accessToken ? 'token' : creds.sessionToken ? 'session' : 'none';
    this.cache = { mtimeMs: file.mtimeMs, creds };
    return creds;
  }

  describe() {
    const c = this.load();
    const expiresAt = c.expiresAt ? Date.parse(c.expiresAt) : NaN;
    return {
      mode: c.mode,
      credentialsFile: this.file,
      source: c.source,
      scope: c.scope || undefined,
      restrictedToBusinessId: c.tokenBusinessId || undefined,
      accessTokenExpiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : undefined,
      autoRefresh: c.mode === 'oauth',
      webSession: c.sessionToken ? 'configured' : 'not configured (wave_list/get/update/delete_transaction need it)',
      signIn: `${cli('login')}  (the user runs it in a terminal on ${HOST}; never ask for tokens in the chat)`,
    };
  }

  setupHint() {
    return (
      `No Wave credentials found. ${LOGIN_HINT} That enables every tool. For a token that does not expire, the user can also run ` +
      `${cli('secrets set WAVE_ACCESS_TOKEN')} and paste a full access token (Wave developer portal → Manage applications → your app → Create token); ` +
      `it is stored in ${this.file} (mode 600). Or set WAVE_CLIENT_ID, WAVE_CLIENT_SECRET and WAVE_REDIRECT_URI the same way and run ${cli('auth')}.`
    );
  }

  /**
   * @param {{ rejectedToken?: string }} opts  pass the token Wave just rejected
   *   to force a refresh (once) instead of returning it again.
   */
  async getAccessToken({ rejectedToken } = {}) {
    const c = this.load();
    if (c.mode === 'none') throw new WaveAuthError(this.setupHint());
    if (c.mode === 'session') {
      if (rejectedToken && rejectedToken === c.sessionToken) {
        throw new WaveAuthError(
          `Wave rejected the stored web session (it ends when the user signs out of Wave or it times out). ${LOGIN_HINT} ` +
            `For the public-API tools, a full access token does not expire: ${cli('secrets set WAVE_ACCESS_TOKEN')}.`,
          { code: 'SESSION_EXPIRED' },
        );
      }
      return c.sessionToken;
    }
    if (c.mode === 'token') {
      if (rejectedToken && rejectedToken === c.accessToken) {
        throw new WaveAuthError(
          `Wave rejected the configured access token (expired or revoked). Generate a new full access token and store it with ${cli('secrets set WAVE_ACCESS_TOKEN')} (in a terminal on ${HOST}), or set up OAuth with ${cli('auth')} so tokens refresh automatically. Credential file: ${this.file}`,
        );
      }
      return c.accessToken;
    }
    if (!rejectedToken && this.isFresh(c)) return c.accessToken;
    return this.refresh(rejectedToken);
  }

  isFresh(c) {
    if (!c.accessToken) return false;
    const expires = Date.parse(c.expiresAt || '');
    if (!Number.isFinite(expires)) return true; // unknown expiry: use until Wave rejects it
    return expires - this.now() > REFRESH_MARGIN_MS;
  }

  async refresh(rejectedToken) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        return await withFileLock(this.lockPath, async () => {
          this.cache = null;
          const c = this.load();
          // Another process may have refreshed while we waited for the lock.
          if (c.accessToken && c.accessToken !== rejectedToken && this.isFresh(c)) return c.accessToken;
          return await this.exchangeRefreshToken(c);
        });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async exchangeRefreshToken(c) {
    if (!c.redirectUri) {
      throw new WaveAuthError(`WAVE_REDIRECT_URI is required to refresh Wave tokens (it must match the URI used at authorization). Add it to ${this.file}.`);
    }
    const body = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
      redirect_uri: c.redirectUri,
    });
    const data = await postTokenEndpoint(this.fetch, `${this.config.oauthBaseUrl}/token/`, body, {
      timeoutMs: this.config.requestTimeoutMs,
      onRetry: (attempt, why) => this.logger?.warn(`Token refresh attempt ${attempt} failed (${why}); retrying`),
    });
    this.saveTokenResponse(data, c);
    this.logger?.info('Refreshed Wave access token');
    return data.access_token;
  }

  saveTokenResponse(data, previous = {}) {
    const expiresAt = data.expires_in ? new Date(this.now() + Number(data.expires_in) * 1000).toISOString() : '';
    writeCredentialFile(this.file, {
      WAVE_ACCESS_TOKEN: data.access_token,
      WAVE_ACCESS_TOKEN_EXPIRES_AT: expiresAt,
      WAVE_REFRESH_TOKEN: data.refresh_token || previous.refreshToken,
      WAVE_TOKEN_SCOPE: data.scope || previous.scope,
      WAVE_TOKEN_BUSINESS_ID: data.businessId || previous.tokenBusinessId,
      WAVE_USER_ID: data.userId || undefined,
    });
    this.cache = null;
  }
}

/** POST to Wave's OAuth token endpoint with bounded retries on transient failures. */
export async function postTokenEndpoint(fetchImpl, url, body, { timeoutMs = 30_000, retries = 3, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt <= retries) {
        onRetry?.(attempt, error.name === 'TimeoutError' ? 'timeout' : error.code || error.message);
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new WaveError(`Could not reach Wave's OAuth server: ${error.message}`, { code: 'NETWORK_ERROR', cause: error });
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (response.ok && data.access_token) return data;
    if (response.status >= 500 && attempt <= retries) {
      onRetry?.(attempt, `HTTP ${response.status}`);
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    const reason = data.error_description || data.error || `HTTP ${response.status}`;
    if (response.status === 403) {
      throw new WaveAuthError(
        `Wave refused the token request (403: ${reason}). Wave only issues OAuth tokens for businesses with an active Pro or Wave Advisors subscription; if it lapsed, reactivate it or use a full access token.`,
      );
    }
    throw new WaveAuthError(
      `Wave refused the token request (${reason}). The refresh token may have been revoked or already used; run ${cli('auth')} to authorize again.`,
    );
  }
}
