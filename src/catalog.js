// Service Catalog: browse items, inspect their forms, order (raise a request) with variables.
// Uses the Service Catalog API (/api/sn_sc/servicecatalog). That API does not enforce mandatory variables
// (the portal does it in the browser), so `order` checks them itself.
import { request } from './http.js';
import { SYS_ID_RE, list } from './table.js';

const BASE = '/api/sn_sc/servicecatalog';

// Variable types that hold no answer: containers, labels, breaks, formatters, macros, UI pages.
const LAYOUT = new Set([0, 11, 12, 14, 15, 17, 19, 20, 24]);
export const TYPE_NAMES = {
  1: 'yes/no', 2: 'multi-line text', 3: 'multiple choice', 4: 'numeric scale', 5: 'select box', 6: 'text',
  7: 'checkbox', 8: 'reference', 9: 'date', 10: 'date/time', 13: 'wide text', 16: 'wide text', 18: 'lookup select',
  21: 'list collector', 22: 'lookup multiple choice', 23: 'html', 25: 'masked', 26: 'email', 27: 'url', 28: 'ip address',
  29: 'duration', 31: 'requested for', 32: 'rich text label', 33: 'attachment',
};
// Reference tables whose rows `order` can find by a human value (and that have an `active` flag).
// Other tables are searched on the variable's display_field; when that is unknown or unreadable,
// the value must be a sys_id.
const REF_LOOKUP = { sys_user: ['name', 'user_name', 'email'], sys_user_group: ['name'] };

export async function searchItems(ctx, text, limit = 20) {
  const res = await request(ctx, 'GET', `${BASE}/items`, { query: { sysparm_text: text, sysparm_limit: limit } });
  return (res.data.result || []).map((i) => ({
    sys_id: i.sys_id,
    name: i.name,
    category: i.category?.title ?? '',
    short_description: i.short_description ?? '',
  }));
}

/** Item by sys_id, or by exact (case-insensitive) name. */
export async function getItem(ctx, ref) {
  let id = ref;
  if (!SYS_ID_RE.test(ref)) {
    const hits = (await searchItems(ctx, ref, 50)).filter((i) => i.name.toLowerCase() === ref.toLowerCase());
    if (!hits.length) throw new Error(`no catalog item named "${ref}"; search with: snow catalog ls "${ref}"`);
    if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} items (${hits.map((h) => h.sys_id).join(', ')}); use the sys_id`);
    id = hits[0].sys_id;
  }
  const res = await request(ctx, 'GET', `${BASE}/items/${id}`);
  const item = res.data.result;
  return { sys_id: item.sys_id, name: item.name, short_description: item.short_description, category: item.category?.title ?? '', variables: flattenVariables(item.variables) };
}

/** Answerable variables in form order, with container titles as `section`. */
export function flattenVariables(vars, section = '') {
  const out = [];
  for (const v of vars || []) {
    const title = LAYOUT.has(v.type) && v.label && !/^formatter/i.test(v.name || '') ? v.label : section;
    if (!LAYOUT.has(v.type) && v.name) {
      out.push({
        name: v.name,
        label: v.label || v.name,
        type: TYPE_NAMES[v.type] ?? `type ${v.type}`,
        // List collectors name their source in `table`; references in `reference`.
        reference: v.reference || (v.type === 21 ? v.table || '' : ''),
        displayField: v.display_field || '',
        mandatory: Boolean(v.mandatory),
        read_only: Boolean(v.read_only),
        choices: (v.choices || []).filter((c) => c.value !== '').map((c) => ({ value: String(c.value), label: c.label })),
        section,
      });
    }
    out.push(...flattenVariables(v.children, title));
  }
  return out;
}

/** sys_id for one reference / list-collector value: a sys_id as-is, else a lookup on the display field. */
async function resolveRef(ctx, v, p) {
  if (SYS_ID_RE.test(p)) return { sysId: p };
  const keys = REF_LOOKUP[v.reference] ?? (v.displayField ? [v.displayField] : null);
  const field = keys?.[0] ?? '<field>';
  const hint = `find it: snow table list ${v.reference} -q '${field}LIKE${p}' -f sys_id,${field}`;
  if (!keys) return { problem: `needs a ${v.reference} sys_id (${hint})` };
  try {
    const active = REF_LOOKUP[v.reference] ? 'active=true^' : '';
    const query = `${active}${keys.map((k, i) => `${i ? 'OR' : ''}${k}=${p}`).join('^')}`;
    const { rows } = await list(ctx, v.reference, { query, fields: ['sys_id', keys[0]], limit: 10 });
    if (rows.length === 1) return { sysId: rows[0].sys_id };
    if (rows.length) return { problem: `"${p}" matches ${rows.length} ${v.reference} records (${rows.map((r) => r.sys_id).join(', ')}); pass the right sys_id, e.g. copied from an earlier request` };
    return { problem: `no ${v.reference} "${p}" (${hint})` };
  } catch (e) {
    if (e.name !== 'ApiError') throw e;
    return { problem: `cannot look up "${p}" in ${v.reference} (HTTP ${e.status}); pass the sys_id instead` };
  }
}

/**
 * Turn user input into the variables payload: choice labels → values, user/group names → sys_ids.
 * Returns { variables, problems } where problems are blocking (unknown names, bad choices, missing mandatory).
 */
export async function buildOrder(ctx, item, input, { force = false } = {}) {
  const byName = new Map(item.variables.map((v) => [v.name, v]));
  const variables = {};
  const problems = [];
  for (const [name, raw] of Object.entries(input)) {
    const v = byName.get(name);
    if (!v) {
      problems.push(`unknown variable "${name}" (see: snow catalog get "${item.name}")`);
      continue;
    }
    let value = String(raw);
    if (v.choices.length) {
      const parts = v.type === 'list collector' ? value.split(',').map((s) => s.trim()) : [value];
      const mapped = parts.map((p) => v.choices.find((c) => c.value === p || c.label.toLowerCase() === p.toLowerCase())?.value);
      if (mapped.some((m) => m === undefined)) {
        problems.push(`${name}: "${value}" is not one of ${v.choices.map((c) => (c.label === c.value ? c.value : `${c.value} (${c.label})`)).join(', ')}`);
        continue;
      }
      value = mapped.join(',');
    } else if (v.reference) {
      const ids = [];
      for (const p of value.split(',').map((s) => s.trim()).filter(Boolean)) {
        const id = await resolveRef(ctx, v, p);
        if (id.problem) problems.push(`${name}: ${id.problem}`);
        else ids.push(id.sysId);
      }
      value = ids.join(',');
    } else if (v.type === 'checkbox' || v.type === 'yes/no') {
      const yes = /^(true|yes|y|1)$/i.test(value);
      value = v.type === 'checkbox' ? String(yes) : yes ? 'Yes' : /^(false|no|n|0)$/i.test(value) ? 'No' : value;
    }
    variables[name] = value;
  }
  const missing = item.variables.filter((v) => v.mandatory && !v.read_only && !(v.name in variables));
  if (missing.length && !force) {
    problems.push(`mandatory on the form: ${missing.map((v) => `${v.name} (${v.label})`).join(', ')}. Some are only mandatory in certain cases; add --force to order anyway`);
  }
  return { variables, problems };
}

/** Place the order. Returns { request_number, request_id, items: [{ number, sys_id }] }. */
export async function orderNow(ctx, item, variables, { requestedFor } = {}) {
  const body = { sysparm_quantity: '1', variables };
  if (requestedFor) body.sysparm_requested_for = requestedFor;
  const res = await request(ctx, 'POST', `${BASE}/items/${item.sys_id}/order_now`, { body });
  const r = res.data.result || {};
  const requestId = r.request_id || r.sys_id;
  let items = [];
  if (requestId) {
    ({ rows: items } = await list(ctx, 'sc_req_item', { query: `request=${requestId}`, fields: ['number', 'sys_id'], limit: 20 }));
  }
  return { request_number: r.request_number || r.number, request_id: requestId, items };
}
