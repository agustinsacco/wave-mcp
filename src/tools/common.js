import * as z from 'zod';
import { toText } from '../format.js';
import { WaveError } from '../wave/errors.js';

// ------------------------------------------------------------ shared argument schemas

export const businessId = z
  .string()
  .min(1)
  .optional()
  .describe('Business ID; defaults to the one wave_get_context reports');

export const id = (what) => z.string().min(1).describe(`${what} ID`);

export const page = z.number().int().min(1).default(1).describe('1-based; use nextPage');
export const pageSize = (max = 100, dflt = 20) =>
  z.number().int().min(1).max(max).default(dflt).describe(`Items per page (max ${max})`);

export const detail = z
  .enum(['summary', 'full'])
  .default('summary')
  .describe('summary: key fields, long text clipped. full: every field and line items');

/** A real calendar date: "2024-04-31" is rejected rather than left to Wave to interpret. */
export const isCalendarDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isCalendarDate, 'Not a real calendar date')
  .describe('Date, YYYY-MM-DD');
export const dateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Use an ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z')
  .describe('ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z');

/** Amounts: numbers or decimal strings; passed to Wave's Decimal scalar unchanged. */
export const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/, 'Use a plain decimal like 12.50')]);
export const positiveAmount = z
  .union([z.number().positive(), z.string().regex(/^\d+(\.\d{1,2})?$/, 'Use a positive amount with at most 2 decimals, e.g. 12.50')])
  .describe('Positive amount, at most 2 decimals');

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. CAD').describe('ISO 4217 currency code, e.g. CAD or USD');
export const countryCode = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code, e.g. CA').describe('ISO 3166-1 alpha-2 country code, e.g. CA');

export const address = z
  .object({
    addressLine1: z.string().optional(),
    addressLine2: z.string().optional(),
    city: z.string().optional(),
    provinceCode: z.string().optional().describe('Province/state code, e.g. CA-ON or US-NY (see wave_get_reference kind=country)'),
    countryCode: countryCode.optional(),
    postalCode: z.string().optional(),
  })
  .describe('Postal address');

export const emailList = z.array(z.string().email()).min(1).max(20);

// ------------------------------------------------------------ annotations

export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
export const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
/** Emails a real recipient: irreversible and outside the Wave account. */
export const SEND = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** State change that is not destructive (approve, mark sent...). */
export const TRANSITION = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ------------------------------------------------------------ registration

/**
 * Register one tool, honouring toolsets and read-only mode. The handler
 * returns a plain object; it is shaped and serialized here, and any thrown
 * error becomes an isError result carrying an actionable message.
 */
export function defineTool(server, ctx, { name, title, description, toolset, annotations, input, handler, local = false }) {
  // `local` tools change only this server's own files, never Wave.
  const write = annotations.readOnlyHint === false && !local;
  if (!ctx.config.toolsets.includes(toolset)) return false;
  if (write && ctx.config.readOnly) return false;
  server.registerTool(
    name,
    {
      title,
      description,
      annotations: { title, ...annotations },
      ...(input ? { inputSchema: input } : {}),
    },
    async (args) => {
      const started = Date.now();
      try {
        const result = await handler(args ?? {});
        if (write) ctx.invalidate();
        ctx.logger.debug(`${name} ok in ${Date.now() - started} ms`);
        return { content: [{ type: 'text', text: toText(result, ctx.config.maxResponseChars) }] };
      } catch (error) {
        if (write) ctx.invalidate();
        const message = error instanceof WaveError ? error.message : `Unexpected error in ${name}: ${error?.message || error}`;
        if (!(error instanceof WaveError)) ctx.logger.error(`${name}: ${error?.stack || error}`);
        else ctx.logger.debug(`${name} failed: ${error.code}`);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  );
  return true;
}

/** Strip keys whose value is undefined, so optional args are truly omitted. */
export function defined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function requireFound(value, what, idValue) {
  if (value === null || value === undefined) {
    throw new WaveError(`${what} ${idValue} was not found in this business. List tools return valid IDs.`, { code: 'NOT_FOUND' });
  }
  return value;
}
