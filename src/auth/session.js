import { WaveAuthError } from '../wave/errors.js';
import { HOST, cli } from '../cli.js';

/** What to tell the user when the web session is missing or expired. */
export const LOGIN_HINT =
  `Ask the user to sign in: in a terminal on ${HOST} (not in the chat) they run: ${cli('login')} ` +
  'and paste a request copied from the Wave web app (next.waveapps.com → DevTools → Network → filter "graphql" → right-click an "internal" request → Copy → Copy as cURL). ' +
  'Only the token is kept, in the credentials file (mode 600). The server picks it up on the next call; no restart needed.';

/**
 * Token source for Wave's web-app API: the session token of a signed-in
 * browser, stored as WAVE_SESSION_TOKEN by "wave-mcp login". It cannot be
 * refreshed from here; when Wave rejects it the user logs in again. The file
 * is re-read on every call, so a new login takes effect without a restart.
 */
export class SessionTokens {
  constructor(tokenProvider) {
    this.provider = tokenProvider;
  }

  configured() {
    return Boolean(this.provider.load().sessionToken);
  }

  async getAccessToken({ rejectedToken } = {}) {
    const token = this.provider.load().sessionToken;
    if (!token) {
      throw new WaveAuthError(`This needs a Wave web session, which is not configured. ${LOGIN_HINT}`, { code: 'NO_SESSION' });
    }
    if (rejectedToken && rejectedToken === token) {
      throw new WaveAuthError(
        `Wave rejected the stored web session (it expires when you sign out of Wave or after Wave's session timeout). ${LOGIN_HINT}`,
        { code: 'SESSION_EXPIRED' },
      );
    }
    return token;
  }
}
