#!/usr/bin/env node
/**
 * Re-introspect Wave's public schema (no credentials needed), report what
 * changed against schema/wave.graphql, and with --write update the snapshot.
 * Exit code 1 when breaking changes are found, so CI can flag drift.
 */
import fs from 'node:fs';
import { buildClientSchema, buildSchema, findBreakingChanges, findDangerousChanges, getIntrospectionQuery, printSchema } from 'graphql';

const SNAPSHOT = new URL('../schema/wave.graphql', import.meta.url);
const url = process.env.WAVE_API_URL || 'https://gql.waveapps.com/graphql/public';

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true }) }),
});
const body = await res.json();
if (!body.data) {
  console.error('Introspection failed:', JSON.stringify(body.errors || body).slice(0, 500));
  process.exit(2);
}
const live = buildClientSchema(body.data);
const current = buildSchema(fs.readFileSync(SNAPSHOT, 'utf8'));
// Built-in directives (@deprecated, @include...) differ between SDL and
// introspection builds; they are not Wave changes.
const builtIn = /\b(deprecated|include|skip|specifiedBy|oneOf)\b/;
const real = (c) => !(c.type.startsWith('DIRECTIVE_') && builtIn.test(c.description));
const breaking = findBreakingChanges(current, live).filter(real);
const dangerous = findDangerousChanges(current, live).filter(real);

const sdl = printSchema(live);
const changed = sdl !== fs.readFileSync(SNAPSHOT, 'utf8');
const newTypes = Object.keys(live.getTypeMap()).filter((n) => !n.startsWith('__') && !current.getType(n));
const newMutations = Object.keys(live.getMutationType().getFields()).filter((n) => !current.getMutationType().getFields()[n]);
const newBusinessFields = Object.keys(live.getType('Business').getFields()).filter((n) => !current.getType('Business').getFields()[n]);

console.log(changed ? 'Schema changed.' : 'Schema unchanged.');
if (newTypes.length) console.log('New types:', newTypes.join(', '));
if (newMutations.length) console.log('New mutations:', newMutations.join(', '));
if (newBusinessFields.length) console.log('New Business fields:', newBusinessFields.join(', '));
for (const c of breaking) console.log(`BREAKING ${c.type}: ${c.description}`);
for (const c of dangerous) console.log(`dangerous ${c.type}: ${c.description}`);

if (process.argv.includes('--write') && changed) {
  fs.writeFileSync(SNAPSHOT, sdl);
  console.log('Snapshot updated. Run npm test and npm run test:contract.');
}
process.exit(breaking.length ? 1 : 0);
