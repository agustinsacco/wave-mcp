import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSchema, parse, validate, visit, TypeInfo, visitWithTypeInfo } from 'graphql';
import { OPS } from '../src/wave/operations.js';

const schema = buildSchema(fs.readFileSync(new URL('../schema/wave.graphql', import.meta.url), 'utf8'));

test('every operation validates against the schema snapshot', () => {
  const names = Object.keys(OPS);
  assert.ok(names.length > 60, `expected the full operation set, got ${names.length}`);
  for (const name of names) {
    const errors = validate(schema, parse(OPS[name]));
    assert.deepEqual(errors.map((e) => e.message), [], `${name} is invalid`);
  }
});

test('operation names are unique and match their registry key', () => {
  for (const [key, doc] of Object.entries(OPS)) {
    const declared = doc.match(/^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/)?.[1];
    assert.equal(declared, key);
  }
});

test('no operation selects a deprecated field', () => {
  for (const [name, doc] of Object.entries(OPS)) {
    const typeInfo = new TypeInfo(schema);
    visit(
      parse(doc),
      visitWithTypeInfo(typeInfo, {
        Field() {
          const def = typeInfo.getFieldDef();
          assert.ok(!def?.deprecationReason, `${name} selects deprecated ${def?.name}`);
        },
      }),
    );
  }
});

test('every mutation in the schema is covered, except deprecated ones', () => {
  const mutationType = schema.getMutationType();
  const used = new Set();
  for (const doc of Object.values(OPS)) {
    for (const m of doc.matchAll(/^\s*mutation\s+\w+\([^)]*\)\s*\{\s*(\w+)\(/gm)) used.add(m[1]);
  }
  const missing = Object.values(mutationType.getFields())
    .filter((f) => f.name !== '_' && !f.deprecationReason && !used.has(f.name))
    .map((f) => f.name);
  assert.deepEqual(missing, []);
});

test('every Query and Business root field is covered', () => {
  const want = [
    ...Object.keys(schema.getQueryType().getFields()).filter((n) => n !== '_'),
    ...Object.keys(schema.getType('Business').getFields()).filter((n) => /^[a-z]/.test(n)),
  ];
  const all = Object.values(OPS).join('\n');
  const businessScalar = new Set(['id', 'name', 'isPersonal', 'organizationalType', 'type', 'subtype', 'currency', 'timezone', 'address', 'phone', 'fax', 'mobile', 'tollFree', 'website', 'isArchived', 'createdAt', 'modifiedAt', 'emailSendEnabled', 'invoiceEstimateSettings']);
  const deprecated = new Set(['isClassicAccounting', 'isClassicInvoicing']);
  const missing = want.filter((n) => !deprecated.has(n) && !businessScalar.has(n) && !new RegExp(`\\b${n}\\s*[({]`).test(all));
  assert.deepEqual(missing, []);
});
