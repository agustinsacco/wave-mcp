/**
 * pi package entry. `pi install <this package>` (npm, git or a local path)
 * loads this extension, which registers the wave MCP server for every pi
 * session, and the wave-accounting skill from ./skills. The user then signs
 * in once with `wave-mcp login`. An mcp.json server named "wave" takes
 * precedence over this registration.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, cli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { TokenProvider } from '../src/auth/tokens.js';

const BIN = fileURLToPath(new URL('../bin/wave-mcp.js', import.meta.url));

/** Run the server with the same Node as pi when pi runs on Node; else whatever `node` is on PATH. */
export function nodeCommand(execPath = process.execPath) {
  return /^node(\.exe)?$/i.test(path.basename(execPath)) ? execPath : 'node';
}

export const DESCRIPTION =
  'Wave accounting (waveapps): transactions (live list/summarize/edit/delete), invoices, estimates, customers, vendors, products, accounts, sales taxes, payments and reports. ' +
  'Load skill wave-accounting first. In codemode call tools.mcp__wave__wave_get_context({}) etc.; results are JSON in content[0].text. ' +
  `Sign-in: the user runs \`${cli('login')}\` in a terminal on ${HOST}`;

/** A one-line notice when nobody has signed in on this machine yet; undefined once credentials exist. */
export function signInNotice(env = process.env) {
  try {
    const config = loadConfig(env);
    if (new TokenProvider(config, { env }).describe().mode !== 'none') return undefined;
  } catch {
    return undefined;
  }
  return `Wave is not signed in on ${HOST}. In a terminal there, run: ${cli('login')}`;
}

export default function wave(pi) {
  pi.registerMcpServer('wave', { command: nodeCommand(), args: [BIN], exposure: 'codemode', description: DESCRIPTION });
  pi.on('session_start', async (_event, ctx) => {
    const notice = signInNotice();
    if (notice && ctx?.hasUI) ctx.ui.notify(notice, 'info');
  });
}
