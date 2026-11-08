import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('docs/TOOLS.md matches the server (regenerate with npm run docs)', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/gen-docs.mjs', '--check'], { cwd: ROOT });
  assert.match(stdout, /up to date/);
});
