import { getSession, rememberUser } from './auth.js';
import { request } from './http.js';

/** Signed-in user {sys_id, user_name, name}; cached alongside the token after first lookup. */
export async function currentUser(ctx, { refresh = false } = {}) {
  const session = await getSession(ctx);
  if (!refresh && session.user?.sys_id) return session.user;
  const res = await request(ctx, 'GET', '/api/now/table/sys_user', {
    query: {
      sysparm_query: 'sys_id=javascript:gs.getUserID()',
      sysparm_fields: 'sys_id,user_name,name,email',
      sysparm_limit: 1,
    },
  });
  const user = res.data.result?.[0];
  if (!user?.sys_id) throw new Error('could not resolve the signed-in user (sys_user lookup returned nothing)');
  rememberUser(ctx, user);
  return user;
}
