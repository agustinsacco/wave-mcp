import { CREDENTIAL_KEYS, readCredentialFile, writeCredentialFile, isTooOpen } from './credentials.js';

/**
 * `wave-mcp secrets set|unset|list` — manage the credentials file without a
 * secret ever appearing on screen, in shell history, in process arguments or
 * in an agent's context.
 *
 *  - On a terminal the value is read with echo off.
 *  - Piped input is read whole (e.g. `pbpaste | ssh host wave-mcp secrets set KEY`).
 *  - `list` prints key names and whether each is set, never values.
 */
const SECRET_KEYS = new Set(['WAVE_ACCESS_TOKEN', 'WAVE_SESSION_TOKEN', 'WAVE_REFRESH_TOKEN', 'WAVE_CLIENT_SECRET', 'WAVE_MCP_HTTP_TOKEN']);

export function readHidden(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => (data += chunk));
      input.on('end', () => resolve(data.replace(/\r?\n$/, '').trim()));
      input.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let value = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = (err) => {
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    // Skip terminal escape sequences (e.g. bracketed-paste markers ESC[200~ / ESC[201~).
    let escape = false;
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape) {
          if (ch >= '@' && ch <= '~' && ch !== '[') escape = false;
          continue;
        }
        if (ch === '\u001b') {
          escape = true;
          continue;
        }
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}

export async function runSecretsCli(args, { file, out = process.stdout, err = process.stderr, input = process.stdin } = {}) {
  const [action, key] = args;
  const known = () => `Known keys: ${CREDENTIAL_KEYS.join(', ')}`;

  if (action === 'list' || !action) {
    const current = readCredentialFile(file);
    out.write(`Credentials file: ${file}${current.exists ? '' : ' (does not exist yet)'}\n`);
    if (current.exists && isTooOpen(current.mode)) out.write(`WARNING: mode ${current.mode.toString(8)}; run: chmod 600 "${file}"\n`);
    for (const k of CREDENTIAL_KEYS) {
      const v = current.values[k];
      out.write(`  ${k.padEnd(30)} ${v ? 'set' : '-'}\n`);
    }
    return 0;
  }

  if (!key || !CREDENTIAL_KEYS.includes(key)) {
    err.write(`Usage: wave-mcp secrets set|unset <KEY>\n${known()}\n`);
    return 2;
  }

  if (action === 'unset') {
    writeCredentialFile(file, { [key]: '' });
    out.write(`${key} removed from ${file}\n`);
    return 0;
  }

  if (action === 'set') {
    const hidden = SECRET_KEYS.has(key);
    const value = hidden ? await readHidden(`${key} (input hidden, Enter to save): `, { input }) : await readVisible(`${key}: `, input, err);
    if (!value) {
      err.write('Nothing entered; file unchanged.\n');
      return 1;
    }
    if (/\s/.test(value)) {
      err.write('The value contains whitespace; refusing to save (copy it again without spaces or line breaks).\n');
      return 1;
    }
    writeCredentialFile(file, { [key]: value });
    out.write(`${key} saved to ${file} (mode 600, ${hidden ? 'value not shown' : value}).\n`);
    return 0;
  }

  err.write(`Unknown action "${action}". Use set, unset or list.\n`);
  return 2;
}

function readVisible(prompt, input, err) {
  if (!input.isTTY) return readHidden('', { input });
  return new Promise((resolve) => {
    err.write(prompt);
    input.setEncoding('utf8');
    input.resume();
    input.once('data', (d) => {
      input.pause();
      resolve(String(d).trim());
    });
  });
}
