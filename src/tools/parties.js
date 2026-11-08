import * as z from 'zod';
import { OPS } from '../wave/operations.js';
import { CREATE, DELETE, UPDATE, address, businessId, currencyCode, dateTime, defineTool, defined, id } from './common.js';
import { mutationResult, registerGet, registerList } from './entity.js';

const CUSTOMER_SORT = z.enum(['CREATED_AT_ASC', 'CREATED_AT_DESC', 'MODIFIED_AT_ASC', 'MODIFIED_AT_DESC', 'NAME_ASC', 'NAME_DESC']);

const shipping = z
  .object({
    name: z.string().optional(),
    address: address.optional(),
    phone: z.string().optional(),
    instructions: z.string().optional(),
  })
  .describe('Shipping contact and address');

const contactFields = {
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  displayId: z.string().optional().describe('Your own account number for the customer'),
  email: z.string().email().optional(),
  mobile: z.string().optional(),
  phone: z.string().optional(),
  fax: z.string().optional(),
  tollFree: z.string().optional(),
  website: z.string().optional(),
  internalNotes: z.string().optional(),
  currency: currencyCode.optional().describe('Default invoicing currency for this customer'),
  address: address.optional(),
  shippingDetails: shipping.optional(),
};

const modifiedFilters = {
  modifiedAtAfter: dateTime.optional().describe('Only records modified after this time (ISO 8601)'),
  modifiedAtBefore: dateTime.optional().describe('Only records modified before this time (ISO 8601)'),
};

export function registerPartyTools(server, ctx) {
  // ------------------------------------------------------------ customers
  registerList(server, ctx, {
    name: 'wave_list_customers',
    title: 'List customers',
    toolset: 'customers',
    field: 'customers',
    ops: { summary: OPS.ListCustomers, full: OPS.ListCustomersFull },
    description: 'List customers with their outstanding and overdue balances. Filter by exact email, archive state or modification time; use search for a name substring.',
    filters: {
      email: z.string().optional().describe('Exact email match'),
      isArchived: z.boolean().optional(),
      sort: z.array(CUSTOMER_SORT).min(1).optional().describe('Default CREATED_AT_DESC'),
      ...modifiedFilters,
    },
    searchFields: ['name', 'email', 'displayId', 'firstName', 'lastName'],
  });
  registerGet(server, ctx, {
    name: 'wave_get_customer',
    title: 'Get customer',
    toolset: 'customers',
    field: 'customer',
    op: OPS.GetCustomer,
    what: 'Customer',
    description: 'One customer with address, shipping details, notes and outstanding/overdue amounts. Deleted customers are still returned by ID, marked deleted: true.',
    // Wave's customerDelete is a soft delete: the record stays readable by ID
    // with isActive=false and drops out of lists (verified live).
    map: (c) => (c.isActive === false ? { deleted: true, note: 'Deleted in Wave: kept for history and hidden from lists.', ...c } : c),
  });
  defineTool(server, ctx, {
    name: 'wave_create_customer',
    title: 'Create customer',
    toolset: 'customers',
    annotations: CREATE,
    description: 'Create a customer. Only name is required.',
    input: z.object({ businessId, name: z.string().min(1).describe('Customer or company name'), ...contactFields }),
    handler: async ({ businessId: b, ...fields }) => {
      const input = { businessId: await ctx.resolveBusinessId(b), ...defined(fields) };
      return mutationResult(await ctx.client.mutate(OPS.CustomerCreate, { input }, 'customerCreate'), 'customer');
    },
  });
  defineTool(server, ctx, {
    name: 'wave_update_customer',
    title: 'Update customer',
    toolset: 'customers',
    annotations: UPDATE,
    description: 'Change fields on a customer. Only the fields you pass are changed; nested address/shipping objects replace the existing ones.',
    input: z.object({ id: id('Customer'), name: z.string().min(1).optional(), ...contactFields }),
    handler: async (fields) => mutationResult(await ctx.client.mutate(OPS.CustomerPatch, { input: defined(fields) }, 'customerPatch'), 'customer'),
  });
  defineTool(server, ctx, {
    name: 'wave_delete_customer',
    title: 'Delete customer',
    toolset: 'customers',
    annotations: DELETE,
    description: 'Delete a customer. Wave removes it from lists, but the record stays readable by ID (wave_get_customer shows deleted: true); there is no undelete through the API.',
    input: z.object({ id: id('Customer') }),
    handler: async ({ id }) => mutationResult(await ctx.client.mutate(OPS.CustomerDelete, { input: { id } }, 'customerDelete'), null, { deletedId: id }),
  });

  // ------------------------------------------------------------ vendors (read-only)
  registerList(server, ctx, {
    name: 'wave_list_vendors',
    title: 'List vendors',
    toolset: 'vendors',
    field: 'vendors',
    ops: { summary: OPS.ListVendors, full: OPS.ListVendorsFull },
    description: 'List vendors (suppliers). Wave\'s API cannot create, change or delete vendors, and bills are not exposed.',
    filters: { email: z.string().optional().describe('Exact email match'), ...modifiedFilters },
    searchFields: ['name', 'email', 'displayId', 'firstName', 'lastName'],
  });
  registerGet(server, ctx, {
    name: 'wave_get_vendor',
    title: 'Get vendor',
    toolset: 'vendors',
    field: 'vendor',
    op: OPS.GetVendor,
    what: 'Vendor',
    description: 'One vendor with address and contact details.',
  });
}
