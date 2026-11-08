#!/usr/bin/env node
/**
 * Writes docs/TOOLS.md from the server itself: every tool (grouped by
 * toolset, with annotations and parameters), resource and prompt, as an MCP
 * client sees them. The same script runs in wave-mcp and questrade-mcp.
 *
 *   npm run docs            regenerate docs/TOOLS.md
 *   npm run docs -- --check exit 1 if docs/TOOLS.md is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'docs', 'TOOLS.md');
const { createServer } = await import(path.join(ROOT, 'src/server.js'));
const { loadConfig, TOOLSETS } = await import(path.join(ROOT, 'src/config.js'));
const contextModule = await import(path.join(ROOT, 'src/context.js'));
const Context = Object.values(contextModule).find((v) => typeof v === 'function' && /Context$/.test(v.name));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Connect a client to a server limited to some toolsets; no credentials, nothing is called. */
async function open(toolsets) {
  const none = path.join(ROOT, '.no-credentials.env');
  const env = { WAVE_CREDENTIALS_FILE: none, QUESTRADE_CREDENTIALS_FILE: none };
  for (const prefix of ['WAVE_MCP', 'QUESTRADE_MCP']) env[`${prefix}_TOOLSETS`] = toolsets.join(',');
  const ctx = new Context({ config: loadConfig(env), env: {}, logger: silent });
  const handler = createMcpHandler(() => createServer(ctx));
  const client = new Client({ name: 'gen-docs', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://docs.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
  return { client, close: async () => (await client.close(), await handler.close()) };
}

const cell = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
/** The first sentence (two if the first is very short); "e.g." and similar do not end one. */
function summary(text) {
  const sentences = String(text).split(/(?<!\b(?:e\.g|i\.e|etc|vs|incl)\.)(?<=[.!?])\s+(?=[A-Z(`"])/);
  let out = sentences[0];
  for (let i = 1; out.length < 40 && i < sentences.length; i++) out += ` ${sentences[i]}`;
  return out.trim();
}

function type(schema = {}) {
  if (schema.enum) return schema.enum.length > 8 ? `${schema.enum.slice(0, 8).map((v) => JSON.stringify(v)).join(' | ')} | …` : schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const alts = schema.anyOf || schema.oneOf;
  if (alts) return alts.map(type).join(' or ');
  const t = Array.isArray(schema.type) ? schema.type.filter((x) => x !== 'null').join(' or ') : schema.type;
  if (t === 'array') return `${type(schema.items)}[]`;
  if (t === 'object' && schema.properties) return `object {${Object.keys(schema.properties).join(', ')}}`;
  return t || 'any';
}

function limits(schema = {}) {
  const out = [];
  if (schema.minimum !== undefined) out.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER) out.push(`max ${schema.maximum}`);
  if (schema.minItems !== undefined) out.push(`${schema.minItems}+ items`);
  if (schema.maxItems !== undefined) out.push(`up to ${schema.maxItems} items`);
  if (schema.format) out.push(schema.format);
  return out.join(', ');
}

function kind(a = {}) {
  if (a.readOnlyHint) return 'read';
  if (a.openWorldHint && a.destructiveHint) return 'sends (irreversible)';
  if (a.destructiveHint) return 'write (changes or deletes)';
  return 'write';
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// Descriptions carry this machine's sign-in command and host; the docs use placeholders.
const { HOST, cli } = await import(path.join(ROOT, 'src/cli.js'));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const generic = (text) =>
  String(text ?? '')
    .replaceAll(cli(), `node <package>/bin/${pkg.name}.js`)
    .replace(new RegExp(`\\bon ${escape(HOST)}\\b`, 'g'), 'on <host>');
const all = await open(TOOLSETS);
const info = all.client.getServerVersion();
const { tools } = await all.client.listTools();
const { resources } = await all.client.listResources();
const { prompts } = await all.client.listPrompts();
await all.close();

const byToolset = [];
for (const ts of TOOLSETS) {
  const one = await open([ts]);
  const names = (await one.client.listTools()).tools.map((t) => t.name);
  await one.close();
  byToolset.push([ts, tools.filter((t) => names.includes(t.name))]);
}

const lines = [];
lines.push(`# ${info.title || info.name}: tools, resources and prompts`, '');
lines.push(`Generated from ${pkg.name} ${pkg.version} by \`npm run docs\`; do not edit by hand.`, '');
const reads = tools.filter((t) => t.annotations?.readOnlyHint).length;
lines.push(`${tools.length} tools in ${TOOLSETS.length} toolsets (${reads} read, ${tools.length - reads} write), ${resources.length} resources and ${prompts.length} prompts.`);
lines.push(`Limit the toolsets with \`${pkg.name.replace(/-mcp$/, '').toUpperCase()}_MCP_TOOLSETS\` (comma-separated).`, '');
lines.push('## Tools', '');
for (const [ts, list] of byToolset) {
  lines.push(`### ${ts}`, '', '| Tool | Kind | What it does |', '|---|---|---|');
  for (const t of list) lines.push(`| [\`${t.name}\`](#${t.name}) | ${kind(t.annotations)} | ${cell(summary(t.description))} |`);
  lines.push('');
}
lines.push('## Tool reference', '');
for (const [ts, list] of byToolset) {
  for (const t of list) {
    lines.push(`### ${t.name}`, '', `**${cell(t.annotations?.title || t.title || t.name)}** · toolset \`${ts}\` · ${kind(t.annotations)}`, '', t.description.trim(), '');
    const props = t.inputSchema?.properties || {};
    const required = new Set(t.inputSchema?.required || []);
    if (Object.keys(props).length) {
      lines.push('| Parameter | Type | Required | Default | Notes |', '|---|---|---|---|---|');
      for (const [name, s] of Object.entries(props)) {
        const notes = [s.description, limits(s)].filter(Boolean).join('. ');
        lines.push(`| \`${name}\` | ${cell(type(s))} | ${required.has(name) && s.default === undefined ? 'yes' : ''} | ${s.default === undefined ? '' : cell(JSON.stringify(s.default))} | ${cell(notes)} |`);
      }
    } else lines.push('No parameters.');
    lines.push('');
  }
}
lines.push('## Resources', '', '| URI | What it is |', '|---|---|');
for (const r of resources) lines.push(`| \`${r.uri}\` | ${cell(r.description || r.title || r.name)} |`);
lines.push('', '## Prompts', '', '| Prompt | Arguments | What it does |', '|---|---|---|');
for (const p of prompts) lines.push(`| \`${p.name}\` | ${cell((p.arguments || []).map((a) => `${a.name}${a.required ? '' : '?'}`).join(', '))} | ${cell(p.description)} |`);
lines.push('');

const text = generic(lines.join('\n'));
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    process.stderr.write('docs/TOOLS.md is out of date: run npm run docs\n');
    process.exit(1);
  }
  process.stdout.write('docs/TOOLS.md is up to date\n');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  process.stdout.write(`Wrote ${path.relative(ROOT, OUT)}: ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts\n`);
}
