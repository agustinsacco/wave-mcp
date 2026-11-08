import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Imported ledgers live in the data directory, one file per business, mode
 * 600 (they contain the full books). Writes are atomic.
 */
export const LEDGER_VERSION = 1;

const fileKey = (businessId) => (businessId ? createHash('sha256').update(businessId).digest('hex').slice(0, 16) : 'default');

export class LedgerStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'ledgers');
    this.cache = new Map(); // file -> { mtimeMs, ledger }
  }

  pathFor(businessId) {
    return path.join(this.dir, `ledger-${fileKey(businessId)}.json`);
  }

  save(businessId, ledger) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.pathFor(businessId);
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: LEDGER_VERSION, businessId: businessId || null, ...ledger }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    this.cache.delete(file);
    return file;
  }

  /** The ledger for this business, else one imported without a business. */
  load(businessId) {
    for (const file of businessId ? [this.pathFor(businessId), this.pathFor(null)] : [this.pathFor(null)]) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const hit = this.cache.get(file);
      if (hit && hit.mtimeMs === stat.mtimeMs) return hit.ledger;
      const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (ledger.version !== LEDGER_VERSION) continue;
      if (businessId && ledger.businessId && ledger.businessId !== businessId) continue;
      this.cache.set(file, { mtimeMs: stat.mtimeMs, ledger });
      return ledger;
    }
    return null;
  }

  remove(businessId) {
    const file = this.pathFor(businessId);
    fs.rmSync(file, { force: true });
    this.cache.delete(file);
  }
}
