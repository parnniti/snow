import { getSession, LoginRequired } from './auth.js';

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function buildUrl(ctx, apiPath, query) {
  const u = /^https?:\/\//.test(apiPath) ? new URL(apiPath) : new URL(apiPath.startsWith('/') ? apiPath : `/${apiPath}`, ctx.instance);
  if (u.origin !== new URL(ctx.instance).origin) throw new Error(`refusing to send token to ${u.origin}; context instance is ${ctx.instance}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u;
}

async function send(url, method, token, body, headers) {
  return fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    // Buffers go as-is (attachment uploads; the caller sets Content-Type), strings as-is, objects as JSON.
    body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * Authenticated call to the instance. Returns { status, headers, data }. Throws ApiError on non-2xx.
 * `binary: true` returns data as a Buffer (attachments, images) instead of parsed JSON/text.
 */
export async function request(ctx, method, apiPath, { query, body, headers, binary = false } = {}) {
  const url = buildUrl(ctx, apiPath, query);
  let session = await getSession(ctx);
  let res = await send(url, method, session.access_token, body, headers);
  if (res.status === 401) {
    // Token revoked or expired early: refresh once, then give up.
    session = await getSession(ctx, { forceRefresh: true });
    res = await send(url, method, session.access_token, body, headers);
    if (res.status === 401) throw new LoginRequired(ctx, 'instance rejected the access token');
  }
  if (binary && res.ok) return { status: res.status, headers: res.headers, data: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let data = text;
  if ((res.headers.get('content-type') || '').includes('json') && text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  if (!res.ok) {
    const e = data?.error;
    const msg = e ? [e.message, e.detail].filter(Boolean).join(': ') : String(text).slice(0, 300) || res.statusText;
    throw new ApiError(res.status, `${method} ${url.pathname} → HTTP ${res.status}: ${msg}`, data);
  }
  return { status: res.status, headers: res.headers, data };
}
