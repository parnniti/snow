// Table API helpers. Reads default to display values; writes accept display values for reference fields
// (e.g. assignment_group=DevOps) via sysparm_input_display_value.
import { request } from './http.js';

export const SYS_ID_RE = /^[0-9a-f]{32}$/;

const tablePath = (table, sysId) => `/api/now/table/${encodeURIComponent(table)}${sysId ? `/${sysId}` : ''}`;

export async function list(ctx, table, { query, fields, limit = 20, offset, displayValue = true } = {}) {
  const res = await request(ctx, 'GET', tablePath(table), {
    query: {
      sysparm_query: query,
      sysparm_fields: fields?.length ? fields.join(',') : undefined,
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_display_value: String(displayValue),
      sysparm_exclude_reference_link: 'true',
    },
  });
  const total = Number(res.headers.get('x-total-count'));
  return { rows: res.data.result, total: Number.isFinite(total) ? total : undefined };
}

/** Get by sys_id, or by `number` (INC0012345, CHG..., RITM..., SCTASK...). */
export async function get(ctx, table, id, { fields, displayValue = true } = {}) {
  if (SYS_ID_RE.test(id)) {
    const res = await request(ctx, 'GET', tablePath(table, id), {
      query: {
        sysparm_fields: fields?.length ? fields.join(',') : undefined,
        sysparm_display_value: String(displayValue),
        sysparm_exclude_reference_link: 'true',
      },
    });
    return res.data.result;
  }
  const { rows } = await list(ctx, table, { query: `number=${id.toUpperCase()}`, fields, limit: 2, displayValue });
  if (!rows.length) throw new Error(`${table}: no record with number ${id.toUpperCase()}`);
  if (rows.length > 1) throw new Error(`${table}: number ${id.toUpperCase()} is ambiguous; use the sys_id`);
  return rows[0];
}

export async function resolveSysId(ctx, table, id) {
  if (SYS_ID_RE.test(id)) return id;
  const rec = await get(ctx, table, id, { fields: ['sys_id'], displayValue: false });
  return rec.sys_id;
}

const writeQuery = {
  sysparm_input_display_value: 'true',
  sysparm_display_value: 'true',
  sysparm_exclude_reference_link: 'true',
};

export async function create(ctx, table, fields) {
  const res = await request(ctx, 'POST', tablePath(table), { query: writeQuery, body: fields });
  return res.data.result;
}

export async function update(ctx, table, id, fields) {
  const sysId = await resolveSysId(ctx, table, id);
  const res = await request(ctx, 'PATCH', tablePath(table, sysId), { query: writeQuery, body: fields });
  return res.data.result;
}
