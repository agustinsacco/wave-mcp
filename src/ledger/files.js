import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, embedded newlines, BOM. */
export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/**
 * Read every entry of a zip archive (stored or deflated). Only what Wave's
 * Data Export produces is supported: no encryption, no zip64.
 */
export function readZip(buffer) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record).');
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const method = buffer.readUInt16LE(ptr + 10);
    const flags = buffer.readUInt16LE(ptr + 8);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`Zip entry ${name} is encrypted.`);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: 512 * 1024 * 1024 });
    else throw new Error(`Zip entry ${name} uses unsupported compression method ${method}.`);
    entries.push({ name, data });
  }
  return entries;
}

const MAX_BYTES = 100 * 1024 * 1024;

/**
 * Load an export from disk. Accepts Wave's Data Export zip, or the CSV files
 * from inside it. Returns { accounting, billItems, files } as CSV texts.
 */
export function loadExportFiles(filePath) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (!['.zip', '.csv'].includes(ext)) {
    throw new Error(`Expected Wave's Data Export .zip or its accounting .csv, got "${path.basename(resolved)}". If you chose Excel when exporting, export again as CSV.`);
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  if (stat.size > MAX_BYTES) throw new Error(`File is ${Math.round(stat.size / 1e6)} MB; the limit is ${MAX_BYTES / 1e6} MB.`);
  const buffer = fs.readFileSync(resolved);

  if (ext === '.csv') return { accounting: buffer.toString('utf8'), billItems: null, files: [path.basename(resolved)] };

  const entries = readZip(buffer).filter((e) => /\.csv$/i.test(e.name));
  if (!entries.length) throw new Error('The zip contains no CSV files. Export again choosing CSV.');
  const base = (e) => path.basename(e.name).toLowerCase();
  const accounting = entries.find((e) => /account/.test(base(e)) && !/bill|vendor|customer/.test(base(e)));
  const bills = entries.find((e) => /bill/.test(base(e)));
  if (!accounting) throw new Error(`No accounting CSV in the zip (found: ${entries.map((e) => e.name).join(', ')}).`);
  return {
    accounting: accounting.data.toString('utf8'),
    billItems: bills ? bills.data.toString('utf8') : null,
    files: entries.map((e) => e.name),
  };
}
