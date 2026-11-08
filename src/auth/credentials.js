import fs from 'node:fs';
import path from 'node:path';

/**
 * Credentials live in a dotenv-style file outside the repository, mode 600,
 * in a directory with mode 700. Env vars with the same names are accepted as
 * a fallback, but rotated OAuth tokens are always written back to the file.
 */
export const CREDENTIAL_KEYS = [
  'WAVE_ACCESS_TOKEN',
  'WAVE_SESSION_TOKEN',
  'WAVE_ACCESS_TOKEN_EXPIRES_AT',
  'WAVE_REFRESH_TOKEN',
  'WAVE_CLIENT_ID',
  'WAVE_CLIENT_SECRET',
  'WAVE_REDIRECT_URI',
  'WAVE_TOKEN_SCOPE',
  'WAVE_TOKEN_BUSINESS_ID',
  'WAVE_USER_ID',
  'WAVE_BUSINESS_ID',
  'WAVE_MCP_HTTP_TOKEN',
];

export function parseEnvText(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function readCredentialFile(file) {
  try {
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    return { exists: true, values: parseEnvText(text), text, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, values: {}, text: '', mtimeMs: 0, mode: 0 };
    throw error;
  }
}

/** True when group or others can read the file. */
export function isTooOpen(mode) {
  return (mode & 0o077) !== 0;
}

function serialize(existingText, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = existingText ? existingText.replace(/\n+$/, '').split(/\r?\n/) : [];
  const out = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && pending.has(match[1])) {
      const value = pending.get(match[1]);
      pending.delete(match[1]);
      if (value === null || value === undefined || value === '') continue; // removal
      out.push(`${match[1]}=${value}`);
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of pending) {
    if (value === null || value === undefined || value === '') continue;
    out.push(`${key}=${value}`);
  }
  return out.join('\n') + '\n';
}

/**
 * Atomically merge `updates` into the credential file. Keys set to null or ''
 * are removed. Unknown keys and comments are preserved.
 */
export function writeCredentialFile(file, updates) {
  for (const value of Object.values(updates)) {
    if (typeof value === 'string' && /[\r\n]/.test(value)) throw new Error('Credential values cannot contain newlines.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const current = readCredentialFile(file);
  const content = serialize(current.text, updates);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  return readCredentialFile(file);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cross-process mutual exclusion around token refresh. Several MCP processes
 * (one per agent lane) can share one credential file, and Wave rotates
 * refresh tokens, so two simultaneous refreshes would invalidate each other.
 */
export async function withFileLock(lockPath, fn, { timeoutMs = 30_000, staleMs = 60_000, pollMs = 100 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // vanished between open and stat
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for credential lock ${lockPath}`);
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}
