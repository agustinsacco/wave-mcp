import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The exact shell command for this checkout's CLI, e.g.
 * `node ~/src/general/wave-mcp/bin/wave-mcp.js login`. Messages that ask the
 * user to run something use it, so an agent in any lane can pass on a command
 * that works as-is (the `wave-mcp` name is only on PATH after npm link).
 */
const BIN = fileURLToPath(new URL('../bin/wave-mcp.js', import.meta.url));
const HOME = os.homedir();

function binPath() {
  const p = HOME && BIN.startsWith(`${HOME}/`) ? `~/${BIN.slice(HOME.length + 1)}` : BIN;
  return /[\s'"$`\\]/.test(p) ? `'${BIN.replace(/'/g, `'\\''`)}'` : p;
}

export const HOST = os.hostname();

export function cli(args = '') {
  return `node ${binPath()}${args ? ` ${args}` : ''}`;
}

/** "In a terminal on <host> (not in this chat), run: <command>" */
export function runInTerminal(args) {
  return `in a terminal on ${HOST} (not in the chat), run: ${cli(args)}`;
}
