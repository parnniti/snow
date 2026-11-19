// Approvals assigned to the signed-in user (sysapproval_approver).
import { SYS_ID_RE, get, list, update } from './table.js';

const TABLE = 'sysapproval_approver';
export const APPROVAL_FIELDS = ['sys_id', 'sysapproval', 'sysapproval.short_description', 'source_table', 'state', 'sys_created_on', 'due_date'];

export async function listApprovals(ctx, me, { all = false, limit = 50 } = {}) {
  const query = `approver=${me.sys_id}${all ? '' : '^state=requested'}^ORDERBYDESCsys_created_on`;
  const { rows } = await list(ctx, TABLE, { query, fields: APPROVAL_FIELDS, limit });
  return rows.map((r) => ({
    for: r.sysapproval,
    what: r['sysapproval.short_description'] ?? '',
    table: r.source_table,
    state: r.state,
    requested: r.sys_created_on,
    due: r.due_date,
    sys_id: r.sys_id,
  }));
}

/** The pending approval of `me` for record NUMBER (or an approval sys_id). */
export async function findApproval(ctx, me, ref) {
  if (SYS_ID_RE.test(ref)) return get(ctx, TABLE, ref, { fields: APPROVAL_FIELDS });
  const { rows } = await list(ctx, TABLE, {
    query: `approver=${me.sys_id}^state=requested^sysapproval.number=${ref.toUpperCase()}`,
    fields: APPROVAL_FIELDS,
    limit: 5,
  });
  if (!rows.length) throw new Error(`no approval waiting on you for ${ref.toUpperCase()} (see: snow approval ls)`);
  if (rows.length > 1) throw new Error(`${rows.length} approvals waiting on you for ${ref}; use the approval sys_id (${rows.map((r) => r.sys_id).join(', ')})`);
  return rows[0];
}

/** Approve or reject. `decision` is "approved" | "rejected". Verifies the state took. */
export async function decide(ctx, approval, decision, comment) {
  const label = decision === 'approved' ? 'Approved' : 'Rejected';
  const rec = await update(ctx, TABLE, approval.sys_id, { state: label, ...(comment ? { comments: comment } : {}) });
  if (String(rec.state).toLowerCase() !== label.toLowerCase()) {
    throw new Error(`ServiceNow kept the approval for ${approval.sysapproval} at "${rec.state}" (sent "${label}")`);
  }
  return rec;
}
