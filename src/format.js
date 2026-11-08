/**
 * Response shaping. Everything a tool returns passes through here so the
 * model gets compact, predictable JSON:
 *  - null / undefined / '' / [] / {} are dropped (absent means "not set")
 *  - `{ code }` wrappers (Currency, Province, ...) collapse to the code
 *  - `{ value }` wrappers (Money inside invoices) collapse to the value
 *  - `__typename` is dropped except where it disambiguates a union
 *  - long free-text fields are clipped in summary mode
 */

const KEEP_TYPENAME_PARENTS = new Set(['discounts', 'source']);

export function compact(value, { clip = 0, parentKey = '' } = {}) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value === '') return undefined;
    if (clip && value.length > clip) return `${value.slice(0, clip)}… [+${value.length - clip} chars]`;
    return value;
  }
  if (Array.isArray(value)) {
    const out = value.map((v) => compact(v, { clip, parentKey })).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== null && value[k] !== undefined);
    if (keys.length === 1 && (keys[0] === 'code' || keys[0] === 'value')) return compact(value[keys[0]], { clip });
    const out = {};
    for (const key of keys) {
      if (key === '__typename' && !KEEP_TYPENAME_PARENTS.has(parentKey)) continue;
      const v = compact(value[key], { clip, parentKey: key });
      if (v !== undefined) out[key === '__typename' ? 'type' : key] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/** Clip long text fields (memos, notes, descriptions) in list views. */
export const SUMMARY_CLIP = 280;

export function shape(value, detail = 'summary') {
  return compact(value, { clip: detail === 'full' ? 0 : SUMMARY_CLIP }) ?? null;
}

/** Turn a Wave `{ pageInfo, edges }` connection into the standard list envelope. */
export function listEnvelope(connection, { page, pageSize, detail = 'summary', map = (n) => n, extra } = {}) {
  const items = (connection?.edges || []).map((e) => shape(map(e.node), detail)).filter(Boolean);
  const info = connection?.pageInfo || {};
  const totalPages = info.totalPages ?? undefined;
  const current = info.currentPage ?? page;
  const hasMore = totalPages !== undefined ? current < totalPages : items.length === pageSize;
  return {
    ...(extra || {}),
    items,
    page: current,
    pageSize,
    totalCount: info.totalCount ?? undefined,
    totalPages,
    hasMore,
    ...(hasMore ? { nextPage: current + 1 } : {}),
  };
}

/** Client-side pagination for lists Wave returns whole (currencies, countries...). */
export function paginateArray(all, { page = 1, pageSize = 50 } = {}) {
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const hasMore = page < totalPages;
  return { items, page, pageSize, totalCount: all.length, totalPages, hasMore, ...(hasMore ? { nextPage: page + 1 } : {}) };
}

/** Offset/limit window over computed rows (reports, payment listings). */
export function windowRows(rows, { offset = 0, limit = 50 } = {}) {
  const items = rows.slice(offset, offset + limit);
  const hasMore = offset + items.length < rows.length;
  return { items, offset, limit, totalCount: rows.length, hasMore, ...(hasMore ? { nextOffset: offset + items.length } : {}) };
}

/**
 * Serialize for the model and enforce the response budget. When a payload is
 * over budget, trailing list items are removed (never silently: the result
 * says how many were dropped and how to page instead).
 */
export function toText(payload, maxChars) {
  let text = JSON.stringify(payload);
  if (!maxChars || text.length <= maxChars) return text;
  if (payload && Array.isArray(payload.items) && payload.items.length > 1) {
    const items = [...payload.items];
    const original = items.length;
    let trimmed = { ...payload };
    while (items.length > 1) {
      items.pop();
      trimmed = {
        ...payload,
        items: [...items],
        truncated: {
          returned: items.length,
          of: original,
          reason: `Response exceeded ${maxChars} characters. Use a smaller pageSize/limit or detail="summary" to see the rest.`,
        },
      };
      text = JSON.stringify(trimmed);
      if (text.length <= maxChars) return text;
    }
    return text;
  }
  return JSON.stringify({
    truncated: true,
    reason: `Response exceeded ${maxChars} characters; narrow the request (filters, smaller pages, detail="summary").`,
    preview: text.slice(0, Math.max(0, maxChars - 300)),
  });
}

// ------------------------------------------------------------ money helpers

/** Parse a Wave decimal string into integer minor units (cents) safely. */
export function toMinor(value, exponent = 2) {
  if (value === null || value === undefined || value === '') return 0;
  const s = String(value).trim().replace(/,/g, '');
  const m = s.match(/^(-)?(\d*)(?:\.(\d*))?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 10 ** exponent) : 0;
  }
  const [, neg, whole = '', frac = ''] = m;
  const padded = (frac + '0'.repeat(exponent + 1)).slice(0, exponent + 1);
  let minor = Number(whole || '0') * 10 ** exponent + Number(padded.slice(0, exponent) || '0');
  if (Number(padded[exponent]) >= 5) minor += 1; // half-up on the next digit
  return neg ? -minor : minor;
}

export function fromMinor(minor, exponent = 2) {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 10 ** exponent);
  const frac = String(abs % 10 ** exponent).padStart(exponent, '0');
  return `${neg ? '-' : ''}${whole}${exponent ? '.' + frac : ''}`;
}

/** Normalize a user-supplied decimal (number or string) to a plain string. */
export function decimalString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid amount: ${value}`);
    return String(value);
  }
  return String(value).trim();
}
