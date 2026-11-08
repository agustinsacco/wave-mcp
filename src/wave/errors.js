/**
 * Errors carry a message written for the model: what went wrong and the next
 * step that fixes it. Tool handlers surface `message` verbatim as an
 * isError tool result.
 */
export class WaveError extends Error {
  constructor(message, { code = 'WAVE_ERROR', details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WaveError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class WaveAuthError extends WaveError {
  constructor(message, opts = {}) {
    super(message, { code: 'UNAUTHENTICATED', ...opts });
    this.name = 'WaveAuthError';
  }
}

export class WaveRateLimitError extends WaveError {
  constructor(message, opts = {}) {
    super(message, { code: 'RATE_LIMITED', ...opts });
    this.name = 'WaveRateLimitError';
  }
}

/** A GraphQL `errors` array from Wave. */
export class WaveApiError extends WaveError {
  constructor(message, { errors = [], ...opts } = {}) {
    super(message, { code: errors[0]?.extensions?.code || 'WAVE_API_ERROR', ...opts });
    this.name = 'WaveApiError';
    this.errors = errors;
  }
}

/** A mutation answered with didSucceed=false and inputErrors. */
export class WaveInputError extends WaveError {
  constructor(message, { inputErrors = [], ...opts } = {}) {
    super(message, { code: 'INPUT_ERROR', ...opts });
    this.name = 'WaveInputError';
    this.inputErrors = inputErrors;
  }
}

/** Something the public API cannot do; the message says what to do instead. */
export class WaveUnsupportedError extends WaveError {
  constructor(message, opts = {}) {
    super(message, { code: 'UNSUPPORTED', ...opts });
    this.name = 'WaveUnsupportedError';
  }
}

const CODE_HINTS = {
  NOT_FOUND: 'Check the ID: list tools return valid IDs, and IDs are specific to one business.',
  GRAPHQL_VALIDATION_FAILED: 'The request did not match Wave\'s schema. If this came from wave_graphql_query, consult the wave://schema resource.',
  VARIABLE_VALUE: 'One of the input values has the wrong type or format (dates are YYYY-MM-DD, amounts are decimals).',
  FORBIDDEN: 'The credential lacks permission for this operation (OAuth scope or business access).',
  INTERNAL_SERVER_ERROR: 'Wave failed internally. Retry once; if it persists, give Wave Support the error id.',
};

export function describeGraphqlErrors(errors) {
  const parts = errors.slice(0, 5).map((e) => {
    const code = e.extensions?.code;
    const where = e.path?.length ? ` at ${e.path.join('.')}` : '';
    const id = e.extensions?.id ? ` (error id ${e.extensions.id})` : '';
    return `${code ? `${code}: ` : ''}${e.message}${where}${id}`;
  });
  if (errors.length > 5) parts.push(`…and ${errors.length - 5} more`);
  const hints = [...new Set(errors.map((e) => CODE_HINTS[e.extensions?.code]).filter(Boolean))];
  return parts.join('; ') + (hints.length ? `. ${hints.join(' ')}` : '');
}

/**
 * The web-app API puts the real reason inside a JSON string, e.g.
 * {"transactions": {"0": {"__all__": [{"message": "... over balanced.",
 * "error_type": "LINE_ITEM_AMOUNT_OVERBALANCED", "variables": {"difference": "0.50"}}]}}}
 * alongside empty and bare-status entries. Pull out the readable reasons.
 */
export function describeInternalInputErrors(inputErrors) {
  const reasons = [];
  const where = (field) => (field && field !== '__all__' && !/^\d+$/.test(field) ? `${field}: ` : '');
  const visit = (node, field) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, field));
    if (typeof node === 'string' && node.trim()) return void reasons.push(`${where(field)}${node.trim()}`);
    if (!node || typeof node !== 'object') return;
    if (typeof node.message === 'string' && node.message) {
      const vars = node.variables && typeof node.variables === 'object' ? Object.entries(node.variables).map(([k, v]) => `${k} ${v}`).join(', ') : '';
      reasons.push(`${where(field)}${node.message}${vars ? ` (${vars})` : ''}${node.error_type ? ` [${node.error_type}]` : ''}`);
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, /^(transactions|\d+|__all__)$/.test(k) ? field : k);
  };
  for (const e of inputErrors || []) {
    const text = String(e?.message || '').trim();
    if (!text || /^\d{3}$/.test(text)) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      reasons.push(`${e.path?.length ? e.path.join('.') + ': ' : ''}${text}`);
      continue;
    }
    visit(parsed);
  }
  if (reasons.length) return [...new Set(reasons)].join('; ');
  const codes = [...new Set((inputErrors || []).map((e) => e?.code).filter(Boolean))];
  return `no reason given${codes.length ? ` (${codes.join(', ')})` : ''}`;
}

export function describeInputErrors(inputErrors) {
  if (!inputErrors?.length) return 'Wave rejected the request without giving a reason.';
  return inputErrors
    .map((e) => `${e.path?.length ? e.path.join('.') + ': ' : ''}${e.message || 'invalid'}${e.code ? ` [${e.code}]` : ''}`)
    .join('; ');
}
