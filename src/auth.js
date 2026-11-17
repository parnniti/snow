// OAuth 2.0 authorization code + PKCE.
// Default client: the public OAuth client that ServiceNow ships on instances for the ServiceNow SDK
// (same client and redirect as `now-sdk auth --type oauth`, see @servicenow/sdk-cli
// src/auth/OAuth/CodeGrant.ts). It has no secret; /sdk-oauth.do shows the code to paste back.
// The browser login uses whatever the instance uses (local login, SAML/OIDC SSO, MFA).
// Instances that disable that client can register their own public client: SNOW_OAUTH_CLIENT_ID.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { BIN, configDir, writePrivateFile } from './config.js';
import { loadTokens, saveTokens } from './tokenstore.js';

export const CLIENT_ID = process.env.SNOW_OAUTH_CLIENT_ID || '543e5655f77746a28228c6009a599dfb';
const REDIRECT_URI = process.env.SNOW_OAUTH_REDIRECT_URI || '/sdk-oauth.do';
const EXPIRY_SKEW_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export class LoginRequired extends Error {
  constructor(ctx, reason) {
    super(`not logged in to "${ctx.name}" (${ctx.instance})${reason ? `: ${reason}` : ''}; run: ${BIN} login -c ${ctx.name}`);
    this.name = 'LoginRequired';
  }
}

const b64url = (buf) => buf.toString('base64url');

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function pendingPath(ctx) {
  return path.join(configDir(), 'pending', `${ctx.name}.json`);
}

/** Step 1: build the authorize URL and remember state + verifier for step 2. */
export function startLogin(ctx) {
  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(16));
  writePrivateFile(pendingPath(ctx), JSON.stringify({ instance: ctx.instance, state, verifier, created: Date.now() }));
  const u = new URL(`${ctx.instance}/oauth_auth.do`);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: '',
  }).toString();
  return u.toString();
}

/**
 * Accepts what /sdk-oauth.do shows: a bare code, "CODE&state=STATE", or the full redirect URL / query string.
 * Returns { code, state } (state may be undefined).
 */
export function parsePastedCode(input) {
  let s = input.trim();
  if (s.includes('?')) s = s.slice(s.indexOf('?') + 1);
  if (!s.includes('=')) return { code: s };
  const params = new URLSearchParams(s.includes('code=') ? s : `code=${s}`);
  return { code: params.get('code') ?? '', state: params.get('state') ?? undefined };
}

/** Step 2: exchange the pasted code for tokens and persist them. */
export async function finishLogin(ctx, pasted) {
  const file = pendingPath(ctx);
  if (!fs.existsSync(file)) throw new Error(`no pending login for "${ctx.name}"; run: ${BIN} login -c ${ctx.name}`);
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pending.instance !== ctx.instance) throw new Error('pending login was started for a different instance; start again');
  if (Date.now() - pending.created > PENDING_TTL_MS) {
    fs.rmSync(file, { force: true });
    throw new Error('pending login expired (10 min); start again');
  }
  const { code, state } = parsePastedCode(pasted);
  if (!code) throw new Error('empty code');
  if (state !== undefined && state !== pending.state) throw new Error('state mismatch: code belongs to a different login attempt; start again');
  const tok = await tokenRequest(ctx, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pending.verifier,
  });
  fs.rmSync(file, { force: true });
  const record = toRecord(ctx, tok);
  saveTokens(ctx.name, record);
  return record;
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export async function promptCode() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question('Paste the code shown in the browser: ')).trim();
  } finally {
    rl.close();
  }
}

async function tokenRequest(ctx, params) {
  const res = await fetch(`${ctx.instance}/oauth_token.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok || !body?.access_token) {
    const reason = body?.error_description || body?.error || text.slice(0, 200) || res.statusText;
    const err = new Error(`token request failed (HTTP ${res.status}): ${reason}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function toRecord(ctx, tok, previous) {
  const now = Date.now();
  return {
    instance: ctx.instance,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || previous?.refresh_token,
    expires_at: now + (Number(tok.expires_in) || 1800) * 1000,
    logged_in_at: previous?.logged_in_at ?? now,
    user: previous?.user,
  };
}

/** Returns the stored record with a valid access token, refreshing when needed. */
export async function getSession(ctx, { forceRefresh = false } = {}) {
  const rec = loadTokens(ctx.name);
  if (!rec) throw new LoginRequired(ctx);
  if (rec.instance !== ctx.instance) throw new LoginRequired(ctx, `stored token is for ${rec.instance}`);
  if (!forceRefresh && rec.expires_at - EXPIRY_SKEW_MS > Date.now()) return rec;
  if (!rec.refresh_token) throw new LoginRequired(ctx, 'access token expired and no refresh token');
  let tok;
  try {
    tok = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: rec.refresh_token });
  } catch (e) {
    if (e.status === 400 || e.status === 401) throw new LoginRequired(ctx, 'refresh token rejected or expired');
    throw e;
  }
  const next = toRecord(ctx, tok, rec);
  saveTokens(ctx.name, next);
  return next;
}

export function rememberUser(ctx, user) {
  const rec = loadTokens(ctx.name);
  if (!rec) return;
  rec.user = user;
  saveTokens(ctx.name, rec);
}
