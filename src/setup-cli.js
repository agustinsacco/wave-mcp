import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST, PACKAGE_NAME, VIA_NPX, cli } from './cli.js';
import { DESCRIPTION, nodeCommand } from '../extensions/wave.js';

/**
 * `wave-mcp setup`: first-time setup on a machine. For each agent client
 * found (pi, which Phosphor lanes use, and Claude Code) it registers the MCP
 * server and installs the wave-accounting skill, then signs in. Every change
 * is shown first and asked for (or accepted with --yes); re-running skips
 * what is already set up.
 */
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'wave-mcp.js');
const SKILL_DIR = path.join(ROOT, 'skills', 'wave-accounting');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function run(cmd, args, { env = process.env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, timeout: 120_000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: r.error?.code === 'ENOENT' };
}

/** What is already in place for pi and Claude Code, without changing anything. */
export function detect({ env = process.env, home = os.homedir() } = {}) {
  const piDir = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
  const piSettings = readJson(path.join(piDir, 'settings.json')) || {};
  const piPackage = (piSettings.packages || []).some((p) => {
    const src = typeof p === 'string' ? p : p?.source;
    return typeof src === 'string' && (path.resolve(piDir, src) === ROOT || /(^|[/:@])wave-mcp(\.git)?(@|$)/.test(src));
  });
  const piSkill = [path.join(piDir, 'skills', 'wave-accounting'), path.join(home, '.agents', 'skills', 'wave-accounting')].find(exists);
  const claudeSkill = path.join(home, '.claude', 'skills', 'wave-accounting');
  return {
    pi: {
      dir: piDir,
      installed: !run('pi', ['--version'], { env }).missing,
      server: piPackage ? 'package' : readJson(path.join(piDir, 'mcp.json'))?.mcpServers?.wave ? 'mcp.json' : null,
      skill: piPackage ? 'package' : piSkill || null,
    },
    claude: {
      installed: !run('claude', ['--version'], { env }).missing,
      skillPath: claudeSkill,
      skill: exists(claudeSkill) ? claudeSkill : null,
    },
  };
}

function linkSkill(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // npx's cache can be cleared, so copy the skill instead of linking into it.
  if (VIA_NPX) fs.cpSync(SKILL_DIR, target, { recursive: true });
  else fs.symlinkSync(SKILL_DIR, target, 'dir');
}

export async function runSetupCli({ yes = false, login = true, out = process.stdout, err = process.stderr, input = process.stdin, env = process.env, home = os.homedir(), runLogin, runCheck } = {}) {
  const interactive = Boolean(input.isTTY) && !yes;
  const rl = interactive ? readline.createInterface({ input, output: err }) : null;
  const ask = async (question) => {
    if (yes) return true;
    if (!rl) return false;
    const a = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return a === '' || a === 'y' || a === 'yes';
  };
  const say = (s = '') => out.write(`${s}\n`);
  const node = nodeCommand();
  // How clients start the server: npx when setup itself ran through npx.
  const [command, args] = VIA_NPX ? ['npx', ['-y', PACKAGE_NAME]] : [node, [BIN]];
  const piSource = VIA_NPX ? `npm:${PACKAGE_NAME}` : ROOT;
  let planned = 0;

  try {
    say(`wave-mcp setup on ${HOST}`);
    say(`  package: ${ROOT}`);
    const d = detect({ env, home });

    // pi (and Phosphor, whose lanes run pi): a local package install brings the server and the skill.
    say('\npi / Phosphor');
    if (!d.pi.installed) say('  pi not found; skipped.');
    else if (d.pi.server && d.pi.skill) say(`  already set up (server: ${d.pi.server}; skill: ${d.pi.skill === 'package' ? 'package' : d.pi.skill}).`);
    else if (!d.pi.server) {
      planned++;
      say(`  will run: pi install ${piSource}`);
      say('  (registers the wave MCP server and the wave-accounting skill for every pi session)');
      if (await ask('  Install?')) {
        const r = run('pi', ['install', piSource], { env });
        say(r.ok ? '  done.' : `  pi install failed: ${r.out.slice(0, 400)}`);
      } else say('  skipped.');
    } else {
      planned++;
      const target = path.join(d.pi.dir, 'skills', 'wave-accounting');
      say(`  server already in ${d.pi.server}; will link the skill: ${target} -> ${SKILL_DIR}`);
      if (await ask('  Link the skill?')) (linkSkill(target), say('  done.'));
      else say('  skipped.');
    }

    // Claude Code: user-scope MCP server and a user skill.
    say('\nClaude Code');
    if (!d.claude.installed) say('  claude not found; skipped.');
    else {
      const has = run('claude', ['mcp', 'get', 'wave'], { env }).ok;
      if (has && d.claude.skill) say('  already set up.');
      else {
        planned++;
        if (!has) say(`  will run: claude mcp add --scope user wave -- ${[command, ...args].join(' ')}`);
        if (!d.claude.skill) say(`  will link the skill: ${d.claude.skillPath} -> ${SKILL_DIR}`);
        if (await ask('  Set up Claude Code?')) {
          if (!has) {
            const r = run('claude', ['mcp', 'add', '--scope', 'user', 'wave', '--', command, ...args], { env });
            say(r.ok ? '  server added.' : `  claude mcp add failed: ${r.out.slice(0, 400)}`);
          }
          if (!d.claude.skill) (linkSkill(d.claude.skillPath), say('  skill linked.'));
        } else say('  skipped.');
      }
    }

    say('\nOther MCP clients (Claude Desktop, Cursor, ...): add this server to their config:');
    say(`  ${JSON.stringify({ mcpServers: { wave: { command, args } } })}`);
    say('  Agents without skills can read the same guide from the server: resource wave://guide.');

    if (!interactive && !yes && planned) say('\nNothing was changed: run in a terminal to confirm each step, or pass --yes.');

    if (rl) rl.close();
    if (login && runLogin) {
      const signedIn = await runLogin({ interactive: Boolean(input.isTTY) });
      if (signedIn === 'skipped') say(`\nSign in later, in a terminal on ${HOST}: ${cli('login')}`);
    } else {
      say(`\nSign in, in a terminal on ${HOST}: ${cli('login')}`);
    }
    if (runCheck) await runCheck();
    say(`\nNew agent sessions pick this up; open ones need /reload (pi) or a restart. Description shown to agents:\n  ${DESCRIPTION}`);
    return 0;
  } finally {
    if (rl) rl.close();
  }
}
